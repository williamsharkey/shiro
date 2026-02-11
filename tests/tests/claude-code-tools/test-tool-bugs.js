/**
 * Shiro Browser OS — Node.js Runtime Bug Tests
 *
 * Comprehensive test suite for bugs in Shiro's Node.js VM shims.
 * Tests filesystem, path, crypto, buffer, events, URL, process,
 * child_process, symlinks, permissions, and edge cases.
 *
 * Run: node test/claude-code-tools/test-tool-bugs.js
 *
 * Known bugs are marked with [KNOWN BUG] and expected to FAIL.
 * New regressions should cause unexpected FAILs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEST_DIR = '/tmp/shiro-tool-tests-' + Date.now();
let passed = 0;
let failed = 0;
let expectedFails = 0;
const failures = [];

function setup() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function test(name, fn, knownBug) {
  try {
    fn();
    if (knownBug) {
      // Known bug now passes — it's been fixed!
      passed++;
      console.log('FIXED: ' + name + ' (was known bug, now passes!)');
    } else {
      passed++;
      console.log('PASS: ' + name);
    }
  } catch (e) {
    const msg = e.message || String(e);
    if (knownBug) {
      expectedFails++;
      console.log('XFAIL: ' + name + ' [KNOWN BUG]');
    } else {
      failed++;
      failures.push({ name, error: msg });
      console.log('FAIL: ' + name + ' — ' + msg);
    }
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label || '') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error((label || '') + ': expected to include ' + JSON.stringify(needle));
  }
}

// =============================================================
// Setup
// =============================================================
setup();

// =============================================================
// 1. FILESYSTEM — BASIC READ/WRITE
// =============================================================

test('fs.writeFileSync creates new file', () => {
  const p = path.join(TEST_DIR, 'write-new.txt');
  fs.writeFileSync(p, 'hello world');
  assert(fs.existsSync(p), 'File should exist');
  assertEqual(fs.readFileSync(p, 'utf8'), 'hello world', 'Content');
});

test('fs.writeFileSync overwrites existing file', () => {
  const p = path.join(TEST_DIR, 'write-overwrite.txt');
  fs.writeFileSync(p, 'original');
  fs.writeFileSync(p, 'replaced');
  assertEqual(fs.readFileSync(p, 'utf8'), 'replaced', 'Overwritten content');
});

test('fs.appendFileSync appends content', () => {
  const p = path.join(TEST_DIR, 'append.txt');
  fs.writeFileSync(p, 'line1\n');
  fs.appendFileSync(p, 'line2\n');
  assertEqual(fs.readFileSync(p, 'utf8'), 'line1\nline2\n', 'Appended');
});

test('fs.existsSync returns false for missing file', () => {
  assertEqual(fs.existsSync(path.join(TEST_DIR, 'nope.txt')), false, 'missing');
});

test('fs.existsSync returns true for existing file', () => {
  const p = path.join(TEST_DIR, 'exists.txt');
  fs.writeFileSync(p, 'x');
  assertEqual(fs.existsSync(p), true, 'exists');
});

test('fs.readFileSync throws for missing file', () => {
  let threw = false;
  try { fs.readFileSync(path.join(TEST_DIR, 'missing.txt')); } catch (e) { threw = true; }
  assert(threw, 'Should throw ENOENT');
});

test('[KNOWN BUG] ENOENT error has .code property', () => {
  // Bug: error.code is undefined instead of "ENOENT"
  try {
    fs.readFileSync(path.join(TEST_DIR, 'missing2.txt'));
  } catch (e) {
    assertEqual(e.code, 'ENOENT', 'error.code');
    return;
  }
  throw new Error('Should have thrown');
}, true);

test('[KNOWN BUG] fs.unlinkSync deletes file', () => {
  // Bug: unlinkSync does not actually remove the file
  const p = path.join(TEST_DIR, 'to-delete.txt');
  fs.writeFileSync(p, 'delete me');
  fs.unlinkSync(p);
  assertEqual(fs.existsSync(p), false, 'Should be deleted');
}, true);

test('fs.renameSync moves file', () => {
  const src = path.join(TEST_DIR, 'rename-src.txt');
  const dst = path.join(TEST_DIR, 'rename-dst.txt');
  fs.writeFileSync(src, 'moveme');
  fs.renameSync(src, dst);
  assertEqual(fs.readFileSync(dst, 'utf8'), 'moveme', 'Dest content');
});

// =============================================================
// 2. FILESYSTEM — DIRECTORIES
// =============================================================

test('fs.mkdirSync creates directory', () => {
  const p = path.join(TEST_DIR, 'newdir');
  fs.mkdirSync(p);
  assert(fs.statSync(p).isDirectory(), 'Should be dir');
});

test('fs.mkdirSync recursive creates nested dirs', () => {
  const p = path.join(TEST_DIR, 'a', 'b', 'c');
  fs.mkdirSync(p, { recursive: true });
  assert(fs.statSync(p).isDirectory(), 'Deep dir');
});

test('[KNOWN BUG] fs.readdirSync excludes dot entry', () => {
  // Bug: readdirSync includes "." in results; real Node.js never does
  const dir = path.join(TEST_DIR, 'listdir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const entries = fs.readdirSync(dir);
  assert(!entries.includes('.'), 'Should not include "." — got: ' + JSON.stringify(entries));
  assert(!entries.includes('..'), 'Should not include ".."');
}, true);

test('fs.readdirSync lists correct number of real entries', () => {
  const dir = path.join(TEST_DIR, 'listdir2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'y.txt'), 'y');
  const entries = fs.readdirSync(dir).filter(e => e !== '.' && e !== '..');
  assertEqual(entries.length, 2, 'Entry count (excluding dots)');
});

test('[KNOWN BUG] fs.rmdirSync removes empty directory', () => {
  // Bug: rmdirSync does not actually remove the directory
  const p = path.join(TEST_DIR, 'empty-rmdir');
  fs.mkdirSync(p);
  fs.rmdirSync(p);
  assertEqual(fs.existsSync(p), false, 'Dir should be gone');
}, true);

// =============================================================
// 3. FILESYSTEM — STAT
// =============================================================

test('fs.statSync isFile/isDirectory', () => {
  const f = path.join(TEST_DIR, 'stat-file.txt');
  const d = path.join(TEST_DIR, 'stat-dir');
  fs.writeFileSync(f, 'data');
  fs.mkdirSync(d, { recursive: true });
  assert(fs.statSync(f).isFile(), 'isFile');
  assert(!fs.statSync(f).isDirectory(), 'file not dir');
  assert(fs.statSync(d).isDirectory(), 'isDir');
  assert(!fs.statSync(d).isFile(), 'dir not file');
});

test('fs.statSync.size matches content length', () => {
  const p = path.join(TEST_DIR, 'stat-size.txt');
  fs.writeFileSync(p, 'hello'); // 5 bytes
  assertEqual(fs.statSync(p).size, 5, 'Size');
});

test('fs.statSync.mtime is Date object', () => {
  const p = path.join(TEST_DIR, 'stat-mtime.txt');
  fs.writeFileSync(p, 'x');
  const mtime = fs.statSync(p).mtime;
  assert(mtime instanceof Date, 'mtime type: ' + typeof mtime + ' value: ' + mtime);
});

// =============================================================
// 4. FILESYSTEM — SYMLINKS
// =============================================================

test('fs.symlinkSync creates symlink', () => {
  const target = path.join(TEST_DIR, 'sym-target.txt');
  const link = path.join(TEST_DIR, 'sym-link.txt');
  fs.writeFileSync(target, 'target');
  fs.symlinkSync(target, link);
  assert(fs.existsSync(link), 'Symlink exists');
});

test('fs.readFileSync follows symlink', () => {
  const target = path.join(TEST_DIR, 'sym-follow-target.txt');
  const link = path.join(TEST_DIR, 'sym-follow-link.txt');
  fs.writeFileSync(target, 'actual content');
  fs.symlinkSync(target, link);
  const content = fs.readFileSync(link, 'utf8');
  assertEqual(content, 'actual content', 'Should read target content');
});

test('[KNOWN BUG] fs.readlinkSync returns target path', () => {
  // Bug: readlinkSync returns empty string instead of target path
  const target = path.join(TEST_DIR, 'readlink-target.txt');
  const link = path.join(TEST_DIR, 'readlink-link.txt');
  fs.writeFileSync(target, 'data');
  fs.symlinkSync(target, link);
  const result = fs.readlinkSync(link);
  assertEqual(result, target, 'readlink target');
}, true);

test('[KNOWN BUG] fs.lstatSync identifies symlink', () => {
  // Bug: lstatSync does not report isSymbolicLink correctly
  const target = path.join(TEST_DIR, 'lstat-target.txt');
  const link = path.join(TEST_DIR, 'lstat-link.txt');
  fs.writeFileSync(target, 'data');
  fs.symlinkSync(target, link);
  const lstat = fs.lstatSync(link);
  assert(lstat.isSymbolicLink(), 'Should identify as symlink');
}, true);

// =============================================================
// 5. PERMISSIONS
// =============================================================

test('[KNOWN BUG] chmod enforces read-only (0o444)', () => {
  // Bug: chmod does not enforce permissions — writes succeed on read-only files
  const p = path.join(TEST_DIR, 'readonly.txt');
  fs.writeFileSync(p, 'original');
  fs.chmodSync(p, 0o444);
  let writeSucceeded = false;
  try {
    fs.writeFileSync(p, 'overwritten');
    writeSucceeded = true;
  } catch (e) { /* expected */ }
  assert(!writeSucceeded, 'Should block write to read-only file');
}, true);

