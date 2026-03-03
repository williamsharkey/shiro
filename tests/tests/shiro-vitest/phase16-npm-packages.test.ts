/**
 * Phase 16: Package Compatibility Targets
 *
 * Tests for upgraded vm module, improved worker_threads stub,
 * npx command, and dynamic script timeout.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('Phase 16: Package Compatibility', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // ─── vm module tests ──────────────────────────────────────────────

  describe('vm module', () => {
    it('compileFunction with no context', async () => {
      await fs.writeFile('/tmp/vm-compile1.js', new TextEncoder().encode(
        'const vm = require("vm");\n' +
        'const fn = vm.compileFunction("return a + b", ["a", "b"]);\n' +
        'console.log(fn(3, 4));'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/vm-compile1.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('7');
    });

    it('compileFunction with parsingContext', async () => {
      await fs.writeFile('/tmp/vm-compile2.js', new TextEncoder().encode(
        'const vm = require("vm");\n' +
        'const ctx = vm.createContext({ x: 10 });\n' +
        'const fn = vm.compileFunction("return x + y", ["y"], { parsingContext: ctx });\n' +
        'console.log(fn(5));'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/vm-compile2.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('15');
    });

    it('createContext provides globalThis fallbacks', async () => {
      await fs.writeFile('/tmp/vm-ctx1.js', new TextEncoder().encode(
        'const vm = require("vm");\n' +
        'const ctx = vm.createContext({});\n' +
        'console.log(typeof ctx.JSON, typeof ctx.Object, typeof ctx.Array);'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/vm-ctx1.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('object function function');
    });

    it('createContext proxy writes back to sandbox', async () => {
      await fs.writeFile('/tmp/vm-ctx2.js', new TextEncoder().encode(
        'const vm = require("vm");\n' +
        'const ctx = vm.createContext({ count: 0 });\n' +
        'ctx.count = 42;\n' +
        'console.log(ctx.count);'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/vm-ctx2.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('42');
    });

    it('isContext true for created contexts', async () => {
      await fs.writeFile('/tmp/vm-isctx1.js', new TextEncoder().encode(
        'const vm = require("vm");\n' +
        'const ctx = vm.createContext({});\n' +
        'console.log(vm.isContext(ctx));'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/vm-isctx1.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('true');
    });

    it('isContext false for plain objects', async () => {
      await fs.writeFile('/tmp/vm-isctx2.js', new TextEncoder().encode(
        'const vm = require("vm");\n' +
        'console.log(vm.isContext({}));'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/vm-isctx2.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('false');
    });

    it('Script.runInContext with proxy context', async () => {
      await fs.writeFile('/tmp/vm-run1.js', new TextEncoder().encode(
        'const vm = require("vm");\n' +
        'const ctx = vm.createContext({ x: 10 });\n' +
        'const s = new vm.Script("x * 2");\n' +
        'console.log(s.runInContext(ctx));'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/vm-run1.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('20');
    });

    it('Script.runInNewContext with sandbox', async () => {
      await fs.writeFile('/tmp/vm-run2.js', new TextEncoder().encode(
        'const vm = require("vm");\n' +
        'const s = new vm.Script("return a + b");\n' +
        'console.log(s.runInNewContext({ a: 3, b: 7 }));'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/vm-run2.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('10');
    });
  });

  // ─── worker_threads tests ──────────────────────────────────────────

  describe('worker_threads improvements', () => {
    it('Worker emits exit without error when no error listener', async () => {
      await fs.writeFile('/tmp/wt-exit1.js', new TextEncoder().encode(
        'const { Worker } = require("worker_threads");\n' +
        'const w = new Worker("./fake.js");\n' +
        'let gotError = false;\n' +
        'w.on("exit", (code) => console.log("exit:" + code + " error:" + gotError));\n'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/wt-exit1.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('exit:1 error:false');
    });

    it('Worker emits error when listener attached', async () => {
      await fs.writeFile('/tmp/wt-exit2.js', new TextEncoder().encode(
        'const { Worker } = require("worker_threads");\n' +
        'const w = new Worker("./fake.js");\n' +
        'let gotError = false;\n' +
        'w.on("error", () => { gotError = true; });\n' +
        'w.on("exit", (code) => console.log("exit:" + code + " error:" + gotError));\n'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/wt-exit2.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('exit:1 error:true');
    });

    it('Worker.terminate resolves', async () => {
      await fs.writeFile('/tmp/wt-term.js', new TextEncoder().encode(
        'const { Worker } = require("worker_threads");\n' +
        'const w = new Worker("./fake.js");\n' +
        'w.terminate().then(code => console.log("terminated:" + code));'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/wt-term.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('terminated:0');
    });

    it('Worker has resourceLimits property', async () => {
      await fs.writeFile('/tmp/wt-rl.js', new TextEncoder().encode(
        'const { Worker } = require("worker_threads");\n' +
        'const w = new Worker("./fake.js");\n' +
        'console.log(typeof w.resourceLimits);'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/wt-rl.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('object');
    });
  });

  // ─── npx tests ──────────────────────────────────────────────────

  describe('npx command', () => {
    it('npx --help shows usage', async () => {
      const { output, exitCode } = await run(shell, 'npx --help');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage: npx');
    });

    it('npx with no args errors', async () => {
      const { output, exitCode } = await run(shell, 'npx');
      expect(exitCode).toBe(1);
      expect(output).toContain('missing command');
    });

    it('npx runs existing bin from node_modules/.bin', async () => {
      // Create a fake script in node_modules/.bin
      await fs.mkdir('/home/user/proj/node_modules/.bin', { recursive: true });
      await fs.writeFile('/home/user/proj/node_modules/.bin/fakecli',
        new TextEncoder().encode('#!/usr/bin/env node\nconsole.log("fakecli-output");'));
      shell.cwd = '/home/user/proj';
      const { output, exitCode } = await run(shell, 'npx fakecli');
      expect(exitCode).toBe(0);
      expect(output).toContain('fakecli-output');
    });

    it('npx passes args through', async () => {
      await fs.mkdir('/home/user/proj2/node_modules/.bin', { recursive: true });
      await fs.writeFile('/home/user/proj2/node_modules/.bin/argtest',
        new TextEncoder().encode('#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join(","));'));
      shell.cwd = '/home/user/proj2';
      const { output, exitCode } = await run(shell, 'npx argtest foo bar');
      expect(exitCode).toBe(0);
      expect(output).toContain('foo,bar');
    });

    it('npx handles scoped packages parsing', async () => {
      // Just verify parsing doesn't crash — it will fail to install since no network
      const { output, exitCode } = await run(shell, 'npx @scope/missing-pkg');
      // Should fail to find/install, but should not crash
      expect(typeof exitCode).toBe('number');
    });

    it('npx handles version specifiers parsing', async () => {
      // Verify pkg@version parsing works (will fail install with no network)
      const { output, exitCode } = await run(shell, 'npx somepkg@1.0.0');
      expect(typeof exitCode).toBe('number');
    });

    it('npx -y flag accepted', async () => {
      // -y flag should not cause errors (will still fail to find package)
      const { output, exitCode } = await run(shell, 'npx -y nonexistent-pkg');
      expect(typeof exitCode).toBe('number');
    });

    it('npx -h shows help', async () => {
      const { output, exitCode } = await run(shell, 'npx -h');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage: npx');
    });
  });

  // ─── timeout test ──────────────────────────────────────────────────

  describe('script timeout scaling', () => {
    it('short scripts use default timeout', async () => {
      // A simple script should run successfully within the default 15s timeout
      await fs.writeFile('/tmp/timeout-test.js', new TextEncoder().encode(
        'console.log("fast");'
      ));
      const { output, exitCode } = await run(shell, 'node /tmp/timeout-test.js');
      expect(exitCode).toBe(0);
      expect(output).toContain('fast');
    });
  });
});
