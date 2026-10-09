/**
 * Piped input reaches the commands inside if/for/case/function bodies, and
 * only exported functions reach a new shell process
 * (williamsharkey/tabcomputer#1: Claude Code's snapshot wraps grep in an
 * if/elif, so `anything | grep foo` printed nothing).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function sh(cmd: string, setup?: (fs: any) => Promise<void>) {
  const { fs, shell } = await createTestShell();
  if (setup) await setup(fs);
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('a pipe into a compound command', () => {
  it.each([
    ['echo X1 | if true; then cat; fi', 'X1\n'],
    ['echo X2 | for i in 1; do cat; done', 'X2\n'],
    ['echo X3 | case a in a) cat;; esac', 'X3\n'],
    ['f(){ if false; then :; else cat; fi; }; echo X8 | f', 'X8\n'],
    ['echo X4 | while read l; do echo "$l"; done', 'X4\n'],
    ['echo X5 | { cat; }', 'X5\n'],
    ['echo X6 | ( cat )', 'X6\n'],
    ['printf "a\\nb\\n" | if true; then read x; echo "got $x"; cat; fi', 'got a\nb\n'],
    ['echo X7 | if true; then echo first; cat; fi', 'first\nX7\n'],
    ['echo X10 | if [ -n x ]; then tr X Y; fi | cat', 'Y10\n'],
    ['echo X11 | if true; then cat </dev/null; echo end; fi', 'end\n'],
    ['printf "1\\n2\\n" | for i in a; do head -1; done', '1\n'],
  ])('%s', async (cmd, want) => {
    expect((await sh(cmd)).out).toBe(want);
  });

  it("Claude Code's grep wrapper (if/elif around grep) filters piped input", async () => {
    const r = await sh(`grep() { if [[ -n \${ZSH_VERSION:-} ]]; then :; elif false; then :; else command grep "$@"; fi; }
printf 'foo\\nbar\\n' | grep foo; echo "rc=$?"`);
    expect(r.out).toBe('foo\nrc=0\n');
  });
});

describe('functions and new shell processes', () => {
  it('an unexported function stays in this shell (subshells and $(...) see it, sh -c and scripts do not)', async () => {
    const r = await sh(`zz(){ echo here; }
sh -c 'type zz' >/dev/null 2>&1 && echo leaked-to-sh || echo sh-clean
bash /tmp/s.sh
(zz)
echo "$(zz)"`, async (fs) => fs.writeFile('/tmp/s.sh', 'type zz >/dev/null 2>&1 && echo leaked-to-script || echo script-clean\n'));
    expect(r.out).toBe('sh-clean\nscript-clean\nhere\nhere\n');
  });

  it('export -f passes it on; export -nf and unset -f take it back', async () => {
    const r = await sh(`zz(){ echo exported; }
export -f zz; sh -c zz
export -nf zz; sh -c 'type zz' >/dev/null 2>&1 || echo gone
export -f nosuch; echo "rc=$?"`);
    expect(r.out).toBe('exported\ngone\ntabcomputer: export: nosuch: not a function\nrc=1\n');
  });
});
