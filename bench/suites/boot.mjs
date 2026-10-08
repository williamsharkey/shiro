// Boot: time to first prompt / interactive, memory after boot, IndexedDB
// size, requests. Cold = fresh browser context (empty HTTP cache and
// IndexedDB); warm = reload of a context that already booted and settled.
import { MB } from '../lib/harness.mjs';

export const name = 'boot';

async function bootOnce(h, opts) {
  const b = await h.boot(opts);
  const res = await b.page.evaluate(() => window.__bench.resources());
  return { ...b, res, requestCount: b.requests.length };
}

function netNow(h) {
  return { requests: h.requests.length, bytes: h.net.bytes };
}

function recordBoot(h, cache, runs) {
  const pick = (f) => runs.map(f);
  h.sample(`boot.${cache}.first_prompt`, pick((r) => r.marks.firstPrompt), 'ms', { cache, notes: 'navigation start → "$ " on the terminal' });
  h.sample(`boot.${cache}.tti`, pick((r) => r.tti), 'ms', { cache, notes: 'first prompt, then 1 s without a long task' });
  h.sample(`boot.${cache}.first_command`, pick((r) => r.firstCmd), 'ms', { cache, notes: '`true` right after boot (lazy loads land here)' });
  h.sample(`boot.${cache}.long_tasks`, pick((r) => r.marks.longTasks), 'count', { cache, notes: 'long tasks (>50 ms) until TTI' });
  h.sample(`boot.${cache}.requests`, pick((r) => r.requestCount), 'count', { cache, notes: 'requests until TTI' });
  h.sample(`boot.${cache}.transfer`, pick((r) => r.netBytes / 1024), 'KiB', { cache, notes: 'bytes over the network until TTI (CDP encodedDataLength)' });
  h.sample(`boot.${cache}.decoded`, pick((r) => r.res.decodedBytes / 1024), 'KiB', { cache, notes: 'decoded body bytes until TTI (resource timing)' });
}

export async function run(h) {
  const n = h.quick ? 3 : h.runs;
  // Cold boots: memory right after TTI too
  const cold = [];
  const mem = [];
  for (let i = 0; i < n; i++) {
    const r = await bootOnce(h, {});
    cold.push(r);
    mem.push(await h.memory());
    await r.context.close();
  }
  recordBoot(h, 'cold', cold);
  h.sample('boot.mem.js_heap', mem.map((m) => m.jsHeapUsed / MB), 'MiB', { notes: 'main-thread JS heap after GC, at TTI (cold)' });
  h.sample('boot.mem.renderer_rss', mem.map((m) => m.rendererRss / MB), 'MiB', { notes: 'renderer process RSS (page + workers), at TTI' });
  if (h.isolated) h.sample('boot.mem.uasm', mem.map((m) => m.uasm?.bytes / MB), 'MiB', { notes: 'performance.measureUserAgentSpecificMemory at TTI' });
  h.sample('boot.mem.dom_nodes', mem.map((m) => m.nodes), 'count', { notes: 'DOM nodes at TTI' });

  // Settle: the background Claude Code install (starts 3 s after boot) finishes
  const settledRuns = h.quick ? 1 : Math.min(n, 3);
  const settled = [];
  let warmCtx = null;
  for (let i = 0; i < settledRuns; i++) {
    const r = await bootOnce(h, { waitSettled: true });
    const m = await h.memory();
    const idb = await r.page.evaluate(async () => (await navigator.storage.estimate()).usage);
    const nn = netNow(h);
    settled.push({ ms: r.settled.ms, m, idb, claude: r.settled.claude, requests: nn.requests, bytes: nn.bytes });
    if (i === settledRuns - 1) warmCtx = r.context; else await r.context.close();
  }
  const note = settled[0].claude.includes('ready') ? 'Claude Code background install done' : `background install: ${settled[0].claude.slice(0, 80)}`;
  h.sample('boot.settled.time', settled.map((s) => s.ms), 'ms', { notes: note });
  h.sample('boot.settled.js_heap', settled.map((s) => s.m.jsHeapUsed / MB), 'MiB', { notes: 'after GC, once the background install finished' });
  h.sample('boot.settled.renderer_rss', settled.map((s) => s.m.rendererRss / MB), 'MiB', { notes: 'renderer RSS after the background install' });
  if (h.isolated) h.sample('boot.settled.uasm', settled.map((s) => s.m.uasm?.bytes / MB), 'MiB', { notes: 'measureUserAgentSpecificMemory after settle' });
  h.sample('boot.settled.idb', settled.map((s) => s.idb / MB), 'MiB', { notes: 'navigator.storage.estimate().usage (IndexedDB + cache)' });
  h.sample('boot.settled.requests', settled.map((s) => s.requests), 'count', { notes: 'requests incl. the background install' });
  h.sample('boot.settled.transfer', settled.map((s) => s.bytes / MB), 'MiB', { notes: 'bytes fetched incl. the background install' });

  // Warm: reload the settled context
  const warm = [];
  for (let i = 0; i < n; i++) warm.push(await bootOnce(h, { context: warmCtx, page: h.page }));
  recordBoot(h, 'warm', warm);
  const wm = await h.memory();
  h.sample('boot.warm.js_heap', [wm.jsHeapUsed / MB], 'MiB', { cache: 'warm', notes: 'one sample, after the last warm reload' });
  await warmCtx.close();
}
