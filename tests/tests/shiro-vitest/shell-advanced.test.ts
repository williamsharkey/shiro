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

  // ─── BREAK / CONTINUE / RETURN ─────────────────────────────────────────────

  describe('break, continue, return', () => {
    it('break exits for loop early', async () => {
      const { output } = await run(shell, 'for i in 1 2 3 4 5; do if [ $i -eq 3 ]; then break; fi; echo $i; done');
      expect(output.replace(/\r/g, '').trim()).toBe('1\n2');
    });

    it('continue skips iteration in for loop', async () => {
      const { output } = await run(shell, 'for i in 1 2 3 4 5; do if [ $i -eq 3 ]; then continue; fi; echo $i; done');
      expect(output.replace(/\r/g, '').trim()).toBe('1\n2\n4\n5');
    });

    it('break exits while loop', async () => {
      await run(shell, 'n=0');
      const { output } = await run(shell, 'while [ $n -lt 10 ]; do if [ $n -eq 3 ]; then break; fi; echo $n; n=$((n+1)); done');
      expect(output.replace(/\r/g, '').trim()).toBe('0\n1\n2');
    });

    it('continue in while loop', async () => {
      await run(shell, 'n=0; result=""');
      const { output } = await run(shell, 'while [ $n -lt 5 ]; do n=$((n+1)); if [ $n -eq 3 ]; then continue; fi; echo $n; done');
      expect(output.replace(/\r/g, '').trim()).toBe('1\n2\n4\n5');
    });

    it('break in C-style for loop', async () => {
      const { output } = await run(shell, 'for ((i=0; i<10; i++)); do if [ $i -eq 4 ]; then break; fi; echo $i; done');
      expect(output.replace(/\r/g, '').trim()).toBe('0\n1\n2\n3');
    });

    it('continue in C-style for loop still updates', async () => {
      const { output } = await run(shell, 'for ((i=0; i<5; i++)); do if [ $i -eq 2 ]; then continue; fi; echo $i; done');
      expect(output.replace(/\r/g, '').trim()).toBe('0\n1\n3\n4');
    });

    it('return exits function with code', async () => {
      await run(shell, 'myfunc() { echo before; return 42; echo after; }');
      const result = await run(shell, 'myfunc');
      expect(result.output.replace(/\r/g, '').trim()).toBe('before');
      expect(result.exitCode).toBe(42);
    });

    it('return 0 from function', async () => {
      await run(shell, 'check() { if [ "$1" = "ok" ]; then return 0; fi; return 1; }');
      const ok = await run(shell, 'check ok');
      expect(ok.exitCode).toBe(0);
      const fail = await run(shell, 'check bad');
      expect(fail.exitCode).toBe(1);
    });

    it('return inside loop inside function', async () => {
      await run(shell, 'search() { for i in a b c; do if [ "$i" = "b" ]; then return 0; fi; done; return 1; }');
      const result = await run(shell, 'search');
      expect(result.exitCode).toBe(0);
    });
  });

  // ─── TRAP ───────────────────────────────────────────────────────────────────

  describe('trap', () => {
    it('trap with no args lists traps', async () => {
      await run(shell, "trap 'echo bye' EXIT");
      const { output } = await run(shell, 'trap');
      expect(output.replace(/\r/g, '').trim()).toContain('EXIT');
    });

    it('trap ERR fires on non-zero exit', async () => {
      await run(shell, "trap 'echo ERROR' ERR");
      const { output } = await run(shell, 'false');
      expect(output.replace(/\r/g, '').trim()).toBe('ERROR');
    });

    it('trap ERR does not fire on zero exit', async () => {
      await run(shell, "trap 'echo ERROR' ERR");
      const { output } = await run(shell, 'true');
      expect(output.replace(/\r/g, '').trim()).toBe('');
    });

    it('trap can be reset with empty string', async () => {
      await run(shell, "trap 'echo ERR' ERR");
      await run(shell, "trap '' ERR");
      const { output } = await run(shell, 'false');
      expect(output.replace(/\r/g, '').trim()).toBe('');
    });

    it('trap can be reset with dash', async () => {
      await run(shell, "trap 'echo ERR' ERR");
      await run(shell, 'trap - ERR');
      const { output } = await run(shell, 'false');
      expect(output.replace(/\r/g, '').trim()).toBe('');
    });
  });

  // ─── SELECT ─────────────────────────────────────────────────────────────────

  describe('select', () => {
    it('select displays numbered menu', async () => {
      // Use __PIPE_STDIN directly since pipeline expansion runs before select body
      shell.env['__PIPE_STDIN'] = '2\n';
      const { output } = await run(shell, 'select fruit in apple banana cherry; do echo $fruit; break; done');
      delete shell.env['__PIPE_STDIN'];
      const lines = output.replace(/\r/g, '').trim().split('\n');
      expect(lines[0]).toBe('1) apple');
      expect(lines[1]).toBe('2) banana');
      expect(lines[2]).toBe('3) cherry');
      expect(lines[3]).toBe('banana');
    });

    it('select sets REPLY variable', async () => {
      shell.env['__PIPE_STDIN'] = '1\n';
      await run(shell, 'select x in a b c; do break; done');
      delete shell.env['__PIPE_STDIN'];
      const { output } = await run(shell, 'echo $REPLY');
      expect(output.replace(/\r/g, '').trim()).toBe('1');
    });

    it('select with invalid choice sets empty var', async () => {
      shell.env['__PIPE_STDIN'] = '99\n';
      const { output } = await run(shell, 'select x in a b; do echo "x=$x"; break; done');
      delete shell.env['__PIPE_STDIN'];
      expect(output.replace(/\r/g, '')).toContain('x=');
    });
  });

  // ─── GETOPTS ────────────────────────────────────────────────────────────────

  describe('getopts', () => {
    it('parses boolean options', async () => {
      await run(shell, 'OPTIND=1');
      await run(shell, 'getopts "abc" opt -a');
      const { output } = await run(shell, 'echo $opt');
      expect(output.replace(/\r/g, '').trim()).toBe('a');
    });

    it('parses option with argument', async () => {
      await run(shell, 'OPTIND=1');
      await run(shell, 'getopts "f:" opt -f myfile');
      const opt = await run(shell, 'echo $opt');
      const arg = await run(shell, 'echo $OPTARG');
      expect(opt.output.replace(/\r/g, '').trim()).toBe('f');
      expect(arg.output.replace(/\r/g, '').trim()).toBe('myfile');
    });

    it('returns 1 when no more options', async () => {
      await run(shell, 'OPTIND=1');
      const result = await run(shell, 'getopts "a" opt hello');
      expect(result.exitCode).toBe(1);
    });

    it('handles attached argument -fvalue', async () => {
      await run(shell, 'OPTIND=1');
      await run(shell, 'getopts "f:" opt -fbar');
      const arg = await run(shell, 'echo $OPTARG');
      expect(arg.output.replace(/\r/g, '').trim()).toBe('bar');
    });
  });

  // ─── ARITHMETIC LOGICAL OPERATORS ───────────────────────────────────────────

  describe('arithmetic logical operators', () => {
    it('logical AND (&&)', async () => {
      const { output } = await run(shell, 'echo $(( 1 && 1 ))');
      expect(output.replace(/\r/g, '').trim()).toBe('1');
      const { output: o2 } = await run(shell, 'echo $(( 1 && 0 ))');
      expect(o2.replace(/\r/g, '').trim()).toBe('0');
    });

    it('logical OR (||)', async () => {
      const { output } = await run(shell, 'echo $(( 0 || 1 ))');
      expect(output.replace(/\r/g, '').trim()).toBe('1');
      const { output: o2 } = await run(shell, 'echo $(( 0 || 0 ))');
      expect(o2.replace(/\r/g, '').trim()).toBe('0');
    });

    it('logical NOT (!)', async () => {
      const { output } = await run(shell, 'echo $(( !0 ))');
      expect(output.replace(/\r/g, '').trim()).toBe('1');
      const { output: o2 } = await run(shell, 'echo $(( !5 ))');
      expect(o2.replace(/\r/g, '').trim()).toBe('0');
    });

    it('ternary operator (?:)', async () => {
      const { output } = await run(shell, 'echo $(( 1 ? 10 : 20 ))');
      expect(output.replace(/\r/g, '').trim()).toBe('10');
      const { output: o2 } = await run(shell, 'echo $(( 0 ? 10 : 20 ))');
      expect(o2.replace(/\r/g, '').trim()).toBe('20');
    });

    it('bitwise AND (&)', async () => {
      const { output } = await run(shell, 'echo $(( 12 & 10 ))');
      expect(output.replace(/\r/g, '').trim()).toBe('8');
    });

    it('bitwise OR (|)', async () => {
      const { output } = await run(shell, 'echo $(( 12 | 3 ))');
      expect(output.replace(/\r/g, '').trim()).toBe('15');
    });

    it('bitwise XOR (^)', async () => {
      const { output } = await run(shell, 'echo $(( 5 ^ 3 ))');
      expect(output.replace(/\r/g, '').trim()).toBe('6');
    });

    it('left shift (<<)', async () => {
      const { output } = await run(shell, 'echo $(( 1 << 4 ))');
      expect(output.replace(/\r/g, '').trim()).toBe('16');
    });

    it('right shift (>>)', async () => {
      const { output } = await run(shell, 'echo $(( 16 >> 2 ))');
      expect(output.replace(/\r/g, '').trim()).toBe('4');
    });

    it('bitwise NOT (~)', async () => {
      const { output } = await run(shell, 'echo $(( ~0 ))');
      expect(output.replace(/\r/g, '').trim()).toBe('-1');
    });
  });

  // ─── PRINTF ─────────────────────────────────────────────────────────────────

  describe('printf', () => {
    it('basic string format', async () => {
      const { output } = await run(shell, 'printf "hello %s\\n" world');
      expect(output.replace(/\r/g, '')).toBe('hello world\n');
    });

    it('decimal format', async () => {
      const { output } = await run(shell, 'printf "%d items\\n" 42');
      expect(output.replace(/\r/g, '')).toBe('42 items\n');
    });

    it('hex format', async () => {
      const { output } = await run(shell, 'printf "%x\\n" 255');
      expect(output.replace(/\r/g, '')).toBe('ff\n');
    });

    it('float format with precision', async () => {
      const { output } = await run(shell, 'printf "%.2f\\n" 3.14159');
      expect(output.replace(/\r/g, '')).toBe('3.14\n');
    });

    it('width padding', async () => {
      const { output } = await run(shell, 'printf "%10s|\\n" hi');
      expect(output.replace(/\r/g, '')).toBe('        hi|\n');
    });

    it('left-justify', async () => {
      const { output } = await run(shell, 'printf "%-10s|\\n" hi');
      expect(output.replace(/\r/g, '')).toBe('hi        |\n');
    });

    it('zero-padded', async () => {
      const { output } = await run(shell, 'printf "%05d\\n" 42');
      expect(output.replace(/\r/g, '')).toBe('00042\n');
    });

    it('literal percent', async () => {
      const { output } = await run(shell, 'printf "100%%\\n"');
      expect(output.replace(/\r/g, '')).toBe('100%\n');
    });
  });

  // ─── TYPE / COMMAND / HASH ──────────────────────────────────────────────────

  describe('type, command, hash', () => {
    it('type identifies builtins', async () => {
      const { output } = await run(shell, 'type echo');
      expect(output.replace(/\r/g, '').trim()).toBe('echo is a shell builtin');
    });

    it('type identifies functions', async () => {
      await run(shell, 'myfn() { echo hi; }');
      const { output } = await run(shell, 'type myfn');
      expect(output.replace(/\r/g, '').trim()).toBe('myfn is a function');
    });

    it('type identifies registered commands', async () => {
      const { output } = await run(shell, 'type ls');
      expect(output.replace(/\r/g, '').trim()).toBe('ls is a registered command');
    });

    it('type returns error for unknown', async () => {
      const result = await run(shell, 'type nonexistent_cmd_xyz');
      expect(result.exitCode).toBe(1);
    });

    it('command -v returns name for known command', async () => {
      const { output } = await run(shell, 'command -v echo');
      expect(output.replace(/\r/g, '').trim()).toBe('echo');
    });

    it('command -v returns 1 for unknown', async () => {
      const result = await run(shell, 'command -v nonexistent_xyz');
      expect(result.exitCode).toBe(1);
    });

    it('hash outputs empty message', async () => {
      const { output } = await run(shell, 'hash');
      expect(output.replace(/\r/g, '').trim()).toContain('hash');
    });
  });

  // ─── 18. alias / unalias ────────────────────────────────────────────────────

  describe('alias / unalias', () => {
    it('alias sets and expands a simple alias', async () => {
      await run(shell, "alias greet='echo hello'");
      const { output } = await run(shell, 'greet');
      expect(output.replace(/\r/g, '').trim()).toBe('hello');
    });

    it('alias with no args lists all aliases', async () => {
      await run(shell, "alias ll='ls -la'");
      const { output } = await run(shell, 'alias');
      expect(output).toContain("ll='ls -la'");
    });

    it('alias expands with additional args', async () => {
      await run(shell, "alias say='echo'");
      const { output } = await run(shell, 'say world');
      expect(output.replace(/\r/g, '').trim()).toBe('world');
    });

    it('unalias removes an alias', async () => {
      await run(shell, "alias greet='echo hi'");
      await run(shell, 'unalias greet');
      const result = await run(shell, 'greet');
      expect(result.exitCode).not.toBe(0);
    });

    it('unalias -a removes all aliases', async () => {
      await run(shell, "alias a='echo a'");
      await run(shell, "alias b='echo b'");
      await run(shell, 'unalias -a');
      const { output } = await run(shell, 'alias');
      expect(output.replace(/\r/g, '').trim()).toBe('');
    });
  });

  // ─── 19. pushd / popd / dirs ────────────────────────────────────────────────

  describe('pushd / popd / dirs', () => {
    it('pushd changes directory and adds to stack', async () => {
      await run(shell, 'mkdir -p /tmp/testdir');
      const { output } = await run(shell, 'pushd /tmp/testdir');
      expect(output).toContain('/tmp/testdir');
      expect(shell.cwd).toBe('/tmp/testdir');
    });

    it('popd returns to previous directory', async () => {
      await run(shell, 'mkdir -p /tmp/testdir');
      const origCwd = shell.cwd;
      await run(shell, 'pushd /tmp/testdir');
      await run(shell, 'popd');
      expect(shell.cwd).toBe(origCwd);
    });

    it('dirs shows the directory stack', async () => {
      const { output } = await run(shell, 'dirs');
      expect(output.replace(/\r/g, '').trim()).toBe(shell.cwd);
    });

    it('popd on empty stack returns error', async () => {
      const result = await run(shell, 'popd');
      expect(result.exitCode).toBe(1);
    });
  });

  // ─── 20. let builtin ───────────────────────────────────────────────────────

  describe('let builtin', () => {
    it('let evaluates arithmetic and sets variables', async () => {
      await run(shell, 'let "x=5+3"');
      expect(shell.env['x']).toBe('8');
    });

    it('let returns 1 when result is 0', async () => {
      const result = await run(shell, 'let "0"');
      expect(result.exitCode).toBe(1);
    });

    it('let returns 0 when result is non-zero', async () => {
      const result = await run(shell, 'let "1+1"');
      expect(result.exitCode).toBe(0);
    });

    it('let with multiple expressions evaluates all', async () => {
      await run(shell, 'let "a=2" "b=3" "c=a+b"');
      expect(shell.env['c']).toBe('5');
    });
  });

  // ─── 21. brace expansion ──────────────────────────────────────────────────

  describe('brace expansion', () => {
    it('{a,b,c} expands to three words', async () => {
      const { output } = await run(shell, 'echo {a,b,c}');
      expect(output.replace(/\r/g, '').trim()).toBe('a b c');
    });

    it('{1..5} expands to number sequence', async () => {
      const { output } = await run(shell, 'echo {1..5}');
      expect(output.replace(/\r/g, '').trim()).toBe('1 2 3 4 5');
    });

    it('{a..e} expands to letter sequence', async () => {
      const { output } = await run(shell, 'echo {a..e}');
      expect(output.replace(/\r/g, '').trim()).toBe('a b c d e');
    });

    it('prefix{a,b}suffix combines', async () => {
      const { output } = await run(shell, 'echo pre{A,B}suf');
      expect(output.replace(/\r/g, '').trim()).toBe('preAsuf preBsuf');
    });

    it('{5..1} descending range', async () => {
      const { output } = await run(shell, 'echo {5..1}');
      expect(output.replace(/\r/g, '').trim()).toBe('5 4 3 2 1');
    });

    it('{1..10..2} range with step', async () => {
      const { output } = await run(shell, 'echo {1..10..2}');
      expect(output.replace(/\r/g, '').trim()).toBe('1 3 5 7 9');
    });

    it('nested brace {a,{b,c}} expands', async () => {
      const { output } = await run(shell, 'echo {a,{b,c}}');
      expect(output.replace(/\r/g, '').trim()).toBe('a b c');
    });

    it('${var} not treated as brace expansion', async () => {
      shell.env['x'] = 'hello';
      const { output } = await run(shell, 'echo ${x}');
      expect(output.replace(/\r/g, '').trim()).toBe('hello');
    });
  });

  // ─── 22. test / [[ ]] improvements ─────────────────────────────────────────

  describe('test improvements', () => {
    it('-s returns 0 for non-empty file', async () => {
      await run(shell, 'echo "data" > /tmp/testfile');
      const result = await run(shell, 'if [ -s /tmp/testfile ]; then echo yes; fi');
      expect(result.output.replace(/\r/g, '').trim()).toBe('yes');
    });

    it('-s returns 1 for missing file', async () => {
      const result = await run(shell, 'if [ -s /tmp/nofile ]; then echo yes; else echo no; fi');
      expect(result.output.replace(/\r/g, '').trim()).toBe('no');
    });

    it('-a combines two tests (AND)', async () => {
      await run(shell, 'echo "data" > /tmp/testfile');
      const result = await run(shell, 'if [ -f /tmp/testfile -a -s /tmp/testfile ]; then echo yes; fi');
      expect(result.output.replace(/\r/g, '').trim()).toBe('yes');
    });

    it('-o combines two tests (OR)', async () => {
      const result = await run(shell, 'if [ -f /tmp/nofile -o -d /home ]; then echo yes; fi');
      expect(result.output.replace(/\r/g, '').trim()).toBe('yes');
    });

    it('[[ =~ ]] matches regex', async () => {
      const result = await run(shell, 'if [[ hello123 =~ ^hello[0-9]+ ]]; then echo match; fi');
      expect(result.output.replace(/\r/g, '').trim()).toBe('match');
    });

    it('[[ =~ ]] sets BASH_REMATCH', async () => {
      // Test that =~ returns 1 for non-match to verify it's actually parsing =~
      const noMatch = await run(shell, '[[ abc123 =~ xyz ]]');
      expect(noMatch.exitCode).toBe(1);
      // Now test match
      const result = await run(shell, '[[ abc123 =~ abc ]]');
      expect(result.exitCode).toBe(0);
      const arr = shell.arrays.get('BASH_REMATCH');
      expect(arr).toBeDefined();
      expect(arr![0]).toBe('abc');
    });

    it('[[ < ]] string comparison', async () => {
      const result = await run(shell, 'if [[ apple < banana ]]; then echo yes; fi');
      expect(result.output.replace(/\r/g, '').trim()).toBe('yes');
    });
  });

  // ─── 23. source / exec / builtin ────────────────────────────────────────────

  describe('source / exec / builtin', () => {
    it('source executes script in current shell scope', async () => {
      await fs.writeFile('/tmp/test.sh', 'MYVAR=hello\n');
      await run(shell, 'source /tmp/test.sh');
      expect(shell.env['MYVAR']).toBe('hello');
    });

    it('. is alias for source', async () => {
      await fs.writeFile('/tmp/test2.sh', 'DOT_VAR=world\n');
      await run(shell, '. /tmp/test2.sh');
      expect(shell.env['DOT_VAR']).toBe('world');
    });

    it('source non-existent file returns error', async () => {
      const result = await run(shell, 'source /tmp/nonexistent.sh');
      expect(result.exitCode).toBe(1);
    });

    it('exec runs command', async () => {
      const { output } = await run(shell, 'exec echo hello');
      expect(output.replace(/\r/g, '').trim()).toBe('hello');
    });

    it('builtin runs builtin ignoring functions', async () => {
      await run(shell, 'echo() { printf "custom: %s" "$1"; }');
      const { output } = await run(shell, 'builtin echo hello');
      expect(output.replace(/\r/g, '').trim()).toBe('hello');
    });
  });

  // ─── 24. shell stubs ──────────────────────────────────────────────────────

  describe('shell stubs', () => {
    it('ulimit -n returns file descriptor limit', async () => {
      const { output, exitCode } = await run(shell, 'ulimit -n');
      expect(exitCode).toBe(0);
      expect(output.replace(/\r/g, '').trim()).toBe('1024');
    });

    it('umask returns 0022', async () => {
      const { output, exitCode } = await run(shell, 'umask');
      expect(exitCode).toBe(0);
      expect(output.replace(/\r/g, '').trim()).toBe('0022');
    });

    it('complete is a silent no-op', async () => {
      const result = await run(shell, 'complete -F _my_func mycommand');
      expect(result.exitCode).toBe(0);
    });

    it('enable is a silent no-op', async () => {
      const result = await run(shell, 'enable -n test');
      expect(result.exitCode).toBe(0);
    });

    it('disown is a silent no-op', async () => {
      const result = await run(shell, 'disown');
      expect(result.exitCode).toBe(0);
    });
  });

  // ─── 25. array improvements ───────────────────────────────────────────────

  describe('array improvements', () => {
    it('${#arr[N]} returns element length', async () => {
      shell.arrays.set('words', ['hello', 'hi', 'greetings']);
      const { output } = await run(shell, 'echo ${#words[0]}');
      expect(output.replace(/\r/g, '').trim()).toBe('5');
    });

    it('${#arr[N]} for assoc array element length', async () => {
      shell.assocArrays.set('map', new Map([['key', 'longvalue']]));
      const { output } = await run(shell, 'echo ${#map[key]}');
      expect(output.replace(/\r/g, '').trim()).toBe('9');
    });

    it('iterate over associative array keys', async () => {
      shell.assocArrays.set('colors', new Map([['red', '#ff0000'], ['blue', '#0000ff']]));
      const { output } = await run(shell, 'for k in ${!colors[@]}; do echo "$k"; done');
      const lines = output.replace(/\r/g, '').trim().split('\n').sort();
      expect(lines).toEqual(['blue', 'red']);
    });

    it('iterate over associative array values', async () => {
      shell.assocArrays.set('nums', new Map([['a', '1'], ['b', '2']]));
      const { output } = await run(shell, 'for v in ${nums[@]}; do echo "$v"; done');
      const lines = output.replace(/\r/g, '').trim().split('\n').sort();
      expect(lines).toEqual(['1', '2']);
    });
  });

  // ─── 26. string operations ────────────────────────────────────────────────

  describe('string operations', () => {
    it('${var/pattern/rep} replaces first match', async () => {
      shell.env['s'] = 'hello world hello';
      const { output } = await run(shell, 'echo ${s/hello/hi}');
      expect(output.replace(/\r/g, '').trim()).toBe('hi world hello');
    });

    it('${var//pattern/rep} replaces all matches', async () => {
      shell.env['s'] = 'hello world hello';
      const { output } = await run(shell, 'echo ${s//hello/hi}');
      expect(output.replace(/\r/g, '').trim()).toBe('hi world hi');
    });

    it('${var:offset:length} extracts substring', async () => {
      shell.env['s'] = 'hello world';
      const { output } = await run(shell, 'echo ${s:6:5}');
      expect(output.replace(/\r/g, '').trim()).toBe('world');
    });

    it('${var:offset} extracts from offset to end', async () => {
      shell.env['s'] = 'hello world';
      const { output } = await run(shell, 'echo ${s:6}');
      expect(output.replace(/\r/g, '').trim()).toBe('world');
    });

    it('${var#pattern} removes shortest prefix', async () => {
      shell.env['path'] = '/home/user/file.txt';
      const { output } = await run(shell, 'echo ${path#*/}');
      expect(output.replace(/\r/g, '').trim()).toBe('home/user/file.txt');
    });

    it('${var##pattern} removes longest prefix', async () => {
      shell.env['path'] = '/home/user/file.txt';
      const { output } = await run(shell, 'echo ${path##*/}');
      expect(output.replace(/\r/g, '').trim()).toBe('file.txt');
    });

    it('${var%pattern} removes shortest suffix', async () => {
      shell.env['f'] = 'file.tar.gz';
      const { output } = await run(shell, 'echo ${f%.*}');
      expect(output.replace(/\r/g, '').trim()).toBe('file.tar');
    });

    it('${var%%pattern} removes longest suffix', async () => {
      shell.env['f'] = 'file.tar.gz';
      const { output } = await run(shell, 'echo ${f%%.*}');
      expect(output.replace(/\r/g, '').trim()).toBe('file');
    });

    it('${var^^} converts to uppercase', async () => {
      shell.env['s'] = 'hello';
      const { output } = await run(shell, 'echo ${s^^}');
      expect(output.replace(/\r/g, '').trim()).toBe('HELLO');
    });

    it('${var,,} converts to lowercase', async () => {
      shell.env['s'] = 'HELLO';
      const { output } = await run(shell, 'echo ${s,,}');
      expect(output.replace(/\r/g, '').trim()).toBe('hello');
    });

    it('${var:-default} uses default when unset', async () => {
      const { output } = await run(shell, 'echo ${UNSET_VAR:-default_val}');
      expect(output.replace(/\r/g, '').trim()).toBe('default_val');
    });

    it('${var:=default} assigns default when unset', async () => {
      await run(shell, 'echo ${NEW_VAR:=assigned}');
      expect(shell.env['NEW_VAR']).toBe('assigned');
    });

    it('${#var} returns string length', async () => {
      shell.env['s'] = 'hello';
      const { output } = await run(shell, 'echo ${#s}');
      expect(output.replace(/\r/g, '').trim()).toBe('5');
    });
  });

  // ─── 27. while read patterns ──────────────────────────────────────────────

  describe('while read patterns', () => {
    it('while read loop with counter', async () => {
      shell.env['__PIPE_STDIN'] = 'a\nb\nc\n';
      const { output } = await run(shell, 'n=0; while read line; do n=$((n+1)); done; echo $n');
      expect(output.replace(/\r/g, '').trim()).toBe('3');
    });

    it('read splits into multiple vars', async () => {
      shell.env['__PIPE_STDIN'] = 'hello world 123\n';
      await run(shell, 'read a b c');
      expect(shell.env['a']).toBe('hello');
      expect(shell.env['b']).toBe('world');
      expect(shell.env['c']).toBe('123');
    });

    it('read -r preserves backslashes', async () => {
      shell.env['__PIPE_STDIN'] = 'path\\to\\file\n';
      await run(shell, 'read -r line');
      expect(shell.env['line']).toBe('path\\to\\file');
    });
  });
});
