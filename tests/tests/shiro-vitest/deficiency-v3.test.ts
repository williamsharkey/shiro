import { describe, it, expect, beforeEach } from 'vitest';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { createTestShell, run } from './helpers';

describe('Deficiency v3 fixes', () => {
  let fs: FileSystem;
  let shell: Shell;

  beforeEach(async () => {
    const env = await createTestShell();
    fs = env.fs;
    shell = env.shell;
  });

  // ─── Fix 1: $() assignment word-splitting ─────────────────────────────

  describe('Fix 1: $() assignment word-splitting', () => {
    it('VAR=$(echo "one two three") preserves spaces', async () => {
      const { output } = await run(shell, 'VAR=$(echo "hello world"); echo $VAR');
      expect(output.trim()).toBe('hello world');
    });

    it('VAR=$(echo "a b c") preserves all words', async () => {
      const { output } = await run(shell, 'X=$(echo "a b c"); echo $X');
      expect(output.trim()).toBe('a b c');
    });

    it('bare $() in echo still word-splits (bash behavior)', async () => {
      const { output } = await run(shell, 'echo $(echo "hello world")');
      // In bash, bare $() word-splits, but echo joins with space. Either way, output is "hello world"
      expect(output.trim()).toContain('hello');
      expect(output.trim()).toContain('world');
    });
  });

  // ─── Fix 2: while/until loop body parsing ─────────────────────────────

  describe('Fix 2: while/until loop body parsing', () => {
    it('while loop with multi-statement body', async () => {
      const { output } = await run(shell, 'X=0; while [ $X -lt 3 ]; do echo $X; X=$(($X + 1)); done');
      expect(output.trim()).toBe('0\r\n1\r\n2');
    });

    it('until loop with counter', async () => {
      const { output } = await run(shell, 'X=0; until [ $X -eq 3 ]; do echo $X; X=$(($X + 1)); done');
      expect(output.trim()).toBe('0\r\n1\r\n2');
    });

    it('for loop with multi-statement body', async () => {
      const { output } = await run(shell, 'for i in a b c; do echo "item: $i"; done');
      expect(output).toContain('item: a');
      expect(output).toContain('item: b');
      expect(output).toContain('item: c');
    });
  });

  // ─── Fix 3: elif support ──────────────────────────────────────────────

  describe('Fix 3: elif support', () => {
    it('if/elif/else/fi basic', async () => {
      const { output } = await run(shell, 'if false; then echo no; elif true; then echo yes; fi');
      expect(output.trim()).toBe('yes');
    });

    it('if true skips elif', async () => {
      const { output } = await run(shell, 'if true; then echo first; elif true; then echo second; fi');
      expect(output.trim()).toBe('first');
    });

    it('if/elif/else falls to else', async () => {
      const { output } = await run(shell, 'if false; then echo no1; elif false; then echo no2; else echo yes; fi');
      expect(output.trim()).toBe('yes');
    });

    it('multiple elif chains', async () => {
      const { output } = await run(shell, 'X=3; if [ $X -eq 1 ]; then echo one; elif [ $X -eq 2 ]; then echo two; elif [ $X -eq 3 ]; then echo three; fi');
      expect(output.trim()).toBe('three');
    });
  });

  // ─── Fix 4: case statements ───────────────────────────────────────────

  describe('Fix 4: case statements', () => {
    it('basic case match', async () => {
      const { output } = await run(shell, 'case foo in bar) echo no;; foo) echo yes;; esac');
      expect(output.trim()).toBe('yes');
    });

    it('case with wildcard', async () => {
      const { output } = await run(shell, 'case hello in *) echo matched;; esac');
      expect(output.trim()).toBe('matched');
    });

    it('case with pipe alternatives', async () => {
      const { output } = await run(shell, 'case yes in y|yes) echo affirmative;; n|no) echo negative;; esac');
      expect(output.trim()).toBe('affirmative');
    });

    it('case with variable', async () => {
      const { output } = await run(shell, 'CMD=start; case $CMD in start) echo starting;; stop) echo stopping;; esac');
      expect(output.trim()).toBe('starting');
    });
  });

  // ─── Fix 6: Shell function definitions ────────────────────────────────

  describe('Fix 6: shell functions', () => {
    it('basic function definition and call', async () => {
      const { output } = await run(shell, 'greet() { echo "hello $1"; }; greet world');
      expect(output.trim()).toBe('hello world');
    });

    it('function with multiple args', async () => {
      const { output } = await run(shell, 'add() { echo $(($1 + $2)); }; add 3 4');
      expect(output.trim()).toBe('7');
    });

    it('function keyword syntax', async () => {
      const { output } = await run(shell, 'function myfunc { echo works; }; myfunc');
      expect(output.trim()).toBe('works');
    });
  });

  // ─── Fix 7: Advanced parameter expansion ──────────────────────────────

  describe('Fix 7: parameter expansion', () => {
    it('${#VAR} string length', async () => {
      const { output } = await run(shell, 'X=hello; echo ${#X}');
      expect(output.trim()).toBe('5');
    });

    it('${VAR##*/} remove longest prefix', async () => {
      const { output } = await run(shell, 'PATH_VAR=/home/user/file.txt; echo ${PATH_VAR##*/}');
      expect(output.trim()).toBe('file.txt');
    });

    it('${VAR%.*} remove shortest suffix', async () => {
      const { output } = await run(shell, 'FILE=test.tar.gz; echo ${FILE%.*}');
      expect(output.trim()).toBe('test.tar');
    });

    it('${VAR%%.*} remove longest suffix', async () => {
      const { output } = await run(shell, 'FILE=test.tar.gz; echo ${FILE%%.*}');
      expect(output.trim()).toBe('test');
    });

    it('${VAR#*/} remove shortest prefix', async () => {
      const { output } = await run(shell, 'P=/usr/local/bin; echo ${P#*/}');
      expect(output.trim()).toBe('usr/local/bin');
    });

    it('${VAR/old/new} replace first', async () => {
      const { output } = await run(shell, 'S="hello world hello"; echo ${S/hello/hi}');
      expect(output.trim()).toBe('hi world hello');
    });

    it('${VAR//old/new} replace all', async () => {
      const { output } = await run(shell, 'S="hello world hello"; echo ${S//hello/hi}');
      expect(output.trim()).toBe('hi world hi');
    });

    it('${VAR:offset:length} substring', async () => {
      const { output } = await run(shell, 'S=abcdefgh; echo ${S:2:3}');
      expect(output.trim()).toBe('cde');
    });

    it('${VAR^^} uppercase', async () => {
      const { output } = await run(shell, 'S=hello; echo ${S^^}');
      expect(output.trim()).toBe('HELLO');
    });

    it('${VAR,,} lowercase', async () => {
      const { output } = await run(shell, 'S=HELLO; echo ${S,,}');
      expect(output.trim()).toBe('hello');
    });
  });

  // ─── Fix 8: Brace expansion ───────────────────────────────────────────

  describe('Fix 8: brace expansion', () => {
    it('{a,b,c} comma expansion', async () => {
      const { output } = await run(shell, 'echo {a,b,c}');
      expect(output.trim()).toBe('a b c');
    });

    it('prefix{a,b}suffix', async () => {
      const { output } = await run(shell, 'echo file.{js,ts}');
      expect(output.trim()).toBe('file.js file.ts');
    });

    it('{1..5} numeric range', async () => {
      const { output } = await run(shell, 'echo {1..5}');
      expect(output.trim()).toBe('1 2 3 4 5');
    });

    it('{a..e} char range', async () => {
      const { output } = await run(shell, 'echo {a..e}');
      expect(output.trim()).toBe('a b c d e');
    });

    it('{01..05} zero-padded range', async () => {
      const { output } = await run(shell, 'echo {01..05}');
      expect(output.trim()).toBe('01 02 03 04 05');
    });
  });

  // ─── Fix 9: Here-string <<< ───────────────────────────────────────────

  describe('Fix 9: here-string <<<', () => {
    it('cat <<< "hello" reads from here-string', async () => {
      const { output } = await run(shell, 'cat <<< "hello world"');
      expect(output.trim()).toBe('hello world');
    });
  });

  // ─── Fix 10: ! negation prefix ────────────────────────────────────────

  describe('Fix 10: ! negation', () => {
    it('! false returns 0', async () => {
      const { exitCode } = await run(shell, '! false');
      expect(exitCode).toBe(0);
    });

    it('! true returns 1', async () => {
      const { exitCode } = await run(shell, '! true');
      expect(exitCode).toBe(1);
    });

    it('! false && echo ok', async () => {
      const { output } = await run(shell, '! false && echo ok');
      expect(output.trim()).toBe('ok');
    });
  });

  // ─── Fix 11: Subshell () ──────────────────────────────────────────────

  describe('Fix 11: subshell ()', () => {
    it('(echo hello) runs in subshell', async () => {
      const { output } = await run(shell, '(echo hello)');
      expect(output.trim()).toBe('hello');
    });

    it('cd in subshell does not affect parent', async () => {
      shell.cwd = '/home/user';
      await run(shell, '(cd /tmp)');
      expect(shell.cwd).toBe('/home/user');
    });
  });

  // ─── Fix 12: Special variables + declare ──────────────────────────────

  describe('Fix 12: special variables + declare', () => {
    it('$$ returns process ID', async () => {
      const { output } = await run(shell, 'echo $$');
      expect(output.trim()).toBe('1');
    });

    it('$RANDOM returns a number', async () => {
      const { output } = await run(shell, 'echo $RANDOM');
      const num = parseInt(output.trim());
      expect(num).toBeGreaterThanOrEqual(0);
      expect(num).toBeLessThan(32768);
    });

    it('$HOSTNAME returns shiro', async () => {
      const { output } = await run(shell, 'echo $HOSTNAME');
      expect(output.trim()).toBe('shiro');
    });

    it('$BASH_VERSION returns 5.0.0', async () => {
      const { output } = await run(shell, 'echo $BASH_VERSION');
      expect(output.trim()).toBe('5.0.0');
    });

    it('declare VAR=val sets variable', async () => {
      const { output } = await run(shell, 'declare X=hello; echo $X');
      expect(output.trim()).toBe('hello');
    });

    it('local VAR=val sets variable', async () => {
      const { output } = await run(shell, 'local Y=world; echo $Y');
      expect(output.trim()).toBe('world');
    });
  });

  // ─── Fix 18: git -C flag ──────────────────────────────────────────────

  describe('Fix 18: git -C', () => {
    it('git -C <dir> init', async () => {
      await fs.mkdir('/tmp/gittest', { recursive: true });
      const { output, exitCode } = await run(shell, 'git -C /tmp/gittest init');
      expect(exitCode).toBe(0);
      expect(output).toContain('Initialized empty Git repository');
      const exists = await fs.exists('/tmp/gittest/.git');
      expect(exists).toBe(true);
    });
  });
});
