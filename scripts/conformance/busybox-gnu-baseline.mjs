#!/usr/bin/env node
/**
 * Run the busybox testsuite (fetched by scripts/conformance/fetch.sh) against
 * the host's GNU tools under bash, and record which cases pass there. Only
 * those are scored for Shiro (tests/conformance/utils-busybox.conf.ts): the
 * suite was written for busybox, so a case GNU fails says nothing about
 * Shiro.
 *
 *   scripts/conformance/fetch.sh && node scripts/conformance/busybox-gnu-baseline.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CONF = join(ROOT, 'tests/conformance/busybox');
const SUITE = join(ROOT, 'tests/conformance/.cache/busybox/testsuite');
if (!existsSync(SUITE)) { console.error('run scripts/conformance/fetch.sh first'); process.exit(1); }
const { scripts, applets } = JSON.parse(readFileSync(join(CONF, 'selection.json'), 'utf8'));

const work = mkdtempSync(join(tmpdir(), 'bb-baseline-'));
const bin = join(work, 'bin');
cpSync(SUITE, join(work, 'testsuite'), { recursive: true });
// `busybox APPLET ARGS` runs the host's APPLET
writeFileSync(join(work, 'busybox'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
// All optional features on; testing() as upstream, printing PASS/FAIL lines
writeFileSync(join(work, 'testsuite/testing.sh'), readFileSync(join(CONF, 'testing.sh'), 'utf8'));
const env = { PATH: `${work}:/usr/bin:/bin`, HOME: work, LC_ALL: 'C.UTF-8', ECHO: 'echo', TZ: 'UTC' };

const out = { scripts: {}, applets: {} };
let pass = 0, total = 0;
for (const s of scripts) {
  const r = spawnSync('bash', [`${s}.tests`], { cwd: join(work, 'testsuite'), env, encoding: 'utf8', timeout: 60000 });
  out.scripts[s] = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^(PASS|FAIL): (.*)$/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] === 'PASS') { pass++; out.scripts[s].push(m[2]); }
  }
}
for (const a of applets) {
  const dir = join(SUITE, a);
  out.applets[a] = [];
  for (const t of readdirSync(dir).sort()) {
    if (!statSync(join(dir, t)).isFile()) continue;
    const tmp = mkdtempSync(join(work, 'case-'));
    const r = spawnSync('bash', ['-e', join(dir, t)], { cwd: tmp, env: { ...env, d: join(work, 'testsuite') }, encoding: 'utf8', timeout: 20000 });
    total++;
    if (r.status === 0) { pass++; out.applets[a].push(t); }
    rmSync(tmp, { recursive: true, force: true });
  }
}
rmSync(work, { recursive: true, force: true });
writeFileSync(join(CONF, 'gnu-baseline.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`GNU passes ${pass}/${total}; wrote tests/conformance/busybox/gnu-baseline.json`);
