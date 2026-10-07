import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('AGY PoC Command', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    const { agyCmd } = await import('@shiro/commands/agy');
    shell.commands.register(agyCmd);
  });

  it('should run the PoC successfully', async () => {
    const { output, exitCode } = await run(shell, 'agy');
    console.log(output);
    expect(exitCode).toBe(0);
    expect(output).toContain('Worker finished successfully');
  });
});
