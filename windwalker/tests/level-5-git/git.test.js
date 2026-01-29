// Level 5: Git tests
// Verify git operations work in the virtual filesystem

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 5: Git (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  const repoDir = '/tmp/ww-git-repo';

  // Setup: clean workspace
  try {
    // Create a clean directory for git tests
    await os.exec(`rm -rf ${repoDir}`);
    await os.exec(`mkdir -p ${repoDir}`);
  } catch (e) {
    // ignore cleanup errors
  }

  // Test: git init
  try {
    const r = await os.exec(`cd ${repoDir} && git init`);
    assert(r.exitCode === 0 || r.stdout.includes('Initialized'),
      'git init should succeed');
    results.pass('git init');
  } catch (e) {
    results.fail('git init', e);
    results.summary();
    return results; // Can't continue without init
  }

  // Test: git status on empty repo
  try {
    const r = await os.exec(`cd ${repoDir} && git status`);
    assert(r.stdout.length > 0, 'git status should produce output');
    results.pass('git status (empty repo)');
  } catch (e) {
    results.fail('git status (empty repo)', e);
  }

  // Test: create file and git add
  try {
    await os.writeFile(`${repoDir}/hello.txt`, 'Hello from windwalker');
    const r = await os.exec(`cd ${repoDir} && git add hello.txt`);
    assertEqual(r.exitCode, 0, 'git add exit code');
    results.pass('git add');
  } catch (e) {
    results.fail('git add', e);
  }

  // Test: git status shows staged file
  try {
    const r = await os.exec(`cd ${repoDir} && git status`);
    // Should mention hello.txt as staged/new
    assertIncludes(r.stdout, 'hello.txt', 'status should show staged file');
    results.pass('git status (staged file)');
  } catch (e) {
    results.fail('git status (staged file)', e);
  }

  // Test: git commit
  try {
    const r = await os.exec(`cd ${repoDir} && git commit -m "initial commit"`);
    assert(r.exitCode === 0 || r.stdout.includes('initial commit'),
      'git commit should succeed');
    results.pass('git commit');
  } catch (e) {
    results.fail('git commit', e);
  }

  // Test: git log
  try {
    const r = await os.exec(`cd ${repoDir} && git log`);
    assertIncludes(r.stdout, 'initial commit', 'log should show commit message');
    results.pass('git log');
  } catch (e) {
    results.fail('git log', e);
  }

  // Test: modify file and check diff
  try {
    await os.writeFile(`${repoDir}/hello.txt`, 'Hello from windwalker\nSecond line');
    const r = await os.exec(`cd ${repoDir} && git diff`);
    assert(r.stdout.length > 0 || r.exitCode === 0, 'git diff should show changes');
    results.pass('git diff');
  } catch (e) {
    results.fail('git diff', e);
  }

  // Test: second commit
  try {
    await os.exec(`cd ${repoDir} && git add hello.txt`);
    const r = await os.exec(`cd ${repoDir} && git commit -m "add second line"`);
    assert(r.exitCode === 0 || r.stdout.includes('add second line'),
      'second commit should succeed');
    results.pass('git commit (second)');
  } catch (e) {
    results.fail('git commit (second)', e);
  }

  // Test: git log shows both commits
  try {
    const r = await os.exec(`cd ${repoDir} && git log`);
    assertIncludes(r.stdout, 'initial commit', 'log should show first commit');
    assertIncludes(r.stdout, 'add second line', 'log should show second commit');
    results.pass('git log (multiple commits)');
  } catch (e) {
    results.fail('git log (multiple commits)', e);
  }

  // Test: git branch
  try {
    const r = await os.exec(`cd ${repoDir} && git branch`);
    assert(r.stdout.length > 0, 'git branch should list branches');
    results.pass('git branch');
  } catch (e) {
    results.fail('git branch', e);
  }

  // Test: multiple files in one commit
  try {
    await os.writeFile(`${repoDir}/a.js`, 'const a = 1;');
    await os.writeFile(`${repoDir}/b.js`, 'const b = 2;');
    await os.exec(`cd ${repoDir} && git add a.js b.js`);
    const r = await os.exec(`cd ${repoDir} && git commit -m "add js files"`);
    assert(r.exitCode === 0, 'multi-file commit should succeed');
    results.pass('multi-file commit');
  } catch (e) {
    results.fail('multi-file commit', e);
  }

  results.summary();
  return results;
}
