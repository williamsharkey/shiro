/**
 * A script statement (and an eval string) is parsed whole before it runs, as
 * bash does: a syntax error runs none of it, prints bash's message and ends a
 * script with status 2. Valid scripts must never be flagged.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';
import { syntaxError } from '@shiro/shell-syntax';

async function script(src: string) {
  const { shell, fs } = await createTestShell();
  await fs.writeFile('/tmp/syn.sh', src);
  let out = '';
  let err = '';
  const code = await shell.execute('bash /tmp/syn.sh', (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

describe('syntax errors stop a script before anything in the statement runs', () => {
  it.each([
    ['echo hi; while\necho status=$?\n', 'unexpected end of file'],
    ['echo hi; if\necho status=$?\n', 'unexpected end of file'],
    ['echo hi; for\n', 'unexpected end of file'],
    ['}\necho should not get here\n', "near unexpected token `}'"],
    ['{ls; }\necho "status=$?"\n', "near unexpected token `}'"],
    ['echo 1 ;; echo 2\n', "near unexpected token `;;'"],
    ['echo a(b)\n', "near unexpected token `('"],
    ['echo $(x\n', "matching `)'"],
    ['echo `x\n', "matching ``'"],
    ['echo "abc\n', `matching \`"'`],
    ['a=( inside=() )\necho len=${#a[@]}\n', "near unexpected token `('"],
    ['f() {\n  for x in a=(); do echo $x; done\n}\nf\n', "near unexpected token `('"],
    ['do echo hi\n', "near unexpected token `do'"],
    ['if true; then echo y; fi; fi\n', "near unexpected token `fi'"],
  ])('%j', async (src, msg) => {
    const r = await script(src);
    expect(r.out).toBe('');
    expect(r.code).toBe(2);
    expect(r.err).toContain(msg);
  });

  it('statements before the bad one ran; the script stops there', async () => {
    const r = await script('echo first\necho second; fi\necho third\n');
    expect(r.out).toBe('first\n');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/line 2: syntax error near unexpected token `fi'/);
  });

  it("eval parses its string first", async () => {
    const r = await script("eval 'echo hi; if'\necho st=$?\n");
    expect(r.out).toBe('st=2\n');
  });

  it('invalid names: FOO-BAR=foo is a command (127); export/readonly/declare/local refuse them', async () => {
    const r = await script('FOO-BAR=foo 2>/dev/null; echo $?\nexport A-B=1 2>/dev/null; echo $?\nreadonly C-D=1 2>/dev/null; echo $?\nf() { local E-F=1 2>/dev/null; }; f; echo $?\n');
    expect(r.out).toBe('127\n1\n1\n1\n');
  });
});

describe('valid scripts are not flagged', () => {
  it.each([
    'f() { echo hi; }',
    'function g { echo hi; }',
    'my-func() {\n  echo hi\n}',
    'a=(); b+=(x "y z"); declare -A m=([k]=v); local -a l=(1 2) 2>/dev/null; typeset t=(1)',
    'arr[(1+2)*3]=9; echo ${arr[9]}',
    'if [[ $x =~ ^a(b|c)$ ]]; then echo y; fi',
    'case $x in a|b) echo ab ;; (c) echo c ;; *) ;; esac',
    'x=$(case $y in a) echo a;; esac)',
    'cat <<EOF\n} ;; fi )\nEOF\necho after',
    'msg="$(cat <<\'EOF\'\nit\'s fine\nEOF\n)"',
    'for ((i=0; i<3; i++)); do echo $i; done',
    'for x in a b; do :; done 2>/dev/null | cat',
    'while read -r l; do branches+=("$l"); done < /dev/null',
    'echo !(a|b) @(x) ?(y) +(z) *(w)',
    'diff <(echo a) <(echo b) >/dev/null',
    'exec {fd}>/dev/null; echo hi >&$fd 2>&1',
    'echo $[1+2] $((3*(4+5))) ${x:-(default)}',
    'echo $\'it\\\'s\' $\'\\c\'\'',
    'if true; then; echo x; fi',
    'let x=( 1 )',
    "trap 'echo bye' EXIT",
    'echo a \\\n  b',
  ])('%j', (src) => {
    expect(syntaxError(src)).toBeNull();
  });
});