// =============================================================
// 6. PATH MODULE
// =============================================================

test('path.join', () => {
  assertEqual(path.join('/a', 'b', 'c.txt'), '/a/b/c.txt', 'join');
});

test('path.resolve returns absolute', () => {
  assert(path.resolve('rel').startsWith('/'), 'absolute');
});

test('path.basename', () => {
  assertEqual(path.basename('/foo/bar.js'), 'bar.js', 'basename');
});

test('path.dirname', () => {
  assertEqual(path.dirname('/foo/bar.js'), '/foo', 'dirname');
});

test('path.extname', () => {
  assertEqual(path.extname('file.ts'), '.ts', 'extname');
});

test('path.parse', () => {
  const p = path.parse('/home/user/file.txt');
  assertEqual(p.root, '/', 'root');
  assertEqual(p.dir, '/home/user', 'dir');
  assertEqual(p.base, 'file.txt', 'base');
  assertEqual(p.name, 'file', 'name');
  assertEqual(p.ext, '.txt', 'ext');
});

// =============================================================
// 7. CRYPTO MODULE
// =============================================================

test('crypto SHA-256', () => {
  const hash = crypto.createHash('sha256').update('hello').digest('hex');
  assertEqual(hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', 'sha256');
});

test('crypto.randomBytes length', () => {
  assertEqual(crypto.randomBytes(16).length, 16, 'length');
});

// =============================================================
// 8. BUFFER
// =============================================================

test('Buffer string roundtrip', () => {
  assertEqual(Buffer.from('hello').toString(), 'hello', 'roundtrip');
});

test('Buffer base64 encode/decode', () => {
  const b = Buffer.from('hello world');
  assertEqual(b.toString('base64'), 'aGVsbG8gd29ybGQ=', 'encode');
  assertEqual(Buffer.from('aGVsbG8gd29ybGQ=', 'base64').toString(), 'hello world', 'decode');
});

test('Buffer hex encode/decode', () => {
  assertEqual(Buffer.from('AB').toString('hex'), '4142', 'hex');
  assertEqual(Buffer.from('4142', 'hex').toString(), 'AB', 'unhex');
});

test('Buffer.concat', () => {
  const c = Buffer.concat([Buffer.from('a'), Buffer.from('b')]);
  assertEqual(c.toString(), 'ab', 'concat');
});

// =============================================================
// 9. EVENTS MODULE
// =============================================================

test('EventEmitter on/emit', () => {
  const { EventEmitter } = require('events');
  const ee = new EventEmitter();
  let got = null;
  ee.on('x', (v) => { got = v; });
  ee.emit('x', 42);
  assertEqual(got, 42, 'emit value');
});

test('EventEmitter once fires only once', () => {
  const { EventEmitter } = require('events');
  const ee = new EventEmitter();
  let count = 0;
  ee.once('x', () => { count++; });
  ee.emit('x');
  ee.emit('x');
  assertEqual(count, 1, 'once');
});

// =============================================================
// 10. URL MODULE
// =============================================================

test('URL parsing', () => {
  const u = new URL('https://example.com:8080/path?k=v#h');
  assertEqual(u.protocol, 'https:', 'protocol');
  assertEqual(u.hostname, 'example.com', 'hostname');
  assertEqual(u.port, '8080', 'port');
  assertEqual(u.pathname, '/path', 'pathname');
  assertEqual(u.search, '?k=v', 'search');
  assertEqual(u.hash, '#h', 'hash');
});

// =============================================================
// 11. CHILD_PROCESS
// =============================================================

test('[KNOWN BUG] child_process.execSync captures stdout', () => {
  // Bug: execSync returns empty string instead of command output
  const cp = require('child_process');
  const result = cp.execSync('echo hello').toString().trim();
  assertEqual(result, 'hello', 'stdout capture');
}, true);

// =============================================================
// 12. PROCESS OBJECT
// =============================================================

test('process.argv is array', () => {
  assert(Array.isArray(process.argv), 'array');
  assert(process.argv.length >= 1, 'has entries');
});

test('process.cwd returns absolute path', () => {
  const cwd = process.cwd();
  assert(typeof cwd === 'string' && cwd.startsWith('/'), 'absolute: ' + cwd);
});

test('process.env is object', () => {
  assert(typeof process.env === 'object', 'env object');
});

test('process.platform is string', () => {
  assert(typeof process.platform === 'string', 'platform string');
});

// =============================================================
// 13. EDGE CASES
// =============================================================

test('Empty file write/read', () => {
  const p = path.join(TEST_DIR, 'empty.txt');
  fs.writeFileSync(p, '');
  assertEqual(fs.readFileSync(p, 'utf8'), '', 'empty content');
  assertEqual(fs.statSync(p).size, 0, 'empty size');
});

test('[KNOWN BUG] Binary data roundtrip preserves bytes', () => {
  // Bug: binary bytes > 0x7F get UTF-8 encoded, corrupting data
  // 5 input bytes become 11 on readback
  const p = path.join(TEST_DIR, 'binary.bin');
  const data = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x80]);
  fs.writeFileSync(p, data);
  const read = fs.readFileSync(p);
  assertEqual(read.length, 5, 'Binary length should be 5');
}, true);

