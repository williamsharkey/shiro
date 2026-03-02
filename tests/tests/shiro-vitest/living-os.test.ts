/**
 * Tests for Living OS commands: less, speak, listen, notify, camera, top, man
 *
 * Web API commands (speak, listen, notify, camera) test graceful degradation:
 * no browser APIs in test env → exit 1 with clear error message.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

describe('less (non-interactive fallback)', () => {
  it('outputs file content to stdout', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/test.txt', new TextEncoder().encode('line1\nline2\nline3\n'));
    const { output, exitCode } = await run(shell, 'less /home/user/test.txt');
    expect(exitCode).toBe(0);
    expect(output).toContain('line1');
    expect(output).toContain('line2');
    expect(output).toContain('line3');
  });

  it('supports -N for line numbers', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/home/user/num.txt', new TextEncoder().encode('alpha\nbeta\n'));
    const { output, exitCode } = await run(shell, 'less -N /home/user/num.txt');
    expect(exitCode).toBe(0);
    expect(output).toMatch(/1\s+alpha/);
    expect(output).toMatch(/2\s+beta/);
  });

  it('reads from stdin pipe', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'echo "piped text" | less');
    expect(exitCode).toBe(0);
    expect(output).toContain('piped text');
  });

  it('errors on missing file', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'less /nonexistent');
    expect(exitCode).toBe(1);
  });
});

describe('speak (graceful degradation)', () => {
  it('exits 1 when SpeechSynthesis unavailable', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'speak "hello"');
    expect(exitCode).toBe(1);
    expect(output).toContain('not available');
  });

  it('shows usage when no text provided and API unavailable', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'speak');
    expect(exitCode).toBe(1);
  });
});

describe('listen (graceful degradation)', () => {
  it('exits 1 when SpeechRecognition unavailable', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'listen');
    expect(exitCode).toBe(1);
    expect(output).toContain('not available');
  });
});

describe('notify (graceful degradation)', () => {
  it('exits 1 when Notification API unavailable', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'notify "test"');
    expect(exitCode).toBe(1);
    expect(output).toContain('not available');
  });
});

describe('camera (graceful degradation)', () => {
  it('exits 1 when getUserMedia unavailable', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'camera');
    expect(exitCode).toBe(1);
    expect(output).toContain('not available');
  });
});

describe('top (batch mode)', () => {
  it('outputs process snapshot in batch mode', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'top -b -n 1');
    expect(exitCode).toBe(0);
    expect(output).toContain('top');
    expect(output).toMatch(/Tasks:/);
  });
});

describe('man', () => {
  it('displays curated man page for grep', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'man grep');
    expect(exitCode).toBe(0);
    expect(output).toContain('GREP');
    expect(output).toContain('NAME');
    expect(output).toContain('print lines that match patterns');
  });

  it('auto-generates man page for commands without curated page', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'man wc');
    expect(exitCode).toBe(0);
    expect(output).toContain('WC');
  });

  it('errors on unknown command', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'man nonexistentcommand');
    expect(exitCode).toBe(1);
    expect(output).toContain('No manual entry');
  });

  it('man -k searches command descriptions', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'man -k list');
    expect(exitCode).toBe(0);
    expect(output).toContain('(1)');
  });

  it('man -f shows whatis', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'man -f ls');
    expect(exitCode).toBe(0);
    expect(output).toContain('ls(1)');
  });

  it('shows usage with no args', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell, 'man');
    expect(exitCode).toBe(1);
    expect(output).toContain('manual page');
  });

  it('displays man page for new Web API commands', async () => {
    const { shell } = await createTestShell();
    for (const cmd of ['speak', 'listen', 'camera', 'notify', 'top', 'less']) {
      const { output, exitCode } = await run(shell, `man ${cmd}`);
      expect(exitCode).toBe(0);
      expect(output).toContain('NAME');
    }
  });
});
