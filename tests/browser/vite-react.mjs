// Vite's React template end to end in Chromium, from a fresh profile, typing
// into the real terminal: npm create vite, npm i, npm run dev, the preview
// renders the app, an edit to src/App.jsx reaches it by HMR (no reload).
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/vite-react.mjs [URL] [--shots DIR]
//
// Prints each step's time and the page's JS heap after each; exits 1 on a
// failure. External requests go through $HTTPS_PROXY when it is set.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const url = args[0] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const LIMIT = Number(process.env.STEP_LIMIT_MS || 600_000);
// VITE=7 for vite 7's template (esbuild and Rollup as their WebAssembly builds)
const VITE = process.env.VITE || 'latest';
// APP=astro: a minimal Astro 5 site instead (written here: create-astro fetches its
// template from codeload.github.com); its page edits reload rather than hot-update
const ASTRO = process.env.APP === 'astro';
const PORT = ASTRO ? 4321 : 5173;
if (shots) mkdirSync(shots, { recursive: true });

const bufferOf = (page) => page.evaluate(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const rows = [];
  for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
  return rows.join('\n');
});
const heapMB = (page) => page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576));

const times = [];
const record = async (page, name, t0) => {
  const ms = Date.now() - t0;
  times.push([name, ms, await heapMB(page)]);
  console.log(`  ok   ${(ms / 1000).toFixed(1).padStart(6)} s  ${String(times.at(-1)[2]).padStart(5)} MB  ${name}`);
};
/** Wait for `re` in the terminal buffer after `from` (a buffer length) */
async function waitBuffer(page, re, from, what) {
  const t0 = Date.now();
  for (;;) {
    const s = (await bufferOf(page)).slice(from);
    const m = re.exec(s);
    if (m) return m;
    if (Date.now() - t0 > LIMIT) throw new Error(`timed out waiting for ${what}:\n${s.split('\n').slice(-25).join('\n')}`);
    await page.waitForTimeout(250);
  }
}
let marks = 0;
/** Type `cmd` and wait for it to exit 0 */
async function step(page, cmd) {
  const mark = `@@step${++marks}`;
  const t0 = Date.now();
  const from = (await bufferOf(page)).length;
  await page.keyboard.type(`${cmd}; echo "${mark} $?"\r`, { delay: 2 });
  const m = await waitBuffer(page, new RegExp(`^${mark} (\\d+)$`, 'm'), from, cmd);
  if (m[1] !== '0') throw new Error(`exit ${m[1]}: ${cmd}\n${(await bufferOf(page)).slice(from).split('\n').slice(-25).join('\n')}`);
  await record(page, cmd, t0);
}
/** Run a command in a shell of its own (the terminal's is running vite) */
const side = (page, cmd) => page.evaluate(async (cmd) => {
  const sh = window.__tabcomputer.shell.fork(); sh.terminal = null;
  let out = '';
  const code = await sh.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { code, out };
}, cmd);
/** The preview of port 5173's frame, once it has loaded the app's page */
async function preview(page) {
  for (let i = 0; i < 300; i++) {
    for (const el of await page.$$(`iframe[data-virtual-port="${PORT}"]`)) {
      const f = await el.contentFrame();
      if (f && f.url() !== 'about:blank' && f.url() !== '') return f;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`no preview of :${PORT}`);
}

/** With MEM=1: resident memory of the browser's processes (Linux), by process type */
async function rss(when) {
  if (!process.env.MEM) return;
  const { execSync } = await import('node:child_process');
  const by = {};
  for (const line of execSync('ps -eo rss=,args=').toString().split('\n')) {
    const m = /^\s*(\d+)\s+(\S*chrom\S*)(.*)$/.exec(line);
    if (!m) continue;
    const type = /--type=(\S+)/.exec(m[3])?.[1] ?? 'browser';
    by[type] = (by[type] ?? 0) + Number(m[1]) / 1024;
  }
  console.log(`  RSS, ${when}:`, Object.entries(by).map(([k, v]) => `${k} ${Math.round(v)} MB`).join(', '));
}

const proxy = process.env.HTTPS_PROXY ? process.env.HTTPS_PROXY.replace(/^\w+:\/\//, '').replace(/\/$/, '') : '';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--enable-precise-memory-info', ...(proxy ? [`--proxy-server=${proxy}`] : [])] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: !!proxy });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const consoleErrors = [];
const responses = [];
page.on('response', (r) => { if (!/localhost:5299\/(assets|$)/.test(r.url())) responses.push(`${r.status()} ${r.headers()['content-type'] ?? ''} ${r.url().slice(0, 150)}`); });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
let failed = false;
const T = Date.now();
try {
  let t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.terminal?.term && window.__tabcomputer?.kernel, null, { timeout: 90_000 });
  for (let i = 0; i < 300 && !/\$ ?$/m.test(await bufferOf(page)); i++) await page.waitForTimeout(100);
  await record(page, 'boot to prompt', t0);
  await rss('booted');
  // Everything written to the terminal (vite clears the screen), for a failure report
  await page.evaluate(() => {
    const t = window.__tabcomputer.terminal.term, w = t.write.bind(t);
    window.__termLog = '';
    t.write = (d, cb) => { window.__termLog += typeof d === 'string' ? d : new TextDecoder().decode(d); return w(d, cb); };
  });
  await page.evaluate(() => window.__tabcomputer.terminal.term.focus());

  if (ASTRO) {
    t0 = Date.now();
    const made = await side(page, `mkdir -p ~/app/src/pages && cd ~/app && printf '%s' '{"name":"app","type":"module","scripts":{"dev":"astro dev","build":"astro build"},"dependencies":{"astro":"^5"}}' > package.json && printf 'import { defineConfig } from "astro/config";\\nexport default defineConfig({});\\n' > astro.config.mjs && printf -- '---\\nconst title = "Hello Astro";\\n---\\n<html><body><h1>{title}</h1><p>count is 0</p></body></html>\\n' > src/pages/index.astro`);
    if (made.code !== 0) throw new Error(made.out);
    await record(page, 'write a minimal Astro site', t0);
  } else {
    await step(page, `npm create vite@${VITE} app -- --template react --no-interactive`);
  }
  await step(page, 'cd app && npm i');
  await rss('installed');

  t0 = Date.now();
  const from = (await bufferOf(page)).length;
  await page.keyboard.type('npm run dev\r', { delay: 2 });
  await waitBuffer(page, ASTRO ? /Local\s+http:\/\/localhost:\d+/ : /ready in \d+ ms|Local:\s+http/, from, 'dev server ready');
  await record(page, 'npm run dev → ready', t0);
  await rss('dev up');
  if (process.env.HEAPSNAP) {
    // A heap snapshot with the dev server up (where the memory goes)
    const cdp = await page.context().newCDPSession(page);
    const chunks = [];
    cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => chunks.push(e.chunk));
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    (await import('node:fs')).writeFileSync(process.env.HEAPSNAP, chunks.join(''));
  }

  t0 = Date.now();
  const opened = await side(page, `serve open ${PORT}`);
  if (opened.code !== 0) throw new Error(`serve open ${PORT}: ${opened.out}`);
  let frame = await preview(page);
  await frame.waitForFunction(() => /count is \d/i.test(document.body?.innerText ?? ''), null, { timeout: LIMIT });
  frame = await preview(page);
  await record(page, 'preview renders the app', t0);
  await frame.evaluate(() => { window.__notReloaded = true; });

  // The edit, from a shell of its own (the terminal's is running vite)
  t0 = Date.now();
  if (ASTRO) {
    await side(page, "sed -i 's|Hello Astro|Edited live|' ~/app/src/pages/index.astro");
    for (let i = 0; ; i++) {
      frame = await preview(page);
      if (await frame.evaluate(() => /Edited live/.test(document.body?.innerText ?? '')).catch(() => false)) break;
      if (i > 240) throw new Error('the preview never showed the edit');
      await page.waitForTimeout(250);
    }
    await record(page, 'edit index.astro → preview updates', t0);
  } else {
    await side(page, "sed -i 's|<h1>[^<]*</h1>|<h1>Edited by HMR</h1>|' ~/app/src/App.jsx");
    await frame.waitForFunction(() => /Edited by HMR/.test(document.body?.innerText ?? ''), null, { timeout: 60_000 });
    if (!await frame.evaluate(() => window.__notReloaded === true)) throw new Error('the preview reloaded instead of hot-updating');
    await record(page, 'edit App.jsx → HMR update', t0);
  }

  t0 = Date.now();
  const built = await side(page, ASTRO ? 'cd ~/app && npm run build && cat dist/index.html' : 'cd ~/app && npm run build && ls dist/assets');
  if (built.code !== 0 || (ASTRO ? !/<h1>Edited live<\/h1>/.test(built.out) : !/\.css\b/.test(built.out) || !/\.js\b/.test(built.out))) throw new Error(`npm run build: ${built.out.slice(-1500)}`);
  await record(page, ASTRO ? 'npm run build (astro build)' : 'npm run build (vite build)', t0);
  await rss('after build');
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
} catch (e) {
  failed = true;
  console.log(`FAIL ${String(e.message).replace(/\n/g, '\n  ')}`);
  for (const f of page.frames()) {
    const text = await f.evaluate(() => document.body?.innerText.slice(0, 200) ?? '').catch((err) => `(${err.message})`);
    console.log(`  frame ${f.url()}: ${JSON.stringify(text)}`);
  }
  for (const m of consoleErrors.slice(-15)) console.log(`  console: ${m}`);
  if (process.env.VERBOSE) {
    const log = await page.evaluate(() => window.__termLog ?? '').catch(() => '');
    console.log('  terminal (last 3000 chars):\n' + log.slice(-3000).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
    for (const r of responses.slice(-40)) console.log(`  response: ${r}`);
    for (const f of page.frames()) if (f.url() === 'about:srcdoc') console.log((await f.content().catch(() => '')).slice(0, 2000));
  }
}
if (shots) await page.screenshot({ path: `${shots}/vite-react.png` }).catch(() => {});
console.log(`${failed ? 'FAIL' : 'ok  '} ${ASTRO ? 'astro@5 minimal site' : `vite@${VITE} react template`}  ${((Date.now() - T) / 1000).toFixed(0)} s`);
await browser.close();
process.exit(failed ? 1 : 0);
