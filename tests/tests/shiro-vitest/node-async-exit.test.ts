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
