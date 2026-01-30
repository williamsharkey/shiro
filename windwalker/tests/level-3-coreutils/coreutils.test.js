// Level 3: Coreutils tests
// Verify individual command implementations

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 3: Coreutils (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  // Setup: create test files
  try {
    await os.writeFile('/tmp/ww-core-a.txt', 'alpha\nbravo\ncharlie\ndelta\necho');
    await os.writeFile('/tmp/ww-core-b.txt', 'one\ntwo\nthree');
    await os.mkdir('/tmp/ww-core-dir');
    await os.writeFile('/tmp/ww-core-dir/x.txt', 'x content');
    await os.writeFile('/tmp/ww-core-dir/y.js', 'console.log("y")');
  } catch (e) {
    results.fail('setup', e);
    results.summary();
    return results;
  }

  // Test: cat
  try {
    const r = await os.exec('cat /tmp/ww-core-a.txt');
    assertIncludes(r.stdout, 'alpha', 'cat should show file content');
    assertIncludes(r.stdout, 'echo', 'cat should show all lines');
    results.pass('cat');
  } catch (e) {
    results.fail('cat', e);
  }

  // Test: ls
  try {
    const r = await os.exec('ls /tmp/ww-core-dir');
    assertIncludes(r.stdout, 'x.txt', 'ls should list x.txt');
    assertIncludes(r.stdout, 'y.js', 'ls should list y.js');
    results.pass('ls');
  } catch (e) {
    results.fail('ls', e);
  }

  // Test: head
  try {
    const r = await os.exec('head -n 2 /tmp/ww-core-a.txt');
    assertIncludes(r.stdout, 'alpha', 'head shows first line');
    assertIncludes(r.stdout, 'bravo', 'head shows second line');
    assert(!r.stdout.includes('charlie'), 'head should not show third line');
    results.pass('head -n 2');
  } catch (e) {
    results.fail('head -n 2', e);
  }

  // Test: tail
  try {
    const r = await os.exec('tail -n 2 /tmp/ww-core-a.txt');
    assertIncludes(r.stdout, 'delta', 'tail shows second-to-last');
    assertIncludes(r.stdout, 'echo', 'tail shows last line');
    assert(!r.stdout.includes('charlie'), 'tail should not show earlier lines');
    results.pass('tail -n 2');
  } catch (e) {
    results.fail('tail -n 2', e);
  }

  // Test: wc -l
  try {
    const r = await os.exec('wc -l /tmp/ww-core-a.txt');
    assertIncludes(r.stdout, '5', 'wc should count 5 lines');
    results.pass('wc -l');
  } catch (e) {
    results.fail('wc -l', e);
  }

  // Test: grep
  try {
    const r = await os.exec('grep "a" /tmp/ww-core-a.txt');
    assertIncludes(r.stdout, 'alpha', 'grep should find alpha');
    assertIncludes(r.stdout, 'charlie', 'grep should find charlie');
    assertIncludes(r.stdout, 'delta', 'grep should find delta');
    assert(!r.stdout.includes('echo'), 'grep should not match echo (no "a")');
    results.pass('grep');
  } catch (e) {
    results.fail('grep', e);
  }

  // Test: grep -i (case insensitive)
  try {
    const r = await os.exec('grep -i "ALPHA" /tmp/ww-core-a.txt');
    assertIncludes(r.stdout, 'alpha', 'grep -i should match case-insensitively');
    results.pass('grep -i');
  } catch (e) {
    results.fail('grep -i', e);
  }

  // Test: grep -v (invert)
  try {
    const r = await os.exec('grep -v "alpha" /tmp/ww-core-a.txt');
    assertIncludes(r.stdout, 'bravo', 'grep -v should include bravo');
    assertIncludes(r.stdout, 'echo', 'grep -v should include echo');
    assert(!r.stdout.includes('alpha'), 'grep -v should exclude alpha');
    results.pass('grep -v');
  } catch (e) {
    results.fail('grep -v', e);
  }

  // Test: sort
  try {
    await os.writeFile('/tmp/ww-sort.txt', 'banana\napple\ncherry');
    const r = await os.exec('sort /tmp/ww-sort.txt');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines[0], 'apple', 'sort first');
    assertEqual(lines[1], 'banana', 'sort second');
    assertEqual(lines[2], 'cherry', 'sort third');
    results.pass('sort');
  } catch (e) {
    results.fail('sort', e);
  }

  // Test: touch creates file
  try {
    await os.exec('touch /tmp/ww-touched.txt');
    const exists = await os.exists('/tmp/ww-touched.txt');
    assert(exists, 'touch should create file');
    results.pass('touch');
  } catch (e) {
    results.fail('touch', e);
  }

  // Test: cp
  try {
    await os.writeFile('/tmp/ww-cp-src.txt', 'copy me');
    await os.exec('cp /tmp/ww-cp-src.txt /tmp/ww-cp-dst.txt');
    const content = await os.readFile('/tmp/ww-cp-dst.txt');
    assertEqual(content, 'copy me', 'cp content');
    results.pass('cp');
  } catch (e) {
    results.fail('cp', e);
  }

  // Test: mv
  try {
    await os.writeFile('/tmp/ww-mv-src.txt', 'move me');
    await os.exec('mv /tmp/ww-mv-src.txt /tmp/ww-mv-dst.txt');
    const content = await os.readFile('/tmp/ww-mv-dst.txt');
    assertEqual(content, 'move me', 'mv content');
    const srcExists = await os.exists('/tmp/ww-mv-src.txt');
    assert(!srcExists, 'mv should remove source');
    results.pass('mv');
  } catch (e) {
    results.fail('mv', e);
  }

  // Test: rm
  try {
    await os.writeFile('/tmp/ww-rm-target.txt', 'remove me');
    await os.exec('rm /tmp/ww-rm-target.txt');
    const exists = await os.exists('/tmp/ww-rm-target.txt');
    assert(!exists, 'rm should remove file');
    results.pass('rm');
  } catch (e) {
    results.fail('rm', e);
  }

  // Test: mkdir via shell
  try {
    await os.exec('mkdir /tmp/ww-mkdir-shell');
    const exists = await os.exists('/tmp/ww-mkdir-shell');
    assert(exists, 'mkdir should create directory');
    results.pass('mkdir (shell)');
  } catch (e) {
    results.fail('mkdir (shell)', e);
  }

  // Test: find
  try {
    const r = await os.exec('find /tmp/ww-core-dir -name "*.js"');
    assertIncludes(r.stdout, 'y.js', 'find should locate .js files');
    results.pass('find -name');
  } catch (e) {
    results.fail('find -name', e);
  }

  // Test: sed substitution
  try {
    const r = await os.exec('echo "hello world" | sed "s/world/earth/"');
    assertIncludes(r.stdout, 'hello earth', 'sed substitution');
    results.pass('sed s///');
  } catch (e) {
    results.fail('sed s///', e);
  }

  // Test: uniq
  try {
    await os.writeFile('/tmp/ww-uniq.txt', 'a\na\nb\nb\nb\nc');
    const r = await os.exec('uniq /tmp/ww-uniq.txt');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines.length, 3, 'uniq should collapse duplicates');
    results.pass('uniq');
  } catch (e) {
    results.fail('uniq', e);
  }

  // Test: diff
  try {
    await os.writeFile('/tmp/ww-diff1.txt', 'line1\nline2\nline3');
    await os.writeFile('/tmp/ww-diff2.txt', 'line1\nchanged\nline3');
    const r = await os.exec('diff /tmp/ww-diff1.txt /tmp/ww-diff2.txt');
    // diff should show some output indicating a difference
    assert(r.stdout.length > 0 || r.exitCode !== 0, 'diff should detect changes');
    results.pass('diff');
  } catch (e) {
    results.fail('diff', e);
  }

  // Test: diff with identical files
  try {
    await os.writeFile('/tmp/ww-diff-same1.txt', 'identical');
    await os.writeFile('/tmp/ww-diff-same2.txt', 'identical');
    const r = await os.exec('diff /tmp/ww-diff-same1.txt /tmp/ww-diff-same2.txt');
    assertEqual(r.exitCode, 0, 'diff identical files should exit 0');
    results.pass('diff (identical files)');
  } catch (e) {
    results.fail('diff (identical files)', e);
  }

  // Test: sort -r (reverse)
  try {
    await os.writeFile('/tmp/ww-sortr.txt', 'a\nb\nc');
    const r = await os.exec('sort -r /tmp/ww-sortr.txt');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines[0], 'c', 'reverse sort first');
    assertEqual(lines[2], 'a', 'reverse sort last');
    results.pass('sort -r');
  } catch (e) {
    results.fail('sort -r', e);
  }

  // Test: sort -n (numeric)
  try {
    await os.writeFile('/tmp/ww-sortn.txt', '10\n2\n30\n1');
    const r = await os.exec('sort -n /tmp/ww-sortn.txt');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines[0], '1', 'numeric sort first');
    assertEqual(lines[3], '30', 'numeric sort last');
    results.pass('sort -n');
  } catch (e) {
    results.fail('sort -n', e);
  }

  // Test: uniq -c (count)
  try {
    await os.writeFile('/tmp/ww-uniqc.txt', 'a\na\na\nb\nc\nc');
    const r = await os.exec('uniq -c /tmp/ww-uniqc.txt');
    assertIncludes(r.stdout, '3', 'uniq -c should show count 3 for a');
    results.pass('uniq -c');
  } catch (e) {
    results.fail('uniq -c', e);
  }

  // Test: head (default 10 lines)
  try {
    const lines = Array.from({length: 20}, (_, i) => `line${i+1}`).join('\n');
    await os.writeFile('/tmp/ww-head20.txt', lines);
    const r = await os.exec('head /tmp/ww-head20.txt');
    assertIncludes(r.stdout, 'line1', 'head default should include line1');
    assertIncludes(r.stdout, 'line10', 'head default should include line10');
    assert(!r.stdout.includes('line11'), 'head default should not include line11');
    results.pass('head (default 10)');
  } catch (e) {
    results.fail('head (default 10)', e);
  }

  // Test: wc (all counts)
  try {
    await os.writeFile('/tmp/ww-wcall.txt', 'hello world\nfoo bar baz\n');
    const r = await os.exec('wc /tmp/ww-wcall.txt');
    assertIncludes(r.stdout, '2', 'wc should show 2 lines');
    assertIncludes(r.stdout, '5', 'wc should show 5 words');
    results.pass('wc (all counts)');
  } catch (e) {
    results.fail('wc (all counts)', e);
  }

  // Test: grep -n (line numbers)
  try {
    await os.writeFile('/tmp/ww-grepn.txt', 'alpha\nbravo\ncharlie');
    const r = await os.exec('grep -n "bravo" /tmp/ww-grepn.txt');
    assertIncludes(r.stdout, '2', 'grep -n should show line number 2');
    results.pass('grep -n');
  } catch (e) {
    results.fail('grep -n', e);
  }

  // Test: echo -n (no newline)
  try {
    const r = await os.exec('echo -n hello');
    assertEqual(r.stdout, 'hello', 'echo -n should omit trailing newline');
    results.pass('echo -n');
  } catch (e) {
    results.fail('echo -n', e);
  }

  // Test: date
  try {
    const r = await os.exec('date');
    assert(r.stdout.length > 0, 'date should produce output');
    results.pass('date');
  } catch (e) {
    results.fail('date', e);
  }

  // Test: whoami
  try {
    const r = await os.exec('whoami');
    assert(r.stdout.trim().length > 0, 'whoami should return a username');
    results.pass('whoami');
  } catch (e) {
    results.fail('whoami', e);
  }

  // Test: basename
  try {
    const r = await os.exec('basename /home/user/file.txt');
    assertIncludes(r.stdout, 'file.txt', 'basename should extract filename');
    results.pass('basename');
  } catch (e) {
    results.fail('basename', e);
  }

  // Test: dirname
  try {
    const r = await os.exec('dirname /home/user/file.txt');
    assertIncludes(r.stdout, '/home/user', 'dirname should extract directory');
    results.pass('dirname');
  } catch (e) {
    results.fail('dirname', e);
  }

  // Test: tr (translate characters)
  try {
    const r = await os.exec('echo "hello" | tr "a-z" "A-Z"');
    assertIncludes(r.stdout, 'HELLO', 'tr should uppercase');
    results.pass('tr');
  } catch (e) {
    results.fail('tr', e);
  }

  // Test: cut -d -f (field extraction)
  try {
    const r = await os.exec('echo "a:b:c" | cut -d: -f2');
    assertIncludes(r.stdout, 'b', 'cut should extract field 2');
    results.pass('cut -d -f');
  } catch (e) {
    results.fail('cut -d -f', e);
  }

  // Test: env (show environment)
  try {
    const r = await os.exec('env');
    assertIncludes(r.stdout, 'HOME', 'env should show HOME');
    results.pass('env');
  } catch (e) {
    results.fail('env', e);
  }

  // Test: printenv (print specific variable)
  try {
    const r = await os.exec('printenv HOME');
    assertIncludes(r.stdout, '/home', 'printenv HOME should show home path');
    results.pass('printenv');
  } catch (e) {
    results.fail('printenv', e);
  }

  // Test: printf (formatted output)
  try {
    const r = await os.exec('printf "%s-%d" hello 42');
    assertIncludes(r.stdout, 'hello-42', 'printf should format');
    results.pass('printf');
  } catch (e) {
    results.fail('printf', e);
  }

  // Test: cat with multiple files
  try {
    await os.writeFile('/tmp/ww-cat1.txt', 'first');
    await os.writeFile('/tmp/ww-cat2.txt', 'second');
    const r = await os.exec('cat /tmp/ww-cat1.txt /tmp/ww-cat2.txt');
    assertIncludes(r.stdout, 'first', 'cat multi should include first');
    assertIncludes(r.stdout, 'second', 'cat multi should include second');
    results.pass('cat (multiple files)');
  } catch (e) {
    results.fail('cat (multiple files)', e);
  }

  // Test: seq (sequence)
  try {
    const r = await os.exec('seq 3');
    assertIncludes(r.stdout, '1', 'seq should include 1');
    assertIncludes(r.stdout, '2', 'seq should include 2');
    assertIncludes(r.stdout, '3', 'seq should include 3');
    results.pass('seq');
  } catch (e) {
    results.fail('seq', e);
  }

  // Test: realpath
  try {
    const r = await os.exec('realpath /tmp/../tmp/ww-core-a.txt');
    assertIncludes(r.stdout, '/tmp/ww-core-a.txt', 'realpath should resolve path');
    results.pass('realpath');
  } catch (e) {
    results.fail('realpath', e);
  }

  // Test: hostname
  try {
    const r = await os.exec('hostname');
    assert(r.stdout.trim().length > 0, 'hostname should return something');
    results.pass('hostname');
  } catch (e) {
    results.fail('hostname', e);
  }

  // Test: uname
  try {
    const r = await os.exec('uname');
    assert(r.stdout.trim().length > 0, 'uname should return something');
    results.pass('uname');
  } catch (e) {
    results.fail('uname', e);
  }

  // Test: rm -r (recursive delete)
  try {
    await os.exec('mkdir -p /tmp/ww-rmr-test/sub');
    await os.writeFile('/tmp/ww-rmr-test/sub/file.txt', 'data');
    await os.exec('rm -r /tmp/ww-rmr-test');
    const exists = await os.exists('/tmp/ww-rmr-test');
    assert(!exists, 'rm -r should remove directory tree');
    results.pass('rm -r');
  } catch (e) {
    results.fail('rm -r', e);
  }

  // Test: cat -n (line numbers)
  try {
    await os.writeFile('/tmp/ww-catn.txt', 'one\ntwo\nthree');
    const r = await os.exec('cat -n /tmp/ww-catn.txt');
    assertIncludes(r.stdout, '1', 'cat -n should show line 1');
    assertIncludes(r.stdout, 'one', 'cat -n should show content');
    results.pass('cat -n');
  } catch (e) {
    results.fail('cat -n', e);
  }

  // Test: ls -l (long format)
  try {
    const r = await os.exec('ls -l /tmp/ww-core-dir');
    assertIncludes(r.stdout, 'x.txt', 'ls -l should show file');
    results.pass('ls -l');
  } catch (e) {
    results.fail('ls -l', e);
  }

  // Test: ls -a (show hidden)
  try {
    await os.exec('mkdir -p /tmp/ww-hidden-dir');
    await os.writeFile('/tmp/ww-hidden-dir/.hidden', 'secret');
    const r = await os.exec('ls -a /tmp/ww-hidden-dir');
    assertIncludes(r.stdout, '.hidden', 'ls -a should show hidden files');
    results.pass('ls -a');
  } catch (e) {
    results.fail('ls -a', e);
  }

  // Test: test command (standalone)
  try {
    const r = await os.exec('test 1 -eq 1 && echo yes');
    assertIncludes(r.stdout, 'yes', 'test command');
    results.pass('test command');
  } catch (e) {
    results.fail('test command', e);
  }

  // Test: sleep (brief)
  try {
    const start = Date.now();
    await os.exec('sleep 0.1');
    const elapsed = Date.now() - start;
    assert(elapsed >= 50, 'sleep should pause execution');
    results.pass('sleep');
  } catch (e) {
    results.fail('sleep', e);
  }

  // Test: seq with range
  try {
    const r = await os.exec('seq 2 5');
    assertIncludes(r.stdout, '2', 'seq range start');
    assertIncludes(r.stdout, '5', 'seq range end');
    assert(!r.stdout.includes('1'), 'seq range should not include 1');
    results.pass('seq (range)');
  } catch (e) {
    results.fail('seq (range)', e);
  }

  // Test: seq with step
  try {
    const r = await os.exec('seq 1 2 7');
    assertIncludes(r.stdout, '1', 'seq step');
    assertIncludes(r.stdout, '3', 'seq step');
    assertIncludes(r.stdout, '5', 'seq step');
    assertIncludes(r.stdout, '7', 'seq step');
    assert(!r.stdout.includes('2'), 'seq step should skip 2');
    results.pass('seq (step)');
  } catch (e) {
    results.fail('seq (step)', e);
  }

  // Test: sed with g flag (global)
  try {
    const r = await os.exec('echo "aaa" | sed "s/a/b/g"');
    assertIncludes(r.stdout, 'bbb', 'sed g flag');
    results.pass('sed g flag');
  } catch (e) {
    results.fail('sed g flag', e);
  }

  // Test: tail -f exit
  try {
    // Just verify tail doesn't hang with a regular file
    const r = await os.exec('tail -n 1 /tmp/ww-core-a.txt');
    assertIncludes(r.stdout, 'echo', 'tail -n 1 should get last line');
    results.pass('tail -n 1');
  } catch (e) {
    results.fail('tail -n 1', e);
  }

  results.summary();
  return results;
}
