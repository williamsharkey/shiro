#!/usr/bin/env node
/**
 * Run the vendored smoosh POSIX shell tests (tests/conformance/smoosh) under
 * the host's dash, the way smoosh's own tests/shell_tests.sh does (each test
 * as `$TEST_SHELL NAME.test` in a fresh temp directory, 5 s), and record
 * which ones dash or bash --posix passes on stdout and exit status. Only
 * those are scored for Shiro (tests/conformance/smoosh-posix.conf.ts): a
 * case neither reference shell passes says nothing about Shiro.
 *
 *   node scripts/conformance/smoosh-dash-baseline.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(ROOT, 'tests/conformance/smoosh');
const work = mkdtempSync(join(tmpdir(), 'smoosh-baseline-'));

// The C helpers some tests call through $TEST_UTIL
const util = join(work, 'util');
spawnSync('mkdir', ['-p', util]);
for (const f of readdirSync(join(DIR, 'util'))) {
  const r = spawnSync('cc', ['-O1', '-o', join(util, f.replace(/\.c$/, '')), join(DIR, 'util', f)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cc ${f}: ${r.stderr}`);
}

const names = readdirSync(join(DIR, 'shell')).filter((f) => f.endsWith('.test')).map((f) => f.slice(0, -5)).sort();
const expected = (name) => {
  const ec = join(DIR, 'shell', `${name}.ec`);
  const out = join(DIR, 'shell', `${name}.out`);
  return {
    status: existsSync(ec) && readFileSync(ec, 'utf8').trim() ? parseInt(readFileSync(ec, 'utf8'), 10) : 0,
    stdout: existsSync(out) ? readFileSync(out, 'utf8') : null,
  };
};

function run(shell, flags, name) {
  const tmp = mkdtempSync(join(work, 'case-'));
  const r = spawnSync(shell, [...flags, join(DIR, 'shell', `${name}.test`)], {
    cwd: tmp, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: tmp, TEST_SHELL: shell, TEST_UTIL: util, LC_ALL: 'C' },
  });
  rmSync(tmp, { recursive: true, force: true });
  const e = expected(name);
  return !r.error && r.status === e.status && (e.stdout === null || r.stdout === e.stdout);
}

const dash = names.filter((n) => run('dash', [], n));
const bash = names.filter((n) => run('bash', ['--posix'], n));
rmSync(work, { recursive: true, force: true });
// `fds` lists open file descriptors 0-20 with fcntl: there is no Shiro equivalent.
// semantics.command.argv0 checks the C helper's argv[0]; Shiro's helper is a
// shell script, whose $0 is the path it was found at.
const scored = names.filter((n) => (dash.includes(n) || bash.includes(n)) && n !== 'semantics.command.argv0' && !readFileSync(join(DIR, 'shell', `${n}.test`), 'utf8').includes('TEST_UTIL}/fds') &&
  !readFileSync(join(DIR, 'shell', `${n}.test`), 'utf8').includes('TEST_UTIL/fds'));
writeFileSync(join(DIR, 'baseline.json'), JSON.stringify({ scored, dash, bashPosix: bash }, null, 1) + '\n');
console.log(`dash passes ${dash.length}/${names.length}, bash --posix ${bash.length}/${names.length}, ${scored.length} scored; wrote tests/conformance/smoosh/baseline.json`);
