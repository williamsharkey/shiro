/**
 * Shell conformance: smoosh's POSIX shell tests (tests/conformance/smoosh,
 * MIT, from github.com/mgree/smoosh tests/shell) run through Shiro's shell
 * the way smoosh's shell_tests.sh runs them: `sh NAME.test` in a fresh empty
 * directory with $TEST_SHELL=sh, judged on stdout (when NAME.out exists) and
 * the exit status (NAME.ec, default 0). stderr isn't compared: the expected
 * messages carry each shell's own prefix. Only cases host dash or bash
 * --posix passes are scored (smoosh/baseline.json, from
 * scripts/conformance/smoosh-baseline.mjs). Results go to
 * tests/conformance/results/shell-smoosh.json.
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Shell } from '@shiro/shell';
import { createTestShell } from '../tests/shiro-vitest/helpers';

const DIR = resolve(__dirname, 'smoosh');
const RESULTS = resolve(__dirname, 'results');
const baseline: { scored: string[] } = JSON.parse(readFileSync(join(DIR, 'baseline.json'), 'utf8'));
const only = process.env.SMOOSH_CASES ? process.env.SMOOSH_CASES.split(',') : null;
const CASE_TIMEOUT = 10_000;

// $TEST_UTIL: the C helpers as shell scripts (argv[0] is the path, as in C)
const UTIL: Record<string, string> = {
  argv: 'i=0; printf \'argv[%d] = "%s";\\n\' 0 "$0"; for a; do i=$((i+1)); printf \'argv[%d] = "%s";\\n\' "$i" "$a"; done\n',
  getenv: 'for v; do if eval "[ \\"\\${$v+set}\\" ]"; then eval "printf \\"%s=\'%s\'\\\\n\\" \\"\\$v\\" \\"\\$$v\\""; else printf \'%s is unset\\n\' "$v"; fi; done\n',
  readdir: 'printf \'%s\\n\' . ..; ls -A "${1:-.}"\n',
};

type CaseResult = { name: string; ok: boolean; status: number; stdout: string; stderr: string; timeout?: boolean; reason?: string };

const area = (name: string) => name.split('.')[0];

async function runAll(): Promise<CaseResult[]> {
  const { fs, shell: base } = await createTestShell();
  await fs.mkdir('/smoosh/shell', { recursive: true });
  await fs.mkdir('/smoosh/util', { recursive: true });
  for (const f of readdirSync(join(DIR, 'shell'))) await fs.writeFile(`/smoosh/shell/${f}`, readFileSync(join(DIR, 'shell', f)));
  for (const [n, body] of Object.entries(UTIL)) {
    await fs.writeFile(`/smoosh/util/${n}`, `#!/bin/sh\n${body}`);
    await fs.chmod?.(`/smoosh/util/${n}`, 0o755);
  }
  const results: CaseResult[] = [];
  for (const name of baseline.scored) {
    if (only && !only.includes(name)) continue;
    const ecFile = join(DIR, 'shell', `${name}.ec`);
    const outFile = join(DIR, 'shell', `${name}.out`);
    const wantStatus = existsSync(ecFile) && readFileSync(ecFile, 'utf8').trim() ? parseInt(readFileSync(ecFile, 'utf8'), 10) : 0;
    const wantOut = existsSync(outFile) ? readFileSync(outFile, 'utf8') : null;
    const tmp = `/tmp/smoosh/${name}`;
    await fs.mkdir(tmp, { recursive: true });
    const shell = new Shell(fs, base.commands);
    Object.assign(shell.env, { HOME: tmp, PWD: tmp, TEST_SHELL: 'sh', TEST_UTIL: '/smoosh/util', LC_ALL: 'C' });
    shell.cwd = tmp;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: any;
    const status = await Promise.race([
      shell.execute(`sh /smoosh/shell/${name}.test`, (s) => { stdout += s; }, (s) => { stderr += s; }, false, undefined, true).catch((e: any) => {
        stderr += `[harness] threw: ${e?.message ?? e}\n`;
        return -1;
      }),
      new Promise<number>((res) => { timer = setTimeout(() => { timedOut = true; shell.abortController?.abort(); res(-2); }, CASE_TIMEOUT); }),
    ]);
    clearTimeout(timer);
    stdout = stdout.replace(/\r\n/g, '\n');
    const outOk = wantOut === null || stdout === wantOut;
    const ok = !timedOut && status === wantStatus && outOk;
    const reason = ok ? undefined : timedOut ? undefined : status !== wantStatus ? `status ${status}, want ${wantStatus}` : 'stdout differs';
    results.push({ name, ok, status, stdout: stdout.slice(0, 2000), stderr: stderr.replace(/\r\n/g, '\n').slice(0, 1000),
      ...(timedOut ? { timeout: true } : {}), ...(reason ? { reason } : {}) });
  }
  return results;
}

describe('smoosh POSIX shell tests', () => {
  it('runs', async () => {
    const res = await runAll();
    mkdirSync(join(RESULTS, 'detail'), { recursive: true });
    writeFileSync(join(RESULTS, 'detail', `shell-smoosh${only ? '.partial' : ''}.json`), JSON.stringify(res, null, 1) + '\n');
    if (only) return;
    const files: Record<string, { pass: number; total: number; failures: { name: string; timeout?: boolean; reason?: string }[] }> = {};
    for (const r of res) {
      const a = (files[area(r.name)] ??= { pass: 0, total: 0, failures: [] });
      a.total++;
      if (r.ok) a.pass++;
      else a.failures.push({ name: r.name, ...(r.timeout ? { timeout: true } : {}), ...(r.reason ? { reason: r.reason } : {}) });
    }
    writeFileSync(join(RESULTS, 'shell-smoosh.json'), JSON.stringify({
      suite: 'smoosh', title: 'Shell: smoosh POSIX tests',
      note: 'POSIX sh cases from [smoosh](https://github.com/mgree/smoosh) (tests/shell), judged on stdout and exit status; scored where host dash or bash --posix passes. "Before" is unix/integration c14344d.',
      files,
    }, null, 1) + '\n');
  }, 1_800_000);
});
