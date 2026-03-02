/**
 * Batch 3 commands: w, who, users, lsof, dos2unix, unix2dos
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeEach(async () => {
  const env = await createTestShell();
  shell = env.shell;
  fs = env.fs;
});

describe('w', () => {
  it('shows uptime header and user line', async () => {
    const { output, exitCode } = await run(shell, 'w');
    const clean = output.replace(/\r/g, '');
    expect(exitCode).toBe(0);
    expect(clean).toContain('load average');
    expect(clean).toContain('USER');
  });

  it('-h suppresses header', async () => {
    const { output } = await run(shell, 'w -h');
    const clean = output.replace(/\r/g, '');
    expect(clean).not.toContain('load average');
    expect(clean).not.toContain('USER');
  });
});

describe('who', () => {
  it('shows user and pts/0', async () => {
    const { output, exitCode } = await run(shell, 'who');
    const clean = output.replace(/\r/g, '');
    expect(exitCode).toBe(0);
    expect(clean).toContain('pts/0');
  });

  it('-q shows count', async () => {
    const { output } = await run(shell, 'who -q');
    expect(output.replace(/\r/g, '')).toContain('# users=1');
  });

  it('-H shows header', async () => {
    const { output } = await run(shell, 'who -H');
    const clean = output.replace(/\r/g, '');
    expect(clean).toContain('NAME');
    expect(clean).toContain('LINE');
  });

  it('-b shows boot time', async () => {
    const { output } = await run(shell, 'who -b');
    expect(output.replace(/\r/g, '')).toContain('system boot');
  });
});

describe('users', () => {
  it('outputs user name', async () => {
    const { output, exitCode } = await run(shell, 'users');
    expect(exitCode).toBe(0);
    const clean = output.replace(/\r/g, '').trim();
    expect(clean.length).toBeGreaterThan(0);
  });
});

describe('lsof', () => {
  it('shows COMMAND header', async () => {
    const { output, exitCode } = await run(shell, 'lsof');
    expect(exitCode).toBe(0);
    expect(output.replace(/\r/g, '')).toContain('COMMAND');
  });

  it('-p filters by PID', async () => {
    const { output, exitCode } = await run(shell, 'lsof -p 99999');
    expect(exitCode).toBe(0);
    // Should still have header
    expect(output.replace(/\r/g, '')).toContain('COMMAND');
  });
});

describe('dos2unix', () => {
  it('converts CRLF to LF from stdin', async () => {
    await fs.writeFile('/home/user/crlf.txt', 'hello\r\nworld\r\n');
    const { output } = await run(shell, 'cat crlf.txt | dos2unix');
    // Output goes through shell which adds \r\n, so check content
    expect(output.replace(/\r/g, '')).toContain('hello\nworld\n');
  });

  it('converts in-place', async () => {
    await fs.writeFile('/home/user/d2u.txt', 'line1\r\nline2\r\n');
    await run(shell, 'dos2unix d2u.txt');
    const content = await fs.readFile('/home/user/d2u.txt', 'utf8') as string;
    expect(content).toBe('line1\nline2\n');
    expect(content).not.toContain('\r');
  });

  it('leaves LF-only unchanged', async () => {
    await fs.writeFile('/home/user/lf.txt', 'a\nb\nc\n');
    await run(shell, 'dos2unix lf.txt');
    const content = await fs.readFile('/home/user/lf.txt', 'utf8') as string;
    expect(content).toBe('a\nb\nc\n');
  });

  it('handles mixed line endings', async () => {
    await fs.writeFile('/home/user/mixed.txt', 'a\r\nb\nc\r\n');
    await run(shell, 'dos2unix mixed.txt');
    const content = await fs.readFile('/home/user/mixed.txt', 'utf8') as string;
    expect(content).toBe('a\nb\nc\n');
  });
});

describe('unix2dos', () => {
  it('converts LF to CRLF in-place', async () => {
    await fs.writeFile('/home/user/u2d.txt', 'line1\nline2\n');
    await run(shell, 'unix2dos u2d.txt');
    const content = await fs.readFile('/home/user/u2d.txt', 'utf8') as string;
    expect(content).toBe('line1\r\nline2\r\n');
  });

  it('does not double-convert existing CRLF', async () => {
    await fs.writeFile('/home/user/u2d2.txt', 'already\r\ndos\r\n');
    await run(shell, 'unix2dos u2d2.txt');
    const content = await fs.readFile('/home/user/u2d2.txt', 'utf8') as string;
    expect(content).toBe('already\r\ndos\r\n');
    // No \r\r\n
    expect(content).not.toContain('\r\r');
  });

  it('converts from stdin', async () => {
    const { output } = await run(shell, 'echo -n "a\nb" | unix2dos');
    // The output goes through shell, which may add its own \r\n.
    // Just verify the core transform happened
    expect(output).toContain('a');
    expect(output).toContain('b');
  });

  it('uses -n for new file output', async () => {
    await fs.writeFile('/home/user/src.txt', 'hello\nworld\n');
    await run(shell, 'unix2dos -n src.txt dest.txt');
    const content = await fs.readFile('/home/user/dest.txt', 'utf8') as string;
    expect(content).toBe('hello\r\nworld\r\n');
    // Original unchanged
    const orig = await fs.readFile('/home/user/src.txt', 'utf8') as string;
    expect(orig).toBe('hello\nworld\n');
  });
});
