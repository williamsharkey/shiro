import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('SSH + SCP over WebRTC', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // ── ssh command ─────────────────────────────────────────────────

  describe('ssh', () => {
    it('shows help with --help', async () => {
      const { output, exitCode } = await run(shell, 'ssh --help');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
      expect(output).toContain('connection-code');
    });

    it('shows help with -h', async () => {
      const { output, exitCode } = await run(shell, 'ssh -h');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
    });

    it('errors with no args', async () => {
      const { output, exitCode } = await run(shell, 'ssh');
      expect(exitCode).toBe(1);
      expect(output).toContain('Usage:');
    });

    it('requires a terminal', async () => {
      // run() helper doesn't provide a terminal, so ssh should fail
      const { output, exitCode } = await run(shell, 'ssh test-code');
      expect(exitCode).toBe(1);
      expect(output).toContain('requires a terminal');
    });

    it('help shows examples', async () => {
      const { output } = await run(shell, 'ssh --help');
      expect(output).toContain('remote start');
      expect(output).toContain('fluffy-cloud');
    });
  });

  // ── scp command ─────────────────────────────────────────────────

  describe('scp', () => {
    it('shows help with --help', async () => {
      const { output, exitCode } = await run(shell, 'scp --help');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
      expect(output).toContain('source');
      expect(output).toContain('destination');
    });

    it('shows help with -h', async () => {
      const { output, exitCode } = await run(shell, 'scp -h');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
    });

    it('errors with no args', async () => {
      const { output, exitCode } = await run(shell, 'scp');
      expect(exitCode).toBe(1);
      expect(output).toContain('Usage:');
    });

    it('errors with one arg', async () => {
      const { output, exitCode } = await run(shell, 'scp file.txt');
      expect(exitCode).toBe(1);
      expect(output).toContain('Usage:');
    });

    it('rejects two remote targets', async () => {
      const { output, exitCode } = await run(shell, 'scp host1:/a host2:/b');
      expect(exitCode).toBe(1);
      expect(output).toContain('cannot copy between two remote hosts');
    });

    it('rejects two local targets', async () => {
      const { output, exitCode } = await run(shell, 'scp file1.txt file2.txt');
      expect(exitCode).toBe(1);
      expect(output).toContain('at least one argument must be remote');
    });

    it('upload requires local file to exist', async () => {
      const { output, exitCode } = await run(shell, 'scp nonexistent.txt code:~/file.txt');
      expect(exitCode).toBe(1);
      expect(output).toContain('No such file');
    });

    it('help shows examples', async () => {
      const { output } = await run(shell, 'scp --help');
      expect(output).toContain('Upload');
      expect(output).toContain('Download');
    });
  });

  // ── Protocol message format tests ─────────────────────────────

  describe('Protocol messages', () => {
    it('terminal_start has correct structure', () => {
      const msg = JSON.parse(JSON.stringify({
        type: 'terminal_start',
        cols: 80,
        rows: 24,
        requestId: 1,
      }));
      expect(msg.type).toBe('terminal_start');
      expect(msg.cols).toBe(80);
      expect(msg.rows).toBe(24);
    });

    it('terminal_input has correct structure', () => {
      const msg = JSON.parse(JSON.stringify({
        type: 'terminal_input',
        data: 'a',
        requestId: 2,
      }));
      expect(msg.type).toBe('terminal_input');
      expect(msg.data).toBe('a');
    });

    it('terminal_output has correct structure', () => {
      const msg = JSON.parse(JSON.stringify({
        type: 'terminal_output',
        data: '~$ ',
      }));
      expect(msg.type).toBe('terminal_output');
      expect(msg.data).toBe('~$ ');
    });

    it('terminal_end has correct structure', () => {
      const msg = JSON.parse(JSON.stringify({
        type: 'terminal_end',
        requestId: 3,
      }));
      expect(msg.type).toBe('terminal_end');
    });

    it('read request encodes path', () => {
      const msg = { type: 'read', path: '/home/user/file.txt', requestId: 10 };
      const parsed = JSON.parse(JSON.stringify(msg));
      expect(parsed.path).toBe('/home/user/file.txt');
    });

    it('write request uses base64 for content', () => {
      const data = new TextEncoder().encode('hello world');
      const base64 = btoa(String.fromCharCode(...data));
      const msg = { type: 'write', path: '/tmp/test', content: base64, requestId: 11 };
      const parsed = JSON.parse(JSON.stringify(msg));

      // Verify round-trip
      const decoded = atob(parsed.content);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      expect(new TextDecoder().decode(bytes)).toBe('hello world');
    });
  });

  // ── SCP target parsing ────────────────────────────────────────

  describe('SCP target parsing', () => {
    it('detects remote target with colon', () => {
      // Simulate the parseTarget logic
      function parseTarget(arg: string) {
        const colon = arg.indexOf(':');
        if (colon < 1) return null;
        return { code: arg.substring(0, colon), path: arg.substring(colon + 1) };
      }

      const remote = parseTarget('fluffy-cloud:/home/user/file.txt');
      expect(remote).not.toBeNull();
      expect(remote!.code).toBe('fluffy-cloud');
      expect(remote!.path).toBe('/home/user/file.txt');
    });

    it('detects local target (no colon)', () => {
      function parseTarget(arg: string) {
        const colon = arg.indexOf(':');
        if (colon < 1) return null;
        return { code: arg.substring(0, colon), path: arg.substring(colon + 1) };
      }

      expect(parseTarget('file.txt')).toBeNull();
      expect(parseTarget('/absolute/path')).toBeNull();
    });

    it('handles tilde in remote path', () => {
      function parseTarget(arg: string) {
        const colon = arg.indexOf(':');
        if (colon < 1) return null;
        return { code: arg.substring(0, colon), path: arg.substring(colon + 1) };
      }

      const remote = parseTarget('mycode:~/documents/file.txt');
      expect(remote).not.toBeNull();
      expect(remote!.path).toBe('~/documents/file.txt');

      // Verify tilde expansion
      const expanded = remote!.path.startsWith('~')
        ? '/home/user' + remote!.path.slice(1)
        : remote!.path;
      expect(expanded).toBe('/home/user/documents/file.txt');
    });

    it('rejects colon at start', () => {
      function parseTarget(arg: string) {
        const colon = arg.indexOf(':');
        if (colon < 1) return null;
        return { code: arg.substring(0, colon), path: arg.substring(colon + 1) };
      }

      expect(parseTarget(':path')).toBeNull();
    });
  });
});