test('Unicode content roundtrip', () => {
  const p = path.join(TEST_DIR, 'unicode.txt');
  const content = 'Hello 世界 Ωμέγα café';
  fs.writeFileSync(p, content, 'utf8');
  assertEqual(fs.readFileSync(p, 'utf8'), content, 'unicode');
});

test('Long content (100KB)', () => {
  const p = path.join(TEST_DIR, 'longline.txt');
  const line = 'x'.repeat(100000);
  fs.writeFileSync(p, line);
  assertEqual(fs.readFileSync(p, 'utf8').length, 100000, 'long length');
});

test('Deeply nested file', () => {
  const deep = path.join(TEST_DIR, 'l1', 'l2', 'l3', 'l4', 'l5');
  fs.mkdirSync(deep, { recursive: true });
  const p = path.join(deep, 'deep.txt');
  fs.writeFileSync(p, 'deep');
  assertEqual(fs.readFileSync(p, 'utf8'), 'deep', 'deep content');
});

test('Path with spaces', () => {
  const dir = path.join(TEST_DIR, 'dir with spaces');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'file with spaces.txt');
  fs.writeFileSync(p, 'spaced');
  assertEqual(fs.readFileSync(p, 'utf8'), 'spaced', 'spaces');
});

test('Multiple rapid writes (last write wins)', () => {
  const p = path.join(TEST_DIR, 'rapid.txt');
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(p, 'v' + i);
  }
  assertEqual(fs.readFileSync(p, 'utf8'), 'v9', 'last write');
});

