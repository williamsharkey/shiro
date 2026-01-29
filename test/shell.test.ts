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

  it('should handle && operator (success)', async () => {
    const { output } = await run(shell, 'echo first && echo second');
    expect(output).toContain('first');
    expect(output).toContain('second');
  });

  it('should handle && operator (failure stops)', async () => {
    const { output } = await run(shell, 'false && echo should-not-appear');
    expect(output).not.toContain('should-not-appear');
  });

  it('should handle || operator (success skips)', async () => {
    const { output } = await run(shell, 'true || echo should-not-appear');
    expect(output).not.toContain('should-not-appear');
  });

  it('should handle || operator (failure runs)', async () => {
    const { output } = await run(shell, 'false || echo fallback');
    expect(output).toContain('fallback');
  });

  it('should handle ; operator', async () => {
    const { output } = await run(shell, 'echo one; echo two; echo three');
    expect(output).toContain('one');
    expect(output).toContain('two');
    expect(output).toContain('three');
  });

  it('should track $? exit code', async () => {
    await run(shell, 'true');
    const { output: out1 } = await run(shell, 'echo $?');
    expect(out1.replace(/\r/g, '').trim()).toBe('0');

    await run(shell, 'false');
    const { output: out2 } = await run(shell, 'echo $?');
    expect(out2.replace(/\r/g, '').trim()).toBe('1');
  });

  it('should handle ${VAR} syntax', async () => {
    await run(shell, 'export NAME=world');
    const { output } = await run(shell, 'echo hello ${NAME}');
    expect(output).toContain('hello world');
  });

  it('should handle combined && and ||', async () => {
    const { output } = await run(shell, 'mkdir /home/user/testcond && echo created || echo failed');
    expect(output).toContain('created');
    expect(output).not.toContain('failed');
  });
});
