/**
 * Shell conformance: oils spec tests (tests/conformance/oils) run through
 * Shiro's shell, one fresh Shell per case, as `bash case.sh` (SH=bash: the cases are judged against bash) in an empty
 * directory. Only cases real bash passes (bash-baseline.json) are scored.
 * Results go to tests/conformance/results/shell-oils.json, which
 * scripts/conformance/report.mjs turns into docs/CONFORMANCE.md.
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Shell } from '@shiro/shell';
import { createTestShell } from '../tests/shiro-vitest/helpers';
// @ts-ignore plain JS module shared with the host-bash baseline script
import { parseSpecFile, judge, argvPy } from './lib/oils-spec.mjs';

const OILS = resolve(__dirname, 'oils');
const RESULTS = resolve(__dirname, 'results');
const files = readFileSync(join(OILS, 'FILES'), 'utf8').split('\n').filter(Boolean);
const baseline: Record<string, number[]> = JSON.parse(readFileSync(join(OILS, 'bash-baseline.json'), 'utf8'));
const only = process.env.SPEC_FILES ? process.env.SPEC_FILES.split(',') : null;
const CASE_TIMEOUT = 8000;
// Cases that hang Shiro synchronously (the event loop never returns, so the
// per-case timeout can't fire). Each is a bug; they're scored as failures.
const HANGS: Record<string, number[]> = JSON.parse(readFileSync(join(__dirname, 'shell-hangs.json'), 'utf8'));
// SPEC_PROGRESS=file logs each case before it runs, to find new hangs
const PROGRESS = process.env.SPEC_PROGRESS;

type CaseResult = { i: number; name: string; ok: boolean; status: number; stdout: string; stderr: string; timeout?: boolean };

const helperCommands = [
  { name: 'argv.py', description: 'print argv (oils spec helper)', async exec(ctx: any) { ctx.stdout += argvPy(ctx.args); return 0; } },
  { name: 'printenv.py', description: 'print env vars (oils spec helper)', async exec(ctx: any) {
    // (an external program: it sees the exported environment, not every shell variable)
    const env = ctx.shell?.exportedEnv?.() ?? ctx.env;
    for (const n of ctx.args) ctx.stdout += (env[n] ?? 'None') + '\n';
    return 0;
  } },
  { name: 'stdout_stderr.py', description: 'oils spec helper', async exec(ctx: any) {
    ctx.stdout += (ctx.args[0] ?? 'STDOUT') + '\n';
    ctx.stderr += (ctx.args[1] ?? 'STDERR') + '\n';
    return ctx.args[2] ? parseInt(ctx.args[2], 10) : 0;
  } },
];

async function runFile(file: string): Promise<CaseResult[]> {
  const cases = parseSpecFile(readFileSync(join(OILS, 'spec', `${file}.test.sh`), 'utf8'));
  const { fs, shell: base } = await createTestShell();
  for (const h of helperCommands) base.commands.register(h as any);
  // Testdata the cases source via $REPO_ROOT/spec/testdata
  await fs.mkdir('/oils/spec/testdata', { recursive: true });
  const td = join(OILS, 'spec/testdata');
  for (const name of readdirSync(td)) await fs.writeFile(`/oils/spec/testdata/${name}`, readFileSync(join(td, name)));
  await fs.mkdir('/spec-cases', { recursive: true });
  const want = new Set(baseline[file] || []);
  const results: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    if (!want.has(i)) continue;
    if (process.env.SPEC_CASES && !process.env.SPEC_CASES.split(',').includes(String(i))) continue;
    if (HANGS[file]?.includes(i)) {
      results.push({ i, name: c.name, ok: false, status: -3, stdout: '', stderr: '[harness] skipped: hangs tabcomputer', timeout: true });
      continue;
    }
    if (PROGRESS) appendFileSync(PROGRESS, `${file} ${i} ${c.name} @${Date.now() % 1000000}\n`);
    const tmp = `/tmp/spec/${file}-${i}`;
    await fs.mkdir(tmp, { recursive: true });
    const script = `/spec-cases/${file}-${i}.sh`;
    await fs.writeFile(script, c.code);
    const shell = new Shell(fs, base.commands);
    Object.assign(shell.env, { TMP: tmp, SH: 'bash', REPO_ROOT: '/oils', HOME: tmp, PWD: tmp });
    shell.cwd = tmp;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: any;
    const status = await Promise.race([
      shell.execute(`bash ${script}`, (s) => { stdout += s; }, (s) => { stderr += s; }, false, undefined, true).catch((e: any) => {
        stderr += `[harness] threw: ${e?.message ?? e}\n`;
        return -1;
      }),
      new Promise<number>((res) => { timer = setTimeout(() => { timedOut = true; shell.abortController?.abort(); res(-2); }, CASE_TIMEOUT); }),
    ]);
    clearTimeout(timer);
    stdout = stdout.replace(/\r\n/g, '\n');
    const ok = !timedOut && judge(c, stdout, status);
    results.push({ i, name: c.name, ok, status, stdout: stdout.slice(0, 2000), stderr: stderr.replace(/\r\n/g, '\n').slice(0, 1000), ...(timedOut ? { timeout: true } : {}) });
  }
  return results;
}

describe('oils spec tests (shell)', () => {
  const perFile = join(RESULTS, 'shell-oils');
  mkdirSync(perFile, { recursive: true });
  for (const file of files) {
    if (only && !only.includes(file)) continue;
    it(file, async () => {
      const res = await runFile(file);
      writeFileSync(join(perFile, `${file}.json`), JSON.stringify({
        pass: res.filter((r) => r.ok).length,
        total: res.length,
        failures: res.filter((r) => !r.ok),
      }, null, 1) + '\n');
    }, 600_000);
  }
  it('writes results', () => {
    // Summary over every file's latest result (a resumed run keeps earlier files)
    const all: Record<string, { pass: number; total: number; failures: { i: number; name: string; timeout?: boolean }[] }> = {};
    for (const file of files) {
      try {
        const r = JSON.parse(readFileSync(join(perFile, `${file}.json`), 'utf8'));
        all[file] = { pass: r.pass, total: r.total, failures: r.failures.map((f: CaseResult) => ({ i: f.i, name: f.name, ...(f.timeout ? { timeout: true } : {}) })) };
      } catch { /* not run */ }
    }
    writeFileSync(join(RESULTS, 'shell-oils.json'), JSON.stringify({ suite: 'oils spec', title: 'Shell: oils spec tests', files: all }, null, 1) + '\n');
  });
});
