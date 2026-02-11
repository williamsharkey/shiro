// Level 5: Git Clone tests
// Verify git clone operations work in the virtual filesystem
// These tests will be activated once foam/shiro confirm git clone fixes are working

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 5: Git Clone (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  const testDir = '/tmp/ww-clone-tests';

  // Setup: clean workspace
  try {
    await os.exec(`rm -rf ${testDir}`);
    await os.exec(`mkdir -p ${testDir}`);
  } catch (e) {
    // ignore cleanup errors
  }

  // Test: git clone small public repo (foam - smallest repo)
  try {
    const cloneDir = `${testDir}/foam-clone`;
    const r = await os.exec(`cd ${testDir} && git clone https://github.com/williamsharkey/foam foam-clone`);

    // Check that clone succeeded (either exitCode 0 or success message)
    assert(
      r.exitCode === 0 || r.stdout.includes('Cloning') || r.stdout.includes('done'),
      'git clone should succeed'
    );

    // Verify cloned directory exists
    const exists = await os.exists(cloneDir);
    assert(exists, 'cloned directory should exist');

    // Verify .git directory exists
    const gitExists = await os.exists(`${cloneDir}/.git`);
    assert(gitExists, '.git directory should exist in clone');

    results.pass('git clone (small repo)');
  } catch (e) {
    results.fail('git clone (small repo)', e);
    // If basic clone doesn't work, skip other tests
    results.summary();
    return results;
  }

  // Test: verify cloned files are readable
  try {
    const cloneDir = `${testDir}/foam-clone`;

    // Check README exists
    const readmeExists = await os.exists(`${cloneDir}/README.md`);
    assert(readmeExists, 'README.md should exist in clone');

    // Read README content
    const readme = await os.readFile(`${cloneDir}/README.md`);
    assert(readme.length > 0, 'README should have content');
    assertIncludes(readme, 'foam', 'README should mention foam');

    results.pass('read cloned files');
  } catch (e) {
    results.fail('read cloned files', e);
  }

  // Test: verify git operations work in cloned repo
  try {
    const cloneDir = `${testDir}/foam-clone`;

    // git log should work
    const logResult = await os.exec(`cd ${cloneDir} && git log --oneline -1`);
    assert(logResult.exitCode === 0, 'git log should work in clone');
    assert(logResult.stdout.length > 0, 'git log should show commits');

    // git status should work
    const statusResult = await os.exec(`cd ${cloneDir} && git status`);
    assert(statusResult.exitCode === 0, 'git status should work in clone');

    results.pass('git operations in clone');
  } catch (e) {
    results.fail('git operations in clone', e);
  }

  // Test: modify file in cloned repo and commit
  try {
    const cloneDir = `${testDir}/foam-clone`;

    // Create a new file
    await os.writeFile(`${cloneDir}/test-from-windwalker.txt`, 'Test from windwalker');

    // Add the file
    const addResult = await os.exec(`cd ${cloneDir} && git add test-from-windwalker.txt`);
    assert(addResult.exitCode === 0, 'git add should work');

    // Commit the file
    const commitResult = await os.exec(`cd ${cloneDir} && git commit -m "test commit from windwalker"`);
    assert(
      commitResult.exitCode === 0 || commitResult.stdout.includes('test commit'),
      'git commit should work in clone'
    );

    // Verify log shows new commit
    const logResult = await os.exec(`cd ${cloneDir} && git log --oneline -1`);
    assertIncludes(logResult.stdout, 'test commit', 'log should show new commit');

    results.pass('commit to cloned repo');
  } catch (e) {
    results.fail('commit to cloned repo', e);
  }

  // Test: clone to specific directory name
  try {
    const customDir = `${testDir}/custom-name`;
    const r = await os.exec(`cd ${testDir} && git clone https://github.com/williamsharkey/foam ${customDir}`);

    assert(r.exitCode === 0 || r.stdout.includes('Cloning'), 'clone with custom dir should succeed');

    const exists = await os.exists(customDir);
    assert(exists, 'custom directory should exist');

    const gitExists = await os.exists(`${customDir}/.git`);
    assert(gitExists, '.git should exist in custom dir');

    results.pass('clone with custom directory');
  } catch (e) {
    results.fail('clone with custom directory', e);
  }

  // Test: clone URL variations (.git suffix)
  try {
    const withGit = `${testDir}/with-git-suffix`;
    const r = await os.exec(`cd ${testDir} && git clone https://github.com/williamsharkey/foam.git ${withGit}`);

    assert(r.exitCode === 0 || r.stdout.includes('Cloning'), 'clone with .git suffix should succeed');

    const exists = await os.exists(withGit);
    assert(exists, 'cloned directory should exist');

    results.pass('clone URL with .git suffix');
  } catch (e) {
    results.fail('clone URL with .git suffix', e);
  }

  // Test: list files in cloned repo
  try {
    const cloneDir = `${testDir}/foam-clone`;

    const files = await os.readdir(cloneDir);
    assert(files.length > 0, 'cloned repo should have files');
    assert(files.includes('.git'), 'should list .git directory');

    // Check for common foam files
    const hasReadme = files.includes('README.md');
    const hasPackage = files.includes('package.json');
    const hasSrc = files.includes('src');

    assert(
      hasReadme || hasPackage || hasSrc,
      'should have expected foam project files'
    );

    results.pass('list cloned repo files');
  } catch (e) {
    results.fail('list cloned repo files', e);
  }

  // Test: verify .git structure
  try {
    const cloneDir = `${testDir}/foam-clone`;
    const gitDir = `${cloneDir}/.git`;

    // Check for essential .git files
    const configExists = await os.exists(`${gitDir}/config`);
    const headExists = await os.exists(`${gitDir}/HEAD`);

    assert(configExists, '.git/config should exist');
    assert(headExists, '.git/HEAD should exist');

    // Read config to verify it's a valid git repo
    const config = await os.readFile(`${gitDir}/config`);
    assertIncludes(config, '[core]', 'config should have [core] section');

    results.pass('verify .git structure');
  } catch (e) {
    results.fail('verify .git structure', e);
  }

  // Test: check git remote
  try {
    const cloneDir = `${testDir}/foam-clone`;

    const r = await os.exec(`cd ${cloneDir} && git remote -v`);
    assert(r.exitCode === 0, 'git remote should work');
    assertIncludes(r.stdout, 'origin', 'should have origin remote');
    assertIncludes(r.stdout, 'github.com', 'origin should point to github');

    results.pass('git remote');
  } catch (e) {
    results.fail('git remote', e);
  }

  // Test: git branch in cloned repo
  try {
    const cloneDir = `${testDir}/foam-clone`;

    const r = await os.exec(`cd ${cloneDir} && git branch`);
    assert(r.exitCode === 0, 'git branch should work in clone');
    assert(r.stdout.length > 0, 'should list branches');

    results.pass('git branch in clone');
  } catch (e) {
    results.fail('git branch in clone', e);
  }

  // Test: performance check - clone should complete in reasonable time
  // (This is just a marker - actual timing is handled by test infrastructure)
  try {
    const start = Date.now();
    const cloneDir = `${testDir}/perf-test`;

    await os.exec(`cd ${testDir} && git clone https://github.com/williamsharkey/foam ${cloneDir}`);

    const elapsed = Date.now() - start;

    // Log timing for analysis (don't fail on slow clones, just note it)
    console.log(`    ⏱  Clone took ${elapsed}ms`);

    // Only fail if extremely slow (> 60 seconds)
    assert(elapsed < 60000, 'clone should complete within 60 seconds');

    results.pass('clone performance');
  } catch (e) {
    results.fail('clone performance', e);
  }

  results.summary();
  return results;
}
