import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import { Shell } from '../src/shell';
import { FileSystem } from '../src/filesystem';
import { npmCmd } from '../src/commands/npm';
import { fetchCmd } from '../src/commands/fetch';
import type { CommandContext } from '../src/commands/index';

/**
 * Create a CommandContext for direct command testing (bypasses shell.execute
 * which hits window.location in favicon.ts recordCommand).
 */
function createCtx(shell: Shell, fs: FileSystem, args: string[]): CommandContext {
  return {
    args,
    fs,
    cwd: shell.cwd,
    env: shell.env,
    stdin: '',
    stdout: '',
    stderr: '',
    shell,
  };
}

describe('Claude Code Install', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  describe('npm install -g flag parsing', () => {
    it('should recognize -g flag and try global install', async () => {
      const ctx = createCtx(shell, fs, ['install', '-g', 'nonexistent-pkg-12345']);
      const exitCode = await npmCmd.exec(ctx);
      // Should try to install globally (not complain about missing package.json)
      expect(ctx.stdout).toContain('Installing packages globally');
    });

    it('should recognize --global flag and try global install', async () => {
      const ctx = createCtx(shell, fs, ['install', '--global', 'nonexistent-pkg-12345']);
      const exitCode = await npmCmd.exec(ctx);
      expect(ctx.stdout).toContain('Installing packages globally');
    });

    it('should create /usr/local/lib/node_modules directory', async () => {
      const ctx = createCtx(shell, fs, ['install', '-g', 'nonexistent-pkg-12345']);
      await npmCmd.exec(ctx);
      const stat = await fs.stat('/usr/local/lib/node_modules');
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create /usr/local/bin directory', async () => {
      const ctx = createCtx(shell, fs, ['install', '-g', 'nonexistent-pkg-12345']);
      await npmCmd.exec(ctx);
      const stat = await fs.stat('/usr/local/bin');
      expect(stat.isDirectory()).toBe(true);
    });

    it('should error when no packages specified for global install', async () => {
      const ctx = createCtx(shell, fs, ['install', '-g']);
      const exitCode = await npmCmd.exec(ctx);
      expect(exitCode).toBe(1);
      expect(ctx.stderr).toContain('please specify packages');
    });

    it('should not require package.json for global installs', async () => {
      // Local install without package.json should fail with "package.json not found"
      const localCtx = createCtx(shell, fs, ['install', 'some-pkg']);
      await npmCmd.exec(localCtx);
      expect(localCtx.stderr).toContain('package.json not found');

      // Global install without package.json should NOT fail with that error
      const globalCtx = createCtx(shell, fs, ['install', '-g', 'some-pkg']);
      await npmCmd.exec(globalCtx);
      expect(globalCtx.stderr).not.toContain('package.json not found');
    });
  });

  describe('PATH includes /usr/local/bin', () => {
    it('should have /usr/local/bin in PATH', () => {
      expect(shell.env['PATH']).toContain('/usr/local/bin');
    });

    it('should have /usr/local/bin first in PATH', () => {
      expect(shell.env['PATH'].startsWith('/usr/local/bin')).toBe(true);
    });

    it('should find executable in /usr/local/bin', async () => {
      await fs.mkdir('/usr/local/bin', { recursive: true });
      await fs.writeFile('/usr/local/bin/testcmd', '#!/bin/sh\necho hello\n');
      const found = await shell.findExecutableInPath('testcmd');
      expect(found).toBe('/usr/local/bin/testcmd');
    });
  });

  describe('install.sh intercept', () => {
    it('should return npm install script for claude.ai/install.sh', async () => {
      const ctx = createCtx(shell, fs, ['-fsSL', 'https://claude.ai/install.sh']);
      const exitCode = await fetchCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('npm install -g @anthropic-ai/claude-code');
    });

    it('should handle outputFile for install.sh', async () => {
      const ctx = createCtx(shell, fs, ['-fsSL', '-o', '/tmp/install.sh', 'https://claude.ai/install.sh']);
      const exitCode = await fetchCmd.exec(ctx);
      expect(exitCode).toBe(0);
      const content = await fs.readFile('/tmp/install.sh', 'utf8') as string;
      expect(content).toContain('npm install -g @anthropic-ai/claude-code');
    });
  });

  describe('global install with bin symlinks', () => {
    it('should create bin symlinks for globally installed packages', async () => {
      await fs.mkdir('/usr/local/lib/node_modules/test-pkg', { recursive: true });
      await fs.mkdir('/usr/local/bin', { recursive: true });
      await fs.writeFile('/usr/local/lib/node_modules/test-pkg/package.json', JSON.stringify({
        name: 'test-pkg',
        version: '1.0.0',
        bin: { 'test-cmd': './cli.js' },
      }));
      await fs.writeFile('/usr/local/lib/node_modules/test-pkg/cli.js',
        '#!/usr/bin/env node\nconsole.log("test-pkg works");\n');

      // Create bin symlink (simulating what npm install -g does)
      await fs.symlink(
        '/usr/local/lib/node_modules/test-pkg/cli.js',
        '/usr/local/bin/test-cmd'
      );

      // Verify the symlink resolves via PATH
      const found = await shell.findExecutableInPath('test-cmd');
      expect(found).toBe('/usr/local/bin/test-cmd');

      // Verify the symlink target is readable
      const stat = await fs.stat('/usr/local/bin/test-cmd');
      expect(stat.type).toBe('symlink');
    });

    it('should resolve scoped package bin names correctly', async () => {
      // @anthropic-ai/claude-code has bin: { "claude": "cli.js" }
      await fs.mkdir('/usr/local/lib/node_modules/@anthropic-ai/claude-code', { recursive: true });
      await fs.mkdir('/usr/local/bin', { recursive: true });
      await fs.writeFile('/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json', JSON.stringify({
        name: '@anthropic-ai/claude-code',
        version: '2.1.0',
        type: 'module',
        bin: { claude: 'cli.js' },
      }));
      await fs.writeFile('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        '#!/usr/bin/env node\nconsole.log("Claude Code v2.1.0");\n');

      // Symlink like npm -g would
      await fs.symlink(
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        '/usr/local/bin/claude'
      );

      // Should find via PATH
      const found = await shell.findExecutableInPath('claude');
      expect(found).toBe('/usr/local/bin/claude');
    });
  });
});
