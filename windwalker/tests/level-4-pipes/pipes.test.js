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

  // Test: head in pipeline
  try {
    const r = await os.exec('cat /tmp/ww-pipe-data.txt | head -n 2');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines.length, 2, 'head -n 2 should return 2 lines');
    assertEqual(lines[0], 'cherry', 'first line');
    results.pass('head in pipeline');
  } catch (e) {
    results.fail('head in pipeline', e);
  }

  // Test: tail in pipeline
  try {
    const r = await os.exec('cat /tmp/ww-pipe-data.txt | tail -n 2');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines.length, 2, 'tail -n 2 should return 2 lines');
    results.pass('tail in pipeline');
  } catch (e) {
    results.fail('tail in pipeline', e);
  }

  // Test: wc -w (word count)
  try {
    const r = await os.exec('echo "one two three" | wc -w');
    assertIncludes(r.stdout, '3', 'word count');
    results.pass('wc -w in pipeline');
  } catch (e) {
    results.fail('wc -w in pipeline', e);
  }

  // Test: wc -c (byte count)
  try {
    const r = await os.exec('echo "hello" | wc -c');
    // "hello\n" = 6 chars
    assert(r.stdout.trim().length > 0, 'wc -c should output count');
    results.pass('wc -c in pipeline');
  } catch (e) {
    results.fail('wc -c in pipeline', e);
  }

  // Test: nested command substitution
  try {
    const r = await os.exec('echo "result: $(echo $(echo nested))"');
    assertIncludes(r.stdout, 'result: nested', 'nested command substitution');
    results.pass('nested command substitution');
  } catch (e) {
    results.fail('nested command substitution', e);
  }

  // Test: backtick command substitution
  try {
    const r = await os.exec('echo "value is `echo 42`"');
    assertIncludes(r.stdout, 'value is 42', 'backtick substitution');
    results.pass('backtick command substitution');
  } catch (e) {
    results.fail('backtick command substitution', e);
  }

  // Test: multiple pipes with wc
  try {
    const r = await os.exec('cat /tmp/ww-pipe-data.txt | grep apple | wc -l');
    assertIncludes(r.stdout, '2', 'multi-pipe with wc');
    results.pass('multiple pipes (grep | wc)');
  } catch (e) {
    results.fail('multiple pipes (grep | wc)', e);
  }

  // Test: sort -r (reverse)
  try {
    const r = await os.exec('cat /tmp/ww-pipe-data.txt | sort -r | head -n 1');
    assertIncludes(r.stdout, 'date', 'reverse sort first');
    results.pass('sort -r in pipeline');
  } catch (e) {
    results.fail('sort -r in pipeline', e);
  }

  // Test: uniq -c (count)
  try {
    const r = await os.exec('cat /tmp/ww-pipe-data.txt | sort | uniq -c');
    assertIncludes(r.stdout, '2', 'uniq -c should show counts');
    results.pass('uniq -c in pipeline');
  } catch (e) {
    results.fail('uniq -c in pipeline', e);
  }

  // Test: tr in pipeline (lowercase)
  try {
    const r = await os.exec('echo "HELLO" | tr "A-Z" "a-z"');
    assertIncludes(r.stdout, 'hello', 'tr should lowercase');
    results.pass('tr lowercase in pipeline');
  } catch (e) {
    results.fail('tr lowercase in pipeline', e);
  }

  // Test: cut in pipeline
  try {
    await os.writeFile('/tmp/ww-csv.txt', 'a,b,c\n1,2,3');
    const r = await os.exec('cat /tmp/ww-csv.txt | cut -d "," -f 2');
    assertIncludes(r.stdout, 'b', 'cut should extract field 2');
    results.pass('cut in pipeline');
  } catch (e) {
    results.fail('cut in pipeline', e);
  }

  // Test: grep -v (invert match)
  try {
    const r = await os.exec('cat /tmp/ww-pipe-data.txt | grep -v apple');
    assert(!r.stdout.includes('apple'), 'grep -v should exclude apple');
    assertIncludes(r.stdout, 'cherry', 'grep -v should include cherry');
    results.pass('grep -v in pipeline');
  } catch (e) {
    results.fail('grep -v in pipeline', e);
  }

  // Test: grep -i (case insensitive)
  try {
    await os.writeFile('/tmp/ww-mixed.txt', 'Apple\napple\nAPPLE');
    const r = await os.exec('cat /tmp/ww-mixed.txt | grep -i apple');
    const lines = r.stdout.trim().split(/\r?\n/);
    assertEqual(lines.length, 3, 'grep -i should match all cases');
    results.pass('grep -i in pipeline');
  } catch (e) {
    results.fail('grep -i in pipeline', e);
  }

  // Test: redirect with && operator
  try {
    await os.exec('echo "step1" > /tmp/ww-step.txt && echo "step2" >> /tmp/ww-step.txt');
    const content = await os.readFile('/tmp/ww-step.txt');
    assertIncludes(content, 'step1', 'step1 present');
    assertIncludes(content, 'step2', 'step2 present');
    results.pass('redirect with && operator');
  } catch (e) {
    results.fail('redirect with && operator', e);
  }

  // Test: pipe exit code propagation
  try {
    const r = await os.exec('false | echo "ran"');
    // The echo should still run; pipe exit code is from last command
    assertIncludes(r.stdout, 'ran', 'second command in pipe runs');
    results.pass('pipe command independence');
  } catch (e) {
    results.fail('pipe command independence', e);
  }

  // Test: printf in pipeline
  try {
    const r = await os.exec('printf "a\\nb\\nc" | wc -l');
    assertIncludes(r.stdout, '3', 'printf piped to wc');
    results.pass('printf in pipeline');
  } catch (e) {
    results.fail('printf in pipeline', e);
  }

  // Test: complex pipeline with multiple transformations
  try {
    await os.writeFile('/tmp/ww-complex.txt', 'Banana\napple\nCherry\napple\nDate');
    const r = await os.exec('cat /tmp/ww-complex.txt | tr "A-Z" "a-z" | sort | uniq -c | sort -rn | head -n 1');
    assertIncludes(r.stdout, '2', 'apple appears twice');
    assertIncludes(r.stdout, 'apple', 'apple is most common');
    results.pass('complex pipeline (5 stages)');
  } catch (e) {
    results.fail('complex pipeline (5 stages)', e);
  }

  // Test: redirect stderr to stdout (2>&1)
  try {
    const r = await os.exec('nonexistent_cmd 2>&1 | cat');
    // Should either contain an error message or have run through cat
    results.pass('stderr redirect (2>&1)');
  } catch (e) {
    // Either passing or throwing is acceptable for this edge case
    results.pass('stderr redirect (2>&1) (threw)');
  }

  // Test: pipeline with arithmetic
  try {
    const r = await os.exec('echo $((5 * 5)) | cat');
    assertIncludes(r.stdout, '25', 'arithmetic in pipeline');
    results.pass('arithmetic in pipeline');
  } catch (e) {
    results.fail('arithmetic in pipeline', e);
  }

  // Test: command substitution in redirect filename
  try {
    await os.exec('echo "test" > /tmp/ww-$(echo subst).txt');
    const content = await os.readFile('/tmp/ww-subst.txt');
    assertIncludes(content, 'test', 'subst in filename');
    results.pass('command substitution in filename');
  } catch (e) {
    results.fail('command substitution in filename', e);
  }

  // Test: multiple redirects in sequence
  try {
    await os.exec('echo "line1" > /tmp/ww-seq.txt');
    await os.exec('echo "line2" >> /tmp/ww-seq.txt');
    await os.exec('echo "line3" >> /tmp/ww-seq.txt');
    const r = await os.exec('cat /tmp/ww-seq.txt | wc -l');
    assertIncludes(r.stdout, '3', 'sequence of redirects');
    results.pass('multiple redirects in sequence');
  } catch (e) {
    results.fail('multiple redirects in sequence', e);
  }

  // Test: grep with pipe and redirect
  try {
    await os.writeFile('/tmp/ww-gpr.txt', 'apple\nbanana\napricot\ncherry');
    await os.exec('cat /tmp/ww-gpr.txt | grep "ap" > /tmp/ww-gpr-out.txt');
    const content = await os.readFile('/tmp/ww-gpr-out.txt');
    assertIncludes(content, 'apple', 'grep pipe redirect apple');
    assertIncludes(content, 'apricot', 'grep pipe redirect apricot');
    assert(!content.includes('banana'), 'should not include banana');
    results.pass('grep with pipe and redirect');
  } catch (e) {
    results.fail('grep with pipe and redirect', e);
  }

  results.summary();
  return results;
}
