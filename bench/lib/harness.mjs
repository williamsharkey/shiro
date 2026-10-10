// Browser side of the benchmark: launches Chromium, boots Shiro pages and
// collects memory/network numbers. Suites get a Harness and call
// `h.metric()` / `h.sample()` to record results.
import { chromium } from 'playwright-core';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, round } from './stats.mjs';
import { startProfile, stopProfile } from './profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INPAGE = readFileSync(join(HERE, 'inpage.js'), 'utf8');
export const CHROMIUM = process.env.CHROMIUM || '/opt/pw-browsers/chromium';

export class Harness {
  constructor({ mode, origin, netcache, runs, quick, log, results, testServer, hostAddr, only, skipRe }) {
    Object.assign(this, { mode, origin, netcache, runs, quick, log, results, testServer, hostAddr, only, skipRe });
    this.browser = null;
    this.page = null;
    this.context = null;
    this.userDataDirs = [];
  }

  get isolated() { return this.mode === 'isolated'; }

  async launch() {
    this.browser = await chromium.launch({
      executablePath: CHROMIUM,
      args: [
        '--no-sandbox',
        // measureUserAgentSpecificMemory resolves on the next GC otherwise (up to 20 s)
        '--enable-blink-features=ForceEagerMeasureMemory',
        `--js-flags=--expose-gc${process.env.BENCH_JS_FLAGS ? ' ' + process.env.BENCH_JS_FLAGS : ''}`,
      ],
    });
    this.browserCdp = await this.browser.newBrowserCDPSession();
  }

  async close() {
    await this.page?.context().close().catch(() => {});
    await this.browser?.close().catch(() => {});
    for (const d of this.userDataDirs) rmSync(d, { recursive: true, force: true });
  }

  async newContext() {
    const context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    await this.netcache.install(context, this.origin);
    await context.addInitScript(INPAGE);
    return context;
  }

