// Level 8: FluffyCoreutils integration tests
// Verify fluffycoreutils commands work correctly when integrated into the host shell.
// These tests validate that the shared coreutils library is properly
// hooked into the OS command system (once integrated).

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 8: FluffyCoreutils (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  // Check if fluffycoreutils is integrated
  const hasFluffyCoreutils = await page.evaluate((osName) => {
    if (osName === 'foam') {
      return !!(window.__foam?.fluffycoreutils || window.__foam?.coreutils);
    }
    return !!(window.__shiro?.fluffycoreutils || window.__shiro?.coreutils);
  }, osTarget);

  if (!hasFluffyCoreutils) {
    results.skip('all fluffycoreutils tests', 'fluffycoreutils not yet integrated');
    results.summary();
    return results;
  }

  // Test: tr (translate characters)
  try {
    results.startTest();
    const r = await os.exec('echo "hello" | tr "aeiou" "AEIOU"');
    assertIncludes(r.stdout, 'hEllO', 'tr should translate vowels');
    results.pass('tr');
  } catch (e) {
    results.fail('tr', e);
  }

  // Test: tr -d (delete characters)
  try {
    results.startTest();
    const r = await os.exec('echo "hello world" | tr -d " "');
    assertIncludes(r.stdout, 'helloworld', 'tr -d should delete spaces');
    results.pass('tr -d');
  } catch (e) {
    results.fail('tr -d', e);
  }

  // Test: cut -d -f (field extraction)
  try {
    results.startTest();
    await os.writeFile('/tmp/ww-cut.csv', 'name,age,city\nAlice,30,NYC\nBob,25,LA');
    const r = await os.exec('cut -d "," -f 1 /tmp/ww-cut.csv');
    assertIncludes(r.stdout, 'name', 'cut should extract first field');
    assertIncludes(r.stdout, 'Alice', 'cut should extract Alice');
    results.pass('cut -d -f');
  } catch (e) {
    results.fail('cut -d -f', e);
  }

  // Test: printf
  try {
    results.startTest();
    const r = await os.exec('printf "Hello %s, you are %d" "World" 42');
    assertIncludes(r.stdout, 'Hello World', 'printf string format');
    assertIncludes(r.stdout, '42', 'printf number format');
    results.pass('printf');
  } catch (e) {
    results.fail('printf', e);
  }

  // Test: test / [ ] (conditional expressions)
  try {
    results.startTest();
    await os.writeFile('/tmp/ww-test-exists.txt', 'exists');
    const r = await os.exec('test -f /tmp/ww-test-exists.txt && echo "yes"');
    assertIncludes(r.stdout, 'yes', 'test -f should succeed for existing file');
    results.pass('test -f');
  } catch (e) {
    results.fail('test -f', e);
  }

  // Test: uname
  try {
    results.startTest();
    const r = await os.exec('uname');
    assert(r.stdout.trim().length > 0, 'uname should return system name');
    results.pass('uname');
  } catch (e) {
    results.fail('uname', e);
  }

  // Test: readlink -f
  try {
    results.startTest();
    const r = await os.exec('readlink -f /tmp/../tmp/ww-test-exists.txt');
    assertIncludes(r.stdout, '/tmp/ww-test-exists.txt', 'readlink should resolve path');
    results.pass('readlink -f');
  } catch (e) {
    results.fail('readlink -f', e);
  }

  // Test: hostname
  try {
    results.startTest();
    const r = await os.exec('hostname');
    assert(r.stdout.trim().length > 0, 'hostname should return a name');
    results.pass('hostname');
  } catch (e) {
    results.fail('hostname', e);
  }

  // Test: date with format
  try {
    results.startTest();
    const r = await os.exec('date "+%Y-%m-%d"');
    assertIncludes(r.stdout, '-', 'date format should include dashes');
    assert(r.stdout.trim().length >= 10, 'date format should be at least YYYY-MM-DD');
    results.pass('date +format');
  } catch (e) {
    results.fail('date +format', e);
  }

  // Test: ln (link/copy)
  try {
    results.startTest();
    await os.writeFile('/tmp/ww-ln-src.txt', 'link source');
    await os.exec('ln -s /tmp/ww-ln-src.txt /tmp/ww-ln-dst.txt');
    const content = await os.readFile('/tmp/ww-ln-dst.txt');
    assertIncludes(content, 'link source', 'ln should create link with same content');
    results.pass('ln -s');
  } catch (e) {
    results.fail('ln -s', e);
  }

  results.summary();
  return results;
}
