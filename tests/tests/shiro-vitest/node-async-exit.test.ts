import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { nodeCmd } from '@shiro/commands/jseval';
import type { CommandContext } from '@shiro/commands/index';

function createCtx(shell: Shell, fs: FileSystem, args: string[], stdin = ''): CommandContext {
  return { args, fs, cwd: shell.cwd, env: { ...shell.env }, stdin, stdout: '', stderr: '', shell };
}

describe('node: async scripts exit when done', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    await fs.writeFile('/tmp/data.txt', 'hello');
  });

  it('keeps output printed after an await', async () => {
    const ctx = createCtx(shell, fs, ['-e', `
      console.log('start');
      (async () => {
        const d = await require('fs').promises.readFile('/tmp/data.txt', 'utf8');
        await new Promise(r => setTimeout(r, 300));
        console.log('end', d);
      })();
    `]);
    expect(await nodeCmd.exec(ctx)).toBe(0);
    expect(ctx.stdout).toContain('start');
    expect(ctx.stdout).toContain('end hello');
  });

  it('exits promptly once async work finishes (not after the 10s fallback)', async () => {
    const t = Date.now();
    const ctx = createCtx(shell, fs, ['-e', `
      (async () => { const d = await require('fs/promises').readFile('/tmp/data.txt', 'utf8'); console.log(d.length); })();
    `]);
    expect(await nodeCmd.exec(ctx)).toBe(0);
    expect(ctx.stdout.trim()).toBe('5');
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

// (both configs: the page's node here, a guest's under `npm run test:worker`)
describe('node: children and exit', () => {
  async function sh(cmd: string) {
    const { shell } = await createTestShell();
    let out = '';
    const code = await Promise.race([
      shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; }),
      new Promise<'hung'>((res) => setTimeout(() => res('hung'), 10_000)),
    ]);
    return { code, out: out.replace(/\r\n/g, '\n') };
  }

  it.each([
    ['piped', ''],
    ['ignored', ', { stdio: "ignore" }'],
  ])('process.exit() with a %s child still running exits at once, as node does (tabcomputer#13)', async (_, opts) => {
    const t0 = Date.now();
    const r = await sh(`node -e 'require("child_process").spawn("sh", ["-c", "sleep 30"]${opts}); setTimeout(() => { console.log("t"); process.exit(3); }, 200)' < /dev/null; echo "status $?"`);
    expect(r).toEqual({ code: 0, out: 't\nstatus 3\n' });
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 30_000);

  it('child.kill() ends the child, not the shell that ran node (tabcomputer#13)', async () => {
    const r = await sh(`node -e 'const c = require("child_process").spawn("sh", ["-c", "sleep 30"]); c.on("exit", () => console.log("exited", c.killed)); setTimeout(() => c.kill(), 200)' < /dev/null; echo "status $?"`);
    expect(r).toEqual({ code: 0, out: 'exited true\nstatus 0\n' });
  }, 30_000);
});

describe('node:wasi', () => {
  it('a WASI instance as a guest; in the page ERR_FEATURE_UNAVAILABLE_ON_PLATFORM (no blocking channel)', async () => {
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute(`node -e 'const { WASI } = require("node:wasi"); try { const w = new WASI({ version: "preview1" }); console.log(typeof w.getImportObject().wasi_snapshot_preview1.fd_write) } catch (e) { console.log(e.code) }; console.log(require("module").isBuiltin("wasi"))' < /dev/null`, (s) => { out += s; }, (s) => { out += s; });
    const { nodeWorkerMode } = await import('@shiro/node-worker/boot');
    expect(out.replace(/\r\n/g, '\n')).toBe(`${nodeWorkerMode(shell.env) ? 'function' : 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'}\ntrue\n`);
  }, 30_000);
});
