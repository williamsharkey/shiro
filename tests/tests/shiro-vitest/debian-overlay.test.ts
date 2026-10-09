/**
 * The overlay's evidence (docs/DEBIAN.md "Hybrid overlay"): each hot program
 * runs the same cases as Debian's binary and as Shiro's builtin, and its
 * default in src/debian/overlay-policy.json may be "shiro" only when every
 * case matches (stdout and exit status). OVERLAY_REPORT=1 prints the table
 * used to pick the defaults.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestShell, run } from './helpers';
import { POLICY } from '@shiro/debian/overlay';
import type { Shell } from '@shiro/shell';

const ROOT = resolve(__dirname, '../../..');
const haveRootfs = existsSync(resolve(ROOT, 'public/debian/rootfs.json'));

/** `P` stands for the program; cases run in /tmp/ov, which holds the fixture files. */
export const CASES: Record<string, string[]> = {
  cat: ['P a.txt', 'P -n a.txt', 'printf "x\\ny\\n" | P', 'P missing; echo rc=$?'],
  head: ['P -n 2 a.txt', 'P -c 5 a.txt', 'seq 20 | P', 'P -n -2 a.txt', 'P a.txt -n 2'],
  tail: ['P -n 2 a.txt', 'P -c 4 a.txt', 'seq 20 | P -n +18', 'P -n 1 a.txt b.txt', 'P a.txt -n 2'],
  wc: ['P -l a.txt', 'P a.txt', 'P -w < a.txt', 'P -c a.txt b.txt'],
  sort: ['P a.txt', 'P -r a.txt', 'P -n nums.txt', 'P -u dup.txt', 'P -t, -k2 csv.txt', 'P -nr nums.txt', 'P a.txt -r'],
  uniq: ['P dup.txt', 'P -c dup.txt', 'P -d dup.txt', 'P -u dup.txt', 'P dup.txt -c'],
  cut: ['P -d, -f2 csv.txt', 'P -c1-3 a.txt', 'P -d, -f1,3 csv.txt', 'P a.txt -c1-3'],
  tr: ['P a-z A-Z < a.txt', 'P -d a < a.txt', 'P -s " " < spaces.txt', 'echo hello | P -cd "a-z\\n"'],
  grep: ['P an a.txt', 'P -c an a.txt', 'P -v an a.txt', 'P -i AP a.txt', 'P -E "^(a|b)" a.txt', 'P -o "an." a.txt', 'P -n e a.txt', 'P -w an a.txt', 'P -r needle dir | sort', 'P -l an a.txt b.txt', 'P zzz a.txt; echo rc=$?', 'P an a.txt -c'],
  sed: ['P s/a/X/ a.txt', 'P s/a/X/g a.txt', 'P -n 2p a.txt', 'P 1d a.txt', 'P /an/d a.txt', 'P -e s/a/1/ -e s/b/2/ a.txt', 'P y/abc/xyz/ a.txt', 'P -E "s/(a)(n)/\\2\\1/" a.txt', 'P "2,3s/^/> /" a.txt', 'cp a.txt s1 && P -E -i s1 -e "s/a/X/" -e "/b/ s/$/ Y/" && cat s1', 'P a.txt -n -e 2p'],
  seq: ['P 5', 'P 2 4', 'P 1 2 9', 'P -s, 3', 'P -w 8 10'],
  basename: ['P /a/b/c.txt', 'P /a/b/c.txt .txt', 'P /'],
  dirname: ['P /a/b/c.txt', 'P c.txt', 'P /'],
  echo: ['P a b', 'P -n x; echo', 'P -e "a\\tb"'],
  printf: ['P "%s-%d\\n" a 5', 'P "%05.1f\\n" 3.14159', 'P "%x %o\\n" 255 8'],
  tee: ['echo hi | P t1.out; cat t1.out', 'echo a | P -a t1.out >/dev/null; cat t1.out'],
  md5sum: ['P a.txt', 'echo x | P'],
  sha256sum: ['P a.txt', 'echo x | P'],
  base64: ['P a.txt', 'echo aGVsbG8K | P -d'],
  basenc: [],
  expr: ['P 2 + 3', 'P 7 / 2', 'P length hello', 'P 1 = 2; echo rc=$?'],
  true: ['P; echo rc=$?'],
  false: ['P; echo rc=$?'],
  test: ['P -f a.txt; echo rc=$?', 'P -d a.txt; echo rc=$?', 'P 3 -gt 2; echo rc=$?'],
  find: ['P dir -name "*.txt" | sort', 'P dir -type d | sort', 'P dir -type f -name "n*" | sort', 'P dir -maxdepth 1 | sort'],
  xargs: ['printf "a\\nb\\n" | P echo', 'printf "a b c" | P -n 1 echo'],
  ls: ['P dir', 'P -1 dir', 'P -a dir', 'P dir -a'],
  mkdir: ['P -p m/n/o && P -p m/n/o; echo rc=$?; ls m/n'],
  touch: ['P newf && ls newf'],
  rm: ['touch r1 && P r1; ls r1 2>/dev/null; echo rc=$?'],
  cp: ['P a.txt c1 && cat c1'],
  mv: ['cp a.txt mv1 && P mv1 mv2 && cat mv2'],
  ln: ['P -s a.txt l1 && readlink l1'],
  readlink: ['ln -sf a.txt rl && P rl'],
  realpath: ['P dir/../a.txt'],
  env: ['P -i A=1 sh -c "echo \\$A"'],
  yes: ['P | head -3', 'P x | head -2'],
  rev: ['P a.txt'],
  tac: ['P a.txt'],
  nl: ['P a.txt'],
  od: ['printf "AB" | P -c', 'printf "AB" | P -An -tx1', 'printf AB | P -An -tx1'],
  comm: ['P s1.txt s2.txt'],
  join: ['P s1.txt s2.txt'],
  paste: ['P s1.txt s2.txt', 'P -d, s1.txt s2.txt'],
  fold: ['P -w 3 a.txt'],
  diff: ['P s1.txt s2.txt; echo rc=$?', 'P a.txt a.txt; echo rc=$?'],
  gzip: ['P -c a.txt | P -dc'],
};

