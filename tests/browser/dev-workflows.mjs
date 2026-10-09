// Developer workflows end to end in Chromium, each from a fresh profile:
// clone a real GitHub repository, then build and test it the way its README
// says, typing into the real terminal.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/dev-workflows.mjs [URL] [--only NAME] [--shots DIR]
//   node tests/browser/dev-workflows.mjs https://tabcomputer.com/
//
// Prints one line per step with its time and one per case; exits 1 if any
// case fails. External requests go through $HTTPS_PROXY when it is set (the
// cloud containers), localhost directly. Needs playwright (NODE_PATH=
// /opt/node-tools/node_modules in the cloud containers) and Chromium
// (CHROMIUM, default the pre-installed one).
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
const LIMIT = Number(process.env.WORKFLOW_LIMIT_MS || 900_000); // per step
if (shots) mkdirSync(shots, { recursive: true });

/** The main terminal's whole buffer (scrollback included), as text rows. */
const bufferOf = (page) => page.evaluate(() => {
  const t = window.__shiro.terminal.term;
  const b = t.buffer.active;
  const rows = [];
  for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
  return rows.join('\n');
});

let marks = 0;
/**
 * Type `cmd` at the prompt and wait for it to finish: it ends with a marker
 * that prints its exit status. Returns the output between the command and
 * the marker.
 */
async function step(page, cmd, expect = null) {
  const mark = `@@step${++marks}`;
  const t0 = Date.now();
  await page.evaluate(() => window.__shiro.terminal.term.focus());
  await page.keyboard.type(`${cmd}; echo "${mark} $?"\r`, { delay: 2 });
  const re = new RegExp(`^${mark} (\\d+)$`, 'm');
  for (;;) {
    const s = await bufferOf(page);
    const m = re.exec(s);
    if (m) {
      const out = s.slice(0, m.index).split(`echo "${mark} $?"`).pop() ?? '';
      const ms = Date.now() - t0;
      const code = Number(m[1]);
      const ok = code === 0 && (!expect || expect.test(out));
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${(ms / 1000).toFixed(1).padStart(6)} s  ${cmd}`);
      if (!ok) throw new Error(`exit ${code}${expect && code === 0 ? `, no ${expect}` : ''}:\n${out.replace(/\s+$/gm, '').trim().split('\n').slice(-25).join('\n')}`);
      return { out, ms };
    }
    if (Date.now() - t0 > LIMIT) throw new Error(`timed out after ${LIMIT / 1000} s: ${cmd}\n${s.split('\n').slice(-25).join('\n')}`);
    await page.waitForTimeout(250);
  }
}

const CASES = [
  { name: 'git: clone, edit, commit, log', steps: [
    ['git clone https://github.com/octocat/Hello-World && cd Hello-World && ls'],
    ['git config user.name "Shiro User" && git config user.email user@shiro.computer'],
    ['echo "edited in Shiro" >> README && git add README && git commit -m "Edit README in Shiro"'],
    ['git log --oneline | head -3', /Edit README in Shiro/],
    ['git status', /nothing to commit|working tree clean/],
  ] },
  { name: 'node: npm install && npm test (jshttp/mime-types)', steps: [
    ['git clone https://github.com/jshttp/mime-types && cd mime-types'],
    ['npm install', /added \d+ package|installed successfully/],
    ['npm test', /\d+ passing/],
  ] },
  { name: 'python: venv, pip install pytest requests, pytest (benjaminp/six)', steps: [
    ['git clone https://github.com/benjaminp/six && cd six'],
    ['python3 -m venv .venv && . .venv/bin/activate'],
    ['pip install pytest requests', /Successfully installed .*pytest/],
    ['python3 -c "import requests; print(requests.__version__)"', /\d+\.\d+/],
    // All but two pass: test_getoutput needs subprocess, the HTTPSHandler
    // move needs ssl, neither of which WASI CPython has
    ['pytest -q test_six.py -k "not test_getoutput and not HTTPSHandler"', /\d+ passed/],
  ] },
  { name: 'C: make test (zserge/jsmn)', steps: [
    ['pkg install make llvm'],
    ['git clone https://github.com/zserge/jsmn && cd jsmn'],
    ['make test', /PASSED|passed/],
  ] },
  { name: 'ssh: ssh -T git@github.com reaches GitHub', steps: [
    ['pkg install openssh'],
    // Without a key GitHub answers "Permission denied (publickey)": the
    // connection, key exchange and host key check all worked
    ['ssh -T -o StrictHostKeyChecking=accept-new -o BatchMode=yes git@github.com 2>&1 | tee /tmp/ssh.out; grep -q "Permission denied (publickey)\\|successfully authenticated" /tmp/ssh.out', /Permission denied \(publickey\)|successfully authenticated/],
  ] },
];

// External hosts through the container's proxy; localhost stays direct (Chromium bypasses loopback)
const proxy = process.env.HTTPS_PROXY ? process.env.HTTPS_PROXY.replace(/^\w+:\/\//, '').replace(/\/$/, '') : '';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', ...(proxy ? [`--proxy-server=${proxy}`] : [])] });
let failed = 0;
const results = [];
for (const c of CASES) {
  if (only && !c.name.includes(only)) continue;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: !!proxy }); // a fresh profile
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  console.log(`${c.name}`);
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.__shiro?.terminal?.term && window.__shiro?.kernel, null, { timeout: 90_000 });
    // the prompt is up
    for (let i = 0; i < 300 && !/\$ ?$/m.test(await bufferOf(page)); i++) await page.waitForTimeout(100);
    await page.waitForTimeout(500);
    for (const [cmd, expect] of c.steps) await step(page, cmd, expect);
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    const s = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`ok   ${c.name}  ${s} s`);
    results.push([c.name, 'ok', s]);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}  ${((Date.now() - t0) / 1000).toFixed(0)} s\n  ${String(e.message).replace(/\n/g, '\n  ')}`);
    results.push([c.name, 'FAIL', ((Date.now() - t0) / 1000).toFixed(0)]);
  }
  if (shots) await page.screenshot({ path: `${shots}/${c.name.replace(/\W+/g, '-')}.png` }).catch(() => {});
  await context.close();
}
await browser.close();
console.log('\n' + results.map((r) => r.join('  ')).join('\n'));
process.exit(failed ? 1 : 0);
