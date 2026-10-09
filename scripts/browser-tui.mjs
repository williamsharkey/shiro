// Drive full-screen programs on Shiro's real terminal (xterm.js on the pty)
// in headless Chromium: keystrokes go through xterm's textarea like a user's,
// and waits read the rendered screen buffer.
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node scripts/browser-tui.mjs http://localhost:5299/ 'run:pkg install vim' \
//     'type:vim x.txt\r' 'wait:x.txt' 'type:ihello\x1b:wq\r' 'wait:$ ' 'shot:/tmp/vim.png'
// Steps:
//   run:CMD     type CMD + Enter at the prompt and wait for the next prompt
//   type:TEXT   keystrokes; JS escapes (\r \x1b \x02 ...) are understood
//   wait:TEXT   until TEXT is on the screen (WAIT_MS, default 60 s)
//   gone:TEXT   until TEXT is no longer on the screen
//   shot:FILE   PNG screenshot of the page
//   screen      print the screen
//   sleep:MS
// SHOW_CONSOLE=1 prints the page's console (TABCOMPUTER_BLINK_DEBUG=1 traces go there).
// Needs playwright (NODE_PATH=/opt/node-tools/node_modules in the cloud
// containers) and Chromium (CHROMIUM, default /opt/pw-browsers/chromium).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const [url = 'http://localhost:5299/', ...steps] = process.argv.slice(2);
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const waitMs = Number(process.env.WAIT_MS || 60_000);
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
if (process.env.SHOW_CONSOLE) page.on('console', (m) => console.log('[console]', m.text().slice(0, 400)));
await page.goto(url);
await page.waitForFunction(() => window.__tabcomputer?.terminal?.term, null, { timeout: 90_000 });
console.log('crossOriginIsolated =', await page.evaluate(() => crossOriginIsolated));

const screen = () => page.evaluate(() => {
  const t = window.__tabcomputer.terminal.term;
  const b = t.buffer.active;
  const rows = [];
  for (let y = 0; y < t.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
  return rows.join('\n');
});
const until = async (cond, what) => {
  const t0 = Date.now();
  while (!cond(await screen())) {
    if (Date.now() - t0 > waitMs) throw new Error(`timed out waiting for ${what}\n${await screen()}`);
    await page.waitForTimeout(100);
  }
};
const unescape = (s) => JSON.parse('"' + s.replace(/"/g, '\\"').replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1') + '"');
const typeKeys = async (text) => {
  await page.evaluate(() => window.__tabcomputer.terminal.term.focus());
  // printable runs as text input, control characters as their keys
  for (const part of text.match(/[\x20-\x7e]+|[^\x20-\x7e]/g) ?? []) {
    const c = part.charCodeAt(0);
    if (part.length > 1 || c >= 0x20) await page.keyboard.type(part, { delay: 15 });
    else if (c === 0x0d) await page.keyboard.press('Enter');
    else if (c === 0x1b) await page.keyboard.press('Escape');
    else if (c === 0x09) await page.keyboard.press('Tab');
    else if (c === 0x7f || c === 0x08) await page.keyboard.press('Backspace');
    else await page.keyboard.press(`Control+${String.fromCharCode(c + 0x60)}`);
  }
};

// Lines that end in the prompt ("...$")
const promptCount = (s) => (s.match(/\$ ?$/gm) ?? []).length;
await until((s) => promptCount(s) > 0, 'the shell prompt');
try {
  for (const step of steps) {
    const i = step.indexOf(':');
    const [op, arg] = i < 0 ? [step, ''] : [step.slice(0, i), step.slice(i + 1)];
    const t0 = Date.now();
    if (op === 'run') {
      await page.evaluate(() => window.__tabcomputer.terminal.term.clear());
      await typeKeys(arg + '\r');
      // the line holding the command no longer ends in "$": a later one does
      // (whitespace ignored: a long command line wraps)
      const bare = (t) => t.replace(/\s+/g, '');
      await until((s) => bare(s).includes(bare(arg)) && promptCount(s) > 0, `the prompt after ${arg}`);
    } else if (op === 'type') await typeKeys(unescape(arg));
    else if (op === 'wait') await until((s) => s.includes(unescape(arg)), JSON.stringify(arg));
    else if (op === 'gone') await until((s) => !s.includes(unescape(arg)), `${JSON.stringify(arg)} to go`);
    else if (op === 'shot') await page.screenshot({ path: arg });
    else if (op === 'screen') console.log((await screen()).replace(/\s+$/gm, ''));
    else if (op === 'sleep') await page.waitForTimeout(Number(arg));
    else throw new Error(`unknown step ${step}`);
    console.log(`ok ${step}  ${Date.now() - t0}ms`);
  }
} catch (e) {
  console.log('FAILED:', e.message);
  await page.screenshot({ path: process.env.FAIL_SHOT || '/tmp/browser-tui-fail.png' });
  await browser.close();
  process.exit(1);
}
await browser.close();
