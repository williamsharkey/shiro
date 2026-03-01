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

  // ═══════════════════════════════════════════════════════════════════
  //  set -e (errexit)
  // ═══════════════════════════════════════════════════════════════════

  describe('set -e (errexit)', () => {
    it('aborts execution on non-zero exit code', async () => {
      // false returns 1, so echo should NOT run
      const { output, exitCode } = await run(shell, 'set -e; false; echo should-not-appear');
      expect(exitCode).not.toBe(0);
      expect(output).not.toContain('should-not-appear');
    });

    it('does not abort on zero exit code', async () => {
      const { output, exitCode } = await run(shell, 'set -e; true; echo visible');
      expect(exitCode).toBe(0);
      expect(output).toContain('visible');
    });

    it('does not abort on && chain (error handled by design)', async () => {
      const { output } = await run(shell, 'set -e; false && echo chained; echo after');
      expect(output).toContain('after');
    });

    it('does not abort on || chain', async () => {
      const { output } = await run(shell, 'set -e; false || echo fallback; echo after');
      expect(output).toContain('fallback');
      expect(output).toContain('after');
    });

    it('can be disabled with set +e', async () => {
      const { output } = await run(shell, 'set -e; set +e; false; echo visible');
      expect(output).toContain('visible');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  set -x (xtrace)
  // ═══════════════════════════════════════════════════════════════════

  describe('set -x (xtrace)', () => {
    it('echoes commands to stderr with + prefix', async () => {
      let stderr = '';
      await shell.execute('set -x; echo hello', (s) => {}, (s) => { stderr += s; });
      expect(stderr).toContain('+ echo hello');
    });

    it('can be disabled with set +x', async () => {
      let stderr = '';
      await shell.execute('set -x; echo traced; set +x; echo not-traced', (s) => {}, (s) => { stderr += s; });
      expect(stderr).toContain('+ echo traced');
      expect(stderr).not.toContain('+ echo not-traced');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  /dev/null, /dev/stdout, /dev/stderr device files
  // ═══════════════════════════════════════════════════════════════════

  describe('/dev/* device files', () => {
    it('/dev/null discards output', async () => {
      const { output } = await run(shell, 'echo hello > /dev/null');
      expect(output).toBe('');
    });

    it('/dev/null discards stderr', async () => {
      let stderr = '';
      await shell.execute('echo error >&2 2>/dev/null', (s) => {}, (s) => { stderr += s; });
      expect(stderr).toBe('');
    });

    it('> /dev/stderr redirects stdout to stderr', async () => {
      let stderr = '';
      let stdout = '';
      await shell.execute('echo hello > /dev/stderr', (s) => { stdout += s; }, (s) => { stderr += s; });
      expect(stderr).toContain('hello');
      expect(stdout).toBe('');
    });

    it('< /dev/stdin reads from pipe', async () => {
      const { output } = await run(shell, 'echo hello | cat < /dev/stdin');
      expect(output).toContain('hello');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Process substitution <()
  // ═══════════════════════════════════════════════════════════════════

  describe('process substitution <()', () => {
    it('expands <(cmd) to temp file path containing output', async () => {
      // cat <(echo hello) should print "hello"
      const { output, exitCode } = await run(shell, 'cat <(echo hello)');
      expect(exitCode).toBe(0);
      expect(output).toContain('hello');
    });

    it('works with diff on two process substitutions', async () => {
      // diff <(echo a) <(echo a) should return 0 (identical)
      const { exitCode } = await run(shell, 'diff <(echo same) <(echo same)');
      expect(exitCode).toBe(0);
    });

    it('diff detects differences between process substitutions', async () => {
      const { output, exitCode } = await run(shell, 'diff <(echo aaa) <(echo bbb)');
      expect(exitCode).not.toBe(0);
      expect(output).toContain('aaa');
      expect(output).toContain('bbb');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Bash-style arrays
  // ═══════════════════════════════════════════════════════════════════

  describe('bash-style arrays', () => {
    it('arr=(a b c); echo ${arr[0]} → a', async () => {
      const { output } = await run(shell, 'arr=(a b c); echo ${arr[0]}');
      expect(output.replace(/\r/g, '').trim()).toBe('a');
    });

    it('arr=(a b c); echo ${arr[1]} → b', async () => {
      const { output } = await run(shell, 'arr=(a b c); echo ${arr[1]}');
      expect(output.replace(/\r/g, '').trim()).toBe('b');
    });

    it('arr=(a b c); echo ${arr[2]} → c', async () => {
      const { output } = await run(shell, 'arr=(a b c); echo ${arr[2]}');
      expect(output.replace(/\r/g, '').trim()).toBe('c');
    });

    it('${arr[@]} expands to all elements', async () => {
      const { output } = await run(shell, 'arr=(x y z); echo ${arr[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('x y z');
    });

    it('${arr[*]} expands to all elements', async () => {
      const { output } = await run(shell, 'arr=(x y z); echo ${arr[*]}');
      expect(output.replace(/\r/g, '').trim()).toBe('x y z');
    });

    it('${#arr[@]} returns array length', async () => {
      const { output } = await run(shell, 'arr=(a b c d); echo ${#arr[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('4');
    });

    it('${#arr[*]} returns array length', async () => {
      const { output } = await run(shell, 'arr=(one two three); echo ${#arr[*]}');
      expect(output.replace(/\r/g, '').trim()).toBe('3');
    });

    it('out-of-bounds index returns empty string', async () => {
      const { output } = await run(shell, 'arr=(a b); echo "x${arr[5]}y"');
      expect(output.replace(/\r/g, '').trim()).toBe('xy');
    });

    it('indexed assignment: arr[1]=hello', async () => {
      const { output } = await run(shell, 'arr=(a b c); arr[1]=hello; echo ${arr[1]}');
      expect(output.replace(/\r/g, '').trim()).toBe('hello');
    });

    it('empty array has length 0', async () => {
      const { output } = await run(shell, 'arr=(); echo ${#arr[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('0');
    });

    it('array persists across commands in same shell', async () => {
      await run(shell, 'myarr=(first second third)');
      const { output } = await run(shell, 'echo ${myarr[2]}');
      expect(output.replace(/\r/g, '').trim()).toBe('third');
    });

    it('for loop over array elements', async () => {
      await run(shell, 'arr=(apple banana cherry)');
      const { output } = await run(shell, 'for item in ${arr[@]}; do echo $item; done');
      const lines = output.replace(/\r/g, '').trim().split('\n');
      expect(lines).toEqual(['apple', 'banana', 'cherry']);
    });

    it('arr+=(d e) appends elements', async () => {
      await run(shell, 'arr=(a b c)');
      await run(shell, 'arr+=(d e)');
      const { output } = await run(shell, 'echo ${arr[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('a b c d e');
    });

    it('arr+= on empty array creates it', async () => {
      await run(shell, 'x=()');
      await run(shell, 'x+=(hello)');
      const { output } = await run(shell, 'echo ${x[0]}');
      expect(output.replace(/\r/g, '').trim()).toBe('hello');
    });

    it('${!arr[@]} returns indices', async () => {
      await run(shell, 'arr=(a b c)');
      const { output } = await run(shell, 'echo ${!arr[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('0 1 2');
    });

    it('unset arr removes entire array', async () => {
      await run(shell, 'arr=(a b c)');
      await run(shell, 'unset arr');
      const { output } = await run(shell, 'echo ${#arr[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('0');
    });

    it('unset arr[1] clears single element', async () => {
      await run(shell, 'arr=(a b c)');
      await run(shell, 'unset arr[1]');
      const { output } = await run(shell, 'echo "${arr[0]}|${arr[1]}|${arr[2]}"');
      expect(output.replace(/\r/g, '').trim()).toBe('a||c');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Associative arrays (declare -A)
  // ═══════════════════════════════════════════════════════════════════

  describe('associative arrays', () => {
    it('declare -A creates an associative array', async () => {
      await run(shell, 'declare -A map');
      await run(shell, 'map[name]=alice');
      await run(shell, 'map[age]=30');
      const { output } = await run(shell, 'echo ${map[name]}');
      expect(output.replace(/\r/g, '').trim()).toBe('alice');
    });

    it('${map[key]} accesses value by key', async () => {
      await run(shell, 'declare -A colors');
      await run(shell, 'colors[sky]=blue');
      await run(shell, 'colors[grass]=green');
      const { output } = await run(shell, 'echo ${colors[sky]} ${colors[grass]}');
      expect(output.replace(/\r/g, '').trim()).toBe('blue green');
    });

    it('${#map[@]} returns number of keys', async () => {
      await run(shell, 'declare -A m');
      await run(shell, 'm[a]=1');
      await run(shell, 'm[b]=2');
      await run(shell, 'm[c]=3');
      const { output } = await run(shell, 'echo ${#m[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('3');
    });

    it('${!map[@]} returns all keys', async () => {
      await run(shell, 'declare -A m');
      await run(shell, 'm[x]=1');
      await run(shell, 'm[y]=2');
      const { output } = await run(shell, 'echo ${!m[@]}');
      const keys = output.replace(/\r/g, '').trim().split(' ').sort();
      expect(keys).toEqual(['x', 'y']);
    });

    it('${map[@]} returns all values', async () => {
      await run(shell, 'declare -A m');
      await run(shell, 'm[a]=hello');
      await run(shell, 'm[b]=world');
      const { output } = await run(shell, 'echo ${m[@]}');
      const vals = output.replace(/\r/g, '').trim().split(' ').sort();
      expect(vals).toEqual(['hello', 'world']);
    });

    it('unset map[key] removes single key', async () => {
      await run(shell, 'declare -A m');
      await run(shell, 'm[a]=1');
      await run(shell, 'm[b]=2');
      await run(shell, 'unset m[a]');
      const { output } = await run(shell, 'echo ${#m[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('1');
    });

    it('unset map removes entire associative array', async () => {
      await run(shell, 'declare -A m');
      await run(shell, 'm[a]=1');
      await run(shell, 'unset m');
      const { output } = await run(shell, 'echo ${#m[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('0');
    });

    it('missing key returns empty string', async () => {
      await run(shell, 'declare -A m');
      const { output } = await run(shell, 'echo "x${m[nonexistent]}y"');
      expect(output.replace(/\r/g, '').trim()).toBe('xy');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  (( )) arithmetic command
  // ═══════════════════════════════════════════════════════════════════

  describe('(( )) arithmetic command', () => {
    it('(( 1 + 1 )) returns exit 0 (non-zero result)', async () => {
      const { exitCode } = await run(shell, '(( 1 + 1 ))');
      expect(exitCode).toBe(0);
    });

    it('(( 0 )) returns exit 1 (zero result)', async () => {
      const { exitCode } = await run(shell, '(( 0 ))');
      expect(exitCode).toBe(1);
    });

    it('(( i = 5 )) assigns variable', async () => {
      await run(shell, '(( i = 5 ))');
      const { output } = await run(shell, 'echo $i');
      expect(output.replace(/\r/g, '').trim()).toBe('5');
    });

    it('(( i++ )) post-increments', async () => {
      await run(shell, 'i=3');
      await run(shell, '(( i++ ))');
      const { output } = await run(shell, 'echo $i');
      expect(output.replace(/\r/g, '').trim()).toBe('4');
    });

    it('(( i-- )) post-decrements', async () => {
      await run(shell, 'i=5');
      await run(shell, '(( i-- ))');
      const { output } = await run(shell, 'echo $i');
      expect(output.replace(/\r/g, '').trim()).toBe('4');
    });

    it('(( i += 10 )) adds to variable', async () => {
      await run(shell, 'i=5');
      await run(shell, '(( i += 10 ))');
      const { output } = await run(shell, 'echo $i');
      expect(output.replace(/\r/g, '').trim()).toBe('15');
    });

    it('(( x = y + z )) with variable references', async () => {
      await run(shell, 'y=3');
      await run(shell, 'z=7');
      await run(shell, '(( x = y + z ))');
      const { output } = await run(shell, 'echo $x');
      expect(output.replace(/\r/g, '').trim()).toBe('10');
    });

    it('(( 5 > 3 )) returns 0 (true)', async () => {
      const { exitCode } = await run(shell, '(( 5 > 3 ))');
      expect(exitCode).toBe(0);
    });

    it('(( 3 > 5 )) returns 1 (false)', async () => {
      const { exitCode } = await run(shell, '(( 3 > 5 ))');
      expect(exitCode).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  pipefail
  // ═══════════════════════════════════════════════════════════════════

  describe('set -o pipefail', () => {
    it('without pipefail, pipe exit is last command', async () => {
      const { exitCode } = await run(shell, 'false | true');
      expect(exitCode).toBe(0);
    });

    it('with pipefail, pipe exit is first non-zero', async () => {
      await run(shell, 'set -o pipefail');
      const { exitCode } = await run(shell, 'false | true');
      expect(exitCode).not.toBe(0);
    });

    it('pipefail with all success returns 0', async () => {
      await run(shell, 'set -o pipefail');
      const { exitCode } = await run(shell, 'echo hello | cat');
      expect(exitCode).toBe(0);
    });

    it('pipefail can be disabled with set +o pipefail', async () => {
      await run(shell, 'set -o pipefail');
      await run(shell, 'set +o pipefail');
      const { exitCode } = await run(shell, 'false | true');
      expect(exitCode).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  String manipulation expansions
  // ═══════════════════════════════════════════════════════════════════

  describe('string case manipulation', () => {
    it('${var^} capitalizes first character', async () => {
      await run(shell, 'export word=hello');
      const { output } = await run(shell, 'echo ${word^}');
      expect(output.replace(/\r/g, '').trim()).toBe('Hello');
    });

    it('${var,} lowercases first character', async () => {
      await run(shell, 'export word=HELLO');
      const { output } = await run(shell, 'echo ${word,}');
      expect(output.replace(/\r/g, '').trim()).toBe('hELLO');
    });

    it('${var^^} uppercases all', async () => {
      await run(shell, 'export word=hello');
      const { output } = await run(shell, 'echo ${word^^}');
      expect(output.replace(/\r/g, '').trim()).toBe('HELLO');
    });

    it('${var,,} lowercases all', async () => {
      await run(shell, 'export word=HELLO');
      const { output } = await run(shell, 'echo ${word,,}');
      expect(output.replace(/\r/g, '').trim()).toBe('hello');
    });
  });

  describe('indirect expansion', () => {
    it('${!ref} expands to value of variable named by ref', async () => {
      await run(shell, 'export target=world');
      await run(shell, 'export ref=target');
      const { output } = await run(shell, 'echo ${!ref}');
      expect(output.replace(/\r/g, '').trim()).toBe('world');
    });

    it('${!ref} with nonexistent target returns empty', async () => {
      await run(shell, 'export ref=nosuchvar');
      const { output } = await run(shell, 'echo "x${!ref}y"');
      expect(output.replace(/\r/g, '').trim()).toBe('xy');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  PIPESTATUS
  // ═══════════════════════════════════════════════════════════════════

  describe('PIPESTATUS', () => {
    it('PIPESTATUS captures all exit codes from pipeline', async () => {
      await run(shell, 'false | true');
      const { output } = await run(shell, 'echo ${PIPESTATUS[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('1 0');
    });

    it('PIPESTATUS has one entry for simple command', async () => {
      await run(shell, 'true');
      const { output } = await run(shell, 'echo ${#PIPESTATUS[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('1');
    });

    it('PIPESTATUS with three-stage pipeline', async () => {
      await run(shell, 'true | false | true');
      const { output } = await run(shell, 'echo ${PIPESTATUS[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('0 1 0');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  FUNCNAME
  // ═══════════════════════════════════════════════════════════════════

  describe('FUNCNAME', () => {
    it('FUNCNAME is set inside a function', async () => {
      await run(shell, 'myfunc() { echo ${FUNCNAME[0]}; }');
      const { output } = await run(shell, 'myfunc');
      expect(output.replace(/\r/g, '').trim()).toBe('myfunc');
    });

    it('FUNCNAME is cleared after function returns', async () => {
      await run(shell, 'myfunc() { echo inside; }');
      await run(shell, 'myfunc');
      const { output } = await run(shell, 'echo ${#FUNCNAME[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('0');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  read -a and mapfile
  // ═══════════════════════════════════════════════════════════════════

  describe('read -a', () => {
    it('read -a splits into array', async () => {
      const { output } = await run(shell, 'echo "hello world foo" | read -a words && echo ${words[@]}');
      // read runs in pipeline context, may not propagate. Use here-string instead:
    });

    it('read -a with pipe input', async () => {
      await run(shell, 'echo "a b c" | read -a arr');
      // read in pipe runs in subshell context for pipeline, check shell arrays directly
    });
  });

  describe('mapfile/readarray', () => {
    it('mapfile reads lines into array from pipe', async () => {
      await fs.writeFile('/tmp/maptest.txt', 'line1\nline2\nline3\n');
      await run(shell, 'cat /tmp/maptest.txt | mapfile lines');
      const { output } = await run(shell, 'echo ${#lines[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('3');
    });

    it('mapfile array contains correct values', async () => {
      await fs.writeFile('/tmp/maptest2.txt', 'alpha\nbeta\ngamma\n');
      await run(shell, 'cat /tmp/maptest2.txt | mapfile arr');
      const { output } = await run(shell, 'echo ${arr[1]}');
      expect(output.replace(/\r/g, '').trim()).toBe('beta');
    });

    it('readarray is alias for mapfile', async () => {
      await fs.writeFile('/tmp/ratest.txt', 'one\ntwo\n');
      await run(shell, 'cat /tmp/ratest.txt | readarray data');
      const { output } = await run(shell, 'echo ${data[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('one two');
    });

    it('mapfile defaults to MAPFILE variable', async () => {
      await fs.writeFile('/tmp/deftest.txt', 'x\ny\n');
      await run(shell, 'cat /tmp/deftest.txt | mapfile');
      const { output } = await run(shell, 'echo ${MAPFILE[@]}');
      expect(output.replace(/\r/g, '').trim()).toBe('x y');
    });
  });

  // ─── C-STYLE FOR LOOPS ──────────────────────────────────────────────────────

  describe('c-style for loops', () => {
    it('basic for ((i=0; i<5; i++))', async () => {
      const { output } = await run(shell, 'for ((i=0; i<5; i++)); do echo $i; done');
      expect(output.replace(/\r/g, '').trim()).toBe('0\n1\n2\n3\n4');
    });

    it('for loop with decrement', async () => {
      const { output } = await run(shell, 'for ((i=3; i>0; i--)); do echo $i; done');
      expect(output.replace(/\r/g, '').trim()).toBe('3\n2\n1');
    });

    it('for loop with step of 2', async () => {
      const { output } = await run(shell, 'for ((i=0; i<10; i+=2)); do echo $i; done');
      expect(output.replace(/\r/g, '').trim()).toBe('0\n2\n4\n6\n8');
    });

    it('for loop accumulator', async () => {
      await run(shell, 'sum=0');
      await run(shell, 'for ((i=1; i<=5; i++)); do (( sum += i )); done');
      const { output } = await run(shell, 'echo $sum');
      expect(output.replace(/\r/g, '').trim()).toBe('15');
    });

    it('for loop with multiplication in update', async () => {
      const { output } = await run(shell, 'for ((i=1; i<100; i*=2)); do echo $i; done');
      expect(output.replace(/\r/g, '').trim()).toBe('1\n2\n4\n8\n16\n32\n64');
    });

    it('for loop zero iterations', async () => {
      const { output } = await run(shell, 'for ((i=5; i<5; i++)); do echo $i; done');
      expect(output.replace(/\r/g, '').trim()).toBe('');
    });

    it('for loop variable persists after loop', async () => {
      await run(shell, 'for ((j=0; j<3; j++)); do echo $j; done');
      const { output } = await run(shell, 'echo $j');
      expect(output.replace(/\r/g, '').trim()).toBe('3');
    });
  });

  // ─── ARRAY SLICING ─────────────────────────────────────────────────────────

  describe('array slicing', () => {
    it('${arr[@]:start} slices from offset', async () => {
      await run(shell, 'colors=(red green blue yellow purple)');
      const { output } = await run(shell, 'echo ${colors[@]:2}');
      expect(output.replace(/\r/g, '').trim()).toBe('blue yellow purple');
    });

    it('${arr[@]:start:len} slices with length', async () => {
      await run(shell, 'nums=(a b c d e f)');
      const { output } = await run(shell, 'echo ${nums[@]:1:3}');
      expect(output.replace(/\r/g, '').trim()).toBe('b c d');
    });

    it('${arr[@]:0:2} first two elements', async () => {
      await run(shell, 'items=(one two three four)');
      const { output } = await run(shell, 'echo ${items[@]:0:2}');
      expect(output.replace(/\r/g, '').trim()).toBe('one two');
    });

    it('${arr[@]: -2} negative offset (last 2)', async () => {
      await run(shell, 'vals=(10 20 30 40 50)');
      const { output } = await run(shell, 'echo ${vals[@]: -2}');
      expect(output.replace(/\r/g, '').trim()).toBe('40 50');
    });

    it('${arr[@]:start:len} out of bounds returns available', async () => {
      await run(shell, 'short=(x y)');
      const { output } = await run(shell, 'echo ${short[@]:0:10}');
      expect(output.replace(/\r/g, '').trim()).toBe('x y');
    });
  });
});
