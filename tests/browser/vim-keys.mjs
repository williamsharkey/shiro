// vim under Blink sometimes reads a key and then blocks in select(fd 0,
// timeout -1) without acting on it: the key's effect (the redraw of a typed
// char, Esc leaving insert mode, `:wq` running) only shows when the next key
// arrives. This opens vim N times, types `ihello`, and counts the rounds where
// the text isn't on screen within --wait ms (a stall), then sends one more key
// to show the input wasn't lost, only not acted on.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/vim-keys.mjs [URL] [--runs N] [--wait MS] [--trace]
//
// --trace prints, for the first stall, the pty input/reads and vim's syscalls
// (x86-64 numbers: 0 read, 1 write, 8 lseek, 23 select [nfds, ?, timeout ms],
// 13 rt_sigaction, 38 setitimer). What it showed: after a key vim's timed wait
// for more input (Blink polls select with timeout 0) ends as a timeout after
// 2-3 ms, vim acts as if 'updatetime' had passed (it writes the swap file,
// fd 3), then blocks in select(-1) with the redraw still pending. Time
// (clock_gettime) never reaches the kernel: Blink keeps it. Exits 1 if any
// round stalled.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const flag = (name) => { const i = args.indexOf(name); return i >= 0 && !!args.splice(i, 1); };
const runs = Number(opt('--runs') ?? 30);
const wait = Number(opt('--wait') ?? 8000);
const trace = flag('--trace');
const url = args[0] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
const screen = () => page.evaluate(() => {
  const t = window.__tabcomputer?.terminal?.term;
  if (!t) return '';
  const b = t.buffer.active;
  const r = [];
  for (let y = 0; y < t.rows; y++) r.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
  return r.join('\n');
});
const until = async (cond, ms = 60_000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await screen();
    if (cond(s)) return s;
    if (Date.now() - t0 > ms) return null;
    await page.waitForTimeout(50);
  }
};
const prompt = (s) => /\$\s*$/.test(s.trimEnd());
const vimUp = (s) => (s.match(/^~\s*$/gm) ?? []).length > 5;
const type = (s) => page.keyboard.type(s, { delay: 15 });

await page.goto(url);
if (!await until(prompt)) throw new Error('no prompt');
await type('pkg install vim && clear\n');
if (!await until((s) => prompt(s) && !/pkg install/.test(s), 240_000)) throw new Error('pkg install vim failed');

if (trace) {
  await page.evaluate(() => {
    const pty = window.__tabcomputer.terminal.tty.pty;
    const k = window.__tabcomputer.kernel;
    const w = window;
    w.__trace = [];
    const t = () => performance.now() | 0;
    const text = (b) => String.fromCharCode(...b); // (b may be a SharedArrayBuffer view: copy first)
    const input = pty.input.bind(pty);
    pty.input = (s) => { w.__trace.push([t(), 'in', typeof s === 'string' ? s : text(s)]); return input(s); };
    const takeRaw = pty.takeRaw.bind(pty);
    pty.takeRaw = (buf) => { const n = takeRaw(buf); w.__trace.push([t(), 'take', text(buf.slice(0, n))]); return n; };
    const syscall = k.syscall.bind(k);
    k.syscall = (proc, nr, a, data) => {
      const p = syscall(proc, nr, a, data);
      if (proc.path === 'vim') { const e = [t(), 'sys', nr, a[0], a[1], a[2]]; w.__trace.push(e); p.then((r) => e.push('=', r, t())); }
      return p;
    };
    const sync = k.syscallSync.bind(k);
    k.syscallSync = (proc, nr, a, data) => {
      const r = sync(proc, nr, a, data);
      if (proc.path === 'vim' && r !== undefined) w.__trace.push([t(), 'sync', nr, a[0], a[1], a[2], '=', r]);
      return r;
    };
  });
}

let stalls = 0;
let traced = false;
for (let k = 1; k <= runs; k++) {
  if (trace) await page.evaluate(() => { window.__trace = []; });
  await type('vim /tmp/vim-keys.txt\n');
  if (!await until(vimUp, wait)) {
    stalls++;
    console.log(`run ${k}: STALL at startup (no empty buffer in ${wait} ms)`);
    await type('\x1b');
    if (!await until(vimUp)) { console.log('vim never came up; giving up'); break; }
  } else if (!await (async () => { await type('ihello'); return until((s) => /^hello/m.test(s), wait); })()) {
    stalls++;
    const before = (await screen()).split('\n')[0];
    if (trace && !traced) {
      traced = true;
      console.log(JSON.stringify(await page.evaluate(() => window.__trace)));
    }
    await type('X');
    const after = (await until((s) => /^hel\S*X/m.test(s), 5000))?.match(/^hel\S*X/m)?.[0];
    console.log(`run ${k}: STALL after typing: screen "${before.trim()}", after one more key "${after?.trim() ?? '(nothing)'}"`);
  } else {
    console.log(`run ${k}: ok`);
  }
  // Leave vim; a stalled Esc needs another key to be acted on
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await type(':q!\n');
  if (!await until((s) => prompt(s) && !vimUp(s), 5000)) {
    await type('\x1b:q!\n');
    if (!await until((s) => prompt(s) && !vimUp(s))) { console.log('vim did not quit; giving up'); break; }
  }
  await type('clear\n');
  await until((s) => prompt(s) && !/vim/.test(s), 10_000);
}
console.log(`${stalls}/${runs} runs stalled`);
await browser.close();
process.exit(stalls ? 1 : 0);
