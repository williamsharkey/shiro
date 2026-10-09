// Run shell commands in Shiro inside headless Chromium (the built app,
// cross-origin isolated), printing each command's output and timing.
//   npm run build && PORT=5299 node server.mjs &
//   node scripts/browser-check.mjs http://localhost:5299/ 'pkg install python3' 'python3 -c "print(1)"'
// Needs playwright (NODE_PATH=/opt/node-tools/node_modules in the cloud
// containers) and Chromium (CHROMIUM, default /opt/pw-browsers/chromium).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

// --upload LOCAL_DIR=TABCOMPUTER_DIR copies a local tree into Shiro's filesystem first
const argv = process.argv.slice(2);
const uploads = [];
for (let i = argv.indexOf('--upload'); i >= 0; i = argv.indexOf('--upload')) { uploads.push(argv[i + 1].split('=')); argv.splice(i, 2); }
const [url = 'http://localhost:5299/', ...cmds] = argv;
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// Containers that reach the internet through a proxy: the browser uses it too
// (https only: plain-http requests to the local server go direct)
const proxy = process.env.HTTPS_PROXY ? process.env.HTTPS_PROXY.replace(/^\w+:\/\//, '').replace(/\/$/, '') : '';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', ...(proxy ? [`--proxy-server=https=${proxy}`] : [])] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: !!proxy })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
if (process.env.SHOW_CONSOLE) page.on('console', (m) => console.log('[console]', m.text().slice(0, 400)));
await page.goto(url);
await page.waitForFunction(() => window.__tabcomputer && window.__tabcomputer.shell, null, { timeout: 90000 });
console.log('crossOriginIsolated =', await page.evaluate(() => crossOriginIsolated));
const { readdirSync, readFileSync, statSync } = await import('node:fs');
for (const [local, remote] of uploads) {
  const files = [];
  const walk = (d, r) => { for (const n of readdirSync(d)) { const p = `${d}/${n}`; if (statSync(p).isDirectory()) walk(p, `${r}/${n}`); else files.push([`${r}/${n}`, readFileSync(p).toString('base64'), statSync(p).mode]); } };
  walk(local, remote);
  for (let i = 0; i < files.length; i += 200) {
    await page.evaluate(async (batch) => {
      for (const [path, b64, mode] of batch) {
        await window.__tabcomputer.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true }).catch(() => {});
        await window.__tabcomputer.fs.writeFile(path, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { mode: mode & 0o777 });
      }
    }, files.slice(i, i + 200));
  }
  console.log(`uploaded ${files.length} files to ${remote}`);
}
let failed = 0;
for (const cmd of cmds) {
  const r = await page.evaluate(async (cmd) => {
    let out = '';
    const t0 = performance.now();
    // A terminal-less fork (kept across commands), so kernel jobs' output is captured, not drawn on the tty
    const sh = window.__checkShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
    const code = await sh.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
    return { code, out, ms: Math.round(performance.now() - t0) };
  }, cmd);
  if (r.code !== 0) failed++;
  console.log(`=== ${cmd}  exit=${r.code}  ${r.ms}ms\n${r.out.replace(/\r\n/g, '\n').trimEnd()}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
