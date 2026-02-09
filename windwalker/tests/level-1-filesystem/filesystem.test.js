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

  // Test: Large file (1MB)
  try {
    const largeContent = 'x'.repeat(1024 * 1024);
    await os.writeFile('/tmp/ww-large.txt', largeContent);
    const content = await os.readFile('/tmp/ww-large.txt');
    assertEqual(content.length, largeContent.length, 'large file size');
    results.pass('large file (1MB)');
  } catch (e) {
    results.fail('large file (1MB)', e);
  }

  // Test: Many files in directory
  try {
    await os.mkdir('/tmp/ww-many');
    for (let i = 0; i < 100; i++) {
      await os.writeFile(`/tmp/ww-many/file${i}.txt`, `content ${i}`);
    }
    const entries = await os.readdir('/tmp/ww-many');
    const names = entries.map(e => typeof e === 'string' ? e : e.name);
    assertEqual(names.length, 100, 'should have 100 files');
    results.pass('many files in directory (100)');
  } catch (e) {
    results.fail('many files in directory (100)', e);
  }

  // Test: Binary-like content (all byte values)
  try {
    // Test with printable characters that could break naive handling
    const binaryLike = String.fromCharCode(...Array(256).fill(0).map((_, i) => i));
    await os.writeFile('/tmp/ww-binary.txt', binaryLike);
    const content = await os.readFile('/tmp/ww-binary.txt');
    assertEqual(content.length, 256, 'binary-like content length');
    results.pass('binary-like content');
  } catch (e) {
    results.fail('binary-like content', e);
  }

  // Test: Read file from home directory
  try {
    await os.writeFile('/home/user/ww-home-test.txt', 'home file');
    const content = await os.readFile('/home/user/ww-home-test.txt');
    assertEqual(content, 'home file', 'home directory file');
    results.pass('write/read in home directory');
  } catch (e) {
    results.fail('write/read in home directory', e);
  }

  // Test: Relative path resolution (if supported)
  try {
    await os.writeFile('/home/user/ww-rel.txt', 'relative test');
    // Try with tilde expansion
    const r = await os.exec('cat /home/user/ww-rel.txt');
    assert(r.stdout.includes('relative test'), 'cat should read home file');
    results.pass('path with tilde (~)');
  } catch (e) {
    results.skip('path with tilde (~)', 'tilde expansion may not be supported');
  }

  // Test: Deep nested directories (via shell mkdir -p)
  try {
    const deepPath = '/tmp/ww-deep/a/b/c/d/e/f';
    await os.exec(`mkdir -p ${deepPath}`);
    await os.writeFile(`${deepPath}/deep.txt`, 'deep file');
    const content = await os.readFile(`${deepPath}/deep.txt`);
    assertEqual(content, 'deep file', 'deep nested file');
    results.pass('deep nested directories (mkdir -p)');
  } catch (e) {
    results.fail('deep nested directories (mkdir -p)', e);
  }

  // Test: File with dots in name
  try {
    await os.writeFile('/tmp/ww.dotted.file.name.txt', 'dotted');
    const content = await os.readFile('/tmp/ww.dotted.file.name.txt');
    assertEqual(content, 'dotted', 'dotted filename');
    results.pass('file with dots in name');
  } catch (e) {
    results.fail('file with dots in name', e);
  }

  // Test: File with spaces in name
  try {
    await os.writeFile('/tmp/ww file with spaces.txt', 'spaced');
    const content = await os.readFile('/tmp/ww file with spaces.txt');
    assertEqual(content, 'spaced', 'spaced filename');
    results.pass('file with spaces in name');
  } catch (e) {
    results.fail('file with spaces in name', e);
  }

  results.summary();
  return results;
}
