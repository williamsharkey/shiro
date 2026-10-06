import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

// github.com/williamsharkey/shiro/issues/74
describe('issue 74: shell pipes, redirects, read, brace groups', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
  });

  async function sh(cmd: string) {
    let out = '';
    let err = '';
    const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
    return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
  }
  const read = async (p: string) => (await fs.readFile(p, 'utf8')) as string;

  describe('functions and builtins honor pipes and redirects', () => {
    it('function output redirected to a file', async () => {
      await sh('f() { echo out; }');
      const r = await sh('f > /tmp/x');
      expect(r.out).toBe('');
      expect(await read('/tmp/x')).toBe('out\n');
      await sh('f >> /tmp/x');
      expect(await read('/tmp/x')).toBe('out\nout\n');
    });

    it('function output piped onward', async () => {
      await sh('f() { echo out; }');
      expect((await sh('f | tr a-z A-Z')).out).toBe('OUT\n');
    });

    it('command -v / type with output discarded', async () => {
      expect((await sh('command -v ls >/dev/null 2>&1')).out).toBe('');
      expect((await sh('command -v ls >/dev/null 2>&1 && echo yes')).out).toBe('yes\n');
      expect((await sh('type ls > /dev/null')).out).toBe('');
    });

    it('eval, sh -c, env, aliases redirected', async () => {
      await sh('eval echo hi > /tmp/e');
      expect(await read('/tmp/e')).toBe('hi\n');
      await sh('/bin/sh -c "echo sh" > /tmp/s');
      expect(await read('/tmp/s')).toBe('sh\n');
      await sh('/usr/bin/env echo env > /tmp/v');
      expect(await read('/tmp/v')).toBe('env\n');
      await sh("alias hey='echo hey'");
      expect((await sh('hey | tr a-z A-Z')).out).toBe('HEY\n');
    });

    it('builtin stderr redirect', async () => {
      const r = await sh('cd /nonexistent-dir 2>/dev/null');
      expect(r.err).toBe('');
      expect(r.code).not.toBe(0);
    });

    it('functions read piped stdin', async () => {
      await sh('g() { cat; }');
      expect((await sh('echo hi | g')).out).toBe('hi\n');
      await sh('h() { read a; echo "got $a"; }');
      expect((await sh('echo yo | h')).out).toBe('got yo\n');
      expect((await sh('h <<< there')).out).toBe('got there\n');
    });

    it('eval and sh -c get piped stdin', async () => {
      expect((await sh('echo abc | eval cat')).out).toBe('abc\n');
      expect((await sh('echo abc | sh -c cat')).out).toBe('abc\n');
    });

    it('a loop in the middle of a pipeline pipes its output on', async () => {
      expect((await sh('printf "a\\nb\\n" | while read l; do echo "$l"; done | tr a-z A-Z')).out).toBe('A\nB\n');
    });
  });

  describe('control structures after a pipe expand their own variables', () => {
    it('while read', async () => {
      expect((await sh('echo y | while read line; do echo "[$line]"; done')).out).toBe('[y]\n');
    });
    it('for', async () => {
      expect((await sh('echo y | for j in 1; do echo $j; done')).out).toBe('1\n');
    });
    it('if', async () => {
      expect((await sh('echo y | if true; then n=7; echo $n; fi')).out).toBe('7\n');
    });
    it('pipeline inside the loop body', async () => {
      const r = await sh('echo hello | while read l; do set | grep "^l=" ; done');
      expect(r.out).toBe('l=hello\n');
    });
    it('outer variables still expand in earlier segments', async () => {
      await sh('v=abc');
      expect((await sh('echo $v | while read x; do echo "<$x>"; done')).out).toBe('<abc>\n');
    });
  });

  describe('read redirects', () => {
    it('here-string', async () => {
      const r = await sh('read v <<< hello; echo "[$v]"');
      expect(r.out).toBe('[hello]\n');
    });
    it('exit status with here-string', async () => {
      expect((await sh('read v <<< hello')).code).toBe(0);
    });
    it('< file', async () => {
      await fs.writeFile('/tmp/f', 'first\nsecond\n');
      expect((await sh('read w < /tmp/f; echo "[$w]"')).out).toBe('[first]\n');
    });
  });

  describe('variable contents are data', () => {
    it('pipe character', async () => {
      expect((await sh('x="a|b"; echo $x')).out).toBe('a|b\n');
    });
    it('redirect characters', async () => {
      expect((await sh('x="a > b"; echo $x')).out).toBe('a > b\n');
      expect(await fs.exists('/home/user/b')).toBe(false);
      expect((await sh('x="a<b&c"; echo "$x"')).out).toBe('a<b&c\n');
    });
    it('command substitution output', async () => {
      expect((await sh('echo "$(echo "x|y")"')).out).toBe('x|y\n');
    });
  });

  describe('brace groups', () => {
    it('redirected', async () => {
      await sh('{ echo a; echo b; } > /tmp/g');
      expect(await read('/tmp/g')).toBe('a\nb\n');
    });
    it('reading a pipe', async () => {
      expect((await sh('echo y | { read q; echo $q; }')).out).toBe('y\n');
    });
    it('piped onward and in && chains', async () => {
      expect((await sh('{ echo b; echo a; } | sort')).out).toBe('a\nb\n');
      expect((await sh('true && { echo yes; }')).out).toBe('yes\n');
    });
    it('runs in the current shell', async () => {
      expect((await sh('{ z=5; }; echo $z')).out).toBe('5\n');
    });
  });

  describe('wc', () => {
    beforeEach(async () => {
      await fs.writeFile('/tmp/a', 'one\ntwo\n');
      await fs.writeFile('/tmp/b', 'three');
    });
    it('prints a line per file and a total', async () => {
      const r = await sh('wc /tmp/a /tmp/b');
      const lines = r.out.trimEnd().split('\n').map((l) => l.trim().split(/\s+/));
      expect(lines).toEqual([
        ['2', '2', '8', '/tmp/a'],
        ['0', '1', '5', '/tmp/b'],
        ['2', '3', '13', 'total'],
      ]);
    });
    it('-c counts bytes, -m characters', async () => {
      await fs.writeFile('/tmp/u', 'héllo\n');
      expect((await sh('wc -c /tmp/u')).out.trim().split(/\s+/)).toEqual(['7', '/tmp/u']);
      expect((await sh('wc -m /tmp/u')).out.trim().split(/\s+/)).toEqual(['6', '/tmp/u']);
    });
    it('counts newlines for stdin', async () => {
      expect((await sh('printf "a\\nb" | wc -l')).out.trim()).toBe('1');
      expect((await sh('echo hi | wc -c')).out.trim()).toBe('3');
    });
  });
});
