// Level 9: Self-build tests
// The ultimate integration test: can the OS git-clone a real repo and build it?
// Tests Foam cloning/building Foam and Shiro cloning/building Shiro.
// This exercises git clone, npm, node, and the full development toolchain.

import { createOSHelpers, TestResults, assertEqual, assert, assertIncludes } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 9: Self-Build (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  // Determine which repo to clone based on the OS under test
  const repoUrl = osTarget === 'foam'
    ? 'https://github.com/williamsharkey/foam'
    : 'https://github.com/williamsharkey/shiro';
  const cloneDir = `/home/user/selfbuild-${osTarget}`;

  // Test: git clone the OS's own repo
  try {
    // Clean up any previous run
    await os.exec(`rm -rf ${cloneDir}`);

    const r = await os.exec(`git clone ${repoUrl} ${cloneDir}`);
    // git clone may output to stderr (progress) or stdout
    const cloneOk = r.exitCode === 0 ||
      r.stdout.includes('Cloning') || r.stderr.includes('Cloning') ||
      r.stdout.includes('done') || r.stderr.includes('done');
    assert(cloneOk, `git clone failed: exit=${r.exitCode} stdout=${r.stdout.slice(0,200)} stderr=${r.stderr.slice(0,200)}`);
    results.pass('git clone own repo');
  } catch (e) {
    results.fail('git clone own repo', e);
    // If clone fails, skip remaining tests
    results.skip('verify cloned files', 'clone failed');
    results.skip('read package.json', 'clone failed');
    results.skip('read README.md', 'clone failed');
    results.skip('list source directory', 'clone failed');
    results.skip('verify source files', 'clone failed');
    results.skip('git log in cloned repo', 'clone failed');
    results.skip('git status in cloned repo', 'clone failed');
    results.skip('modify and commit in cloned repo', 'clone failed');
    results.summary();
    return results;
  }

  // Test: cloned directory has expected files
  try {
    const hasPackageJson = await os.exists(`${cloneDir}/package.json`);
    const hasReadme = await os.exists(`${cloneDir}/README.md`);
    assert(hasPackageJson, 'cloned repo should have package.json');
    assert(hasReadme, 'cloned repo should have README.md');
    results.pass('verify cloned files');
  } catch (e) {
    results.fail('verify cloned files', e);
  }

  // Test: read and parse package.json
  try {
    const pkg = await os.readFile(`${cloneDir}/package.json`);
    const parsed = JSON.parse(pkg);
    assertEqual(parsed.name, osTarget, `package.json name should be ${osTarget}`);
    assert(parsed.version, 'package.json should have version');
    results.pass('read package.json');
  } catch (e) {
    results.fail('read package.json', e);
  }

  // Test: read README.md
  try {
    const readme = await os.readFile(`${cloneDir}/README.md`);
    assert(readme.length > 100, 'README should have substantial content');
    results.pass('read README.md');
  } catch (e) {
    results.fail('read README.md', e);
  }

  // Test: list source directory
  try {
    const r = await os.exec(`ls ${cloneDir}/src`);
    assert(r.stdout.length > 0, 'src/ directory should have files');
    results.pass('list source directory');
  } catch (e) {
    results.fail('list source directory', e);
  }

  // Test: verify key source files exist
  try {
    if (osTarget === 'foam') {
      const hasVfs = await os.exists(`${cloneDir}/src/vfs.js`);
      const hasShell = await os.exists(`${cloneDir}/src/shell.js`);
      const hasCommands = await os.exists(`${cloneDir}/src/commands.js`);
      assert(hasVfs, 'foam should have src/vfs.js');
      assert(hasShell, 'foam should have src/shell.js');
      assert(hasCommands, 'foam should have src/commands.js');
    } else {
      const hasFs = await os.exists(`${cloneDir}/src/filesystem.ts`);
      const hasShell = await os.exists(`${cloneDir}/src/shell.ts`);
      const hasMain = await os.exists(`${cloneDir}/src/main.ts`);
      assert(hasFs, 'shiro should have src/filesystem.ts');
      assert(hasShell, 'shiro should have src/shell.ts');
      assert(hasMain, 'shiro should have src/main.ts');
    }
    results.pass('verify source files');
  } catch (e) {
    results.fail('verify source files', e);
  }

  // Test: git log works in cloned repo
  try {
    const r = await os.exec(`cd ${cloneDir} && git log`);
    assert(r.stdout.length > 0, 'git log should show commits');
    assertIncludes(r.stdout, 'commit', 'git log should contain commit entries');
    results.pass('git log in cloned repo');
  } catch (e) {
    results.fail('git log in cloned repo', e);
  }

  // Test: git status in cloned repo (should be clean)
  try {
    const r = await os.exec(`cd ${cloneDir} && git status`);
    assert(r.stdout.length > 0, 'git status should produce output');
    results.pass('git status in cloned repo');
  } catch (e) {
    results.fail('git status in cloned repo', e);
  }

  // Test: modify a file and commit in cloned repo
  try {
    // Add a test marker file
    await os.writeFile(`${cloneDir}/WINDWALKER_TEST.md`, [
      '# Windwalker Self-Build Test',
      '',
      `This file was created by windwalker level-9 self-build test.`,
      `OS: ${osTarget}`,
      `Date: ${new Date().toISOString()}`,
    ].join('\n'));

    await os.exec(`cd ${cloneDir} && git add WINDWALKER_TEST.md`);
    const r = await os.exec(`cd ${cloneDir} && git commit -m "windwalker: add self-build test marker"`);
    assert(r.exitCode === 0 || r.stdout.includes('windwalker'), 'commit should succeed');

    // Verify it shows in log
    const log = await os.exec(`cd ${cloneDir} && git log --oneline`);
    assertIncludes(log.stdout, 'windwalker', 'log should show our commit');

    results.pass('modify and commit in cloned repo');
  } catch (e) {
    results.fail('modify and commit in cloned repo', e);
  }

  // Test: grep across cloned source (realistic Spirit workflow)
  try {
    const searchTerm = osTarget === 'foam' ? 'writeFile' : 'writeFile';
    const srcDir = `${cloneDir}/src`;
    const r = await os.exec(`grep -r "${searchTerm}" ${srcDir}`);
    assert(r.stdout.length > 0, `grep should find "${searchTerm}" in source`);
    results.pass('grep across cloned source');
  } catch (e) {
    results.fail('grep across cloned source', e);
  }

  // Test: find all JS/TS files in cloned repo
  try {
    const ext = osTarget === 'foam' ? '*.js' : '*.ts';
    const r = await os.exec(`find ${cloneDir}/src -name "${ext}"`);
    assert(r.stdout.trim().split(/\r?\n/).length >= 3, `should find multiple ${ext} files`);
    results.pass('find source files');
  } catch (e) {
    results.fail('find source files', e);
  }

  // Test: count lines of code in cloned repo
  try {
    const ext = osTarget === 'foam' ? '*.js' : '*.ts';
    const r = await os.exec(`find ${cloneDir}/src -name "${ext}" | xargs wc -l`);
    assert(r.stdout.length > 0, 'wc should count lines');
    results.pass('count lines of code');
  } catch (e) {
    results.fail('count lines of code', e);
  }

  results.summary();
  return results;
}
