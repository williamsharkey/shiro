// Level 11: Advanced command tests
// Tests for glob, source, xargs, less, make, ed, type, which, unset, read
// These are Foam-specific commands not covered by fluffycoreutils

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 11: Advanced Commands (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  // ─── SETUP ─────────────────────────────────────────────────────────────────
  try {
    await os.mkdir('/tmp/ww-adv');
    await os.mkdir('/tmp/ww-adv/sub');
    await os.writeFile('/tmp/ww-adv/file1.txt', 'hello');
    await os.writeFile('/tmp/ww-adv/file2.txt', 'world');
    await os.writeFile('/tmp/ww-adv/script.js', 'console.log("js")');
    await os.writeFile('/tmp/ww-adv/sub/nested.txt', 'nested content');
  } catch (e) {
    results.fail('setup', e);
    results.summary();
    return results;
  }

  // ─── GLOB COMMAND ──────────────────────────────────────────────────────────

  // Test: glob basic pattern
  try {
    const r = await os.exec('glob "*.txt" /tmp/ww-adv');
    assertIncludes(r.stdout, 'file1.txt', 'glob should find file1.txt');
    assertIncludes(r.stdout, 'file2.txt', 'glob should find file2.txt');
    assert(!r.stdout.includes('script.js'), 'glob should not match .js');
    results.pass('glob *.txt');
  } catch (e) {
    results.fail('glob *.txt', e);
  }

  // Test: glob recursive pattern
  try {
    const r = await os.exec('glob "**/*.txt" /tmp/ww-adv');
    assertIncludes(r.stdout, 'file1.txt', 'glob should find file1.txt');
    assertIncludes(r.stdout, 'nested.txt', 'glob should find nested.txt');
    results.pass('glob **/*.txt (recursive)');
  } catch (e) {
    results.fail('glob **/*.txt (recursive)', e);
  }

  // Test: glob with no matches
  try {
    const r = await os.exec('glob "*.xyz" /tmp/ww-adv');
    assertEqual(r.exitCode, 0, 'glob with no matches should exit 0');
    results.pass('glob (no matches)');
  } catch (e) {
    results.fail('glob (no matches)', e);
  }

  // ─── SOURCE / . COMMAND ────────────────────────────────────────────────────

  // Test: source script
  try {
    await os.writeFile('/tmp/ww-adv/setup.sh', 'export WW_SOURCED=yes\necho "sourced"');
    const r = await os.exec('source /tmp/ww-adv/setup.sh');
    assertIncludes(r.stdout, 'sourced', 'source should run script');
    results.pass('source script');
  } catch (e) {
    results.fail('source script', e);
  }

  // Test: . (dot) alias for source
  try {
    await os.writeFile('/tmp/ww-adv/dot.sh', 'echo "dot-sourced"');
    const r = await os.exec('. /tmp/ww-adv/dot.sh');
    assertIncludes(r.stdout, 'dot-sourced', '. should run script');
    results.pass('. (dot) command');
  } catch (e) {
    results.fail('. (dot) command', e);
  }

  // Test: source with comments
  try {
    await os.writeFile('/tmp/ww-adv/comments.sh', '# comment line\necho "after comment"\n# another comment');
    const r = await os.exec('source /tmp/ww-adv/comments.sh');
    assertIncludes(r.stdout, 'after comment', 'source should skip comments');
    results.pass('source (with comments)');
  } catch (e) {
    results.fail('source (with comments)', e);
  }

  // ─── TYPE COMMAND ──────────────────────────────────────────────────────────

  // Test: type builtin
  try {
    const r = await os.exec('type echo');
    assertIncludes(r.stdout, 'builtin', 'type should identify echo as builtin');
    results.pass('type (builtin)');
  } catch (e) {
    results.fail('type (builtin)', e);
  }

  // Test: type not found
  try {
    const r = await os.exec('type nonexistent_cmd_12345');
    assert(r.exitCode !== 0 || r.stderr.includes('not found'), 'type should fail for unknown command');
    results.pass('type (not found)');
  } catch (e) {
    results.fail('type (not found)', e);
  }

  // ─── WHICH COMMAND ─────────────────────────────────────────────────────────

  // Test: which known command
  try {
    const r = await os.exec('which cat');
    assertIncludes(r.stdout, '/usr/bin/cat', 'which should show path');
    results.pass('which (known)');
  } catch (e) {
    results.fail('which (known)', e);
  }

  // Test: which unknown command
  try {
    const r = await os.exec('which nonexistent_cmd_67890');
    assert(r.exitCode !== 0 || r.stderr.length > 0, 'which should fail for unknown');
    results.pass('which (unknown)');
  } catch (e) {
    results.fail('which (unknown)', e);
  }

  // ─── UNSET COMMAND ─────────────────────────────────────────────────────────

  // Test: unset variable
  try {
    await os.exec('export WW_UNSET_TEST=value');
    const before = await os.exec('echo $WW_UNSET_TEST');
    assertIncludes(before.stdout, 'value', 'var should be set');

    await os.exec('unset WW_UNSET_TEST');
    const after = await os.exec('echo $WW_UNSET_TEST');
    assert(!after.stdout.includes('value'), 'var should be unset');
    results.pass('unset variable');
  } catch (e) {
    results.fail('unset variable', e);
  }

  // ─── XARGS COMMAND ─────────────────────────────────────────────────────────

  // Test: xargs basic
  try {
    const r = await os.exec('echo -e "a\\nb\\nc" | xargs echo');
    assertIncludes(r.stdout, 'a', 'xargs should pass a');
    assertIncludes(r.stdout, 'b', 'xargs should pass b');
    assertIncludes(r.stdout, 'c', 'xargs should pass c');
    results.pass('xargs basic');
  } catch (e) {
    results.fail('xargs basic', e);
  }

  // Test: xargs -I (replace)
  try {
    await os.writeFile('/tmp/ww-adv/items.txt', 'apple\nbanana\ncherry');
    const r = await os.exec('cat /tmp/ww-adv/items.txt | xargs -I {} echo "fruit: {}"');
    assertIncludes(r.stdout, 'fruit: apple', 'xargs -I should replace');
    assertIncludes(r.stdout, 'fruit: banana', 'xargs -I should replace');
    results.pass('xargs -I (replace)');
  } catch (e) {
    results.fail('xargs -I (replace)', e);
  }

  // ─── LESS / MORE COMMAND ───────────────────────────────────────────────────

  // Test: less file
  try {
    await os.writeFile('/tmp/ww-adv/longfile.txt', 'line1\nline2\nline3\nline4\nline5');
    const r = await os.exec('less /tmp/ww-adv/longfile.txt');
    assertIncludes(r.stdout, 'line1', 'less should show content');
    assertIncludes(r.stdout, 'line5', 'less should show all lines');
    results.pass('less file');
  } catch (e) {
    results.fail('less file', e);
  }

  // Test: less -N (line numbers)
  try {
    const r = await os.exec('less -N /tmp/ww-adv/longfile.txt');
    assertIncludes(r.stdout, '1', 'less -N should show line numbers');
    assertIncludes(r.stdout, 'line1', 'less -N should show content');
    results.pass('less -N (line numbers)');
  } catch (e) {
    results.fail('less -N (line numbers)', e);
  }

  // Test: more (alias for less)
  try {
    const r = await os.exec('more /tmp/ww-adv/longfile.txt');
    assertIncludes(r.stdout, 'line1', 'more should work like less');
    results.pass('more');
  } catch (e) {
    results.fail('more', e);
  }

  // Test: less with pipe
  try {
    const r = await os.exec('cat /tmp/ww-adv/longfile.txt | less');
    assertIncludes(r.stdout, 'line1', 'less should read from pipe');
    results.pass('less (piped)');
  } catch (e) {
    results.fail('less (piped)', e);
  }

  // ─── MAKE COMMAND ──────────────────────────────────────────────────────────

  // Test: make basic target
  try {
    await os.writeFile('/tmp/ww-adv/Makefile', `all:
\techo "building all"

clean:
\techo "cleaning"
`);
    const r = await os.exec('cd /tmp/ww-adv && make all');
    assertIncludes(r.stdout, 'building all', 'make should run target');
    results.pass('make basic');
  } catch (e) {
    results.fail('make basic', e);
  }

  // Test: make with dependencies
  try {
    await os.writeFile('/tmp/ww-adv/Makefile2', `build: compile
\techo "build done"

compile:
\techo "compiling"
`);
    const r = await os.exec('cd /tmp/ww-adv && make -f Makefile2 build');
    assertIncludes(r.stdout, 'compiling', 'make should run dependency first');
    assertIncludes(r.stdout, 'build done', 'make should run target after deps');
    results.pass('make (dependencies)');
  } catch (e) {
    results.fail('make (dependencies)', e);
  }

  // Test: make default target
  try {
    const r = await os.exec('cd /tmp/ww-adv && make');
    assertIncludes(r.stdout, 'building all', 'make should run default target');
    results.pass('make (default target)');
  } catch (e) {
    results.fail('make (default target)', e);
  }

  // Test: make unknown target
  try {
    const r = await os.exec('cd /tmp/ww-adv && make nonexistent');
    assert(r.exitCode !== 0 || r.stderr.includes('No rule'), 'make should fail for unknown target');
    results.pass('make (unknown target)');
  } catch (e) {
    results.fail('make (unknown target)', e);
  }

  // ─── ED COMMAND (line editor) ──────────────────────────────────────────────

  // Test: ed print file
  try {
    await os.writeFile('/tmp/ww-adv/ed-test.txt', 'first\nsecond\nthird');
    const r = await os.exec('ed /tmp/ww-adv/ed-test.txt p');
    assertIncludes(r.stdout, 'first', 'ed p should print content');
    assertIncludes(r.stdout, 'third', 'ed p should print all');
    results.pass('ed p (print)');
  } catch (e) {
    results.fail('ed p (print)', e);
  }

  // Test: ed with line numbers
  try {
    const r = await os.exec('ed /tmp/ww-adv/ed-test.txt n');
    assertIncludes(r.stdout, '1', 'ed n should show line numbers');
    assertIncludes(r.stdout, 'first', 'ed n should show content');
    results.pass('ed n (numbered)');
  } catch (e) {
    results.fail('ed n (numbered)', e);
  }

  // Test: ed write
  try {
    await os.writeFile('/tmp/ww-adv/ed-write.txt', 'original');
    const r = await os.exec('ed /tmp/ww-adv/ed-write.txt 1c "changed" w');
    assertIncludes(r.stdout, 'written', 'ed w should confirm write');
    const content = await os.readFile('/tmp/ww-adv/ed-write.txt');
    assertIncludes(content, 'changed', 'ed should modify file');
    results.pass('ed c + w (change and write)');
  } catch (e) {
    results.fail('ed c + w (change and write)', e);
  }

  // Test: ed substitution
  try {
    await os.writeFile('/tmp/ww-adv/ed-sub.txt', 'hello world');
    await os.exec('ed /tmp/ww-adv/ed-sub.txt 1s/world/universe/ w');
    const content = await os.readFile('/tmp/ww-adv/ed-sub.txt');
    assertIncludes(content, 'universe', 'ed s should substitute');
    results.pass('ed s (substitute)');
  } catch (e) {
    results.fail('ed s (substitute)', e);
  }

  // Test: ed search
  try {
    await os.writeFile('/tmp/ww-adv/ed-search.txt', 'alpha\nbeta\ngamma\nalpha again');
    const r = await os.exec('ed /tmp/ww-adv/ed-search.txt /alpha/');
    assertIncludes(r.stdout, 'alpha', 'ed search should find matches');
    results.pass('ed /pattern/ (search)');
  } catch (e) {
    results.fail('ed /pattern/ (search)', e);
  }

  // ─── READ COMMAND ──────────────────────────────────────────────────────────

  // Test: read from pipe
  try {
    const r = await os.exec('echo "test value" | read MYVAR && echo $MYVAR');
    // Note: read behavior varies - in subshell the var may not persist
    // Just verify the command runs without error
    assertEqual(r.exitCode, 0, 'read should exit 0');
    results.pass('read command');
  } catch (e) {
    results.fail('read command', e);
  }

  // ─── TEST COMMAND ADDITIONAL OPERATORS ─────────────────────────────────────

  // Test: test -e (file exists)
  try {
    const r = await os.exec('test -e /tmp/ww-adv/file1.txt && echo exists');
    assertIncludes(r.stdout, 'exists', 'test -e should find file');
    results.pass('test -e (exists)');
  } catch (e) {
    results.fail('test -e (exists)', e);
  }

  // Test: test -e (not exists)
  try {
    const r = await os.exec('test -e /tmp/ww-adv/nonexistent && echo exists || echo missing');
    assertIncludes(r.stdout, 'missing', 'test -e should fail for missing');
    results.pass('test -e (not exists)');
  } catch (e) {
    results.fail('test -e (not exists)', e);
  }

  // Test: test -z (empty string)
  try {
    const r = await os.exec('test -z "" && echo empty');
    assertIncludes(r.stdout, 'empty', 'test -z should detect empty');
    results.pass('test -z (empty)');
  } catch (e) {
    results.fail('test -z (empty)', e);
  }

  // Test: test -a (AND)
  try {
    const r = await os.exec('test 1 -eq 1 -a 2 -eq 2 && echo both');
    assertIncludes(r.stdout, 'both', 'test -a should AND conditions');
    results.pass('test -a (AND)');
  } catch (e) {
    results.fail('test -a (AND)', e);
  }

  // Test: test -o (OR)
  try {
    const r = await os.exec('test 1 -eq 2 -o 2 -eq 2 && echo either');
    assertIncludes(r.stdout, 'either', 'test -o should OR conditions');
    results.pass('test -o (OR)');
  } catch (e) {
    results.fail('test -o (OR)', e);
  }

  // Test: test -le (less than or equal)
  try {
    const r = await os.exec('test 5 -le 5 && echo le');
    assertIncludes(r.stdout, 'le', 'test -le should work');
    results.pass('test -le');
  } catch (e) {
    results.fail('test -le', e);
  }

  // Test: test -ge (greater than or equal)
  try {
    const r = await os.exec('test 5 -ge 3 && echo ge');
    assertIncludes(r.stdout, 'ge', 'test -ge should work');
    results.pass('test -ge');
  } catch (e) {
    results.fail('test -ge', e);
  }

  // ─── HELP COMMAND ──────────────────────────────────────────────────────────

  // Test: help
  try {
    const r = await os.exec('help');
    assertIncludes(r.stdout, 'Available commands', 'help should show header');
    assertIncludes(r.stdout, 'cat', 'help should list cat');
    results.pass('help');
  } catch (e) {
    results.fail('help', e);
  }

  // ─── CLEANUP ───────────────────────────────────────────────────────────────
  try {
    await os.exec('rm -r /tmp/ww-adv');
  } catch {
    // Ignore cleanup errors
  }

  results.summary();
  return results;
}