  /**
   * Open a page and boot Shiro; returns timings. `context` reuses one (warm
   * cache: its HTTP cache and IndexedDB survive), otherwise a fresh one (cold).
   */
  async boot({ context, page, waitSettled = false, settleQuietMs = 1000, path, keepNetwork = false } = {}) {
    context = context ?? (await this.newContext());
    page = page ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Network.enable');
    const requests = [];
    const net = { bytes: 0, byUrl: new Map() };
    const urls = new Map();
    cdp.on('Network.requestWillBeSent', (e) => { if (!e.redirectResponse) requests.push(e.request.url); urls.set(e.requestId, e.request.url); });
    cdp.on('Network.loadingFinished', (e) => {
      net.bytes += e.encodedDataLength;
      const u = urls.get(e.requestId);
      if (u) net.byUrl.set(u, (net.byUrl.get(u) || 0) + e.encodedDataLength);
    });
    this.net = net;
    this.requests = requests;
    const consoleLines = [];
    page.on('console', (m) => { consoleLines.push(m.text()); if (process.env.BENCH_CONSOLE) this.log(`[console] ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e) => this.log(`[pageerror] ${e.message}`));
    const t0 = Date.now();
    if (page.url().startsWith(this.origin)) await page.reload({ waitUntil: 'commit' });
    else await page.goto(this.origin + (path ?? process.env.BENCH_PATH ?? '/'), { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__bench?.marks.firstPrompt, null, { timeout: 120000, polling: 50 });
    // Time to interactive: first prompt, then no long task for settleQuietMs
    let tti;
    for (;;) {
      const s = await page.evaluate(() => {
        const lt = window.__bench.longTasks;
        const lastEnd = lt.length ? Math.max(...lt.map(([s, d]) => s + d)) : 0;
        return { now: performance.now(), lastEnd, fp: window.__bench.marks.firstPrompt };
      });
      const ref = Math.max(s.fp, s.lastEnd);
      if (s.now - ref >= settleQuietMs) { tti = ref; break; }
      if (Date.now() - t0 > 120000) { tti = ref; break; }
      await page.waitForTimeout(100);
    }
    const marks = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return { ...window.__bench.marks, domContentLoaded: nav?.domContentLoadedEventEnd, load: nav?.loadEventEnd, longTasks: window.__bench.longTasks.length };
    });
    // First command right after boot: lazy loading lands here
    const firstCmd = await page.evaluate(() => window.__bench.sh('true').then((r) => r.ms));
    let settled = null;
    if (waitSettled) {
      // Background Claude Code install starts 3 s after boot
      const t1 = Date.now();
      while (Date.now() - t1 < 120000) {
        if (consoleLines.some((l) => /Claude Code (ready|background install failed)/.test(l))) break;
        await page.waitForTimeout(200);
      }
      settled = { ms: Date.now() - t0, claude: consoleLines.find((l) => /Claude Code (ready|background install failed)/.test(l)) || 'timeout' };
    }
    this.context = context;
    this.page = page;
    this.cdp = cdp;
    const result = { context, page, cdp, marks, tti, firstCmd, requests: [...requests], netBytes: net.bytes, consoleLines, settled };
    // The Network domain makes DevTools keep copies of response bodies in the renderer (up to
    // ~190 MiB in fetch-heavy runs like npm and apt), which inflates every later RSS reading.
    // Only the boot counts above need it; keepNetwork leaves it on.
    if (!keepNetwork) await cdp.send('Network.disable').catch(() => {});
    return result;
  }

  /** Main page heap, total renderer memory (RSS incl. workers) and DOM counters. */
  async memory({ gc = true, uasm = true } = {}) {
    const page = this.page, cdp = this.cdp;
    if (gc) {
      await cdp.send('HeapProfiler.enable').catch(() => {});
      await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    }
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const out = { jsHeapUsed: m.JSHeapUsedSize, jsHeapTotal: m.JSHeapTotalSize, nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents };
    if (uasm && this.isolated) {
      out.uasm = await page.evaluate(async () => {
        if (!performance.measureUserAgentSpecificMemory) return null;
        const r = await performance.measureUserAgentSpecificMemory();
        const byType = {};
        for (const b of r.breakdown) for (const a of b.attribution.length ? b.attribution : [{ scope: 'unattributed' }]) {
          byType[a.scope] = (byType[a.scope] || 0) + b.bytes / Math.max(1, b.attribution.length || 1);
        }
        return { bytes: r.bytes, byScope: byType };
      }).catch(() => null);
    }
    out.rendererRss = await this.rendererRss();
    return out;
  }

  /** Resident memory of the renderer process(es) from /proc (Linux). */
  async rendererRss() {
    const pids = await this.rendererPids();
    let total = 0;
    for (const pid of pids) total += procRss(pid) || 0;
    return total || null;
  }

  async rendererPids() {
    try {
      const { processInfo } = await this.browserCdp.send('SystemInfo.getProcessInfo');
      return processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
    } catch { return []; }
  }

  /**
   * Run `fn` while sampling renderer RSS every 25 ms; returns
   * { result, peakRss, baseRss, peakDelta }.
   */
  /**
   * Bytes in the renderers' PartitionAlloc buffer partition (memory-infra dump). DevTools keeps
   * copies of response bodies there while Playwright's Network/Fetch sessions are attached, so
   * fetch-heavy steps (npm, apt) grow it without the page doing anything; it counts in RSS.
   */
  async bufferPartition() {
    try {
      const pids = await this.rendererPids();
      const s = await this.browser.newBrowserCDPSession();
      const events = [];
      s.on('Tracing.dataCollected', (e) => events.push(...e.value));
      const done = new Promise((r) => s.once('Tracing.tracingComplete', r));
      await s.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } } });
      await s.send('Tracing.requestMemoryDump', { deterministic: false, levelOfDetail: 'light' });
      await s.send('Tracing.end');
      await done;
      await s.detach().catch(() => {});
      let total = 0;
      for (const e of events) {
        const a = e.ph === 'v' && pids.includes(e.pid) ? e.args?.dumps?.allocators : null;
        const v = a?.['partition_alloc/partitions/buffer']?.attrs?.size?.value;
        if (v) total += parseInt(v, 16);
      }
      return total;
    } catch { return null; }
  }

  async withPeakRss(fn, { dynamic = false, buffer = false } = {}) {
    // buffer: also return the buffer partition's growth (see bufferPartition) and the peak net of it
    const buf0 = buffer ? await this.bufferPartition() : null;
    // dynamic: re-read the renderer list while sampling (a navigation can swap processes)
    let pids = await this.rendererPids();
    const read = () => pids.reduce((s, p) => s + (procRss(p) || 0), 0);
    const base = read();
    let peak = base, stop = false;
    const timer = setInterval(() => { const v = read(); if (v > peak) peak = v; }, 25);
    const refresh = dynamic ? (async () => { while (!stop) { pids = await this.rendererPids(); await new Promise((r) => setTimeout(r, 100)); } })() : null;
    try {
      const result = await fn();
      const v = read(); if (v > peak) peak = v;
      const out = { result, baseRss: base, peakRss: peak, peakDelta: peak - base };
      if (buffer) {
        const buf1 = await this.bufferPartition();
        if (buf0 != null && buf1 != null) { out.bufferGrowth = buf1 - buf0; out.peakDeltaNet = out.peakDelta - Math.max(0, out.bufferGrowth); }
      }
      return out;
    } finally { clearInterval(timer); stop = true; await refresh; }
  }


  /** In-page evaluate with a readable error. */
  eval(fn, arg) { return this.page.evaluate(fn, arg); }
  sh(cmd) { return this.page.evaluate((c) => window.__bench.sh(c), cmd); }

  /** Record one metric from raw samples. */
  sample(name, samples, unit, { notes = '', cache, extra } = {}) {
    const s = summarize(samples);
    const rec = {
      name, suite: this.suite ?? null, mode: this.mode, cache: cache ?? null, unit,
      median: round(s.median), p90: round(s.p90), min: round(s.min), max: round(s.max), n: s.n,
      samples: samples.map((x) => round(x)), notes,
      ...(extra ? { extra } : {}),
    };
    this.results.push(rec);
    this.log(`  ${name.padEnd(44)} ${String(rec.median).padStart(10)} ${unit.padEnd(6)} p90 ${rec.p90}${notes ? '  — ' + notes : ''}`);
    return rec;
  }

  /** A metric that failed or is unavailable in this mode. */
  skip(name, unit, reason) {
    this.results.push({ name, suite: this.suite ?? null, mode: this.mode, cache: null, unit, median: null, p90: null, n: 0, samples: [], notes: reason, error: true });
    this.log(`  ${name.padEnd(44)} ${'—'.padStart(10)} ${unit.padEnd(6)} ${reason}`);
  }

  /** A block that records several metrics (some named outside its group, like *.peak_rss.*) runs when the group or any of them is wanted. */
  wantsAny(group, ...names) { return !this.skipRe?.some((re) => re.test(group)) && (this.wants(group) || names.some((n) => this.wants(n))); }

  wants(name) { return (!this.only || this.only.some((re) => re.test(name))) && !this.skipRe?.some((re) => re.test(name)); }

  /** Run a measurement; record a skip if it throws. `force`: run even if --only/--skip leave it out (setup other metrics need). */
  async try(name, unit, fn, { force = false } = {}) {
    if (!force && !this.wants(name)) return;
    const t0 = Date.now();
    const prof = process.env.BENCH_PROFILE && new RegExp(process.env.BENCH_PROFILE).test(name) && this.cdp;
    if (prof) await startProfile(this.cdp);
    try { await fn(); if (process.env.BENCH_VERBOSE) this.log(`    (${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) {
      this.skip(name, unit, 'failed: ' + String(e?.message || e).split('\n')[0].slice(0, 200));
    } finally {
      if (prof) await stopProfile(this.cdp, `${this.mode}-${name}`, this.log).catch((e) => this.log(`      profile failed: ${e.message}`));
    }
  }
}

export function procRss(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+) kB/.exec(s);
    return m ? Number(m[1]) * 1024 : null;
  } catch { return null; }
}

export const MB = 1024 * 1024;
