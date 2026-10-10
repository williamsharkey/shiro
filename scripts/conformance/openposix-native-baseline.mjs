#!/usr/bin/env node
/**
 * Run the Open POSIX Test Suite binaries built by
 * scripts/conformance/build-openposix.sh natively on the host and record
 * which pass (exit status 0, PTS_PASS). Only those are scored for Shiro
 * (tests/conformance/posix-openposix.conf.ts). They run as uid/gid 1000,
 * like Shiro's processes, one at a time per worker in a fresh directory.
 *
 *   node scripts/conformance/openposix-native-baseline.mjs
 */
import { readdirSync, writeFileSync, mkdtempSync, rmSync, chownSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(ROOT, 'tests/conformance/.cache/openposix-bin');
const names = readdirSync(BIN).sort();
const UID = Number(process.env.OPENPOSIX_UID ?? 1000);
const results = {};
let next = 0;
async function worker() {
  while (next < names.length) {
    const name = names[next++];
    const dir = mkdtempSync(join(tmpdir(), 'openposix-'));
    if (UID !== 0) chownSync(dir, UID, UID);
    const t0 = Date.now();
    const code = await new Promise((resolve) => {
      const p = spawn(join(BIN, name), [], { cwd: dir, uid: UID, gid: UID, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', TMPDIR: dir } });
      const t = setTimeout(() => p.kill('SIGKILL'), 20000);
      p.on('close', (c) => { clearTimeout(t); resolve(c); });
      p.on('error', () => { clearTimeout(t); resolve(-1); });
    });
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* left behind */ }
    if (code === 0) results[name] = { ms: Date.now() - t0 };
  }
}
await Promise.all(Array.from({ length: Math.max(2, Math.min(8, cpus().length)) }, worker));
const sorted = Object.fromEntries(Object.entries(results).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(ROOT, 'tests/conformance/openposix/native-baseline.json'), JSON.stringify(sorted, null, 1) + '\n');
console.log(`native: ${Object.keys(sorted).length}/${names.length} Open POSIX tests pass`);
