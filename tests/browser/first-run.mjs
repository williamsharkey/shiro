// First impression of the desktop (the Unix edition, tabcomputer.com): from a
// fresh browser profile, every suggestion in the welcome banner and every
// package app in the dock must work on the first try. Each case gets its own
// fresh profile, clicks the real link or dock icon, and waits on the
// rendered terminal.
//
// The terminal UI (shiro.computer, `?ui=terminal`, `?profile=shiro`; the
// shiro profile, docs/PROFILES.md) has no dock or welcome links: there the
// cases click the HUD's `help` link and type the same programs at the prompt.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/first-run.mjs [URL] [--only NAME] [--shots DIR]
//
// Prints one line per case with its time; exits 1 if any case fails.
// Needs playwright (NODE_PATH=/opt/node-tools/node_modules in the cloud
// containers) and Chromium (CHROMIUM, default the pre-installed one).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const only = opt('--only');
const shots = opt('--shots');
const url = args[0] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LIMIT = Number(process.env.FIRST_RUN_LIMIT_MS || 60_000); // per case
if (shots) mkdirSync(shots, { recursive: true });

/** The focused window's active terminal, as text rows. */
const screenOf = (page) => page.evaluate(() => {
  const wm = window.__tabcomputer.desktop;
  const view = wm?.focused()?.content;
  const terms = view?.terminals?.() ?? [window.__tabcomputer.terminal];
  const t = (view?.activeTerminal?.() ?? terms[terms.length - 1]).term;
  const b = t.buffer.active;
  const rows = [];
  for (let y = 0; y < t.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
  return rows.join('\n');
});

async function until(page, cond, what, ms = LIMIT) {
  const t0 = Date.now();
  for (;;) {
    const s = await screenOf(page);
    if (cond(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}:\n${s.replace(/\s+$/gm, '').replace(/\n{3,}/g, '\n\n')}`);
    await page.waitForTimeout(100);
  }
}

/** Click the banner link whose text is `text` (an OSC 8 link in the main terminal). */
async function clickBannerLink(page, text) {
  const box = await page.evaluate((text) => {
    const t = window.__tabcomputer.terminal.term;
    const b = t.buffer.active;
    for (let y = 0; y < t.rows; y++) {
      const line = b.getLine(b.viewportY + y)?.translateToString(true) ?? '';
      const re = new RegExp(`(^|[ ·:])${text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}( |$)`);
      const m = re.exec(line);
      if (!m) continue;
      const x = m.index + m[1].length;
      const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      const cw = screen.width / t.cols, ch = screen.height / t.rows;
      return { x: screen.left + (x + text.length / 2) * cw, y: screen.top + (y + 0.5) * ch };
    }
    return null;
  }, text);
  if (!box) throw new Error(`no banner link "${text}"`);
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(150); // xterm finds the link on hover
  await page.mouse.click(box.x, box.y);
}

async function clickDock(page, name) {
  const items = page.locator('.sd-dock-item');
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const tip = await items.nth(i).locator('.sd-dock-tip').textContent();
    if (tip?.startsWith(name)) { await items.nth(i).click(); return; }
  }
  throw new Error(`no dock item "${name}"`);
}

/** --shots: a picture of the program while it runs */
const snap = (page, name) => shots ? page.screenshot({ path: `${shots}/${name}.png` }).catch(() => {}) : null;
const typeKeys = async (page, s) => { for (const ch of s) await page.keyboard.type(ch, { delay: 20 }); };
const promptBack = (s) => /\$\s*$/.test(s.trimEnd());

/** Type a command at the main terminal's prompt. */
async function typeCommand(page, cmd) {
  await page.evaluate(() => window.__tabcomputer.terminal.term.focus());
  await typeKeys(page, cmd + '\r');
}

const TERMINAL_CASES = [
  { name: 'terminal: help link', run: async (page) => {
    await clickBannerLink(page, 'help');
    await until(page, (s) => s.split('\n').filter(Boolean).length > 8 && promptBack(s), 'the help text');
  } },
  { name: 'terminal: apt install cowsay', run: async (page) => {
    await typeCommand(page, 'apt install cowsay && cowsay hello from shiro');
    await until(page, (s) => s.includes('< hello from') && promptBack(s), 'cowsay\'s speech bubble');
  } },
  { name: 'terminal: htop', run: async (page) => {
    await typeCommand(page, 'apt install htop && htop');
    await until(page, (s) => /Load average/.test(s) && /F10Quit/.test(s), 'htop\'s meters');
    await snap(page, 'terminal-htop-running');
    await page.keyboard.press('q');
    await until(page, (s) => !s.includes('F10Quit') && promptBack(s), 'the prompt after q');
  } },
  { name: 'terminal: python3', run: async (page) => {
    await typeCommand(page, 'python3');
    await until(page, (s) => /^>>> ?$/m.test(s), 'the Python prompt');
    await typeKeys(page, 'print(6*7)\r');
    await until(page, (s) => /^42$/m.test(s), 'print(6*7)');
    await typeKeys(page, 'exit()\r');
    await until(page, (s) => promptBack(s), 'the shell prompt after exit()');
  } },
  { name: 'terminal: ls /dom', run: async (page) => {
    await typeCommand(page, 'ls /dom');
    await until(page, (s) => /ls \/dom\n[^\n]*\S/.test(s) && promptBack(s), 'a listing of /dom');
    const s = await screenOf(page);
    if (/No such file|cannot access|not found/i.test(s)) throw new Error(`ls /dom failed:\n${s}`);
  } },
];

const DESKTOP_CASES = [
  { name: 'apt install cowsay', run: async (page) => {
    await clickBannerLink(page, 'apt install cowsay');
    await until(page, (s) => s.includes('< hello from') && promptBack(s), 'cowsay\'s speech bubble');
  } },
  { name: 'htop', run: async (page) => {
    await clickBannerLink(page, 'htop');
    await until(page, (s) => /Load average/.test(s) && /F10Quit/.test(s), 'htop\'s meters');
    await snap(page, 'htop-running');
    await page.keyboard.press('q');
    await until(page, (s) => !s.includes('F10Quit') && promptBack(s), 'the prompt after q');
  } },
  { name: 'python3', run: async (page) => {
    await clickBannerLink(page, 'python3');
    await until(page, (s) => /^>>> ?$/m.test(s), 'the Python prompt');
    await typeKeys(page, 'print(6*7)\r');
    await until(page, (s) => /^42$/m.test(s), 'print(6*7)');
    await typeKeys(page, 'exit()\r');
    await until(page, (s) => promptBack(s), 'the shell prompt after exit()');
  } },
  { name: 'ls /dom', run: async (page) => {
    await clickBannerLink(page, 'ls /dom');
    await until(page, (s) => /ls \/dom\n[^\n]*\S/.test(s) && promptBack(s), 'a listing of /dom');
    const s = await screenOf(page);
    if (/No such file|cannot access|not found/i.test(s)) throw new Error(`ls /dom failed:\n${s}`);
  } },
  { name: 'help', run: async (page) => {
    await clickBannerLink(page, 'help');
    await until(page, (s) => s.split('\n').filter(Boolean).length > 8 && promptBack(s), 'the help text');
  } },
  { name: 'dock: Vim', run: async (page) => {
    await clickDock(page, 'Vim');
    await until(page, (s) => (s.match(/^~\s*$/gm) ?? []).length > 5, 'vim\'s empty buffer');
    await typeKeys(page, 'ihello vim');
    await page.keyboard.press('Escape');
    await until(page, (s) => s.includes('hello vim'), 'typed text');
    await snap(page, 'vim-running');
    await typeKeys(page, ':q!\r');
  } },
  { name: 'dock: htop', run: async (page) => {
    await clickDock(page, 'htop');
    await until(page, (s) => /Load average/.test(s) && /F10Quit/.test(s), 'htop');
    await snap(page, 'dock-htop-running');
    await page.keyboard.press('q');
    await until(page, (s) => !s.includes('F10Quit') && promptBack(s), 'the prompt after q');
  } },
  { name: 'resize: htop follows a zoomed window', run: async (page) => {
    await clickDock(page, 'htop');
    await until(page, (s) => /F10Quit/.test(s), 'htop');
    const cols = () => page.evaluate(() => window.__tabcomputer.desktop.focused().content.terminals().at(-1).term.cols);
    const before = await cols();
    await page.locator('.sd-zoom').last().click(); // the green light of the focused window
    await page.waitForFunction((n) => window.__tabcomputer.desktop.focused().content.terminals().at(-1).term.cols > n, before, { timeout: 10_000 });
    const after = await cols();
    // htop redraws at the new width: its CPU meter spans it
    await until(page, (s) => s.split('\n').some((l) => /CPU\[/.test(l) && l.length > before + 5), `htop redrawn at ${after} columns (was ${before})`);
    await snap(page, 'htop-zoomed');
    await page.keyboard.press('q');
    await until(page, (s) => promptBack(s), 'the prompt after q');
  } },
  { name: 'dock: Python', run: async (page) => {
    await clickDock(page, 'Python');
    await until(page, (s) => /^>>> ?$/m.test(s), 'the Python prompt');
    await typeKeys(page, 'import sys; print(sys.version_info[0])\r');
    await until(page, (s) => /^3$/m.test(s), 'the Python version');
    await snap(page, 'python-running');
  } },
];

const target = new URL(url);
const terminalUi = target.searchParams.get('ui') === 'terminal'
  || (target.searchParams.get('profile') === 'shiro' && target.searchParams.get('ui') !== 'desktop')
  || /(^|\.)shiro\.computer$/.test(target.hostname) && target.searchParams.get('ui') !== 'desktop';
const CASES = terminalUi ? TERMINAL_CASES : DESKTOP_CASES;

// Containers that reach the internet through a proxy (the live site): the browser uses it too
const proxy = /^https:/.test(url) && process.env.HTTPS_PROXY ? process.env.HTTPS_PROXY.replace(/^\w+:\/\//, '').replace(/\/$/, '') : '';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', ...(proxy ? [`--proxy-server=${proxy}`] : [])] });
let failed = 0;
for (const c of CASES) {
  if (only && !c.name.includes(only)) continue;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: !!proxy }); // a fresh profile
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  try {
    await page.goto(url);
    if (terminalUi) {
      await page.waitForFunction(() => window.__tabcomputer?.terminal?.term && window.__tabcomputer.uiMode === 'terminal', null, { timeout: 60_000 });
      await until(page, (s) => /help/.test(s) && promptBack(s), 'the HUD and prompt', 30_000);
    } else {
      await page.waitForFunction(() => window.__tabcomputer?.terminal?.term && window.__tabcomputer.desktop, null, { timeout: 60_000 });
      await until(page, (s) => s.includes('try:') && promptBack(s), 'the welcome banner and prompt', 30_000);
    }
    // The desktop switches the terminal to its own font when it has loaded (cells change size)
    await page.waitForFunction(() => /JetBrains/.test(window.__tabcomputer.terminal.term.options.fontFamily ?? ''), null, { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const t1 = Date.now();
    await c.run(page);
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    console.log(`ok   ${c.name}  ${Date.now() - t1} ms (boot ${t1 - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}  ${Date.now() - t0} ms\n  ${String(e.message).replace(/\n/g, '\n  ')}`);
  }
  if (shots) await page.screenshot({ path: `${shots}/${c.name.replace(/\W+/g, '-')}.png` }).catch(() => {});
  await context.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
