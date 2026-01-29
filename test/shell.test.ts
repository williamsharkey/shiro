import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '../src/shell';

describe('Shell', () => {
  let shell: Shell;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
  });

  it('should run echo', async () => {
    const { output } = await run(shell, 'echo hello world');
    expect(output).toBe('hello world\r\n');
  });

  it('should handle pipes', async () => {
    await run(shell, 'echo hello world > /home/user/pipe.txt');
    const { output } = await run(shell, 'cat /home/user/pipe.txt | grep hello');
    expect(output).toContain('hello');
  });

  it('should handle redirects', async () => {
    await run(shell, 'echo test content > /home/user/redir.txt');
    const { output } = await run(shell, 'cat /home/user/redir.txt');
    expect(output).toContain('test content');
  });

  it('should handle append redirect', async () => {
    await run(shell, 'echo line1 > /home/user/append.txt');
    await run(shell, 'echo line2 >> /home/user/append.txt');
    const { output } = await run(shell, 'cat /home/user/append.txt');
    expect(output).toContain('line1');
    expect(output).toContain('line2');
  });

  it('should expand environment variables', async () => {
    const { output } = await run(shell, 'echo $HOME');
    expect(output).toContain('/home/user');
  });

  it('should change directory', async () => {
    await run(shell, 'mkdir /home/user/testcd');
    await run(shell, 'cd /home/user/testcd');
    const { output } = await run(shell, 'pwd');
    expect(output).toContain('/home/user/testcd');
  });

  it('should report command not found', async () => {
    const { output, exitCode } = await run(shell, 'nonexistentcommand');
    expect(exitCode).toBe(127);
    expect(output).toContain('command not found');
  });

  it('should handle comments', async () => {
    const { output, exitCode } = await run(shell, '# this is a comment');
    expect(exitCode).toBe(0);
    expect(output).toBe('');
  });

  it('should set environment variables', async () => {
    await run(shell, 'export FOO=bar');
    const { output } = await run(shell, 'echo $FOO');
    expect(output).toContain('bar');
  });
});
