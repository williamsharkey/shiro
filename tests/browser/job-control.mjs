// Job control in the real app: full-screen kernel programs (vim, htop under
// Blink) stopped with Ctrl-Z, listed by `jobs`, resumed with `fg` (redrawing),
// sent to the background with `bg`, and `wait` / `kill %N` on them.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/job-control.mjs [URL] [--only NAME] [--shots DIR]
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
const LIMIT = Number(process.env.JOB_LIMIT_MS || 90_000);
if (shots) mkdirSync(shots, { recursive: true });

const screenOf = (page) => page.evaluate(() => {
  const t = window.__shiro?.terminal?.term;
  if (!t) return '';
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

const snap = (page, name) => shots ? page.screenshot({ path: `${shots}/${name}.png` }).catch(() => {}) : null;
const typeKeys = async (page, s) => { for (const ch of s) await page.keyboard.type(ch, { delay: 15 }); };
const promptBack = (s) => /\$\s*$/.test(s.trimEnd());
/** Type a command at the prompt and press Enter */
const run = async (page, cmd) => { await typeKeys(page, cmd); await page.keyboard.press('Enter'); };
/** The last `n` non-empty lines */
const tail = (s, n) => s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
const vimBuffer = (s) => (s.match(/^~\s*$/gm) ?? []).length > 5;
const htopUp = (s) => /Load average/.test(s) && /F10Quit/.test(s);

const CASES = [
  { name: 'vim: Ctrl-Z, jobs, fg', run: async (page) => {
    await run(page, 'vim /tmp/jc.txt');
    await until(page, vimBuffer, "vim's empty buffer");
    await typeKeys(page, 'ihello');
    await page.keyboard.press('Escape');
    await until(page, (s) => s.includes('hello'), 'typed text');
    await page.keyboard.press('Control+z');
    await until(page, (s) => /Stopped/.test(tail(s, 3)) && promptBack(s), 'the prompt after Ctrl-Z');
    await snap(page, 'vim-stopped');
    // The prompt starts its own line (the Stopped line ends with CR LF)
    if (!/^user@\S+\$\s*$/m.test(await screenOf(page))) throw new Error('the prompt after "Stopped" does not start at column 0');
    await run(page, 'wait %1; echo "wait $?"');
    await until(page, (s) => /^wait 148$/m.test(s) && promptBack(s), 'wait on a stopped job returning 148');
    await run(page, 'jobs');
    await until(page, (s) => /\[1\]\+\s+Stopped\s+vim \/tmp\/jc.txt/.test(s) && promptBack(s), 'jobs listing vim as Stopped');
    await run(page, 'fg');
    await until(page, (s) => vimBuffer(s) && s.includes('hello'), 'vim redrawn with its text after fg');
    await snap(page, 'vim-fg');
    await typeKeys(page, ':wq\r');
    await until(page, (s) => promptBack(s) && !vimBuffer(s), 'the prompt after :wq');
    await run(page, 'cat /tmp/jc.txt; jobs; echo jobs-done');
    await until(page, (s) => /^hello$/m.test(s) && /jobs-done/.test(s) && !/Stopped/.test(tail(s, 3)), 'the file written and no jobs left');
  } },
  { name: 'htop: Ctrl-Z, bg is stopped again by the tty, fg, q', run: async (page) => {
    await run(page, 'htop');
    await until(page, htopUp, "htop's meters");
    await page.keyboard.press('Control+z');
    await until(page, (s) => /Stopped/.test(tail(s, 3)) && promptBack(s), 'the prompt after Ctrl-Z');
    await run(page, 'jobs -l');
    await until(page, (s) => /\[1\]\+\s+\d+\s+Stopped\s+htop/.test(s) && promptBack(s), 'jobs -l with a pid');
    await run(page, 'bg %1');
    await until(page, (s) => /\[1\]\+ htop &/.test(s) && promptBack(s), 'bg resuming it');
    await page.waitForTimeout(500);
    await run(page, 'jobs');
    await until(page, (s) => /\[1\]\+\s+Stopped.*htop/.test(tail(s, 2)) && promptBack(s), 'the tty stopping it again (SIGTTIN/SIGTTOU)');
    await run(page, 'fg %1');
    await until(page, htopUp, 'htop redrawn after fg');
    await snap(page, 'htop-fg');
    await page.keyboard.press('q');
    await until(page, (s) => !s.includes('F10Quit') && promptBack(s), 'the prompt after q');
  } },
  { name: 'two stopped jobs: fg %2, kill %1, wait', run: async (page) => {
    await run(page, 'vim /tmp/a.txt');
    await until(page, vimBuffer, 'first vim');
    await page.keyboard.press('Control+z');
    await until(page, (s) => /Stopped/.test(tail(s, 3)) && promptBack(s), 'first stop');
    await run(page, 'htop');
    await until(page, htopUp, 'htop');
    await page.keyboard.press('Control+z');
    await until(page, (s) => /\[2\]\+\s+Stopped/.test(tail(s, 3)) && promptBack(s), 'second stop as job 2');
    await run(page, 'fg %2');
    await until(page, htopUp, 'htop back with fg %2');
    await page.keyboard.press('q');
    await until(page, (s) => !s.includes('F10Quit') && promptBack(s), 'the prompt after htop quits');
    await run(page, 'kill %1; wait %1; echo "status $?"');
    await until(page, (s) => /status (1\d\d)/.test(s) && promptBack(s), 'vim killed (a stopped job still takes SIGTERM)');
  } },
  { name: 'kernel sh in a screen window: vim and htop, Ctrl-Z, jobs, fg', setup: 'screen', run: async (page) => {
    // screen runs $SHELL, Shiro's sh as a kernel process on the window's pty
    await run(page, 'screen -q');
    await until(page, (s) => promptBack(s) && !/screen -q\s*$/m.test(s), "the window's shell prompt");
    await run(page, 'echo "in $0 pid $$"');
    await until(page, (s) => /in \S*sh pid \d+/.test(s) && promptBack(s), 'the kernel shell');
    await run(page, 'vim /tmp/k.txt');
    await until(page, vimBuffer, 'vim in the window');
    await typeKeys(page, 'iinside');
    await page.keyboard.press('Escape');
    await until(page, (s) => s.includes('inside'), 'typed text');
    await page.keyboard.press('Control+z');
    await until(page, (s) => /\[1\]\+\s+Stopped\s+vim/.test(s) && promptBack(s), 'vim stopped, the window shell prompting');
    await run(page, 'htop');
    await until(page, htopUp, 'htop in the window');
    await page.keyboard.press('Control+z');
    await until(page, (s) => /\[2\]\+\s+Stopped\s+htop/.test(s) && promptBack(s), 'htop stopped as job 2');
    await run(page, 'jobs');
    await until(page, (s) => /\[1\]-\s+Stopped\s+vim/.test(s) && /\[2\]\+\s+Stopped\s+htop/.test(tail(s, 4)) && promptBack(s), 'jobs listing both');
    await run(page, 'fg %1');
    await until(page, (s) => vimBuffer(s) && s.includes('inside'), 'vim redrawn after fg %1');
    await snap(page, 'screen-vim-fg');
    await typeKeys(page, ':wq\r');
    // (screen's altscreen is off by default: vim's last screen stays above the prompt)
    await until(page, (s) => promptBack(s) && /written/.test(tail(s, 2)), 'the window prompt after :wq');
    await run(page, 'fg');
    await until(page, htopUp, 'htop back with fg');
    await page.keyboard.press('q');
    await until(page, (s) => !s.includes('F10Quit') && promptBack(s), 'the prompt after htop quits');
    await run(page, 'cat /tmp/k.txt; jobs; echo "jobs-done $?"');
    await until(page, (s) => /^inside$/m.test(s) && /jobs-done 0/.test(s) && promptBack(s), 'the file written, no jobs left');
    await run(page, 'exit');
    await until(page, (s) => /screen is terminating/.test(s) && promptBack(s), 'back at the page prompt');
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
    await run(page, `pkg install vim htop${c.setup ? ' ' + c.setup : ''} && clear`);
    await until(page, (s) => promptBack(s) && !/pkg install/.test(s), 'vim and htop installed', 240_000);
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
