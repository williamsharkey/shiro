#!/usr/bin/env node
/**
 * Run the vendored oils spec cases under the host's bash and record which
 * ones bash itself passes under our judge. Only those cases are scored for
 * Shiro (tests/conformance/shell-spec.conf.ts); the rest depend on bash
 * versions, locales or the oils harness and say nothing about Shiro.
 *
 *   node scripts/conformance/oils-bash-baseline.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpecFile, judge } from '../../tests/conformance/lib/oils-spec.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OILS = join(ROOT, 'tests/conformance/oils');
const files = readFileSync(join(OILS, 'FILES'), 'utf8').split('\n').filter(Boolean);

// Host versions of the spec helpers (oils' own are python2 scripts)
const work = mkdtempSync(join(tmpdir(), 'oils-baseline-'));
const bin = join(work, 'bin');
mkdirSync(bin);
const helpers = {
  'argv.py': 'import sys\nprint(repr(sys.argv[1:]).replace(chr(92)+chr(92)+"udc", chr(92)+"udc"))\n',
  'printenv.py': 'import os, sys\nfor n in sys.argv[1:]: print(os.environ.get(n))\n',
  'stdout_stderr.py': 'import sys\na=sys.argv\nprint(a[1] if len(a)>1 else "STDOUT")\nprint(a[2] if len(a)>2 else "STDERR", file=sys.stderr)\nsys.exit(int(a[3]) if len(a)>3 else 0)\n',
};
for (const [name, body] of Object.entries(helpers)) {
  writeFileSync(join(bin, name), '#!/usr/bin/env python3\n' + body);
  chmodSync(join(bin, name), 0o755);
}

const out = {};
let total = 0, pass = 0;
for (const f of files) {
  const cases = parseSpecFile(readFileSync(join(OILS, 'spec', `${f}.test.sh`), 'utf8'));
  out[f] = [];
  cases.forEach((c, i) => {
    const tmp = mkdtempSync(join(work, 'case-'));
    const r = spawnSync('bash', ['-c', c.code], {
      cwd: tmp, encoding: 'utf8', timeout: 5000,
      env: { PATH: `${bin}:/usr/bin:/bin`, TMP: tmp, SH: 'bash', REPO_ROOT: OILS, HOME: tmp, LC_ALL: 'C.UTF-8' },
    });
    total++;
    if (judge(c, r.stdout, r.status ?? -1)) { pass++; out[f].push(i); }
    rmSync(tmp, { recursive: true, force: true });
  });
}
rmSync(work, { recursive: true, force: true });
writeFileSync(join(OILS, 'bash-baseline.json'), JSON.stringify(out) + '\n');
console.log(`bash passes ${pass}/${total} cases; wrote tests/conformance/oils/bash-baseline.json`);
