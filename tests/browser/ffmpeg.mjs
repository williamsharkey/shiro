// The ffmpeg shim (ffmpeg.wasm) in Chromium against the built app: its
// worker and core load from the page's own origin (a cross-origin worker
// can't start, and COEP blocks a cross-origin core without CORP), lazily,
// the first time ffmpeg runs. Checks `ffmpeg -version` and a small transcode
// (a generated test clip to mp4, then to gif), typed into the terminal.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/ffmpeg.mjs [URL]
//
// Exits 1 on failure. Needs playwright (NODE_PATH=/opt/node-tools/node_modules
// in the cloud containers) and Chromium (CHROMIUM, default the pre-installed one).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const url = process.argv[2] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const proxy = /^https:/.test(url) && process.env.HTTPS_PROXY ? process.env.HTTPS_PROXY.replace(/^\w+:\/\//, '').replace(/\/$/, '') : '';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', ...(proxy ? [`--proxy-server=${proxy}`] : [])] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: !!proxy })).newPage();
const errors = [];
const foreign = [];
const origin = new URL(url).origin;
page.on('pageerror', (e) => errors.push(e.message));
const fetched = [];
page.on('request', (r) => {
  if (!/ffmpeg/i.test(r.url())) return;
  fetched.push(r.url());
  if (!r.url().startsWith(origin)) foreign.push(r.url());
});

const bufferOf = () => page.evaluate(() => {
  const t = window.__tabcomputer.terminal.term, b = t.buffer.active, rows = [];
  for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
  return rows.join('\n');
});
let n = 0;
async function step(cmd, expect, limit = 300_000) {
  const mark = `@@ff${++n}`;
  const t0 = Date.now();
  await page.evaluate(() => window.__tabcomputer.terminal.term.focus());
  await page.keyboard.type(`${cmd}; echo "${mark} $?"\r`, { delay: 2 });
  for (;;) {
    const s = await bufferOf();
    const m = new RegExp(`^${mark} (\\d+)$`, 'm').exec(s);
    if (m) {
      const out = s.slice(0, m.index).split(`echo "${mark} $?"`).pop();
      const ok = m[1] === '0' && expect.test(out);
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${cmd}`);
      if (!ok) throw new Error(`exit ${m[1]}:\n${out.trim().split('\n').slice(-20).join('\n')}`);
      return out;
    }
    if (Date.now() - t0 > limit) throw new Error(`timed out: ${cmd}\n${s.split('\n').slice(-20).join('\n')}`);
    await page.waitForTimeout(250);
  }
}

let failed = false;
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.terminal?.term, null, { timeout: 90_000 });
  for (let i = 0; i < 300 && !/\$ ?$/m.test(await bufferOf()); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  // The core (~31 MB) is fetched when ffmpeg first runs, not at boot
  if (fetched.some((u) => /\.wasm/.test(u))) throw new Error(`ffmpeg's core loaded at boot: ${fetched.join(', ')}`);
  await step('ffmpeg -version', /^ffmpeg version \S+/m);
  await step('ffmpeg -y -f lavfi -i testsrc=duration=1:size=64x48:rate=5 -pix_fmt yuv420p /tmp/clip.mp4', /Output: \/tmp\/clip\.mp4 \(\d/);
  await step('ffmpeg -y -i /tmp/clip.mp4 -vf scale=32:-1 /tmp/clip.gif && ls -l /tmp/clip.gif && head -c 6 /tmp/clip.gif; echo', /GIF89a/);
  if (foreign.length) throw new Error(`cross-origin ffmpeg requests: ${foreign.join(', ')}`);
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('ok   ffmpeg');
} catch (e) {
  failed = true;
  console.log(`FAIL ffmpeg\n  ${String(e.message).replace(/\n/g, '\n  ')}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
