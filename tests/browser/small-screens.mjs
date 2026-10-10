// Phones and tablets (docs/DESKTOP.md "Small screens"), in Chromium with device emulation:
//   no scroll    the page never scrolls sideways; the menu bar, dock, windows, menus, stacks
//                and notifications stay inside the viewport
//   windows      phones (also on their side) maximize every window; tablets get normal
//                windows that fit the work area, and a Preview beside the Terminal
//   keyboard     with the on-screen keyboard up (a shorter viewport) the Terminal and its
//                prompt stay above it
//   welcome      the first-run welcome fits a phone as a bottom sheet
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/small-screens.mjs [URL] [--shots DIR]
//
// Exits 1 if any check fails.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch {
  try { pw = require('/opt/node-tools/node_modules/playwright'); } catch { pw = require('playwright-core'); }
}
const { chromium, devices } = pw;
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const url = args[0] || 'http://localhost:5299/';
if (shots) mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const SIZES = [
  { name: 'phone', phone: true, ...devices['iPhone 13'] },
  { name: 'phone-landscape', phone: true, ...devices['iPhone 13 landscape'] },
  { name: 'w600', phone: true, viewport: { width: 600, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'ipad-mini', phone: false, ...devices['iPad Mini'] },
  { name: 'ipad-landscape', phone: false, ...devices['iPad (gen 7) landscape'] },
];

/** What's outside the viewport, and the page's sideways scroll */
const overflow = () => {
  const W = innerWidth, H = innerHeight, out = [];
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (sw > W) out.push(`scrollWidth ${sw} > ${W}`);
  if (scrollX) out.push(`scrollX ${scrollX}`);
  for (const sel of ['.sd-menubar', '.sd-dock', '.sd-win', '.sd-toast', '.sd-menu', '.sd-stack', '.sd-welcome']) {
    for (const e of document.querySelectorAll(sel)) {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      if (!r.width || cs.display === 'none' || cs.visibility === 'hidden' || e.closest('[data-state=minimized]')) continue;
      if (r.left < -1 || r.right > W + 1 || r.top < -1 || r.bottom > H + 1) out.push(`${sel}${e.dataset.app ? `[${e.dataset.app}]` : ''} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }
  return out;
};
const states = () => [...document.querySelectorAll('.sd-win')].map(w => `${w.dataset.app}:${w.dataset.state}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
for (const { name, phone, defaultBrowserType, ...device } of SIZES) {
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(name, 'pageerror', e.message));
  // Welcome dismissed, until the last step asks for it (sessionStorage survives the reload)
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('show-welcome')) localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 60_000 });
  await page.waitForTimeout(1000);
  const vp = page.viewportSize();
  const fits = async (what) => { const o = await page.evaluate(overflow); check(`${name} ${vp.width}×${vp.height}: ${what} fits`, !o.length, o.join(' | ')); };
  await fits('boot');

  for (const app of ['files', 'settings', 'apps']) {
    await page.evaluate((a) => window.__shiroDesktop.openApp(a), app);
    await page.waitForTimeout(500);
  }
  await fits('Files, Settings, Apps');
  const st = await page.evaluate(states);
  check(`${name}: windows ${phone ? 'maximized' : 'normal'}`, st.every(s => phone ? s.endsWith(':maximized') : !s.endsWith(':maximized')), st.join(' '));

  // A menu and a dock stack
  await page.click('.sd-menubar .sd-brand, .sd-menubar [data-menu]').catch(() => {});
  await page.waitForTimeout(300);
  await fits('a menu');
  await page.keyboard.press('Escape');
  const stack = await page.$('.sd-stack-tile');
  if (stack) { await stack.click(); await page.waitForTimeout(300); await fits('a dock stack'); await page.keyboard.press('Escape'); await page.mouse.click(vp.width / 2, 60); }

  // A Preview
  await page.evaluate(async () => {
    const s = window.__tabcomputer.shell.fork(); s.cwd = '/home/user';
    await s.execute('mkdir -p /tmp/site && printf "<h1>Small</h1>" > /tmp/site/index.html', () => {}, () => {});
    void window.__tabcomputer.shell.fork().execute('serve /tmp/site 8080', () => {}, () => {});
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__tabcomputer.shell.fork().execute('serve open 8080', () => {}, () => {}));
  await page.waitForSelector('.sd-preview iframe', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await fits('a Preview');
  const pv = await page.evaluate(() => document.querySelector('.sd-win[data-app=preview]')?.dataset.state);
  check(`${name}: Preview ${phone ? 'maximized' : 'beside the Terminal'}`, phone ? pv === 'maximized' : pv === 'snapped-right', pv);
  if (shots) await page.screenshot({ path: join(shots, `small-${name}-preview.png`) });

  // The on-screen keyboard: on phones the visible viewport shrinks; the Terminal follows
  if (name === 'phone') {
    await page.evaluate(() => window.__shiroDesktop.openApp('terminal', { newWindow: true }));
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.55) });
    await page.waitForTimeout(800);
    await fits('the Terminal with the keyboard up');
    const t = await page.evaluate(() => {
      const w = window.__shiroDesktop.focused();
      const cur = w.element.querySelector('.xterm-helper-textarea, .xterm-cursor-layer, .xterm-screen');
      const r = w.element.getBoundingClientRect();
      const term = w.content.activeTerminal().term;
      return { bottom: Math.round(r.bottom), H: innerHeight, rows: term.rows, cols: term.cols, app: w.appId, cur: !!cur };
    });
    check('phone: Terminal above the keyboard', t.app === 'terminal' && t.bottom <= t.H && t.rows >= 5 && t.cols >= 30, JSON.stringify(t));
    if (shots) await page.screenshot({ path: join(shots, 'small-phone-keyboard.png') });
    await page.setViewportSize(vp);
    await page.waitForTimeout(500);
  }

  // The welcome, as on a first visit
  await page.evaluate(() => { localStorage.removeItem('tabcomputer-desktop-welcome'); sessionStorage.setItem('show-welcome', '1'); });
  await page.reload();
  await page.waitForSelector('.sd-welcome', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await fits('the welcome');
  const demos = await page.$$eval('.sd-welcome-demo', els => els.length);
  const clear = await page.evaluate(() => {
    const w = document.querySelector('.sd-welcome')?.getBoundingClientRect();
    const k = document.querySelector('.sd-keybar');
    const kr = k && k.getBoundingClientRect().height ? k.getBoundingClientRect() : null;
    return { bottom: Math.round(w?.bottom ?? 0), keybar: kr ? Math.round(kr.top) : null };
  });
  check(`${name}: welcome above the key bar`, clear.keybar === null || clear.bottom <= clear.keybar, JSON.stringify(clear));
  check(`${name}: welcome demos`, demos === 6, String(demos));
  if (shots) await page.screenshot({ path: join(shots, `small-${name}-welcome.png`) });
  await ctx.close();
}
await browser.close();
const failed = results.filter(x => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
