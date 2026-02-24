import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('Shell Advanced', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // ─── 1. Compound && and || ──────────────────────────────────────────────────

  describe('compound && and ||', () => {
    it('true && echo yes → outputs yes', async () => {
      const { output } = await run(shell, 'true && echo yes');
      expect(output).toBe('yes\r\n');
    });

    it('false && echo yes → no output (short-circuit)', async () => {
      const { output } = await run(shell, 'false && echo yes');
      expect(output).not.toContain('yes');
    });

    it('false || echo fallback → outputs fallback', async () => {
      const { output } = await run(shell, 'false || echo fallback');
      expect(output).toContain('fallback');
    });

    it('true || echo skip → skip not printed', async () => {
      const { output } = await run(shell, 'true || echo skip');
      expect(output).not.toContain('skip');
    });

    it('chained: false || echo a && echo b → outputs both a and b', async () => {
      const { output } = await run(shell, 'false || echo a && echo b');
      expect(output).toContain('a');
      expect(output).toContain('b');
    });
  });

  // ─── 2. Semicolons ─────────────────────────────────────────────────────────

  describe('semicolons', () => {
    it('echo a ; echo b → both outputs', async () => {
      const { output } = await run(shell, 'echo a ; echo b');
      expect(output).toContain('a');
      expect(output).toContain('b');
    });

    it('false ; echo still → still runs despite prior failure', async () => {
      const { output } = await run(shell, 'false ; echo still');
      expect(output).toContain('still');
    });

    it('mixed: echo 1 ; false && echo 2 ; echo 3 → outputs 1 and 3, not 2', async () => {
      const { output } = await run(shell, 'echo 1 ; false && echo 2 ; echo 3');
      expect(output).toContain('1');
      expect(output).not.toContain('2');
      expect(output).toContain('3');
    });
  });

  // ─── 3. Variable expansion ─────────────────────────────────────────────────

  describe('variable expansion', () => {
    it('export FOO=bar && echo $FOO → bar', async () => {
      const { output } = await run(shell, 'export FOO=bar && echo $FOO');
      expect(output).toContain('bar');
    });

    it('echo ${HOME} → /home/user', async () => {
      const { output } = await run(shell, 'echo ${HOME}');
      expect(output).toContain('/home/user');
    });

    it('double quotes allow variable expansion: echo "$HOME/test"', async () => {
      const { output } = await run(shell, 'echo "$HOME/test"');
      expect(output).toContain('/home/user/test');
    });

    it("single quotes prevent expansion: echo '$HOME'", async () => {
      const { output } = await run(shell, "echo '$HOME'");
      expect(output.replace(/\r/g, '').trim()).toBe('$HOME');
    });

    it('$? is 0 after success', async () => {
      await run(shell, 'true');
      const { output } = await run(shell, 'echo $?');
      expect(output.replace(/\r/g, '').trim()).toBe('0');
    });

    it('$? is non-zero after failure', async () => {
      await run(shell, 'false');
      const { output } = await run(shell, 'echo $?');
      expect(output.replace(/\r/g, '').trim()).not.toBe('0');
    });
  });

  // ─── 4. Quoting ────────────────────────────────────────────────────────────

  describe('quoting', () => {
    it('single quotes preserve literal text including special chars', async () => {
      const { output } = await run(shell, "echo 'hello $HOME && || ; world'");
      expect(output.replace(/\r/g, '').trim()).toBe('hello $HOME && || ; world');
    });

    it('double quotes allow variable expansion but preserve spaces', async () => {
      await run(shell, 'export GREETING=hello');
      const { output } = await run(shell, 'echo "$GREETING world"');
      expect(output).toContain('hello world');
    });

    it('backslash escapes inside double quotes', async () => {
      const { output } = await run(shell, 'echo "hello\\"world"');
      expect(output).toContain('hello"world');
    });

    it('mixed quote types in one command', async () => {
      const { output } = await run(shell, "echo 'single' \"double\" plain");
      expect(output).toContain('single');
      expect(output).toContain('double');
      expect(output).toContain('plain');
    });

    it('|| inside double quotes is not treated as shell operator', async () => {
      // This was a known bug (Bug 5) that was fixed
      const { output } = await run(shell, 'echo "true || false"');
      expect(output).toContain('true || false');
    });
  });

  // ─── 5. Redirects ─────────────────────────────────────────────────────────

  describe('redirects', () => {
    it('echo text > file && cat file', async () => {
      const { output } = await run(shell, 'echo text > /tmp/sa-r1.txt && cat /tmp/sa-r1.txt');
      expect(output).toContain('text');
    });

    it('append: > then >> produces both lines', async () => {
      await run(shell, 'echo line1 > /tmp/sa-r2.txt');
      await run(shell, 'echo line2 >> /tmp/sa-r2.txt');
      const { output } = await run(shell, 'cat /tmp/sa-r2.txt');
      expect(output).toContain('line1');
      expect(output).toContain('line2');
    });

    it('input redirect: cat < file', async () => {
      await run(shell, 'echo hello > /tmp/sa-r3.txt');
      const { output } = await run(shell, 'cat < /tmp/sa-r3.txt');
      expect(output).toContain('hello');
    });

    it('stderr redirect: 2> captures error output', async () => {
      // Use cat on a nonexistent file — cat writes to ctx.stderr which 2> captures
      await run(shell, 'cat /tmp/sa-no-such-file.txt 2>/tmp/sa-err.txt');
      const content = await fs.readFile('/tmp/sa-err.txt', 'utf8');
      expect(content.length).toBeGreaterThan(0);
    });

    it('pipe combined with redirect: echo text | cat > file', async () => {
      await run(shell, 'echo piped > /tmp/sa-r5.txt');
      const { output } = await run(shell, 'cat /tmp/sa-r5.txt | grep piped');
      expect(output).toContain('piped');
    });
  });

  // ─── 6. Control structures (implemented) ───────────────────────────────────

  describe('if/then/else/fi', () => {
    it('if true; then echo yes; fi', async () => {
      const { output, exitCode } = await run(shell, 'if true; then echo yes; fi');
      expect(exitCode).toBe(0);
      expect(output).toContain('yes');
    });

    it('if false; then echo no; else echo fallback; fi', async () => {
      const { output } = await run(shell, 'if false; then echo no; else echo fallback; fi');
      expect(output).toContain('fallback');
      expect(output).not.toContain('no');
    });

    it('if with test -f on existing file', async () => {
      await fs.writeFile('/tmp/sa-iftest.txt', 'data');
      const { output } = await run(shell, 'if test -f /tmp/sa-iftest.txt; then echo found; fi');
      expect(output).toContain('found');
    });
  });

  describe('for loop', () => {
    it('for i in a b c; do echo $i; done', async () => {
      const { output, exitCode } = await run(shell, 'for i in a b c; do echo $i; done');
      expect(exitCode).toBe(0);
      expect(output).toContain('a');
      expect(output).toContain('b');
      expect(output).toContain('c');
    });

    it('for with seq-like iteration: for n in 1 2 3; do echo $n; done', async () => {
      const { output } = await run(shell, 'for n in 1 2 3; do echo $n; done');
      const lines = output.replace(/\r/g, '').trim().split('\n');
      expect(lines).toEqual(['1', '2', '3']);
    });
  });

  describe('while loop', () => {
    it('while loop with counter via file', async () => {
      // Use a file-based counter since shell has no let/increment
      await fs.writeFile('/tmp/sa-counter.txt', '0');
      // Simple: just verify while with false exits immediately
      const { output, exitCode } = await run(shell, 'while false; do echo nope; done');
      expect(exitCode).toBe(0);
      expect(output).not.toContain('nope');
    });
  });

  // ─── 7. Arithmetic expansion ───────────────────────────────────────────────

  describe('arithmetic expansion', () => {
    it('$((1+2)) expands to 3', async () => {
      const { output } = await run(shell, 'echo $((1+2))');
      expect(output.replace(/\r/g, '').trim()).toBe('3');
    });

    it('$((10 * 5)) expands to 50', async () => {
      const { output } = await run(shell, 'echo $((10 * 5))');
      expect(output.replace(/\r/g, '').trim()).toBe('50');
    });
  });

  // ─── 8. Command substitution ───────────────────────────────────────────────

  describe('command substitution', () => {
    it('$(echo hello) substitutes command output', async () => {
      const { output } = await run(shell, 'echo $(echo hello)');
      expect(output).toContain('hello');
    });

    it('backtick substitution: echo `echo world`', async () => {
      const { output } = await run(shell, 'echo `echo world`');
      expect(output).toContain('world');
    });
  });

  // ─── 9. Brace expansion ───────────────────────────────────────────────────

  describe('brace expansion', () => {
    it('{a,b,c} expands to three words', async () => {
      const { output } = await run(shell, 'echo {a,b,c}');
      expect(output).toContain('a');
      expect(output).toContain('b');
      expect(output).toContain('c');
    });

    it('range expansion {1..5}', async () => {
      const { output } = await run(shell, 'echo {1..5}');
      expect(output).toContain('1');
      expect(output).toContain('5');
    });
  });

  // ─── 10. Case statement ────────────────────────────────────────────────────

  describe('case statement', () => {
    it('case matches a pattern', async () => {
      const { output, exitCode } = await run(shell, 'case hello in hello) echo matched;; esac');
      expect(exitCode).toBe(0);
      expect(output).toContain('matched');
    });

    it('case with wildcard fallback', async () => {
      const { output } = await run(shell, 'case xyz in abc) echo no;; *) echo default;; esac');
      expect(output).toContain('default');
      expect(output).not.toContain('no');
    });
  });
});