const FILES: Record<string, string> = {
  'a.txt': 'apple\nbanana\ncherry\nmango\n',
  'b.txt': 'one\ntwo\nan\n',
  'nums.txt': '10\n9\n100\n-3\n2.5\n',
  'dup.txt': 'a\na\nb\nc\nc\nc\nd\n',
  'csv.txt': 'x,3,p\ny,1,q\nz,2,r\n',
  'spaces.txt': 'a   b    c\n',
  's1.txt': 'a\nb\nc\n',
  's2.txt': 'b\nc\nd\n',
  'dir/one.txt': 'needle\n',
  'dir/sub/two.txt': 'hay\nneedle\n',
  'dir/sub/n3.txt': 'x\n',
};

describe.skipIf(!haveRootfs)('overlay: Shiro builtins vs Debian programs', () => {
  let shell: Shell;
  beforeAll(async () => {
    const t = await createTestShell();
    shell = t.shell;
    expect((await run(shell, 'debian install')).exitCode).toBe(0);
    for (const [p, text] of Object.entries(FILES)) {
      await t.fs.mkdir(`/tmp/ov/${p}`.replace(/\/[^/]+$/, ''), { recursive: true });
      await t.fs.writeFile(`/tmp/ov/${p}`, text);
    }
  }, 60000);

  const report: Record<string, { cases: number; matched: number; diffs: string[] }> = {};

  // The suite checks the programs that default to Shiro's; OVERLAY_REPORT=1 compares them all
  const all = !!process.env.OVERLAY_REPORT;
  for (const [prog, cases] of Object.entries(CASES)) {
    if (!cases.length || (!all && POLICY[`/usr/bin/${prog}`]?.default !== 'shiro')) continue;
    it(`${prog}`, async () => {
      const path = (await run(shell, `command -v /usr/bin/${prog} /usr/bin/${prog}.debian`)).output.trim().split('\n').pop() || `/usr/bin/${prog}`;
      const r = { cases: cases.length, matched: 0, diffs: [] as string[] };
      for (const c of cases) {
        const fresh = 'builtin rm -rf /tmp/ovw && builtin cp -r /tmp/ov /tmp/ovw && cd /tmp/ovw && ';
        const deb = await run(shell, fresh + c.replace(/\bP\b/g, path) + '; echo "[rc=$?]"');
        const shi = await run(shell, fresh + c.replace(/\bP\b/g, `builtin ${prog}`) + '; echo "[rc=$?]"');
        const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\/usr\/bin\/[\w.-]+:|builtin:|\b[\w.-]+: /g, '');
        if (deb.output === shi.output) r.matched++;
        else r.diffs.push(`${c}\n  debian: ${JSON.stringify(deb.output.slice(0, 200))}\n  shiro:  ${JSON.stringify(shi.output.slice(0, 200))}${norm(deb.output) === norm(shi.output) ? ' (differs only in error-message prefixes)' : ''}`);
      }
      report[prog] = r;
      const policy = POLICY[`/usr/bin/${prog}`];
      if (policy?.default === 'shiro') expect(r.diffs, `${prog} defaults to Shiro's but differs from Debian's`).toEqual([]);
    }, 300000);
  }

  it('report', () => {
    if (!process.env.OVERLAY_REPORT) return;
    mkdirSync(resolve(ROOT, '.debian-build'), { recursive: true });
    writeFileSync(resolve(ROOT, '.debian-build/overlay-report.json'), JSON.stringify(report, null, 1));
    for (const [p, r] of Object.entries(report)) console.log(`${r.matched === r.cases ? 'SAME' : 'DIFF'} ${p} ${r.matched}/${r.cases}\n${r.diffs.join('\n')}`);
  });
});
