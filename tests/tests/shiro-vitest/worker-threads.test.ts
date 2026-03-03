/**
 * Tests for worker_threads graceful stub.
 * Verifies Worker, MessageChannel, MessagePort don't throw and have proper interfaces.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

describe('worker_threads stub', () => {
  it('Worker constructor does not throw', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/wt.js', new TextEncoder().encode(
      'const { Worker } = require("worker_threads");\n' +
      'const w = new Worker("./fake.js");\n' +
      'console.log("ok");'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/wt.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('ok');
  });

  it('Worker has event emitter methods', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/wt-events.js', new TextEncoder().encode(
      'const { Worker } = require("worker_threads");\n' +
      'const w = new Worker("./fake.js");\n' +
      'console.log(typeof w.on, typeof w.once, typeof w.off, typeof w.emit);'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/wt-events.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('function function function function');
  });

  it('Worker.terminate() returns promise resolving to 0', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/wt-term.js', new TextEncoder().encode(
      'const { Worker } = require("worker_threads");\n' +
      'const w = new Worker("./fake.js");\n' +
      'w.terminate().then(code => console.log("exit:" + code));'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/wt-term.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('exit:0');
  });

  it('MessageChannel creates linked ports', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/wt-mc.js', new TextEncoder().encode(
      'const { MessageChannel } = require("worker_threads");\n' +
      'const ch = new MessageChannel();\n' +
      'console.log(typeof ch.port1.postMessage, typeof ch.port2.close);'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/wt-mc.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('function function');
  });

  it('isMainThread is true, parentPort is null', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/wt-main.js', new TextEncoder().encode(
      'const wt = require("worker_threads");\n' +
      'console.log(wt.isMainThread, wt.parentPort);'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/wt-main.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('true null');
  });

  it('setEnvironmentData/getEnvironmentData round-trips', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/wt-env.js', new TextEncoder().encode(
      'const wt = require("worker_threads");\n' +
      'wt.setEnvironmentData("key", "val");\n' +
      'console.log(wt.getEnvironmentData("key"));'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/wt-env.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('val');
  });

  it('BroadcastChannel exists and does not throw', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/wt-bc.js', new TextEncoder().encode(
      'const { BroadcastChannel } = require("worker_threads");\n' +
      'const bc = new BroadcastChannel("test");\n' +
      'bc.postMessage("hello");\n' +
      'bc.close();\n' +
      'console.log("ok");'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/wt-bc.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('ok');
  });

  it('node:worker_threads also resolves', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/wt-node.js', new TextEncoder().encode(
      'const wt = require("node:worker_threads");\n' +
      'console.log(wt.isMainThread, wt.threadId);'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/wt-node.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('true 0');
  });

  it('SHARE_ENV is a symbol', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/wt-share.js', new TextEncoder().encode(
      'const wt = require("worker_threads");\n' +
      'console.log(typeof wt.SHARE_ENV);'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/wt-share.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('symbol');
  });

  it('Worker fires error and exit events asynchronously', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/wt-fire.js', new TextEncoder().encode(
      'const { Worker } = require("worker_threads");\n' +
      'const w = new Worker("./fake.js");\n' +
      'let gotError = false, gotExit = false;\n' +
      'w.on("error", () => { gotError = true; });\n' +
      'w.on("exit", () => { gotExit = true; console.log("error:" + gotError + " exit:" + gotExit); });\n'
    ));
    const { output, exitCode } = await run(shell, 'node /home/user/wt-fire.js');
    expect(exitCode).toBe(0);
    expect(output).toContain('error:true exit:true');
  });
});
