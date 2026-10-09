// Terminal fidelity for full-screen programs in the real app: TERM and
// terminfo, resize (SIGWINCH and a redraw), mouse reporting (SGR 1006),
// bracketed paste, 256-color/truecolor, the alternate screen and Unicode
// width, with vim, htop, less, nano, tmux and screen (Blink) on the desktop
// terminal's pty.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/tui.mjs [URL] [--only NAME] [--shots DIR]
//
// Prints one line per case with its time; exits 1 if any case fails.
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
const LIMIT = Number(process.env.TUI_LIMIT_MS || 60_000);
if (shots) mkdirSync(shots, { recursive: true });

const screenOf = (page) => page.evaluate(() => {
  const t = window.__shiro?.terminal?.term;
  if (!t) return '';
  const b = t.buffer.active;
  const rows = [];
  for (let y = 0; y < t.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
  return rows.join('\n');
});
const termInfo = (page) => page.evaluate(() => {
  const t = window.__shiro.terminal.term;
  const pty = window.__shiro.terminal.tty.pty;
  return { rows: t.rows, cols: t.cols, buffer: t.buffer.active.type, cursorX: t.buffer.active.cursorX, cursorY: t.buffer.active.cursorY, pty: { ...pty.winsize }, modes: { ...t.modes } };
});

async function until(page, cond, what, ms = LIMIT) {
  const t0 = Date.now();
  for (;;) {
    const s = await screenOf(page);
    if (await cond(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}:\n${s.replace(/\s+$/gm, '').replace(/\n{3,}/g, '\n\n')}`);
    await page.waitForTimeout(100);
  }
}

const snap = (page, name) => shots ? page.screenshot({ path: `${shots}/${name}.png` }).catch(() => {}) : null;
const typeKeys = async (page, s) => { for (const ch of s) await page.keyboard.type(ch, { delay: 15 }); };
const promptBack = (s) => /\$\s*$/.test(s.trimEnd());
const run = async (page, cmd) => { await typeKeys(page, cmd); await page.keyboard.press('Enter'); };
/** Run a shell command and wait for its output to match */
const sh = async (page, cmd, re, what) => { await run(page, cmd); return until(page, (s) => re.test(s) && promptBack(s), what ?? cmd); };
const vimUp = (s) => (s.match(/^~\s*$/gm) ?? []).length > 3;
/** vim: leave whatever mode, run an ex command, wait for `re` on the screen */
const vimEx = async (page, cmd, re, what) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await typeKeys(page, `:${cmd}\r`);
  return until(page, (s) => re.test(s), what ?? `:${cmd}`);
};
const vimQuit = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await typeKeys(page, ':qa!\r');
  await until(page, (s) => promptBack(s) && !vimUp(s), 'the prompt after :qa!');
};
/** Pixel position of cell (col, row), 0-based, in the page */
const cellXY = (page, col, row) => page.evaluate(([c, r]) => {
  const t = window.__shiro.terminal.term;
  const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
  // (the screen element can be wider than cols × cell width)
  const cell = t._core._renderService.dimensions.css.cell;
  return [screen.left + (c + 0.5) * cell.width, screen.top + (r + 0.5) * cell.height];
}, [col, row]);
/** Resize the terminal: its desktop window's client area (the classic UI: the page) */
const resizeTo = async (page, width, height) => {
  const desk = await page.evaluate(([w, h]) => {
    const d = window.__shiro.desktop;
    const el = window.__shiro.terminal.term.element;
    const win = d?.windows().find((x) => x.body.contains(el));
    if (!win) return false;
    win.resize(w, h);
    return true;
  }, [width, height]);
  if (!desk) await page.setViewportSize({ width, height });
  await page.waitForTimeout(500);
  return termInfo(page);
};

const CASES = [
  { name: 'TERM and terminfo', run: async (page) => {
    await sh(page, 'echo "term=$TERM"', /term=xterm-256color/);
    await run(page, 'vim -u NONE');
    await until(page, vimUp, 'vim');
    await vimEx(page, 'echo &term "co=" &t_Co', /xterm-256color co= 256/, 'vim: term and 256 colors from terminfo');
    await vimQuit(page);
    await run(page, 'tput colors; tput cols; tput lines');
    const i = await termInfo(page);
    await until(page, (s) => new RegExp(`^256\\n${i.cols}\\n${i.rows}$`, 'm').test(s) && promptBack(s), 'tput colors/cols/lines');
  } },
  { name: 'resize: SIGWINCH and redraw (vim, htop, less)', run: async (page) => {
    const a = await termInfo(page);
    await run(page, 'vim -u NONE');
    await until(page, vimUp, 'vim');
    await vimEx(page, 'echo &columns &lines', new RegExp(`^${a.cols} ${a.rows}\\s*$`, 'm'), 'vim size');
    const b = await resizeTo(page, 600, 360);
    if (b.cols === a.cols || b.pty.cols !== b.cols || b.pty.rows !== b.rows) throw new Error(`resize didn't reach the pty: ${JSON.stringify({ a, b })}`);
    await vimEx(page, 'echo &columns &lines', new RegExp(`^${b.cols} ${b.rows}\\s*$`, 'm'), 'vim size after resize');
    await snap(page, 'resize-vim');
    await vimQuit(page);
    await run(page, 'htop');
    await until(page, (s) => /F1Help/.test(s), 'htop');
    const c = await resizeTo(page, 900, 560);
    // htop redraws its function bar on the new bottom row
    await until(page, (s) => /F10Quit/.test(s.split('\n')[c.rows - 1] ?? ''), 'htop redrawn at the new size');
    await page.keyboard.press('q');
    await until(page, promptBack, 'the prompt after htop');
    await run(page, 'seq 1 300 | less');
    await until(page, (s) => /^1$/m.test(s), 'less');
    const d = await resizeTo(page, 700, 300);
    await until(page, (s) => s.split('\n')[d.rows - 1]?.startsWith(':') && new RegExp(`^${d.rows - 1}$`, 'm').test(s), 'less redrawn with the new height');
    await page.keyboard.press('q');
    await until(page, promptBack, 'the prompt after less');
  } },
  { name: 'alternate screen: vim and less restore the shell screen', run: async (page) => {
    await sh(page, 'echo marker-before-vim', /^marker-before-vim$/m);
    await run(page, 'vim -u NONE');
    await until(page, vimUp, 'vim');
    if ((await termInfo(page)).buffer !== 'alternate') throw new Error('vim is not on the alternate screen');
    await vimQuit(page);
    const s = await screenOf(page);
    if (!/^marker-before-vim$/m.test(s)) throw new Error(`the shell screen wasn't restored:\n${s}`);
    if ((await termInfo(page)).buffer !== 'normal') throw new Error('still on the alternate screen after vim');
  } },
  { name: 'mouse: vim (SGR 1006) clicks move the cursor', run: async (page) => {
    await run(page, 'seq 1 40 > /tmp/m.txt; vim -u NONE /tmp/m.txt');
    await until(page, (s) => /^1$/m.test(s), 'vim with the file');
    await vimEx(page, 'set mouse=a ttymouse=sgr', /ttymouse=sgr/);
    const [x, y] = await cellXY(page, 0, 9); // row 10
    await page.evaluate(() => { const p = window.__shiro.terminal.tty.pty; window.__in = []; const i = p.input.bind(p); p.input = (t) => { window.__in.push(typeof t === 'string' ? t : String.fromCharCode(...t)); return i(t); }; });
    await page.mouse.click(x, y);
    await page.waitForTimeout(300);
    await vimEx(page, 'echo "line=" . line(".")', /line=10/, 'vim cursor on line 10 after a click')
      .catch(async (e) => { throw new Error(`pty input ${JSON.stringify(await page.evaluate(() => window.__in))} modes ${JSON.stringify((await termInfo(page)).modes)}\n${e.message}`); });
    await vimQuit(page);
  } },
  // htop's ncurses asks for SGR (1006) natively but only X10 (1000) under
  // Blink, and then doesn't parse the X10 reports (they read as Esc [ M ...)
  { name: 'mouse: htop clicks on a column header sort by it', run: async (page) => {
    await run(page, 'htop');
    await until(page, (s) => /F10Quit/.test(s), 'htop');
    // Click the PID column header: htop sorts by it (the ▽/△ marker moves there)
    const lines = (await screenOf(page)).split('\n');
    const hy = lines.findIndex((l) => /PID USER/.test(l));
    const col = lines[hy].indexOf('PID');
    const [hx, hyPx] = await cellXY(page, col + 1, hy);
    await page.mouse.click(hx, hyPx);
    await until(page, (s) => {
      const h = s.split('\n').find((l) => /PID.*USER/.test(l)) ?? '';
      const m = h.search(/[▽△]/);
      return m >= 0 && m < h.indexOf('USER');
    }, 'htop sorted by PID after a click on its header');
    await page.keyboard.press('q');
    await until(page, (s) => promptBack(s) && !/F10Quit/.test(s), 'the prompt after htop');
  } },
  { name: 'bracketed paste: vim gets the text literally (no autoindent cascade)', run: async (page) => {
    await run(page, 'vim -u NONE -c "set autoindent nocompatible" /tmp/p.txt');
    await until(page, vimUp, 'vim');
    await typeKeys(page, 'i');
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__shiro.terminal.term.paste('    a\n    b\n    c\n'));
    await page.waitForTimeout(500);
    await vimEx(page, 'w', /written/);
    await vimQuit(page);
    await sh(page, 'cat -A /tmp/p.txt', /\$\s*$/);
    const s = await screenOf(page);
    if (!/^ {4}a\$\n {4}b\$\n {4}c\$$/m.test(s)) throw new Error(`pasted text was changed:\n${s}`);
  } },
  { name: 'colors: 256 and truecolor reach the terminal', run: async (page) => {
    await sh(page, "printf '\\033[38;5;196mR256\\033[0m \\033[38;2;10;200;30mTRUE\\033[0m\\n'", /R256 TRUE/);
    const cells = await page.evaluate(() => {
      const t = window.__shiro.terminal.term;
      const b = t.buffer.active;
      for (let y = b.length - 1; y >= 0; y--) {
        const line = b.getLine(y);
        const text = line?.translateToString(true) ?? '';
        const i = text.indexOf('R256 TRUE');
        if (i < 0 || text.includes('printf')) continue;
        const c1 = line.getCell(i), c2 = line.getCell(i + 5);
        return { p: [c1.isFgPalette(), c1.getFgColor()], rgb: [c2.isFgRGB(), c2.getFgColor()] };
      }
      return null;
    });
    if (!cells || !cells.p[0] || cells.p[1] !== 196 || !cells.rgb[0] || cells.rgb[1] !== ((10 << 16) | (200 << 8) | 30)) throw new Error(`colors: ${JSON.stringify(cells)}`);
  } },
  { name: 'Unicode width: CJK and emoji take two cells (shell and vim)', run: async (page) => {
    await run(page, "printf '漢字😀|\\n'");
    await until(page, (s) => /^漢字😀\|$/m.test(s) && promptBack(s), 'the line');
    const w = await page.evaluate(() => {
      const t = window.__shiro.terminal.term;
      const b = t.buffer.active;
      for (let y = b.length - 1; y >= 0; y--) {
        const line = b.getLine(y);
        const text = line?.translateToString(true) ?? '';
        if (text.startsWith('漢字') && !text.includes('printf')) {
          for (let x = 0; x < t.cols; x++) if (line.getCell(x)?.getChars() === '|') return x;
        }
      }
      return -1;
    });
    if (w !== 6) throw new Error(`"|" at column ${w}, expected 6`);
    await run(page, "printf '漢字😀|\\n' > /tmp/u.txt; vim -u NONE /tmp/u.txt");
    await until(page, (s) => /^漢字😀\|/m.test(s), 'vim with the file');
    await typeKeys(page, '$');
    await vimEx(page, 'echo virtcol(".") strdisplaywidth(getline(1))', /^7 7\s*$/m, "vim's widths");
    await vimQuit(page);
  } },
  { name: 'nano: open, type, save, quit', run: async (page) => {
    await run(page, 'nano /tmp/n.txt');
    await until(page, (s) => /\^X Exit/.test(s), 'nano');
    await typeKeys(page, 'nano text');
    await page.keyboard.press('Control+o');
    await until(page, (s) => /File Name to Write|Write to File/.test(s), 'the save prompt');
    await page.keyboard.press('Enter');
    await until(page, (s) => /Wrote 1 line/.test(s), 'saved');
    await page.keyboard.press('Control+x');
    await until(page, promptBack, 'the prompt after nano');
    await sh(page, 'cat /tmp/n.txt', /^nano text$/m);
  } },
  { name: 'tmux: split, resize, exit', run: async (page) => {
    await run(page, 'tmux');
    await until(page, (s) => /\[0\]/.test(s) && promptBack(s.split('\n').slice(0, -1).join('\n')), 'tmux status line');
    await page.keyboard.press('Control+b');
    await typeKeys(page, '%');
    await until(page, (s) => /│/.test(s), 'a vertical split');
    const i = await resizeTo(page, 900, 500);
    await run(page, 'tput cols');
    // Two panes and a border share the (settled) width (tmux spreads a resize unevenly)
    let lastTmux;
    await until(page, async (s) => {
      const w = Number(/│(\d+)\s*$/m.exec(s)?.[1]);
      const { cols } = await termInfo(page);
      lastTmux = { w, cols, pty: (await termInfo(page)).pty };
      const left = s.split('\n').find((l) => l.includes('│'))?.indexOf('│') ?? -1;
      return w > 0 && left > 0 && left + 1 + w === cols;
    }, 'the panes filling the new width').catch((e) => { throw new Error(`${JSON.stringify(lastTmux)} ${e.message}`); });
    await run(page, 'exit');
    await page.waitForTimeout(500);
    await run(page, 'exit');
    await until(page, (s) => /exited/.test(s) && promptBack(s), 'back at the page prompt');
  } },
  { name: 'screen: the window shell sees the size, follows a resize', setup: 'screen', run: async (page) => {
    await run(page, 'screen -q');
    await until(page, (s) => promptBack(s) && !/screen -q\s*$/m.test(s), "the window's prompt");
    const a = await termInfo(page);
    await run(page, 'clear; stty size; tput cols');
    await until(page, (s) => new RegExp(`^${a.rows} ${a.cols}\\n${a.cols}$`, 'm').test(s) && promptBack(s), 'stty size and tput cols in the window');
    const b = await resizeTo(page, 700, 400);
    await run(page, 'clear; stty size');
    await until(page, (s) => new RegExp(`^${b.rows} ${b.cols}$`, 'm').test(s) && promptBack(s), 'the new size in the window');
    await run(page, 'exit');
    await until(page, (s) => /screen is terminating/.test(s) && promptBack(s), 'back at the page prompt');
  } },
  { name: 'man: a page through the pager, q back to the prompt', setup: 'mandoc', run: async (page) => {
    await run(page, 'man mandoc');
    await until(page, (s) => /MANDOC\(1\)/.test(s) && /NAME/.test(s), 'the mandoc(1) page');
    await page.keyboard.press('q');
    await until(page, promptBack, 'the prompt after man');
  } },
];

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
for (const c of CASES) {
  if (only && !c.name.includes(only)) continue;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await page.goto(url);
    await until(page, (s) => promptBack(s), 'the first prompt');
    await run(page, `pkg install vim htop less nano tmux${c.setup ? ' ' + c.setup : ''} && clear`);
    await until(page, (s) => promptBack(s) && !/pkg install/.test(s), 'packages installed', 300_000);
    await c.run(page);
    console.log(`ok   ${c.name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    await snap(page, `${c.name.replace(/\W+/g, '-')}-failed`);
    console.log(`FAIL ${c.name} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n${String(e.message ?? e).split('\n').map((l) => '     ' + l).join('\n')}`);
  }
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
