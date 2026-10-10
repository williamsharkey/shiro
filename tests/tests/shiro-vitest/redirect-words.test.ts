/**
 * Redirection words and order as bash has them: a compound's `> f` opens f
 * before the compound's words expand; a simple command's file word expands on
 * its own to one word (glob included) or is an "ambiguous redirect"; function
 * body redirects apply per call; redirections may sit among NAME=value words;
 * exec N<> opens for reading and writing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import { redirectWordSpans } from '@shiro/shell-redirect-words';

let shell: Shell;

beforeEach(async () => {
  ({ shell } = await createTestShell());
  await sh('mkdir -p /tmp/rw && cd /tmp/rw && rm -f /tmp/rw/*');
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('compound redirects open first', () => {
  it('( … ) > f, for … done > f, case … esac > f, [[ ]] > f', async () => {
    expect((await sh('echo hello > f; (echo `cat f` world) > f; cat f')).out).toBe('world\n');
    expect((await sh('echo hello > f; for x in `cat f` w; do echo $x; done > f; cat f')).out).toBe('w\n');
    expect((await sh('echo hello > f; case `cat f` in hello) echo h;; *) echo o;; esac > f; cat f')).out).toBe('o\n');
    expect((await sh('echo hello > f; [[ `cat f` = hello ]] > f; echo $?')).out).toBe('1\n');
  });

  it('1>&2 and 0< after a compound', async () => {
    let err = '';
    await shell.execute('( echo foo ) 1>&2', () => {}, (s) => { err += s; });
    expect(err.replace(/\r\n/g, '\n')).toBe('foo\n');
    expect((await sh('echo in > g; { cat; } 0<g')).out).toBe('in\n');
  });

  it("a function body's redirect is expanded on each call", async () => {
    const r = await sh('i=0; fun() { echo "file $i"; } 1> "/tmp/rw/file$((i++))"; fun; fun; echo i=$i; cat file0 file1');
    expect(r.out).toBe('i=2\nfile 1\nfile 2\n');
  });
});

describe('simple command redirect words', () => {
  it('globs to one file, else ambiguous', async () => {
    expect((await sh('touch one-bar; echo hi > one-*; cat one-bar')).out).toBe('hi\n');
    expect((await sh('touch a-1 a-2; echo hi > a-*; echo $?')).out).toMatch(/a-\*: ambiguous redirect\n1\n$/);
    expect((await sh('echo esc > one-\\*; cat one-\\*')).out).toBe('esc\n');
  });

  it('word splitting and braces are ambiguous; quoted is one word', async () => {
    expect((await sh("f='x y'; echo hi > $f; echo $?")).out).toMatch(/\$f: ambiguous redirect\n1\n$/);
    expect((await sh('echo hi > b-{1,2}; echo $?')).out).toMatch(/ambiguous redirect\n1\n$/);
    expect((await sh(`f='x y'; echo hi > "$f"; cat "x y"`)).out).toBe('hi\n');
  });

  it('failglob: no match is an error', async () => {
    expect((await sh('shopt -s failglob; echo hi > zz-*; echo $?')).out).toMatch(/no match: zz-\*\n1\n$/);
  });

  it('finds the words it needs to', () => {
    expect(redirectWordSpans('echo hi > $f 2>&1').map((s) => s.word)).toEqual(['$f']);
    expect(redirectWordSpans('cat < a-* | wc > "$o"')).toEqual([{ start: 6, end: 9, word: 'a-*' }]);
    expect(redirectWordSpans('cmd > /dev/null')).toEqual([]);
    expect(redirectWordSpans('diff <(ls) > out.$$')).toEqual([{ start: 13, end: 19, word: 'out.$$' }]);
    expect(redirectWordSpans('[[ a > b ]]')).toEqual([]);
  });
});

describe('redirections among assignments', () => {
  it('A=1 >f B=2 cmd and >f A=1 cmd', async () => {
    expect((await sh('FOO=foo >o1 BAR=bar printenv FOO BAR; cat o1')).out).toBe('foo\nbar\n');
    expect((await sh('>o2 FOO=foo printenv FOO; cat o2')).out).toBe('foo\n');
  });
});

describe('exec N<>', () => {
  it('reads from the start and writes after', async () => {
    const r = await sh('echo first > rw.txt; exec 8<>rw.txt; read line <&8; echo line=$line; echo second 1>&8; exec 8>&-; cat rw.txt');
    expect(r.out).toBe('line=first\nfirst\nsecond\n');
  });

  it('creates a missing file', async () => {
    expect((await sh('exec 9<>new.txt; echo x >&9; exec 9>&-; cat new.txt')).out).toBe('x\n');
  });
});
