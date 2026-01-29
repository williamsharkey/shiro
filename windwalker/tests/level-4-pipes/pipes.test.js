// Level 4: Pipes and redirection tests
// Verify pipelines, redirects, and compound command operators

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 4: Pipes & Redirection (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  // Setup
  try {
    await os.writeFile('/tmp/ww-pipe-data.txt', 'cherry\napple\nbanana\napple\ncherry\ndate');
  } catch (e) {
    results.fail('setup', e);
    results.summary();
    return results;
  }

  // Test: Simple pipe
  try {
    const r = await os.exec('echo "hello world" | wc -l');
    assertIncludes(r.stdout, '1', 'pipe to wc should count 1 line');
    results.pass('simple pipe (echo | wc)');
  } catch (e) {
    results.fail('simple pipe (echo | wc)', e);
  }

  // Test: Multi-stage pipeline
  try {
    const r = await os.exec('cat /tmp/ww-pipe-data.txt | sort | uniq');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines.length, 4, 'sort | uniq should yield 4 unique items');
    assertEqual(lines[0], 'apple', 'first sorted unique');
    results.pass('multi-stage pipeline (cat | sort | uniq)');
  } catch (e) {
    results.fail('multi-stage pipeline (cat | sort | uniq)', e);
  }

  // Test: grep in pipeline
  try {
    const r = await os.exec('cat /tmp/ww-pipe-data.txt | grep "apple"');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines.length, 2, 'grep should find 2 apple lines');
    results.pass('grep in pipeline');
  } catch (e) {
    results.fail('grep in pipeline', e);
  }

  // Test: stdout redirect (>)
  try {
    await os.exec('echo "redirected output" > /tmp/ww-redir.txt');
    const content = await os.readFile('/tmp/ww-redir.txt');
    assertIncludes(content, 'redirected output', 'redirect content');
    results.pass('stdout redirect (>)');
  } catch (e) {
    results.fail('stdout redirect (>)', e);
  }

  // Test: stdout append redirect (>>)
  try {
    await os.exec('echo "line1" > /tmp/ww-append.txt');
    await os.exec('echo "line2" >> /tmp/ww-append.txt');
    const content = await os.readFile('/tmp/ww-append.txt');
    assertIncludes(content, 'line1', 'append should keep line1');
    assertIncludes(content, 'line2', 'append should add line2');
    results.pass('stdout append redirect (>>)');
  } catch (e) {
    results.fail('stdout append redirect (>>)', e);
  }

  // Test: stdin redirect (<)
  try {
    const r = await os.exec('wc -l < /tmp/ww-pipe-data.txt');
    assertIncludes(r.stdout, '6', 'stdin redirect line count');
    results.pass('stdin redirect (<)');
  } catch (e) {
    results.fail('stdin redirect (<)', e);
  }

  // Test: && operator (short-circuit on success)
  try {
    const r = await os.exec('true && echo "success"');
    assertIncludes(r.stdout, 'success', '&& should run second on success');
    results.pass('&& operator (success path)');
  } catch (e) {
    results.fail('&& operator (success path)', e);
  }

  // Test: && operator (short-circuit on failure)
  try {
    const r = await os.exec('false && echo "should not appear"');
    assert(!r.stdout.includes('should not appear'),
      '&& should not run second on failure');
    results.pass('&& operator (failure path)');
  } catch (e) {
    results.fail('&& operator (failure path)', e);
  }

  // Test: || operator (run on failure)
  try {
    const r = await os.exec('false || echo "fallback"');
    assertIncludes(r.stdout, 'fallback', '|| should run second on failure');
    results.pass('|| operator');
  } catch (e) {
    results.fail('|| operator', e);
  }

  // Test: Combined && and ||
  try {
    const r = await os.exec('true && echo "yes" || echo "no"');
    assertIncludes(r.stdout, 'yes', '&& || combined');
    assert(!r.stdout.includes('no'), 'should not hit || branch');
    results.pass('combined && ||');
  } catch (e) {
    results.fail('combined && ||', e);
  }

  // Test: Command substitution $()
  try {
    const r = await os.exec('echo "today is $(echo Tuesday)"');
    assertIncludes(r.stdout, 'today is Tuesday', 'command substitution');
    results.pass('command substitution $()');
  } catch (e) {
    results.fail('command substitution $()', e);
  }

  // Test: Pipeline with redirect
  try {
    await os.exec('cat /tmp/ww-pipe-data.txt | sort | uniq > /tmp/ww-pipe-out.txt');
    const content = await os.readFile('/tmp/ww-pipe-out.txt');
    const lines = content.trim().split(/\r?\n/);
    assertEqual(lines.length, 4, 'pipeline > file');
    results.pass('pipeline with redirect');
  } catch (e) {
    results.fail('pipeline with redirect', e);
  }

  // Test: tee
  try {
    await os.exec('echo "tee test" | tee /tmp/ww-tee.txt');
    const content = await os.readFile('/tmp/ww-tee.txt');
    assertIncludes(content, 'tee test', 'tee should write to file');
    results.pass('tee');
  } catch (e) {
    results.fail('tee', e);
  }

  // Test: xargs
  try {
    const r = await os.exec('echo "hello world" | xargs echo');
    assertIncludes(r.stdout, 'hello world', 'xargs echo');
    results.pass('xargs');
  } catch (e) {
    results.fail('xargs', e);
  }

  results.summary();
  return results;
}
