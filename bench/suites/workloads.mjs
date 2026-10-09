// Real workloads, the cheap ones (in --quick and full runs): desktop boot to
// its reveal mark, ffmpeg's first run (loads the ~31 MB core) and a warm run,
// and the npm Claude Code CLI's `--version`, first and warm. Every sample is a
// fresh browser context (empty HTTP cache and IndexedDB), so "first" means a
// new visitor's first use; external downloads come from bench/.cache/net.
// The slow ones (Debian, apt, python3, git clone, native Claude) are in
// workloads-slow.mjs.
import { MB } from '../lib/harness.mjs';

export const name = 'workloads';
// Each sample opens its own fresh context; the runner's settled work page isn't used
export const ownPages = true;

async function run1(h, cmd, check, limitMs = 300000) {
  const r = await h.withPeakRss(() => h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [`${cmd} > /tmp/wl.out 2>&1`, limitMs]));
  const out = (await h.sh('cat /tmp/wl.out')).out;
  if (r.result.code !== 0 || (check && !check.test(out))) throw new Error(`${cmd}: exit ${r.result.code}: ${out.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`);
  return { ms: r.result.ms, peak: r.peakDelta / MB };
}

export async function run(h) {
  if (!h.isolated) { h.skip('workload.suite', '', 'measured in the isolated (production) configuration only'); return; }
  const n = h.quick ? 3 : h.runs;
  const reveal = [], revealWarm = [], bootPeak = [], rssAt = [], heapAt = [];
  const ff = { first: [], firstPeak: [], warm: [], warmPeak: [] };
  const cl = { first: [], firstPeak: [], warm: [], warmPeak: [] };
  // The work page the runner opened isn't needed: each sample is its own visitor
  await h.page?.context().close().catch(() => {});
  for (let i = 0; i < n; i++) {
    const context = await h.newContext();
    try {
      const page = await context.newPage();
      await page.goto('about:blank');
      const b = await h.withPeakRss(() => h.boot({ context, page, path: '/?ui=desktop' }), { dynamic: true });
      const mark = await page.evaluate(() => performance.getEntriesByName('shiro:desktop:revealed')[0]?.startTime ?? null);
      if (mark == null) throw new Error('no shiro:desktop:revealed mark (did the desktop boot?)');
      reveal.push(mark);
      bootPeak.push(b.peakRss / MB);
      const m = await h.memory({ uasm: false });
      rssAt.push(m.rendererRss / MB);
      heapAt.push(m.jsHeapUsed / MB);

      if (h.wants('workload.ffmpeg')) {
        const f = await run1(h, 'ffmpeg -version', /ffmpeg version/);
        ff.first.push(f.ms); ff.firstPeak.push(f.peak);
        for (let j = 0; j < 2; j++) { const w = await run1(h, 'ffmpeg -version', /ffmpeg version/); ff.warm.push(w.ms); ff.warmPeak.push(w.peak); }
      }
      if (h.wants('workload.claude_npm')) {
        const c = await run1(h, 'claude --npm --version', /\d+\.\d+\.\d+ \(Claude Code\)/);
        cl.first.push(c.ms); cl.firstPeak.push(c.peak);
        for (let j = 0; j < 2; j++) { const w = await run1(h, 'claude --npm --version', /Claude Code/); cl.warm.push(w.ms); cl.warmPeak.push(w.peak); }
      }
      // Warm visit: reload the same context (HTTP cache and IndexedDB kept)
      await h.boot({ context, page, path: '/?ui=desktop' });
      revealWarm.push(await page.evaluate(() => performance.getEntriesByName('shiro:desktop:revealed')[0]?.startTime ?? NaN));
    } finally {
      await context.close().catch(() => {});
      h.page = null;
    }
  }
  h.sample('workload.desktop.reveal', reveal, 'ms', { notes: 'navigation → `shiro:desktop:revealed` (the desktop\'s one visible frame), fresh profile, `/?ui=desktop`' });
  h.sample('workload.desktop.reveal_warm', revealWarm, 'ms', { cache: 'warm', notes: 'same, reloading a visited profile' });
  h.sample('workload.desktop.peak_rss', bootPeak, 'MiB', { notes: 'renderer RSS peak from navigation to the first prompt (absolute, not a delta)' });
  h.sample('workload.desktop.rss', rssAt, 'MiB', { notes: 'renderer RSS once the desktop is up' });
  h.sample('workload.desktop.js_heap', heapAt, 'MiB', { notes: 'main-thread JS heap after GC once the desktop is up' });
  if (ff.first.length) {
    h.sample('workload.ffmpeg.first', ff.first, 'ms', { notes: '`ffmpeg -version`, first run of the page: loads ffmpeg.wasm\'s core (~31 MB, from the app origin)' });
    h.sample('workload.ffmpeg.warm', ff.warm, 'ms', { notes: 'the next two `ffmpeg -version` runs' });
    h.sample('workload.peak_rss.ffmpeg_first', ff.firstPeak, 'MiB', { notes: 'renderer RSS peak above the pre-run level, first run' });
    h.sample('workload.peak_rss.ffmpeg_warm', ff.warmPeak, 'MiB', { notes: 'same, warm runs' });
  }
  if (cl.first.length) {
    h.sample('workload.claude_npm.first', cl.first, 'ms', { notes: '`claude --npm --version`, first run of a fresh profile (npm tarball from the bench cache, install + load of cli.js)' });
    h.sample('workload.claude_npm.warm', cl.warm, 'ms', { notes: 'the next two runs (installed, module load only)' });
    h.sample('workload.peak_rss.claude_npm_first', cl.firstPeak, 'MiB', { notes: 'renderer RSS peak above the pre-run level, first run' });
    h.sample('workload.peak_rss.claude_npm_warm', cl.warmPeak, 'MiB', { notes: 'same, warm runs' });
  }
}
