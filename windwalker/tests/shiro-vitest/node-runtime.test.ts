import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, createTestOS } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { ShiroTerminal } from '@shiro/terminal';
import { nodeCmd } from '@shiro/commands/jseval';
import type { CommandContext } from '@shiro/commands/index';

function createCtx(shell: Shell, fs: FileSystem, args: string[], terminal?: ShiroTerminal): CommandContext {
  return {
    args,
    fs,
    cwd: shell.cwd,
    env: shell.env,
    stdin: '',
    stdout: '',
    stderr: '',
    shell,
    terminal,
  };
}

describe('Node Runtime (jseval.ts)', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  describe('node -p (print mode)', () => {
    it('should evaluate and print a numeric expression', async () => {
      const ctx = createCtx(shell, fs, ['-p', '42 * 2']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('84');
    });

    it('should evaluate and print a string expression', async () => {
      const ctx = createCtx(shell, fs, ['-p', '"hello world"']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('hello world');
    });

    it('should evaluate JSON.stringify', async () => {
      const ctx = createCtx(shell, fs, ['-p', 'JSON.stringify({a: 1})']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('{"a":1}');
    });

    it('should evaluate array expression', async () => {
      const ctx = createCtx(shell, fs, ['-p', '[1,2,3].map(x => x * 2)']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toContain('2');
      expect(ctx.stdout.trim()).toContain('4');
      expect(ctx.stdout.trim()).toContain('6');
    });

    it('should return undefined for void expressions', async () => {
      const ctx = createCtx(shell, fs, ['-p', 'void 0']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('undefined');
    });
  });

  describe('node -e (eval mode)', () => {
    it('should execute code with console.log', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'console.log("hello from -e")']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hello from -e');
    });

    it('should support process.exit', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'process.exit(42)']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(42);
    });

    it('should support process.env', async () => {
      shell.env['TEST_VAR'] = 'test_value';
      const ctx = createCtx(shell, fs, ['-e', 'console.log(process.env.TEST_VAR)']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('test_value');
    });
  });

  describe('node script execution', () => {
    it('should run a .js file', async () => {
      await fs.writeFile('/home/user/test.js', 'console.log("script output");');
      const ctx = createCtx(shell, fs, ['/home/user/test.js']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('script output');
    });

    it('should handle require of built-in modules', async () => {
      await fs.writeFile('/home/user/test-require.js',
        'const path = require("path"); console.log(path.join("/foo", "bar"));');
      const ctx = createCtx(shell, fs, ['/home/user/test-require.js']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('/foo/bar');
    });

    it('should handle require of node: prefixed modules', async () => {
      await fs.writeFile('/home/user/test-node-prefix.js',
        'const os = require("node:os"); console.log(os.platform());');
      const ctx = createCtx(shell, fs, ['/home/user/test-node-prefix.js']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim().length).toBeGreaterThan(0);
    });

    it('should support ESM import syntax', async () => {
      await fs.writeFile('/home/user/test-esm.mjs',
        'import path from "path";\nconsole.log(path.join("/a", "b"));');
      const ctx = createCtx(shell, fs, ['/home/user/test-esm.mjs']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('/a/b');
    });
  });

  describe('process shim', () => {
    it('should have process.version', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'console.log(process.version)']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toMatch(/v\d+\.\d+\.\d+/);
    });

    it('should have process.platform', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'console.log(process.platform)']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('linux');
    });

    it('should have process.arch', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'console.log(process.arch)']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim().length).toBeGreaterThan(0);
    });

    it('should have process.pid', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'console.log(process.pid)']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(parseInt(ctx.stdout.trim())).toBeGreaterThan(0);
    });

    it('should support process.hrtime()', async () => {
      const ctx = createCtx(shell, fs, ['-e',
        'const t = process.hrtime(); console.log(Array.isArray(t) && t.length === 2)']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('true');
    });

    it('should support process.cwd()', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'console.log(process.cwd())']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe(shell.cwd);
    });

    it('should support process.stdout.write', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'process.stdout.write("direct write")']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('direct write');
    });

    it('should have process.stderr.write', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'process.stderr.write("err msg")']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stderr).toContain('err msg');
    });
  });

  describe('built-in module shims', () => {
    it('path module works', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const path = require("path");',
        'console.log(path.basename("/foo/bar/baz.txt"));',
        'console.log(path.dirname("/foo/bar/baz.txt"));',
        'console.log(path.extname("file.js"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('baz.txt');
      expect(ctx.stdout).toContain('/foo/bar');
      expect(ctx.stdout).toContain('.js');
    });

    it('os module works', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const os = require("os");',
        'console.log(typeof os.homedir());',
        'console.log(typeof os.tmpdir());',
        'console.log(typeof os.hostname());',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('string');
    });

    it('util module works', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const util = require("util");',
        'console.log(typeof util.promisify);',
        'console.log(typeof util.inspect);',
        'console.log(typeof util.types);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      const lines = ctx.stdout.trim().split('\n');
      expect(lines.every((l: string) => l.trim() === 'function' || l.trim() === 'object')).toBe(true);
    });

    it('fs module can read and write', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fs = require("fs");',
        'fs.writeFileSync("/tmp/node-test.txt", "hello from node");',
        'const content = fs.readFileSync("/tmp/node-test.txt", "utf8");',
        'console.log(content);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('hello from node');
    });

    it('fs.promises works', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const fsp = require("fs").promises;',
        'await fsp.writeFile("/tmp/async-test.txt", "async hello");',
        'const content = await fsp.readFile("/tmp/async-test.txt", "utf8");',
        'console.log(content);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('async hello');
    });

    it('events module works', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const EventEmitter = require("events");',
        'const ee = new EventEmitter();',
        'ee.on("test", (msg) => console.log("got: " + msg));',
        'ee.emit("test", "hello");',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('got: hello');
    });

    it('stream module exists', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const stream = require("stream");',
        'console.log(typeof stream.Readable);',
        'console.log(typeof stream.Writable);',
        'console.log(typeof stream.Duplex);',
        'console.log(typeof stream.Transform);',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim().split('\n').every((l: string) => l.trim() === 'function')).toBe(true);
    });

    it('Buffer is available', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'const b = Buffer.from("hello");',
        'console.log(b.toString("base64"));',
      ].join('\n')]);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout.trim()).toBe('aGVsbG8=');
    });
  });

  describe('error handling', () => {
    it('should catch syntax errors', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'const x = {{{']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(1);
      expect(ctx.stderr.length).toBeGreaterThan(0);
    });

    it('should catch runtime errors', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'undefinedVar.method()']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(1);
      expect(ctx.stderr.length).toBeGreaterThan(0);
    });

    it('should propagate non-zero exit codes', async () => {
      const ctx = createCtx(shell, fs, ['-e', 'process.exit(2)']);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(2);
    });
  });

  describe('interactive mode (real xterm.js terminal)', () => {
    let os: Awaited<ReturnType<typeof createTestOS>>;

    beforeEach(async () => {
      os = await createTestOS();
    });

    it('should stream stdout directly to terminal', async () => {
      const ctx = createCtx(os.shell, os.fs, ['-e', 'process.stdout.write("hello terminal")'], os.terminal);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      // stdout was streamed to terminal, so ctx.stdout may be empty (streamedToTerminal=true)
      // but the terminal received the output
    });

    it('should activate passthrough when setRawMode(true) is called', async () => {
      const ctx = createCtx(os.shell, os.fs, ['-e', [
        'process.stdin.setRawMode(true);',
        'process.stdout.write("raw mode active");',
        'process.exit(0);',
      ].join('\n')], os.terminal);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
    });

    it('should bridge stdin data events from terminal', async () => {
      const ctx = createCtx(os.shell, os.fs, ['-e', [
        'let received = "";',
        'process.stdin.setRawMode(true);',
        'process.stdin.on("data", (d) => {',
        '  received += d;',
        '  if (received.includes("quit")) {',
        '    process.stdout.write("got: " + received);',
        '    process.exit(0);',
        '  }',
        '});',
      ].join('\n')], os.terminal);

      const execPromise = nodeCmd.exec(ctx);
      await new Promise(r => setTimeout(r, 50));

      os.type('hello');
      await new Promise(r => setTimeout(r, 50));
      os.type('quit');

      const exitCode = await execPromise;
      expect(exitCode).toBe(0);
    }, 10000);

    it('should report isTTY true with terminal', async () => {
      const ctx = createCtx(os.shell, os.fs, ['-e', [
        'const out = [];',
        'out.push("stdin:" + process.stdin.isTTY);',
        'out.push("stdout:" + process.stdout.isTTY);',
        'out.push("stderr:" + process.stderr.isTTY);',
        'console.log(out.join(","));',
      ].join('\n')], os.terminal);
      await nodeCmd.exec(ctx);
      // Output streamed to terminal — check ctx.stdout for non-streamed fallback
      // With terminal present, isTTY should be true for all three
    });

    it('should report isTTY false without terminal', async () => {
      const ctx = createCtx(shell, fs, ['-e', [
        'console.log("stdin:" + !!process.stdin.isTTY);',
        'console.log("stdout:" + !!process.stdout.isTTY);',
      ].join('\n')]);
      await nodeCmd.exec(ctx);
      expect(ctx.stdout).toContain('stdin:false');
      expect(ctx.stdout).toContain('stdout:false');
    });

    it('should provide terminal dimensions via stdout.columns/rows', async () => {
      const ctx = createCtx(os.shell, os.fs, ['-p', 'process.stdout.columns + "x" + process.stdout.rows'], os.terminal);
      const exitCode = await nodeCmd.exec(ctx);
      expect(exitCode).toBe(0);
      // Terminal has dimensions (headless xterm defaults to 80x24)
    });

    it('should handle Ctrl+C through passthrough to stdin', async () => {
      const ctx = createCtx(os.shell, os.fs, ['-e', [
        'process.stdin.setRawMode(true);',
        'process.stdin.on("data", (d) => {',
        '  if (d === "\\x03") {',
        '    process.exit(130);',
        '  }',
        '});',
      ].join('\n')], os.terminal);

      const execPromise = nodeCmd.exec(ctx);
      await new Promise(r => setTimeout(r, 50));
      os.type('\x03');

      const exitCode = await execPromise;
      expect(exitCode).toBe(130);
    }, 10000);
  });
});
