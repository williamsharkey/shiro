#!/usr/bin/env node
/**
 * Run the LTP binaries built by scripts/conformance/build-ltp.sh natively on
 * the host and record which pass (Summary with passed > 0, failed 0, broken
 * 0). Only those are scored for Shiro (tests/conformance/syscalls-ltp.conf.ts).
 *
 *   node scripts/conformance/ltp-native-baseline.mjs
 */
import { readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeLtp } from '../../tests/conformance/lib/ltp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(ROOT, 'tests/conformance/.cache/ltp-bin');
const names = readdirSync(BIN).sort();
const results = {};
let next = 0;
async function worker() {
  while (next < names.length) {
    const name = names[next++];
    const dir = mkdtempSync(join(tmpdir(), 'ltp-'));
    const out = await new Promise((resolve) => {
      let text = '';
      const p = spawn(join(BIN, name), [], { cwd: dir, env: { PATH: `${BIN}:/usr/bin:/bin`, TMPDIR: dir, LTP_TIMEOUT_MUL: '1' } });
      const t = setTimeout(() => p.kill('SIGKILL'), 60000);
      p.stdout.on('data', (d) => { text += d; });
      p.stderr.on('data', (d) => { text += d; });
      p.on('close', (code) => { clearTimeout(t); resolve({ text, code }); });
      p.on('error', () => { clearTimeout(t); resolve({ text, code: -1 }); });
    });
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a test left a mount behind */ }
    const j = judgeLtp(out.text);
    if (j.ok) results[name] = { passed: j.passed, skipped: j.skipped };
  }
}
await Promise.all(Array.from({ length: Math.max(2, cpus().length) }, worker));
const sorted = Object.fromEntries(Object.entries(results).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(ROOT, 'tests/conformance/ltp/native-baseline.json'), JSON.stringify(sorted, null, 1) + '\n');
console.log(`native: ${Object.keys(sorted).length}/${names.length} LTP tests pass`);
