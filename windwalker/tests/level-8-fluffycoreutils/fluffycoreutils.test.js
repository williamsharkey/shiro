// Level 8: Extended coreutils tests
// Tests for commands beyond the basics -- tr, cut, printf, test, uname,
// seq, which, chmod, ln, readlink, and extended flag coverage.
// These commands exist natively in both Foam and Shiro (no shared library needed).

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 8: Extended Coreutils (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  // Test: tr (translate characters)
  try {
    const r = await os.exec('echo "hello" | tr "a-z" "A-Z"');
    assertIncludes(r.stdout, 'HELLO', 'tr should translate to uppercase');
    results.pass('tr');
  } catch (e) {
    results.fail('tr', e);
  }

  // Test: tr -d (delete characters)
  try {
    const r = await os.exec('echo "hello world" | tr -d " "');
    assertIncludes(r.stdout, 'helloworld', 'tr -d should delete spaces');
    results.pass('tr -d');
  } catch (e) {
    results.fail('tr -d', e);
  }

  // Test: cut -d -f (field extraction)
  try {
    await os.writeFile('/tmp/ww-cut.csv', 'name,age,city\nalice,30,nyc\nbob,25,sf');
    const r = await os.exec('cut -d "," -f 1 /tmp/ww-cut.csv');
    assertIncludes(r.stdout, 'name', 'cut field 1 header');
    assertIncludes(r.stdout, 'alice', 'cut field 1 row 1');
    assertIncludes(r.stdout, 'bob', 'cut field 1 row 2');
    results.pass('cut -d -f');
  } catch (e) {
    results.fail('cut -d -f', e);
  }

  // Test: printf
  try {
    const r = await os.exec('printf "hello %s\\n" world');
    assertIncludes(r.stdout, 'hello world', 'printf format string');
    results.pass('printf');
  } catch (e) {
    results.fail('printf', e);
  }

  // Test: test command (numeric equality)
  try {
    const r = await os.exec('test 1 -eq 1 && echo "equal"');
    assertIncludes(r.stdout, 'equal', 'test 1 -eq 1 should succeed');
    results.pass('test (numeric eq)');
  } catch (e) {
    results.fail('test (numeric eq)', e);
  }

  // Test: test -f (file exists)
  try {
    await os.writeFile('/tmp/ww-testf.txt', 'exists');
    const r = await os.exec('test -f /tmp/ww-testf.txt && echo "found"');
    assertIncludes(r.stdout, 'found', 'test -f should detect file');
    results.pass('test -f');
  } catch (e) {
    results.fail('test -f', e);
  }

  // Test: test -d (directory exists)
  try {
    const r = await os.exec('test -d /tmp && echo "isdir"');
    assertIncludes(r.stdout, 'isdir', 'test -d should detect directory');
    results.pass('test -d');
  } catch (e) {
    results.fail('test -d', e);
  }

  // Test: test string equality
  try {
    const r = await os.exec('test "abc" = "abc" && echo "match"');
    assertIncludes(r.stdout, 'match', 'test string equality');
    results.pass('test (string eq)');
  } catch (e) {
    results.fail('test (string eq)', e);
  }

  // Test: test failure path
  try {
    const r = await os.exec('test 1 -eq 2 && echo "yes" || echo "no"');
    assertIncludes(r.stdout, 'no', 'test failure should take || path');
    results.pass('test (failure path)');
  } catch (e) {
    results.fail('test (failure path)', e);
  }

  // Test: uname
  try {
    const r = await os.exec('uname');
    assert(r.stdout.trim().length > 0, 'uname should return something');
    results.pass('uname');
  } catch (e) {
    results.fail('uname', e);
  }

  // Test: seq
  try {
    const r = await os.exec('seq 1 5');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines.length, 5, 'seq 1 5 should produce 5 lines');
    assertEqual(lines[0], '1', 'seq starts at 1');
    assertEqual(lines[4], '5', 'seq ends at 5');
    results.pass('seq');
  } catch (e) {
    results.fail('seq', e);
  }

  // Test: seq with step
  try {
    const r = await os.exec('seq 2 2 10');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines[0], '2', 'seq step starts at 2');
    assertEqual(lines[4], '10', 'seq step ends at 10');
    results.pass('seq (step)');
  } catch (e) {
    results.fail('seq (step)', e);
  }

  // Test: which
  try {
    const r = await os.exec('which echo');
    assert(r.stdout.trim().length > 0 || r.exitCode === 0, 'which should find echo');
    results.pass('which');
  } catch (e) {
    results.fail('which', e);
  }

  // Test: hostname
  try {
    const r = await os.exec('hostname');
    assert(r.stdout.trim().length > 0, 'hostname should return a name');
    results.pass('hostname');
  } catch (e) {
    results.fail('hostname', e);
  }

  // Test: env lists environment variables
  try {
    const r = await os.exec('env');
    assert(r.stdout.length > 0, 'env should list variables');
    results.pass('env');
  } catch (e) {
    results.fail('env', e);
  }

  // Test: date with format string
  try {
    const r = await os.exec('date "+%Y-%m-%d"');
    assertIncludes(r.stdout, '-', 'date format should include dashes');
    assert(r.stdout.trim().length >= 10, 'date format should be at least YYYY-MM-DD');
    results.pass('date +format');
  } catch (e) {
    results.fail('date +format', e);
  }

  // Test: cat multiple files
  try {
    await os.writeFile('/tmp/ww-cat1.txt', 'part1\n');
    await os.writeFile('/tmp/ww-cat2.txt', 'part2\n');
    const r = await os.exec('cat /tmp/ww-cat1.txt /tmp/ww-cat2.txt');
    assertIncludes(r.stdout, 'part1', 'cat multi file 1');
    assertIncludes(r.stdout, 'part2', 'cat multi file 2');
    results.pass('cat (multiple files)');
  } catch (e) {
    results.fail('cat (multiple files)', e);
  }

  // Test: rm -r (recursive)
  try {
    await os.exec('mkdir -p /tmp/ww-rmr/sub');
    await os.writeFile('/tmp/ww-rmr/sub/file.txt', 'deep');
    await os.exec('rm -r /tmp/ww-rmr');
    const exists = await os.exists('/tmp/ww-rmr');
    assert(!exists, 'rm -r should remove directory tree');
    results.pass('rm -r');
  } catch (e) {
    results.fail('rm -r', e);
  }

  // Test: mkdir -p (recursive)
  try {
    await os.exec('mkdir -p /tmp/ww-mkdirp/a/b/c');
    const exists = await os.exists('/tmp/ww-mkdirp/a/b/c');
    assert(exists, 'mkdir -p should create nested dirs');
    results.pass('mkdir -p');
  } catch (e) {
    results.fail('mkdir -p', e);
  }

  // Test: ls -l (long format)
  try {
    await os.writeFile('/tmp/ww-lsl.txt', 'content');
    const r = await os.exec('ls -l /tmp/ww-lsl.txt');
    assert(r.stdout.length > 0, 'ls -l should produce output');
    results.pass('ls -l');
  } catch (e) {
    results.fail('ls -l', e);
  }

  // Test: ls -a (show hidden)
  try {
    await os.writeFile('/tmp/.ww-hidden', 'hidden');
    const r = await os.exec('ls -a /tmp');
    assertIncludes(r.stdout, '.ww-hidden', 'ls -a should show hidden files');
    results.pass('ls -a');
  } catch (e) {
    results.fail('ls -a', e);
  }

  // Test: ln -s (symlink / copy)
  try {
    await os.writeFile('/tmp/ww-ln-src.txt', 'link source');
    await os.exec('ln -s /tmp/ww-ln-src.txt /tmp/ww-ln-dst.txt');
    const content = await os.readFile('/tmp/ww-ln-dst.txt');
    assertIncludes(content, 'link source', 'ln should create link with same content');
    results.pass('ln -s');
  } catch (e) {
    results.fail('ln -s', e);
  }

  // Test: readlink -f (resolve path)
  try {
    await os.writeFile('/tmp/ww-readlink.txt', 'target');
    const r = await os.exec('readlink -f /tmp/../tmp/ww-readlink.txt');
    assertIncludes(r.stdout, '/tmp/ww-readlink.txt', 'readlink should resolve path');
    results.pass('readlink -f');
  } catch (e) {
    results.fail('readlink -f', e);
  }

  results.summary();
  return results;
}
