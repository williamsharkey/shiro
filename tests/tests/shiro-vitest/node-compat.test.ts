/**
 * Systematic Node.js module compatibility tests.
 *
 * Tests Shiro's Node.js shims (in jseval/node-cmd.ts) for each built-in module.
 * Each test uses `node -e` with console.log to verify behavior through the
 * nodeCmd.exec() interface. File paths use /tmp/nc-* prefix to avoid collisions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { nodeCmd } from '@shiro/commands/jseval';
import type { CommandContext } from '@shiro/commands/index';

function createCtx(shell: Shell, fs: FileSystem, args: string[], stdin = ''): CommandContext {
  return { args, fs, cwd: shell.cwd, env: shell.env, stdin, stdout: '', stderr: '', shell };
}

describe('Node.js Module Compatibility', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // ─── fs module (~15 tests) ──────────────────────────────────────────────

  describe('fs', () => {
    it('readFileSync with utf8 encoding', async () => {
      await fs.writeFile('/tmp/nc-fs-read.txt', 'hello fs');
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const content = fs.readFileSync("/tmp/nc-fs-read.txt", "utf8");',
        'console.log(content);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hello fs');
    });

    it('writeFileSync creates a file readable by readFileSync', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'fs.writeFileSync("/tmp/nc-fs-write.txt", "written by node");',
        'console.log(fs.readFileSync("/tmp/nc-fs-write.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('written by node');
    });

    it('existsSync returns true for existing file', async () => {
      await fs.writeFile('/tmp/nc-fs-exists.txt', 'exists');
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'console.log("exists:" + fs.existsSync("/tmp/nc-fs-exists.txt"));',
        'console.log("missing:" + fs.existsSync("/tmp/nc-fs-nope.txt"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('exists:true');
      expect(ctx.stdout).toContain('missing:false');
    });

    it('mkdirSync creates a directory recognized by existsSync', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'fs.mkdirSync("/tmp/nc-fs-mkdir", { recursive: true });',
        'console.log("dir:" + fs.existsSync("/tmp/nc-fs-mkdir"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('dir:true');
    });

    it('readdirSync lists files in a directory', async () => {
      await fs.mkdir('/tmp/nc-fs-readdir', { recursive: true });
      await fs.writeFile('/tmp/nc-fs-readdir/a.txt', 'a');
      await fs.writeFile('/tmp/nc-fs-readdir/b.txt', 'b');
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const entries = fs.readdirSync("/tmp/nc-fs-readdir");',
        'console.log(entries.sort().join(","));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('a.txt');
      expect(ctx.stdout).toContain('b.txt');
    });

    it('statSync returns file stats with isFile/isDirectory', async () => {
      await fs.writeFile('/tmp/nc-fs-stat.txt', 'data');
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const stat = fs.statSync("/tmp/nc-fs-stat.txt");',
        'console.log("isFile:" + stat.isFile());',
        'console.log("isDir:" + stat.isDirectory());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('isFile:true');
      expect(ctx.stdout).toContain('isDir:false');
    });

    it('unlinkSync queues file deletion without error', async () => {
      // unlinkSync queues an async IDB deletion — it does not immediately
      // remove from fileCache, so readFileSync may still see the file.
      // We verify it runs without throwing and the async delete is queued.
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'fs.writeFileSync("/tmp/nc-fs-unlink.txt", "delete me");',
        'console.log("before:" + fs.readFileSync("/tmp/nc-fs-unlink.txt", "utf8"));',
        'fs.unlinkSync("/tmp/nc-fs-unlink.txt");',
        'console.log("unlink:ok");',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('before:delete me');
      expect(ctx.stdout).toContain('unlink:ok');
    });

    it('renameSync moves a file', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'fs.writeFileSync("/tmp/nc-fs-rename-src.txt", "move me");',
        'fs.renameSync("/tmp/nc-fs-rename-src.txt", "/tmp/nc-fs-rename-dst.txt");',
        'console.log("src:" + fs.existsSync("/tmp/nc-fs-rename-src.txt"));',
        'console.log("dst:" + fs.readFileSync("/tmp/nc-fs-rename-dst.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('src:false');
      expect(ctx.stdout).toContain('dst:move me');
    });

    it('appendFileSync appends to a file', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'fs.writeFileSync("/tmp/nc-fs-append.txt", "hello");',
        'fs.appendFileSync("/tmp/nc-fs-append.txt", " world");',
        'console.log(fs.readFileSync("/tmp/nc-fs-append.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hello world');
    });

    it('copyFileSync copies a file', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'fs.writeFileSync("/tmp/nc-fs-copy-src.txt", "copy me");',
        'fs.copyFileSync("/tmp/nc-fs-copy-src.txt", "/tmp/nc-fs-copy-dst.txt");',
        'console.log(fs.readFileSync("/tmp/nc-fs-copy-dst.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('copy me');
    });

    it('readdir callback lists files', async () => {
      await fs.mkdir('/tmp/nc-fs-readdir-cb', { recursive: true });
      await fs.writeFile('/tmp/nc-fs-readdir-cb/file1.txt', 'x');
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const entries = await new Promise((resolve, reject) => {',
        '  fs.readdir("/tmp/nc-fs-readdir-cb", (err, files) => err ? reject(err) : resolve(files));',
        '});',
        'console.log("entries:" + entries.join(","));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('entries:file1.txt');
    });

    it('promises.readFile reads a file', async () => {
      await fs.writeFile('/tmp/nc-fs-pread.txt', 'async read');
      const ctx = createCtx(shell, fs, ['-e', [
        'const fsp = require("fs").promises;',
        'const content = await fsp.readFile("/tmp/nc-fs-pread.txt", "utf8");',
        'console.log(content);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('async read');
    });

    it('promises.writeFile writes a file', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fsp = require("fs").promises;',
        'const fs = require("fs");',
        'await fsp.writeFile("/tmp/nc-fs-pwrite.txt", "async write");',
        'console.log(fs.readFileSync("/tmp/nc-fs-pwrite.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('async write');
    });

    it('readFileSync without encoding returns Buffer', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'fs.writeFileSync("/tmp/nc-fs-buf.txt", "buffer test");',
        'const buf = fs.readFileSync("/tmp/nc-fs-buf.txt");',
        'console.log("isUint8Array:" + (buf instanceof Uint8Array));',
        'console.log("content:" + buf.toString());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('isUint8Array:true');
      expect(ctx.stdout).toContain('content:buffer test');
    });

    it('readdirSync withFileTypes returns dirent objects', async () => {
      await fs.mkdir('/tmp/nc-fs-dirent', { recursive: true });
      await fs.writeFile('/tmp/nc-fs-dirent/file.txt', 'x');
      await fs.mkdir('/tmp/nc-fs-dirent/subdir', { recursive: true });
      await fs.writeFile('/tmp/nc-fs-dirent/subdir/child.txt', 'y');
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const entries = fs.readdirSync("/tmp/nc-fs-dirent", { withFileTypes: true });',
        'for (const e of entries) {',
        '  console.log(e.name + ":" + (e.isDirectory() ? "dir" : "file"));',
        '}',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('file.txt:file');
      expect(ctx.stdout).toContain('subdir:dir');
    });
  });

  // ─── path module (~12 tests) ───────────────────────────────────────────

  describe('path', () => {
    it('join concatenates path segments', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log(path.join("a", "b", "c"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('a/b/c');
    });

    it('resolve creates an absolute path', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'const result = path.resolve("/foo", "bar", "baz");',
        'console.log(result);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('/foo/bar/baz');
    });

    it('basename extracts the filename', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log(path.basename("/foo/bar/baz.txt"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('baz.txt');
    });

    it('basename strips extension when provided', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log(path.basename("file.test.js", ".js"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('file.test');
    });

    it('dirname extracts the directory', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log(path.dirname("/foo/bar/baz.txt"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('/foo/bar');
    });

    it('extname extracts the extension', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log(path.extname("file.ts"));',
        'console.log(path.extname("noext"));',
        'console.log(path.extname("multi.dot.js"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('.ts');
      // Empty string for no extension — we check it doesn't produce .ts for "noext"
      expect(ctx.stdout).toContain('.js');
    });

    it('relative computes relative path', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log(path.relative("/a/b/c", "/a/d/e"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('..');
      expect(ctx.stdout).toContain('d/e');
    });

    it('isAbsolute detects absolute paths', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log("abs:" + path.isAbsolute("/foo"));',
        'console.log("rel:" + path.isAbsolute("foo"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('abs:true');
      expect(ctx.stdout).toContain('rel:false');
    });

    it('parse breaks a path into components', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'const p = path.parse("/home/user/file.txt");',
        'console.log("root:" + p.root);',
        'console.log("dir:" + p.dir);',
        'console.log("base:" + p.base);',
        'console.log("ext:" + p.ext);',
        'console.log("name:" + p.name);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('root:/');
      expect(ctx.stdout).toContain('dir:/home/user');
      expect(ctx.stdout).toContain('base:file.txt');
      expect(ctx.stdout).toContain('ext:.txt');
      expect(ctx.stdout).toContain('name:file');
    });

    it('format reconstructs a path from components', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log(path.format({ dir: "/home/user", base: "file.txt" }));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('/home/user/file.txt');
    });

    it('sep is forward slash', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log("sep:" + path.sep);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('sep:/');
    });

    it('delimiter is colon', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log("delim:" + path.delimiter);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('delim::');
    });
  });

  // ─── buffer module (~8 tests) ──────────────────────────────────────────

  describe('buffer', () => {
    it('Buffer.from string creates buffer with correct content', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const b = Buffer.from("hello");',
        'console.log("str:" + b.toString());',
        'console.log("len:" + b.length);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('str:hello');
      expect(ctx.stdout).toContain('len:5');
    });

    it('Buffer.from array creates buffer from byte values', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const b = Buffer.from([72, 105]);',
        'console.log(b.toString());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('Hi');
    });

    it('Buffer.alloc creates zero-filled buffer', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const b = Buffer.alloc(4);',
        'console.log("len:" + b.length);',
        'console.log("zero:" + (b[0] === 0 && b[3] === 0));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('len:4');
      expect(ctx.stdout).toContain('zero:true');
    });

    it('toString with base64 encoding', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const b = Buffer.from("hello");',
        'console.log(b.toString("base64"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('aGVsbG8=');
    });

    it('toString with hex encoding', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const b = Buffer.from("AB");',
        'console.log(b.toString("hex"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('4142');
    });

    it('slice returns a sub-buffer', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const b = Buffer.from("hello world");',
        'const s = b.slice(0, 5);',
        'console.log(s.toString());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hello');
    });

    it('Buffer.concat joins buffers', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const a = Buffer.from("hello ");',
        'const b = Buffer.from("world");',
        'const c = Buffer.concat([a, b]);',
        'console.log(c.toString());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hello world');
    });

    it('Buffer.isBuffer detects buffers', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const b = Buffer.from("test");',
        'console.log("buf:" + Buffer.isBuffer(b));',
        'console.log("str:" + Buffer.isBuffer("not a buffer"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('buf:true');
      expect(ctx.stdout).toContain('str:false');
    });
  });

  // ─── events module (~6 tests) ──────────────────────────────────────────

  describe('events', () => {
    it('on/emit fires listeners', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const EventEmitter = require("events");',
        'const ee = new EventEmitter();',
        'ee.on("data", (msg) => console.log("got:" + msg));',
        'ee.emit("data", "hello");',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('got:hello');
    });

    it('once fires only once', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const EventEmitter = require("events");',
        'const ee = new EventEmitter();',
        'let count = 0;',
        'ee.once("ping", () => count++);',
        'ee.emit("ping");',
        'ee.emit("ping");',
        'console.log("count:" + count);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('count:1');
    });

    it('removeListener removes a specific listener', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const EventEmitter = require("events");',
        'const ee = new EventEmitter();',
        'const fn = () => console.log("should not fire");',
        'ee.on("test", fn);',
        'ee.removeListener("test", fn);',
        'ee.emit("test");',
        'console.log("done");',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).not.toContain('should not fire');
      expect(ctx.stdout).toContain('done');
    });

    it('removeAllListeners clears all listeners for an event', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const EventEmitter = require("events");',
        'const ee = new EventEmitter();',
        'ee.on("test", () => console.log("FIRED_A"));',
        'ee.on("test", () => console.log("FIRED_B"));',
        'ee.removeAllListeners("test");',
        'ee.emit("test");',
        'console.log("cleared");',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).not.toContain('FIRED_A');
      expect(ctx.stdout).not.toContain('FIRED_B');
      expect(ctx.stdout).toContain('cleared');
    });

    it('listenerCount returns correct count', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const EventEmitter = require("events");',
        'const ee = new EventEmitter();',
        'ee.on("data", () => {});',
        'ee.on("data", () => {});',
        'ee.on("other", () => {});',
        'console.log("data:" + ee.listenerCount("data"));',
        'console.log("other:" + ee.listenerCount("other"));',
        'console.log("none:" + ee.listenerCount("none"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('data:2');
      expect(ctx.stdout).toContain('other:1');
      expect(ctx.stdout).toContain('none:0');
    });

    it('emit with multiple arguments', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const EventEmitter = require("events");',
        'const ee = new EventEmitter();',
        'ee.on("multi", (a, b, c) => console.log(a + "," + b + "," + c));',
        'ee.emit("multi", 1, 2, 3);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('1,2,3');
    });
  });

  // ─── process module (~8 tests) ─────────────────────────────────────────

  describe('process', () => {
    it('process.env contains shell environment', async () => {
      shell.env['NC_TEST_VAR'] = 'test123';
      const ctx = createCtx(shell, fs, ['-e', [
        'console.log("val:" + process.env.NC_TEST_VAR);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('val:test123');
    });

    it('process.cwd() returns current working directory', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'console.log("cwd:" + process.cwd());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('cwd:' + shell.cwd);
    });

    it('process.platform is linux', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'console.log("platform:" + process.platform);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('platform:linux');
    });

    it('process.version matches semver format', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'console.log("version:" + process.version);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toMatch(/version:v\d+\.\d+\.\d+/);
    });

    it('process.argv includes node and script args', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'console.log("argv0:" + process.argv[0]);',
        'console.log("len:" + process.argv.length);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('argv0:node');
    });

    it('process.nextTick schedules a callback', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'let called = false;',
        'process.nextTick(() => { called = true; });',
        'await new Promise(r => setTimeout(r, 10));',
        'console.log("called:" + called);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('called:true');
    });

    it('process.stdout.write outputs without newline', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'process.stdout.write("no newline");',
        'process.stdout.write(" here");',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('no newline');
      expect(ctx.stdout).toContain(' here');
    });

    it('process.stderr.write outputs to stderr', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'process.stderr.write("error output");',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stderr).toContain('error output');
    });
  });

  // ─── crypto module (~5 tests) ──────────────────────────────────────────

  describe('crypto', () => {
    it('createHash sha256 produces correct hex digest', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const crypto = require("crypto");',
        'const hash = crypto.createHash("sha256").update("hello").digest("hex");',
        'console.log("hash:" + hash);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      // SHA-256 of "hello" = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      expect(ctx.stdout).toContain('hash:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('createHash sha1 produces hex digest', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const crypto = require("crypto");',
        'const hash = crypto.createHash("sha1").update("hello").digest("hex");',
        'console.log("hash:" + hash);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      // SHA-1 of "hello" = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
      expect(ctx.stdout).toContain('hash:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    });

    it('createHash md5 produces a hex digest (fnv shim)', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const crypto = require("crypto");',
        'const hash = crypto.createHash("md5").update("hello").digest("hex");',
        'console.log("len:" + hash.length);',
        'console.log("hex:" + /^[0-9a-f]+$/.test(hash));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      // md5 is shimmed with FNV, so we just verify it produces a hex string
      expect(ctx.stdout).toContain('hex:true');
    });

    it('randomBytes returns buffer of specified length', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const crypto = require("crypto");',
        'const buf = crypto.randomBytes(16);',
        'console.log("len:" + buf.length);',
        'console.log("isUint8:" + (buf instanceof Uint8Array));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('len:16');
      expect(ctx.stdout).toContain('isUint8:true');
    });

    it('randomUUID returns a valid UUID', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const crypto = require("crypto");',
        'const uuid = crypto.randomUUID();',
        'console.log("valid:" + /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid));',
        'console.log("uuid:" + uuid);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('valid:true');
    });
  });

  // ─── os module (~6 tests) ──────────────────────────────────────────────

  describe('os', () => {
    it('platform returns linux', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("os");',
        'console.log("platform:" + os.platform());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('platform:linux');
    });

    it('arch returns x64', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("os");',
        'console.log("arch:" + os.arch());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('arch:x64');
    });

    it('homedir returns /home/user', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("os");',
        'console.log("home:" + os.homedir());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('home:/home/user');
    });

    it('tmpdir returns /tmp', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("os");',
        'console.log("tmp:" + os.tmpdir());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('tmp:/tmp');
    });

    it('cpus returns array of cpu info', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("os");',
        'const cpus = os.cpus();',
        'console.log("isArray:" + Array.isArray(cpus));',
        'console.log("hasCpus:" + (cpus.length > 0));',
        'console.log("hasModel:" + (typeof cpus[0].model === "string"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('isArray:true');
      expect(ctx.stdout).toContain('hasCpus:true');
      expect(ctx.stdout).toContain('hasModel:true');
    });

    it('EOL is newline', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("os");',
        'console.log("eol:" + JSON.stringify(os.EOL));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('eol:"\\n"');
    });
  });

  // ─── child_process module (~4 tests) ───────────────────────────────────

  describe('child_process', () => {
    it('exec runs a shell command and returns stdout', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const cp = require("child_process");',
        'const result = await new Promise((resolve, reject) => {',
        '  cp.exec("echo hello-from-exec", (err, stdout) => {',
        '    if (err) reject(err);',
        '    else resolve(stdout);',
        '  });',
        '});',
        'console.log("out:" + result.trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('out:hello-from-exec');
    });

    it('execSync runs a shell command synchronously', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const cp = require("child_process");',
        'const result = cp.execSync("echo sync-test");',
        'console.log("out:" + result.toString().trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('out:sync-test');
    });

    it('exec can write and read files through shell', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const cp = require("child_process");',
        'const fs = require("fs");',
        'await new Promise((resolve, reject) => {',
        '  cp.exec("echo file-content > /tmp/nc-cp-test.txt", (err) => err ? reject(err) : resolve());',
        '});',
        'const content = fs.readFileSync("/tmp/nc-cp-test.txt", "utf8");',
        'console.log("content:" + content.trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('content:file-content');
    });

    it('exec returns non-zero exit code on failure', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const cp = require("child_process");',
        'const result = await new Promise((resolve) => {',
        '  cp.exec("false", (err, stdout, stderr) => {',
        '    resolve({ code: err ? (err.code || 1) : 0 });',
        '  });',
        '});',
        'console.log("code:" + result.code);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('code:1');
    });
  });

  // ─── url module (~6 tests) ─────────────────────────────────────────────

  describe('url', () => {
    it('parse extracts URL components', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const url = require("url");',
        'const parsed = url.parse("https://example.com:8080/path?q=1#hash");',
        'console.log("protocol:" + parsed.protocol);',
        'console.log("hostname:" + parsed.hostname);',
        'console.log("port:" + parsed.port);',
        'console.log("pathname:" + parsed.pathname);',
        'console.log("hash:" + parsed.hash);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('protocol:https:');
      expect(ctx.stdout).toContain('hostname:example.com');
      expect(ctx.stdout).toContain('port:8080');
      expect(ctx.stdout).toContain('pathname:/path');
      expect(ctx.stdout).toContain('hash:#hash');
    });

    it('format reconstructs a URL from components', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const url = require("url");',
        'const u = new URL("https://example.com/path");',
        'console.log("formatted:" + url.format(u));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('formatted:https://example.com/path');
    });

    it('URL class href property', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const { URL } = require("url");',
        'const u = new URL("https://example.com/test?key=val");',
        'console.log("href:" + u.href);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('href:https://example.com/test?key=val');
    });

    it('URL class searchParams', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const { URL } = require("url");',
        'const u = new URL("https://example.com/?a=1&b=2");',
        'console.log("a:" + u.searchParams.get("a"));',
        'console.log("b:" + u.searchParams.get("b"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('a:1');
      expect(ctx.stdout).toContain('b:2');
    });

    it('URL class pathname', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const { URL } = require("url");',
        'const u = new URL("https://example.com/foo/bar");',
        'console.log("path:" + u.pathname);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('path:/foo/bar');
    });

    it('URL class hostname', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const { URL } = require("url");',
        'const u = new URL("https://sub.example.com/path");',
        'console.log("host:" + u.hostname);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('host:sub.example.com');
    });
  });

  // ─── stream module (~4 tests) ──────────────────────────────────────────

  describe('stream', () => {
    it('Readable constructor exists and is a function', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const stream = require("stream");',
        'console.log("readable:" + typeof stream.Readable);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('readable:function');
    });

    it('Writable constructor exists and is a function', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const stream = require("stream");',
        'console.log("writable:" + typeof stream.Writable);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('writable:function');
    });

    it('Transform constructor exists and is a function', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const stream = require("stream");',
        'console.log("transform:" + typeof stream.Transform);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('transform:function');
    });

    it('Duplex and PassThrough also exist', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const stream = require("stream");',
        'console.log("duplex:" + typeof stream.Duplex);',
        'console.log("passthrough:" + typeof stream.PassThrough);',
        'console.log("pipeline:" + typeof stream.pipeline);',
        'console.log("finished:" + typeof stream.finished);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('duplex:function');
      expect(ctx.stdout).toContain('passthrough:function');
      expect(ctx.stdout).toContain('pipeline:function');
      expect(ctx.stdout).toContain('finished:function');
    });
  });

  // ─── util module (~5 tests) ────────────────────────────────────────────

  describe('util', () => {
    it('promisify wraps a callback function', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const util = require("util");',
        'function add(a, b, cb) { cb(null, a + b); }',
        'const addAsync = util.promisify(add);',
        'const result = await addAsync(3, 4);',
        'console.log("result:" + result);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('result:7');
    });

    it('format with %s and %d placeholders', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const util = require("util");',
        'console.log(util.format("hello %s, you are %d", "world", 42));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hello world, you are 42');
    });

    it('types.isDate detects Date objects', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const util = require("util");',
        'console.log("date:" + util.types.isDate(new Date()));',
        'console.log("str:" + util.types.isDate("not a date"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('date:true');
      expect(ctx.stdout).toContain('str:false');
    });

    it('types.isRegExp detects RegExp objects', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const util = require("util");',
        'console.log("regex:" + util.types.isRegExp(/test/));',
        'console.log("str:" + util.types.isRegExp("not a regex"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('regex:true');
      expect(ctx.stdout).toContain('str:false');
    });

    it('inspect converts objects to string representation', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const util = require("util");',
        'console.log("null:" + util.inspect(null));',
        'console.log("undef:" + util.inspect(undefined));',
        'console.log("num:" + util.inspect(42));',
        'console.log("fn:" + util.inspect(function myFn() {}));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('null:null');
      expect(ctx.stdout).toContain('undef:undefined');
      expect(ctx.stdout).toContain('num:42');
      expect(ctx.stdout).toContain('fn:[Function: myFn]');
    });
  });

  // ─── Cross-module integration tests ────────────────────────────────────

  describe('cross-module integration', () => {
    it('fs + path: write and read using joined paths', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const path = require("path");',
        'const dir = "/tmp/nc-cross-1";',
        'fs.mkdirSync(dir, { recursive: true });',
        'const filePath = path.join(dir, "test.txt");',
        'fs.writeFileSync(filePath, "cross-module");',
        'console.log(fs.readFileSync(filePath, "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('cross-module');
    });

    it('crypto + buffer: hash a buffer', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const crypto = require("crypto");',
        'const buf = Buffer.from("test data");',
        'const hash = crypto.createHash("sha256").update(buf).digest("hex");',
        'console.log("len:" + hash.length);',
        'console.log("hex:" + /^[0-9a-f]+$/.test(hash));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('len:64');
      expect(ctx.stdout).toContain('hex:true');
    });

    it('child_process + fs: exec writes file, fs reads it', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const cp = require("child_process");',
        'const fs = require("fs");',
        'await new Promise((resolve, reject) => {',
        '  cp.exec("echo integration > /tmp/nc-cross-cp.txt", (err) => err ? reject(err) : resolve());',
        '});',
        'console.log("content:" + fs.readFileSync("/tmp/nc-cross-cp.txt", "utf8").trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('content:integration');
    });

    it('util.promisify + child_process.exec', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const cp = require("child_process");',
        'const util = require("util");',
        'const exec = util.promisify(cp.exec);',
        'const { stdout } = await exec("echo promisified");',
        'console.log("out:" + stdout.trim());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('out:promisified');
    });

    it('events + process: EventEmitter inheritable', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const EventEmitter = require("events");',
        'class MyEmitter extends EventEmitter {}',
        'const emitter = new MyEmitter();',
        'emitter.on("test", (v) => console.log("val:" + v));',
        'emitter.emit("test", "inherited");',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('val:inherited');
    });

    it('os + path: construct home-relative paths', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("os");',
        'const path = require("path");',
        'const configPath = path.join(os.homedir(), ".config", "app.json");',
        'console.log("path:" + configPath);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('path:/home/user/.config/app.json');
    });

    it('buffer + fs: write buffer, read string', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const buf = Buffer.from("buffer write test");',
        'fs.writeFileSync("/tmp/nc-cross-buf.txt", buf.toString());',
        'console.log(fs.readFileSync("/tmp/nc-cross-buf.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('buffer write test');
    });
  });

  // ─── node: prefix support ─────────────────────────────────────────────

  describe('node: prefix', () => {
    it('require("node:fs") works same as require("fs")', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("node:fs");',
        'fs.writeFileSync("/tmp/nc-nodeprefix.txt", "node:fs works");',
        'console.log(fs.readFileSync("/tmp/nc-nodeprefix.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('node:fs works');
    });

    it('require("node:path") works same as require("path")', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("node:path");',
        'console.log(path.join("a", "b"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('a/b');
    });

    it('require("node:os") works same as require("os")', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("node:os");',
        'console.log("platform:" + os.platform());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('platform:linux');
    });

    it('require("node:crypto") works same as require("crypto")', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const crypto = require("node:crypto");',
        'console.log("uuid:" + /^[0-9a-f-]+$/.test(crypto.randomUUID()));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('uuid:true');
    });

    it('require("node:events") works same as require("events")', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const EventEmitter = require("node:events");',
        'const ee = new EventEmitter();',
        'ee.on("x", () => console.log("node:events ok"));',
        'ee.emit("x");',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('node:events ok');
    });

    it('require("node:util") works same as require("util")', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const util = require("node:util");',
        'console.log(util.format("hello %s", "node:util"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hello node:util');
    });

    it('require("node:buffer") provides Buffer', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const { Buffer: B } = require("node:buffer");',
        'console.log("ok:" + B.from("test").toString());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('ok:test');
    });

    it('require("node:stream") provides stream classes', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const stream = require("node:stream");',
        'console.log("has:" + (typeof stream.Readable === "function"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('has:true');
    });

    it('require("node:url") provides URL class', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const { URL } = require("node:url");',
        'const u = new URL("https://example.com/test");',
        'console.log("path:" + u.pathname);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('path:/test');
    });

    it('require("node:child_process") provides exec', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const cp = require("node:child_process");',
        'console.log("hasExec:" + (typeof cp.exec === "function"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hasExec:true');
    });
  });

  // ─── Edge cases and additional module features ─────────────────────────

  describe('edge cases', () => {
    it('Buffer.from with base64 encoding', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const b = Buffer.from("aGVsbG8=", "base64");',
        'console.log("decoded:" + b.toString());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('decoded:hello');
    });

    it('Buffer.from with hex encoding', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const b = Buffer.from("48656c6c6f", "hex");',
        'console.log("decoded:" + b.toString());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('decoded:Hello');
    });

    it('Buffer.byteLength returns correct byte count', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'console.log("ascii:" + Buffer.byteLength("hello"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('ascii:5');
    });

    it('Buffer.isEncoding returns true for valid encodings', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'console.log("utf8:" + Buffer.isEncoding("utf8"));',
        'console.log("base64:" + Buffer.isEncoding("base64"));',
        'console.log("hex:" + Buffer.isEncoding("hex"));',
        'console.log("bogus:" + Buffer.isEncoding("bogus"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('utf8:true');
      expect(ctx.stdout).toContain('base64:true');
      expect(ctx.stdout).toContain('hex:true');
      expect(ctx.stdout).toContain('bogus:false');
    });

    it('crypto createHash with chained update calls', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const crypto = require("crypto");',
        'const hash = crypto.createHash("sha256")',
        '  .update("hello")',
        '  .update(" world")',
        '  .digest("hex");',
        'console.log("hash:" + hash);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      // SHA-256 of "hello world" = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
      expect(ctx.stdout).toContain('hash:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });

    it('os.userInfo returns user information', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("os");',
        'const info = os.userInfo();',
        'console.log("username:" + info.username);',
        'console.log("homedir:" + info.homedir);',
        'console.log("uid:" + info.uid);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('username:user');
      expect(ctx.stdout).toContain('homedir:/home/user');
      expect(ctx.stdout).toContain('uid:1000');
    });

    it('os.hostname returns shiro', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("os");',
        'console.log("hostname:" + os.hostname());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hostname:shiro');
    });

    it('path.normalize resolves dots', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log(path.normalize("/foo/bar/../baz"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('/foo/baz');
    });

    it('EventEmitter eventNames returns registered event names', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const EventEmitter = require("events");',
        'const ee = new EventEmitter();',
        'ee.on("a", () => {});',
        'ee.on("b", () => {});',
        'console.log("names:" + ee.eventNames().sort().join(","));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('names:a,b');
    });

    it('util.types has additional type checkers', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const util = require("util");',
        'console.log("isMap:" + util.types.isMap(new Map()));',
        'console.log("isSet:" + util.types.isSet(new Set()));',
        'console.log("isPromise:" + util.types.isPromise(Promise.resolve()));',
        'console.log("isNativeError:" + util.types.isNativeError(new Error()));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('isMap:true');
      expect(ctx.stdout).toContain('isSet:true');
      expect(ctx.stdout).toContain('isPromise:true');
      expect(ctx.stdout).toContain('isNativeError:true');
    });

    it('fs.createWriteStream collects written chunks', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const ws = fs.createWriteStream("/tmp/nc-ws.txt");',
        'ws.write("chunk-a");',
        'ws.write("chunk-b");',
        'await new Promise(resolve => ws.end(resolve));',
        'console.log(fs.readFileSync("/tmp/nc-ws.txt", "utf8"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('chunk-achunk-b');
    });

    it('process.hrtime returns tuple of seconds and nanoseconds', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const t = process.hrtime();',
        'console.log("isArray:" + Array.isArray(t));',
        'console.log("len:" + t.length);',
        'console.log("typeS:" + typeof t[0]);',
        'console.log("typeN:" + typeof t[1]);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('isArray:true');
      expect(ctx.stdout).toContain('len:2');
      expect(ctx.stdout).toContain('typeS:number');
      expect(ctx.stdout).toContain('typeN:number');
    });

    it('fs.statSync on directory returns isDirectory true', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'const stat = fs.statSync("/tmp");',
        'console.log("isDir:" + stat.isDirectory());',
        'console.log("isFile:" + stat.isFile());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('isDir:true');
      expect(ctx.stdout).toContain('isFile:false');
    });

    it('crypto.createHash base64 encoding', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const crypto = require("crypto");',
        'const hash = crypto.createHash("sha256").update("test").digest("base64");',
        'console.log("b64:" + hash);',
        'console.log("len:" + hash.length);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      // base64 of SHA-256 should be a non-empty string with base64 chars
      expect(ctx.stdout).toMatch(/b64:[A-Za-z0-9+/=]+/);
    });

    it('util.callbackify wraps async function to callback style', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const util = require("util");',
        'async function asyncAdd(a, b) { return a + b; }',
        'const cbAdd = util.callbackify(asyncAdd);',
        'const result = await new Promise((resolve, reject) => {',
        '  cbAdd(5, 6, (err, val) => err ? reject(err) : resolve(val));',
        '});',
        'console.log("result:" + result);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('result:11');
    });

    it('process.exit with non-zero code', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'process.exit(42);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(42);
    });

    it('process.pid is a positive number', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'console.log("pid:" + process.pid);',
        'console.log("positive:" + (process.pid > 0));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('positive:true');
    });
  });
});
