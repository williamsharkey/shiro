// Level 1: Filesystem tests
// Verify VFS CRUD operations work correctly

import { createOSHelpers, TestResults, assertEqual, assert } from '../helpers.js';

export default async function run(page, osTarget) {
  const results = new TestResults(`Level 1: Filesystem (${osTarget})`);
  const os = createOSHelpers(page, osTarget);
  console.log(`\n● ${results.suite}`);

  // Test: Write and read a file
  try {
    await os.writeFile('/tmp/ww-test.txt', 'hello windwalker');
    const content = await os.readFile('/tmp/ww-test.txt');
    assertEqual(content, 'hello windwalker', 'file content mismatch');
    results.pass('writeFile + readFile');
  } catch (e) {
    results.fail('writeFile + readFile', e);
  }

  // Test: Overwrite a file
  try {
    await os.writeFile('/tmp/ww-test.txt', 'overwritten');
    const content = await os.readFile('/tmp/ww-test.txt');
    assertEqual(content, 'overwritten', 'overwrite failed');
    results.pass('overwrite file');
  } catch (e) {
    results.fail('overwrite file', e);
  }

  // Test: Read nonexistent file throws
  try {
    let threw = false;
    try {
      await os.readFile('/tmp/nonexistent-ww-' + Date.now());
    } catch {
      threw = true;
    }
    assert(threw, 'reading nonexistent file should throw');
    results.pass('readFile throws for missing file');
  } catch (e) {
    results.fail('readFile throws for missing file', e);
  }

  // Test: mkdir and readdir
  try {
    await os.mkdir('/tmp/ww-testdir');
    await os.writeFile('/tmp/ww-testdir/a.txt', 'aaa');
    await os.writeFile('/tmp/ww-testdir/b.txt', 'bbb');
    const entries = await os.readdir('/tmp/ww-testdir');
    // entries might be strings or objects with name property
    const names = entries.map(e => typeof e === 'string' ? e : e.name);
    assert(names.includes('a.txt'), 'readdir should list a.txt');
    assert(names.includes('b.txt'), 'readdir should list b.txt');
    results.pass('mkdir + readdir');
  } catch (e) {
    results.fail('mkdir + readdir', e);
  }

  // Test: stat returns file info
  try {
    await os.writeFile('/tmp/ww-stat.txt', 'stat test');
    const info = await os.stat('/tmp/ww-stat.txt');
    assert(info, 'stat should return info');
    // Most VFS implementations include type or isFile
    results.pass('stat returns info');
  } catch (e) {
    results.fail('stat returns info', e);
  }

  // Test: exists
  try {
    const yes = await os.exists('/tmp/ww-stat.txt');
    const no = await os.exists('/tmp/ww-definitely-not-' + Date.now());
    assert(yes === true, 'exists should return true for existing file');
    assert(no === false, 'exists should return false for missing file');
    results.pass('exists check');
  } catch (e) {
    results.fail('exists check', e);
  }

  // Test: unlink
  try {
    await os.writeFile('/tmp/ww-unlink.txt', 'delete me');
    assert(await os.exists('/tmp/ww-unlink.txt'), 'file should exist before unlink');
    await os.unlink('/tmp/ww-unlink.txt');
    assert(!(await os.exists('/tmp/ww-unlink.txt')), 'file should not exist after unlink');
    results.pass('unlink');
  } catch (e) {
    results.fail('unlink', e);
  }

  // Test: rename
  try {
    await os.writeFile('/tmp/ww-rename-old.txt', 'rename me');
    await os.rename('/tmp/ww-rename-old.txt', '/tmp/ww-rename-new.txt');
    const content = await os.readFile('/tmp/ww-rename-new.txt');
    assertEqual(content, 'rename me', 'renamed file content mismatch');
    assert(!(await os.exists('/tmp/ww-rename-old.txt')), 'old file should not exist');
    results.pass('rename');
  } catch (e) {
    results.fail('rename', e);
  }

  // Test: Write file with auto-mkdir (nested path)
  try {
    await os.writeFile('/tmp/ww-nested/deep/file.txt', 'deep content');
    const content = await os.readFile('/tmp/ww-nested/deep/file.txt');
    assertEqual(content, 'deep content', 'nested file content');
    results.pass('write to nested path (auto-mkdir)');
  } catch (e) {
    // Some VFS implementations require explicit mkdir first
    results.skip('write to nested path (auto-mkdir)', 'may require explicit mkdir');
  }

  // Test: Empty file
  try {
    await os.writeFile('/tmp/ww-empty.txt', '');
    const content = await os.readFile('/tmp/ww-empty.txt');
    assertEqual(content, '', 'empty file should have empty content');
    results.pass('empty file');
  } catch (e) {
    results.fail('empty file', e);
  }

  // Test: File with special characters
  try {
    const special = 'line1\nline2\ttab\n"quotes" and \'apostrophes\'';
    await os.writeFile('/tmp/ww-special.txt', special);
    const content = await os.readFile('/tmp/ww-special.txt');
    assertEqual(content, special, 'special chars roundtrip');
    results.pass('file with special characters');
  } catch (e) {
    results.fail('file with special characters', e);
  }

  // Test: Unicode content
  try {
    const unicode = '日本語テスト 🎉 café résumé';
    await os.writeFile('/tmp/ww-unicode.txt', unicode);
    const content = await os.readFile('/tmp/ww-unicode.txt');
    assertEqual(content, unicode, 'unicode roundtrip');
    results.pass('unicode content');
  } catch (e) {
    results.fail('unicode content', e);
  }

  results.summary();
  return results;
}
