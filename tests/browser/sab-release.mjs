// Does Chromium give back a big SharedArrayBuffer (or shared WebAssembly
// memory) once the worker using it is terminated and the page drops it?
// Rolldown's 112 MB shared memory stayed after `vite build`; this shows the
// browser frees it (renderer RSS falls by ~110 MB within a second), so what
// held it was a reference in tabcomputer's code.
//
//   node tests/browser/sab-release.mjs [sab|mem]
import { chromium } from 'playwright-core';
import http from 'node:http';
import { execSync } from 'node:child_process';

const kind = process.argv[2] || 'sab';
const PAGE = `<!doctype html><meta charset=utf-8><body><script>
const src = 'onmessage = (e) => { const v = new Uint8Array(e.data); for (let i = 0; i < v.length; i += 4096) v[i] = 1; postMessage(0); };';
const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
let w = null, sab = null, mem = null;
window.step = async (kind) => {
  if (kind === 'sab') sab = new SharedArrayBuffer(112 << 20);
  else { mem = new WebAssembly.Memory({ initial: 1792, maximum: 16384, shared: true }); sab = mem.buffer; }
  w = new Worker(url);
  await new Promise((r) => { w.onmessage = r; w.postMessage(sab); });
};
window.drop = () => { w.terminate(); w = null; sab = null; mem = null; };
</script>`;

const srv = http.createServer((q, s) => {
  s.writeHead(200, { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
  s.end(PAGE);
}).listen(0);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--js-flags=--expose-gc'] });
const page = await browser.newPage();
await page.goto(`http://localhost:${srv.address().port}/`);
const cdp = await page.context().newCDPSession(page);
const rss = () => {
  let t = 0;
  for (const l of execSync('ps -eo rss=,args=').toString().split('\n')) {
    const m = /^\s*(\d+)\s+\S*chrom\S*.*--type=renderer/.exec(l);
    if (m) t += Number(m[1]);
  }
  return Math.round(t / 1024);
};
const gc = async () => { await page.evaluate(() => globalThis.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); };

console.log(kind, 'renderer at start', rss(), 'MB');
await page.evaluate((k) => window.step(k), kind);
console.log(kind, 'a worker touched 112 MB of it', rss(), 'MB');
await page.evaluate(() => window.drop());
for (const t of [1, 5, 20]) {
  await new Promise((r) => setTimeout(r, t * 1000));
  await gc();
  console.log(kind, `terminated and dropped, +${t} s`, rss(), 'MB');
}
await browser.close();
srv.close();