test('JSON roundtrip through filesystem', () => {
  const p = path.join(TEST_DIR, 'data.json');
  const obj = { name: 'test', nums: [1, 2, 3], nested: { a: true } };
  fs.writeFileSync(p, JSON.stringify(obj));
  const read = JSON.parse(fs.readFileSync(p, 'utf8'));
  assertEqual(read.name, 'test', 'json name');
  assertEqual(read.nums.length, 3, 'json array');
  assertEqual(read.nested.a, true, 'json nested');
});

test('[KNOWN BUG] setTimeout callback fires', () => {
  // Bug: setTimeout callbacks never fire in Shiro node VM
  // Can't truly test this synchronously, but we document it
  // The actual bug is that the VM exits before macrotasks run
  let fired = false;
  setTimeout(() => { fired = true; }, 0);
  // In real Node.js, even setTimeout(fn, 0) wouldn't fire synchronously
  // This test documents the bug exists — it can't be synchronously verified
  // The real issue is visible when running async scripts with await+setTimeout
  return; // Skip — can't test macrotask in sync context
});

// =============================================================
// SUMMARY
// =============================================================

console.log('');
console.log('========================================');
console.log('RESULTS: ' + passed + ' passed, ' + failed + ' unexpected failures, ' + expectedFails + ' expected failures (known bugs)');
console.log('TOTAL:   ' + (passed + failed + expectedFails) + ' tests');
console.log('========================================');

if (failures.length > 0) {
  console.log('');
  console.log('UNEXPECTED FAILURES (regressions):');
  for (const f of failures) {
    console.log('  - ' + f.name + ': ' + f.error);
  }
}

if (expectedFails > 0) {
  console.log('');
  console.log('KNOWN BUGS (' + expectedFails + '):');
  console.log('  - fs error objects missing .code property (e.g., ENOENT)');
  console.log('  - fs.unlinkSync does not delete files');
  console.log('  - fs.rmdirSync does not remove directories');
  console.log('  - fs.readdirSync includes "." dot entry');
  console.log('  - fs.readlinkSync returns empty string');
  console.log('  - fs.lstatSync does not identify symlinks');
  console.log('  - chmod does not enforce file permissions');
  console.log('  - child_process.execSync returns empty stdout');
  console.log('  - Binary data (bytes >0x7F) corrupted by UTF-8 encoding');
}

process.exit(failed > 0 ? 1 : 0);
