// Previews of in-tab servers on the desktop (docs/DESKTOP.md "Previews"), in Chromium:
//   serve open    a Preview window (beside the Terminal) renders the served page
//   stop/restart  the window says the server stopped, and reloads when it's back
//   listening     a node server that starts by itself gets an "Open Preview" offer, not a
//                 window; the offer opens one, and goes away when the server does
// tests/browser/vite-react.mjs covers a Vite + React app with HMR in the same window.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/previews.mjs [URL] [--shots DIR]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch {
  try { pw = require('/opt/node-tools/node_modules/playwright'); } catch { pw = require('playwright-core'); }
}
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const url = args[0] || 'http://localhost:5299/';
if (shots) mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
await page.goto(url);
await page.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 60_000 });
await page.waitForTimeout(1000);
const side = (cmd, wait = true) => page.evaluate(async ([cmd, wait]) => {
  const s = window.__tabcomputer.shell.fork(); s.terminal = null; let o = '';
  const p = s.execute(cmd, x => { o += x; }, x => { o += x; });
  if (!wait) return { code: 0, o: '' };
  return { code: await p, o };
}, [cmd, wait]);
const frameText = async (port) => {
  const el = await page.$(`.sd-preview iframe[data-virtual-port="${port}"]`);
  const f = await el?.contentFrame();
  return f ? f.evaluate(() => document.body?.innerText ?? '').catch(() => '') : '';
};
const until = async (fn, ms = 15_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await page.waitForTimeout(200); } };

// serve open
await side(`mkdir -p /tmp/site && printf '<h1>Static site</h1>' > /tmp/site/index.html && serve /tmp/site 8080`);
const opened = await side('serve open 8080');
check('serve open', opened.code === 0, opened.o.trim().replace(/\s+/g, ' '));
check('preview renders the page', !!await until(async () => /Static site/.test(await frameText(8080))), await frameText(8080));
const layout = await page.evaluate(() => window.__shiroDesktop.visibleOrder().map(w => `${w.appId}:${w.state}`).join(' '));
check('beside the Terminal', /preview:snapped-right/.test(layout) && /terminal:snapped-left/.test(layout), layout);
check('in the dock while open', !!await page.$('.sd-dock-item[data-app=preview].sd-running'));
if (shots) await page.screenshot({ path: join(shots, 'preview-window.png') });

// stop / restart
await side('serve stop 8080');
check('marked stopped', !!await until(() => page.$('.sd-preview-stopped')), await page.evaluate(() => window.__shiroDesktop.visibleOrder().find(w => w.appId === 'preview')?.title));
if (shots) await (await page.$('.sd-win.sd-focused, .sd-win')).screenshot({ path: join(shots, 'preview-stopped.png') });
await side('serve /tmp/site 8080');
check('reloads when it is back', !!await until(async () => !(await page.$('.sd-preview-stopped')) && /Static site/.test(await frameText(8080))));

// a node server that starts by itself: an offer
await side(`node -e "require('http').createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<h1>Node says hi</h1>'); }).listen(3000)"`, false);
const toast = await until(() => page.$('.sd-preview-toast'));
check('listening: an offer, not a window', !!toast && !(await page.$('.sd-preview iframe[data-virtual-port="3000"]')), toast ? await toast.innerText() : 'no offer');
if (shots && toast) await toast.screenshot({ path: join(shots, 'preview-offer.png') });
await page.click('.sd-preview-toast [data-act=open]');
check('the offer opens a preview', !!await until(async () => /Node says hi/.test(await frameText(3000))));
check('the offer is gone', !(await page.$('.sd-preview-toast')));

await browser.close();
const failed = results.filter(x => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
