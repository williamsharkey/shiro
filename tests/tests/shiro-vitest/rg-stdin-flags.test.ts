import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';
import { translateRustRegex } from '@shiro/commands/rg';

describe('rg: piped stdin (#78)', () => {
  let shell: Shell;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    await env.fs.mkdir('/tmp/rgs', { recursive: true });
    await env.fs.writeFile('/tmp/rgs/f.txt', 'needle in a file\n');
    await run(shell, 'cd /tmp/rgs');
  });

  it('searches the pipe, not the working directory', async () => {
    const { output, exitCode } = await run(shell, 'echo needle from pipe | rg needle');
    expect(output).toContain('needle from pipe');
    expect(output).not.toContain('f.txt');
    expect(exitCode).toBe(0);
  });

  it('numbers stdin lines only with -n', async () => {
    expect((await run(shell, "printf 'a\\nb\\n' | rg -n b")).output).toContain('2:b');
    expect((await run(shell, "printf 'a\\nb\\n' | rg b")).output.trim()).toBe('b');
  });

  it('an empty pipe is still a pipe: no match, no directory search', async () => {
    const { output, exitCode } = await run(shell, 'true | rg needle');
    expect(output).not.toContain('f.txt');
    expect(exitCode).toBe(1);
  });

  it('reads a < file redirect', async () => {
    const { output } = await run(shell, 'rg needle < /tmp/rgs/f.txt');
    expect(output.trim()).toBe('needle in a file');
  });

  it('without a pipe (or with /dev/null) searches the working directory', async () => {
    expect((await run(shell, 'rg needle')).output).toContain('f.txt:1:needle in a file');
    expect((await run(shell, 'rg needle < /dev/null')).output).toContain('f.txt:1:needle in a file');
  });

  it('a path argument wins over stdin', async () => {
    const { output } = await run(shell, 'echo nothing here | rg needle f.txt');
    expect(output).toContain('needle in a file');
  });
});

describe('rg: Rust-regex inline flags (#79)', () => {
  it('folds leading flag groups into RegExp flags', () => {
    expect(translateRustRegex('(?i)foo')).toEqual({ source: 'foo', flags: 'i' });
    expect(translateRustRegex('(?is)a.b')).toEqual({ source: 'a.b', flags: 'is' });
    expect(translateRustRegex('(?i)(?m)^x')).toEqual({ source: '^x', flags: 'im' });
    expect(translateRustRegex('plain')).toEqual({ source: 'plain', flags: '' });
  });

  it('turns (?P<name>…) into (?<name>…) but leaves an escaped paren alone', () => {
    expect(translateRustRegex('(?P<w>\\w+)')).toEqual({ source: '(?<w>\\w+)', flags: '' });
    expect(translateRustRegex('\\(?P<x')).toEqual({ source: '\\(?P<x', flags: '' });
  });

  it('reports what JavaScript cannot express instead of matching nothing', () => {
    expect(translateRustRegex('(?x)a b')).toHaveProperty('error');
    expect(translateRustRegex('a(?i)b')).toHaveProperty('error');
  });

  it('matches case-insensitively through the command', async () => {
    const { shell, fs } = await createTestShell();
    await fs.writeFile('/tmp/flags.txt', 'Hello\nworld\n');
    const ok = await run(shell, "rg '(?i)HELLO' /tmp/flags.txt");
    expect(ok.output).toContain('Hello');
    expect(ok.exitCode).toBe(0);
    expect((await run(shell, "rg '(?x)a b' /tmp/flags.txt")).exitCode).toBe(2);
  });
});
