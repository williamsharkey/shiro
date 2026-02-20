import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { lazyCommand } from '@shiro/utils/lazy-command';
import { Command } from '@shiro/commands/index';

// ─── Polyfills for commands that check window globals ────────────
{
  // localStorage polyfill (linkedom doesn't provide working localStorage)
  if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage?.getItem) {
    const store: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { for (const k in store) delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (i: number) => Object.keys(store)[i] ?? null,
    };
  }
}
if (typeof window !== 'undefined') {
  (window as any).__termcastSession = null;
  (window as any).__shiroGroup = undefined;
  (window as any).__shiroMCPConnections = undefined;
}

describe('Lazy-Loaded Commands', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    // Clean up window globals between tests
    if (typeof window !== 'undefined') {
      (window as any).__termcastSession = null;
      (window as any).__shiroGroup = undefined;
      (window as any).__shiroMCPConnections = undefined;
    }
  });

  // ─── lazyCommand helper ──────────────────────────────────────

  describe('lazyCommand()', () => {
    it('should return a Command with correct name and description', () => {
      const cmd = lazyCommand('test-cmd', 'Test description', async () => ({
        name: 'test-cmd',
        description: 'Test description',
        async exec() { return 0; },
      }));
      expect(cmd.name).toBe('test-cmd');
      expect(cmd.description).toBe('Test description');
      expect(typeof cmd.exec).toBe('function');
    });

    it('should call loader on first exec and cache for subsequent calls', async () => {
      let loadCount = 0;
      const inner: Command = {
        name: 'counter',
        description: 'Counts loads',
        async exec(ctx) { ctx.stdout = 'ok\n'; return 0; },
      };
      const cmd = lazyCommand('counter', 'Counts loads', async () => {
        loadCount++;
        return inner;
      });

      // Register and run twice
      shell.commands.register(cmd);
      await run(shell, 'counter');
      await run(shell, 'counter');
      expect(loadCount).toBe(1); // loaded only once
    });

    it('should propagate loader errors', async () => {
      const cmd = lazyCommand('broken', 'Broken loader', async () => {
        throw new Error('load failed');
      });
      shell.commands.register(cmd);
      const { exitCode } = await run(shell, 'broken');
      expect(exitCode).not.toBe(0);
    });
  });

  // ─── build ───────────────────────────────────────────────────

  describe('build', () => {
    beforeEach(async () => {
      const { buildCmd } = await import('@shiro/commands/build');
      shell.commands.register(buildCmd);
    });

    it('should show usage with no args', async () => {
      const { output, exitCode } = await run(shell, 'build');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
      expect(output).toContain('build');
    });

    it('should show usage with --help', async () => {
      const { output, exitCode } = await run(shell, 'build --help');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
    });

    it('should error on nonexistent file', async () => {
      const { exitCode } = await run(shell, 'build /tmp/nonexistent.ts');
      expect(exitCode).not.toBe(0);
    });
  });

  // ─── nano ────────────────────────────────────────────────────

  describe('nano', () => {
    beforeEach(async () => {
      const { nanoCmd } = await import('@shiro/commands/nano');
      shell.commands.register(nanoCmd);
    });

    it('should error with no file argument', async () => {
      const { output, exitCode } = await run(shell, 'nano');
      expect(exitCode).toBe(1);
      expect(output).toContain('Usage:');
    });

    it('should error without terminal', async () => {
      const { nanoCmd } = await import('@shiro/commands/nano');
      const ctx = {
        args: ['/tmp/test.txt'], fs, cwd: '/home/user', env: {},
        stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await nanoCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('terminal');
    });

    it('should be registered and discoverable', async () => {
      const { output } = await run(shell, 'which nano');
      expect(output).toBeTruthy();
    });
  });

  // ─── termcast ────────────────────────────────────────────────

  describe('termcast', () => {
    beforeEach(async () => {
      const { termcastCmd } = await import('@shiro/commands/termcast');
      shell.commands.register(termcastCmd);
    });

    it('should show help with no args', async () => {
      const { output, exitCode } = await run(shell, 'termcast');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
      expect(output).toContain('start');
      expect(output).toContain('stop');
    });

    it('should show "not recording" for status', async () => {
      const { output, exitCode } = await run(shell, 'termcast status');
      expect(exitCode).toBe(0);
      expect(output.toLowerCase()).toContain('not recording');
    });

    it('should error on play without filename', async () => {
      const { output, exitCode } = await run(shell, 'termcast play');
      expect(exitCode).toBe(1);
      expect(output).toContain('missing');
    });

    it('should error on export without filename', async () => {
      const { output, exitCode } = await run(shell, 'termcast export');
      expect(exitCode).toBe(1);
      expect(output).toContain('missing');
    });
  });

  // ─── image ───────────────────────────────────────────────────

  describe('image', () => {
    beforeEach(async () => {
      const { imageCmd } = await import('@shiro/commands/image');
      shell.commands.register(imageCmd);
    });

    it('should show help with no args', async () => {
      const { output, exitCode } = await run(shell, 'image');
      expect(exitCode).toBe(0);
      expect(output).toContain('save');
      expect(output).toContain('load');
      expect(output).toContain('list');
    });

    it('should list images (empty initially)', async () => {
      const { exitCode } = await run(shell, 'image list');
      expect(exitCode).toBe(0);
    });

    it('should save and load a snapshot', async () => {
      // Create test directory with files
      await fs.mkdir('/tmp/img-test', { recursive: true });
      await fs.writeFile('/tmp/img-test/hello.txt', 'hello world');
      await fs.writeFile('/tmp/img-test/data.txt', 'some data');

      // Save image
      const { exitCode: saveCode, output: saveOut } = await run(shell, 'image save testimg /tmp/img-test');
      expect(saveCode).toBe(0);
      expect(saveOut).toContain('Saved image');

      // Delete original files
      await fs.unlink('/tmp/img-test/hello.txt');
      await fs.unlink('/tmp/img-test/data.txt');

      // Load image
      const { exitCode: loadCode } = await run(shell, 'image load testimg');
      expect(loadCode).toBe(0);

      // Verify restored
      const content = await fs.readFile('/tmp/img-test/hello.txt', 'utf8');
      expect(content).toBe('hello world');
    });

    it('should delete an image', async () => {
      await fs.mkdir('/tmp/img-del', { recursive: true });
      await fs.writeFile('/tmp/img-del/f.txt', 'x');
      await run(shell, 'image save delme /tmp/img-del');

      const { exitCode } = await run(shell, 'image delete delme');
      expect(exitCode).toBe(0);

      // Verify the image file is gone
      try {
        await fs.stat('/home/user/shiro-images/delme.json');
        expect.fail('Image file should be deleted');
      } catch {
        // expected
      }
    });

    it('should error on save without name', async () => {
      const { exitCode, output } = await run(shell, 'image save');
      expect(exitCode).toBe(1);
      expect(output).toContain('missing');
    });
  });

  // ─── gh ──────────────────────────────────────────────────────

  describe('gh', () => {
    beforeEach(async () => {
      const { ghCmd } = await import('@shiro/commands/gh');
      shell.commands.register(ghCmd);
    });

    it('should show help with no args', async () => {
      const { output, exitCode } = await run(shell, 'gh');
      expect(exitCode).toBe(0);
      expect(output).toContain('usage:');
      expect(output).toContain('pr');
      expect(output).toContain('issue');
    });

    it('should show version', async () => {
      const { output, exitCode } = await run(shell, 'gh --version');
      expect(exitCode).toBe(0);
      expect(output).toContain('0.1.0');
    });

    it('should report not logged in without token', async () => {
      const { exitCode, output } = await run(shell, 'gh auth status');
      expect(exitCode).toBe(1);
      expect(output).toContain('not logged in');
    });
  });

  // ─── mcp ─────────────────────────────────────────────────────

  describe('mcp', () => {
    beforeEach(async () => {
      const { mcpCmd } = await import('@shiro/commands/mcp-client');
      shell.commands.register(mcpCmd);
    });

    it('should show help with no args', async () => {
      const { output, exitCode } = await run(shell, 'mcp');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
      expect(output).toContain('connect');
      expect(output).toContain('status');
    });

    it('should show no active connections for status', async () => {
      const { output, exitCode } = await run(shell, 'mcp status');
      expect(exitCode).toBe(0);
      expect(output).toContain('No active');
    });

    it('should no-op on disconnect with no connections', async () => {
      const { output, exitCode } = await run(shell, 'mcp disconnect');
      expect(exitCode).toBe(0);
      expect(output).toContain('No active');
    });
  });

  // ─── group ───────────────────────────────────────────────────

  describe('group', () => {
    beforeEach(async () => {
      const { groupCmd } = await import('@shiro/commands/group');
      shell.commands.register(groupCmd);
    });

    it('should show help with no args', async () => {
      const { output, exitCode } = await run(shell, 'group');
      expect(exitCode).toBe(0);
      expect(output).toContain('join');
      expect(output).toContain('leave');
      expect(output).toContain('peers');
    });

    it('should show "not in a group" for status', async () => {
      const { output, exitCode } = await run(shell, 'group status');
      expect(exitCode).toBe(0);
      expect(output.toLowerCase()).toContain('not in a group');
    });

    it('should error on peers when not in group', async () => {
      const { exitCode, output } = await run(shell, 'group peers');
      expect(exitCode).toBe(1);
      expect(output.toLowerCase()).toContain('not in a group');
    });
  });

  // ─── cc/gcc ──────────────────────────────────────────────────

  describe('cc/gcc', () => {
    beforeEach(async () => {
      const { ccCmd, gccCmd } = await import('@shiro/commands/cc');
      shell.commands.register(ccCmd);
      shell.commands.register(gccCmd);
    });

    it('should show usage with no args', async () => {
      const { output, exitCode } = await run(shell, 'cc');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
      expect(output).toContain('cc');
    });

    it('should show version', async () => {
      const { output, exitCode } = await run(shell, 'cc --version');
      expect(exitCode).toBe(0);
      expect(output).toContain('xcc');
    });

    it('gcc should also work', async () => {
      const { output, exitCode } = await run(shell, 'gcc --help');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
    });
  });

  // ─── python / python3 / pip ──────────────────────────────────

  describe('python/python3/pip', () => {
    beforeEach(async () => {
      const { pythonCmd, python3Cmd, pipCmd } = await import('@shiro/commands/python');
      shell.commands.register(pythonCmd);
      shell.commands.register(python3Cmd);
      shell.commands.register(pipCmd);
    });

    it('python command should be registered with correct metadata', async () => {
      const { pythonCmd, python3Cmd } = await import('@shiro/commands/python');
      expect(pythonCmd.name).toBe('python');
      expect(pythonCmd.description).toContain('Python');
      expect(python3Cmd.name).toBe('python3');
      expect(typeof pythonCmd.exec).toBe('function');
    });

    it('python should fail gracefully when Pyodide unavailable', async () => {
      // In test env, Pyodide CDN load fails — command should return error, not crash
      const { pythonCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['-c', 'print("hello")'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pythonCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('failed to load Pyodide');
    });

    it('pip should show usage without install subcommand', async () => {
      const { pipCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: [],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pipCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('usage: pip install');
    });

    it('pip should show usage with install but no package', async () => {
      const { pipCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['install'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pipCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('usage: pip install');
    });
  });

  // ─── sqlite3 ─────────────────────────────────────────────────

  describe('sqlite3', () => {
    beforeEach(async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      shell.commands.register(sqlite3Cmd);
    });

    it('should be registered and discoverable', () => {
      const cmd = shell.commands.get('sqlite3');
      expect(cmd).toBeTruthy();
      expect(cmd!.description).toContain('SQLite');
    });

    it('should error on interactive mode without terminal', async () => {
      // sqlite3 with no query arg tries interactive mode → needs terminal
      // But first it tries to load sql.js from CDN which fails in test env
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: [],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      // Will fail at sql.js load in test env
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('error');
    });

    it('should handle stdin piping path (sql.js unavailable)', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: [':memory:', 'SELECT 1;'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      // CDN load will fail in test env
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('sql.js');
    });

  });
});
