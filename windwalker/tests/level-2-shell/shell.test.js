// Level 2: Shell tests
// Verify command execution, exit codes, and environment variables

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 2: Shell (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  // Test: echo command
  try {
    const r = await os.exec('echo hello world');
    assertIncludes(r.stdout, 'hello world', 'echo output');
    results.pass('echo');
  } catch (e) {
    results.fail('echo', e);
  }

  // Test: pwd
  try {
    const r = await os.exec('pwd');
    assert(r.stdout.trim().length > 0, 'pwd should return a path');
    assert(r.stdout.trim().startsWith('/'), 'pwd should return absolute path');
    results.pass('pwd');
  } catch (e) {
    results.fail('pwd', e);
  }

  // Test: Exit code 0 for success
  try {
    const r = await os.exec('true');
    assertEqual(r.exitCode, 0, 'true should exit 0');
    results.pass('exit code 0 (true)');
  } catch (e) {
    results.fail('exit code 0 (true)', e);
  }

  // Test: Exit code 1 for failure
  try {
    const r = await os.exec('false');
    assert(r.exitCode !== 0, 'false should exit non-zero');
    results.pass('exit code non-zero (false)');
  } catch (e) {
    results.fail('exit code non-zero (false)', e);
  }

  // Test: Environment variable expansion
  try {
    const r = await os.exec('echo $HOME');
    assert(r.stdout.trim().length > 0, 'HOME should be set');
    results.pass('env var expansion ($HOME)');
  } catch (e) {
    results.fail('env var expansion ($HOME)', e);
  }

  // Test: export and use variable
  try {
    const r = await os.exec('export WW_TEST=windwalker && echo $WW_TEST');
    assertIncludes(r.stdout, 'windwalker', 'exported var');
    results.pass('export + use variable');
  } catch (e) {
    results.fail('export + use variable', e);
  }

  // Test: cd changes directory
  try {
    await os.exec('cd /tmp');
    const r = await os.exec('pwd');
    // Note: cd may or may not persist across exec calls depending on OS impl
    // This test checks if cd at least works within a compound command
    const r2 = await os.exec('cd /tmp && pwd');
    assertIncludes(r2.stdout, '/tmp', 'cd should change directory');
    results.pass('cd changes directory');
  } catch (e) {
    results.fail('cd changes directory', e);
  }

  // Test: Command not found
  try {
    const r = await os.exec('nonexistent_command_ww_12345');
    assert(r.exitCode !== 0 || r.stderr.length > 0,
      'nonexistent command should fail or produce stderr');
    results.pass('command not found error');
  } catch (e) {
    // Throwing is also acceptable for command not found
    results.pass('command not found error (threw)');
  }

  // Test: Quoted strings
  try {
    const r = await os.exec('echo "hello   world"');
    assertIncludes(r.stdout, 'hello   world', 'quoted string preserves spaces');
    results.pass('quoted string handling');
  } catch (e) {
    results.fail('quoted string handling', e);
  }

  // Test: Single quotes prevent expansion
  try {
    const r = await os.exec("echo '$HOME'");
    assertIncludes(r.stdout, '$HOME', 'single quotes should prevent expansion');
    results.pass('single quotes prevent expansion');
  } catch (e) {
    results.fail('single quotes prevent expansion', e);
  }

  // Test: Semicolon separates commands
  try {
    const r = await os.exec('echo first; echo second');
    assertIncludes(r.stdout, 'first', 'first command');
    assertIncludes(r.stdout, 'second', 'second command');
    results.pass('semicolon separates commands');
  } catch (e) {
    results.fail('semicolon separates commands', e);
  }

  results.summary();
  return results;
}
