#!/usr/bin/env node
/**
 * The oils spec conformance suite (tests/conformance/shell-spec.conf.ts) in
 * a real browser: builds the app, serves it with server.mjs (cross-origin
 * isolated), loads it in the pre-installed Chromium via playwright-core and
 * runs every scored case through the page's own shell (a fresh Shell per
 * case, `bash CASE.sh` in an empty directory, like the vitest harness). Cases
 * are judged here with the same lib. Results: tests/conformance/results/
 * shell-oils-browser.json (a scoreboard section of its own).
 *
 *   node scripts/conformance/browser-oils.mjs [--no-build] [--files a,b]
 *
 * CHROMIUM overrides /opt/pw-browsers/chromium. Never run `playwright install`.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseSpecFile, judge, argvPy, pyRepr } from '../../tests/conformance/lib/oils-spec.mjs';

// playwright-core (devDependency), else the copy preinstalled in the cloud containers
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OILS = join(ROOT, 'tests/conformance/oils');
const RESULTS = join(ROOT, 'tests/conformance/results');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = opt('--files')?.split(',');
const PORT = Number(process.env.PORT || 5317);
const CASE_TIMEOUT = 8000;

if (!args.includes('--no-build') || !existsSync(join(ROOT, 'dist/index.html'))) {
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
}
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), STATIC_DIR: join(ROOT, 'dist') }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1500));

const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => window.__tabcomputer && window.__tabcomputer.shell, null, { timeout: 120000 });

// The oils helper commands, and the testdata the cases source
const testdata = Object.fromEntries(readdirSync(join(OILS, 'spec/testdata')).map((n) => [n, readFileSync(join(OILS, 'spec/testdata', n), 'utf8')]));
await page.evaluate(async ({ pyReprSrc, argvPySrc, testdata }) => {
  const { fs, commands } = window.__tabcomputer;
  // eslint-disable-next-line no-new-func
  const argvPy = new Function(`${pyReprSrc}\n${argvPySrc}\nreturn argvPy;`)();
  commands.register({ name: 'argv.py', description: 'oils spec helper', async exec(ctx) { ctx.stdout += argvPy(ctx.args); return 0; } });
  commands.register({ name: 'printenv.py', description: 'oils spec helper', async exec(ctx) {
    // (an external program: it sees the exported environment, not every shell variable)
    const env = ctx.shell?.exportedEnv?.() ?? ctx.env;
    for (const n of ctx.args) ctx.stdout += (env[n] ?? 'None') + '\n';
    return 0;
  } });
  commands.register({ name: 'stdout_stderr.py', description: 'oils spec helper', async exec(ctx) {
    ctx.stdout += (ctx.args[0] ?? 'STDOUT') + '\n';
    ctx.stderr += (ctx.args[1] ?? 'STDERR') + '\n';
    return ctx.args[2] ? parseInt(ctx.args[2], 10) : 0;
  } });
  await fs.mkdir('/oils/spec/testdata', { recursive: true });
  for (const [n, text] of Object.entries(testdata)) await fs.writeFile(`/oils/spec/testdata/${n}`, text);
  await fs.mkdir('/spec-cases', { recursive: true });
}, { pyReprSrc: pyRepr.toString(), argvPySrc: argvPy.toString(), testdata });

const files = readFileSync(join(OILS, 'FILES'), 'utf8').split('\n').filter(Boolean).filter((f) => !only || only.includes(f));
const baseline = JSON.parse(readFileSync(join(OILS, 'bash-baseline.json'), 'utf8'));
const hangs = JSON.parse(readFileSync(join(ROOT, 'tests/conformance/shell-hangs.json'), 'utf8'));
const out = {};
for (const file of files) {
  const cases = parseSpecFile(readFileSync(join(OILS, 'spec', `${file}.test.sh`), 'utf8'));
  const want = new Set(baseline[file] || []);
  const res = { pass: 0, total: 0, failures: [] };
  for (const [i, c] of cases.entries()) {
    if (!want.has(i)) continue;
    res.total++;
    if (hangs[file]?.includes(i)) { res.failures.push({ i, name: c.name, timeout: true }); continue; }
    const r = await page.evaluate(async ({ file, i, code, timeout }) => {
      const { fs, shell: base, commands } = window.__tabcomputer;
      const tmp = `/tmp/spec/${file}-${i}`;
      await fs.mkdir(tmp, { recursive: true });
      const script = `/spec-cases/${file}-${i}.sh`;
      await fs.writeFile(script, code);
      const sh = new base.constructor(fs, commands);
      Object.assign(sh.env, { TMP: tmp, SH: 'bash', REPO_ROOT: '/oils', HOME: tmp, PWD: tmp });
      sh.cwd = tmp;
      let stdout = '';
      let timedOut = false;
      let timer;
      const status = await Promise.race([
        sh.execute(`bash ${script}`, (s) => { stdout += s; }, () => {}, false, undefined, true).catch(() => -1),
        new Promise((res) => { timer = setTimeout(() => { timedOut = true; sh.abortController?.abort(); res(-2); }, timeout); }),
      ]);
      clearTimeout(timer);
      return { stdout: stdout.replace(/\r\n/g, '\n'), status, timedOut };
    }, { file, i, code: c.code, timeout: CASE_TIMEOUT });
    if (!r.timedOut && judge(c, r.stdout, r.status)) res.pass++;
    else res.failures.push({ i, name: c.name, ...(r.timedOut ? { timeout: true } : {}) });
  }
  out[file] = res;
  console.log(`${file}: ${res.pass}/${res.total}`);
}
await browser.close();
server.kill();
const name = only ? 'shell-oils-browser.partial.json' : 'shell-oils-browser.json';
writeFileSync(join(RESULTS, name), JSON.stringify({
  suite: 'oils spec (Chromium)',
  title: 'Shell: oils spec tests in Chromium',
  note: 'The same cases as above, run by scripts/conformance/browser-oils.mjs through the built app in headless Chromium (cross-origin isolated).',
  files: out,
}, null, 1) + '\n');
const sum = Object.values(out).reduce((a, v) => [a[0] + v.pass, a[1] + v.total], [0, 0]);
console.log(`total: ${sum[0]}/${sum[1]}`);
