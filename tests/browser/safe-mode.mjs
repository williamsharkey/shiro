// Safe mode (src/safe-mode.ts) gets a machine whose saved state freezes the
// page booting again. Needs a build and a running server:
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/safe-mode.mjs [http://localhost:5299/]
// 1. A ~/.profile that spins the page forever (js-eval) and saved windows.
// 2. A normal load freezes: no prompt.
// 3. ?safe=1 boots the terminal with the banner, without running ~/.profile;
//    `safe-mode disable-profile` and `reset-layout` fix it.
// 4. A normal load works again.
// 5. Loads that never reach the prompt put the tab in safe mode by themselves.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const base = process.argv[2] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const context = await browser.newContext();
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const url = (q) => new URL(q, base).toString();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Is the first prompt up within `ms`? Polled from here: in a frozen page nothing of Playwright's runs, timeouts included. */
async function promptUp(page, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await Promise.race([
      page.evaluate(() => !!window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished')).catch(() => false),
      wait(2000).then(() => false),
    ]);
    if (r) return true;
    await wait(250);
  }
  return false;
}
/** Boot `q` in a fresh page; the page, or null if the first prompt isn't up within `ms`. */
async function boot(q, ms = 60000) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  console.log(`  loading ${q}`);
  await page.goto(url(q), { timeout: ms, waitUntil: 'commit' }).catch((e) => console.log(`  goto: ${e.message.split('\n')[0]}`));
  const up = await promptUp(page, ms);
  if (up) return page;
  // A frozen renderer never answers page.close(): close its tab from the browser side
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const t of targetInfos) if (t.type === 'page') await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
  await cdp.detach().catch(() => {});
  return null;
}
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const s = window.__checkShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  return { code, out: out.replace(/\r\n/g, '\n') };
}, cmd);
const screen = (page) => page.evaluate(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n');
});

// 1. A machine that freezes at boot
let page = await boot('/?ui=terminal');
check(!!page, 'first boot reaches the prompt');
await page.evaluate(async () => {
  await window.__tabcomputer.fs.writeFile('/home/user/.profile', "echo profile-ran > /tmp/profile-ran\njs-eval 'for (;;) {}'\n");
  localStorage.setItem('tabcomputer-desktop-session', JSON.stringify({ v: 1, windows: [{ id: 'w1', app: 'terminal', g: { x: 0, y: 0, width: 400, height: 300 }, state: 'normal' }] }));
  await window.__tabcomputer.fs.sync();
});
await page.close();

// 2. Now a normal load never gets to the prompt
const t0 = Date.now();
check(!(await boot('/?ui=terminal', 20000)), `a normal load freezes (no prompt after ${Math.round((Date.now() - t0) / 1000)} s)`);

// 3. Safe mode
page = await boot('/?safe=1');
check(!!page, 'safe mode reaches the prompt');
const text = await screen(page);
check(text.includes('Safe mode') && text.includes('safe-mode exit'), 'the banner says safe mode is on and how to leave it');
check((await sh(page, 'test -e /tmp/profile-ran')).code !== 0, '~/.profile did not run');
check(await page.evaluate(() => window.__tabcomputer.uiMode) === 'terminal', 'the terminal UI, not the desktop');
const st = await sh(page, 'safe-mode');
check(st.out.includes('Safe mode is on: asked for'), `safe-mode: ${st.out.split('\n')[0]}`);
check((await sh(page, 'console --prev -g Starting')).out.includes('[tabcomputer] Starting'), "console --prev shows the earlier session's log");
check((await sh(page, 'safe-mode disable-profile')).out.includes('Renamed ~/.profile to ~/.profile.disabled'), 'disable-profile renames ~/.profile');
check((await sh(page, 'safe-mode reset-layout')).out.includes('tabcomputer-desktop-session'), 'reset-layout clears the saved windows');
check((await sh(page, 'cat ~/.profile.disabled')).out.includes("js-eval"), 'the old ~/.profile is kept');
await page.evaluate(() => window.__tabcomputer.fs.sync());
await page.close();

// 4. Fixed: a normal load works again
page = await boot('/?ui=terminal');
check(!!page, 'after the fix a normal load reaches the prompt');

// 5. Two loads of the tab that never reached the prompt: safe mode by itself
if (page) {
  await page.evaluate(() => sessionStorage.setItem('tabcomputer-boots-unfinished', '2'));
  await page.reload();
  const up = await promptUp(page, 60000);
  check(up && (await screen(page)).includes('never reached the prompt'), 'unfinished loads put the tab in safe mode by themselves');
  await page.reload();
  await promptUp(page, 60000);
  check(!(await screen(page)).includes('Safe mode'), 'and the load after that is normal again');
}

await browser.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
