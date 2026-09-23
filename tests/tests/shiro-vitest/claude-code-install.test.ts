import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { npmCmd } from '@shiro/commands/npm';
import { fetchCmd } from '@shiro/commands/fetch';
import { nodeCmd } from '@shiro/commands/jseval';
import { CLAUDE_CODE_PKG, CLAUDE_CODE_DIR } from '@shiro/claude-code-version';
import type { CommandContext } from '@shiro/commands/index';

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
    // FileSystem always opens the same IndexedDB ('shiro-fs'), so tests in this
    // file share state. The bin-symlink fixtures below write a stub cli.js; left
    // in place it stands in for the real CLI in the "REAL install" steps, which
    // is how a fully broken `claude` kept this suite green. Wipe between tests.
    for (const p of [CLAUDE_CODE_DIR, '/usr/local/bin/claude']) {
      try { await fs.rm(p, { recursive: true }); } catch { /* not there yet */ }
    }
  });

  describe('npm install -g flag parsing', () => {
    it('should recognize -g flag and try global install', async () => {
      const ctx = createCtx(shell, fs, ['install', '-g', 'nonexistent-pkg-12345']);
      const exitCode = await npmCmd.exec(ctx);
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
      const localCtx = createCtx(shell, fs, ['install', 'some-pkg']);
      await npmCmd.exec(localCtx);
      expect(localCtx.stderr).toContain('package.json not found');

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

      await fs.symlink(
        '/usr/local/lib/node_modules/test-pkg/cli.js',
        '/usr/local/bin/test-cmd'
      );

      const found = await shell.findExecutableInPath('test-cmd');
      expect(found).toBe('/usr/local/bin/test-cmd');

      const stat = await fs.lstat('/usr/local/bin/test-cmd');
      expect(stat.type).toBe('symlink');
    });

    it('should resolve scoped package bin names correctly', async () => {
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

      await fs.symlink(
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        '/usr/local/bin/claude'
      );

      const found = await shell.findExecutableInPath('claude');
      expect(found).toBe('/usr/local/bin/claude');
    });
  });

  describe('REAL install: curl -fsSL https://claude.ai/install.sh | bash', () => {
    it('step 1: curl gets install script', async () => {
      const ctx = createCtx(shell, fs, ['-fsSL', 'https://claude.ai/install.sh']);
      const exitCode = await fetchCmd.exec(ctx);
      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('npm install -g @anthropic-ai/claude-code');
    });

    it('step 2: npm install -g @anthropic-ai/claude-code downloads real package', async () => {
      const ctx = createCtx(shell, fs, ['install', '-g', CLAUDE_CODE_PKG]);
      const exitCode = await npmCmd.exec(ctx);

      expect(exitCode).toBe(0);
      expect(ctx.stdout).toContain('@anthropic-ai/claude-code');

      const pkgJson = await fs.readFile(
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json', 'utf8'
      ) as string;
      const pkg = JSON.parse(pkgJson);
      expect(pkg.name).toBe('@anthropic-ai/claude-code');
      expect(pkg.version).toBeTruthy();

      const stat = await fs.stat('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js');
      expect(stat.type).toBe('file');

      const binStat = await fs.lstat('/usr/local/bin/claude');
      expect(binStat.type).toBe('symlink');
    }, 120000);

    it('step 3: claude is found via PATH after install', async () => {
      const installCtx = createCtx(shell, fs, ['install', '-g', CLAUDE_CODE_PKG]);
      await npmCmd.exec(installCtx);

      const found = await shell.findExecutableInPath('claude');
      expect(found).toBe('/usr/local/bin/claude');
    }, 120000);

    it('step 3b: claude --version runs through PATH after install', async () => {
      const installCtx = createCtx(shell, fs, ['install', '-g', CLAUDE_CODE_PKG]);
      const installExit = await npmCmd.exec(installCtx);
      expect(installExit).toBe(0);

      const { output, exitCode } = await run(shell, 'claude --version');

      expect(exitCode).toBe(0);
      expect(output).toMatch(/\d+\.\d+\.\d+/);
    }, 120000);

    it('step 4: claude --version runs via node and outputs version', async () => {
      const installCtx = createCtx(shell, fs, ['install', '-g', CLAUDE_CODE_PKG]);
      const installExit = await npmCmd.exec(installCtx);
      expect(installExit).toBe(0);

      const nodeCtx = createCtx(shell, fs, [
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        '--version'
      ]);
      const exitCode = await nodeCmd.exec(nodeCtx);

      expect(exitCode).toBe(0);
      expect(nodeCtx.stdout).toMatch(/\d+\.\d+\.\d+/);
      expect(nodeCtx.stderr).toBe('');
    }, 120000);

    it('step 5: claude --help shows usage information', async () => {
      const installCtx = createCtx(shell, fs, ['install', '-g', CLAUDE_CODE_PKG]);
      await npmCmd.exec(installCtx);

      const helpCtx = createCtx(shell, fs, [
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        '--help'
      ]);
      const exitCode = await nodeCmd.exec(helpCtx);

      expect(exitCode).toBe(0);
      expect(helpCtx.stdout.length).toBeGreaterThan(0);
    }, 120000);

    // Skipped under Node: src/node-compat/process.ts only sets ANTHROPIC_BASE_URL
    // when `window` exists, so here the CLI dials api.anthropic.com directly and
    // the shim cannot resolve it — the request never reaches Anthropic, so no
    // "Invalid API key" ever comes back and this spends its full 120s timeout
    // retrying ENOTFOUND. The authenticated request path is browser-only and has
    // to be verified there.
    it.skip('step 6: claude -p "hello" runs with API key error', async () => {
      const installCtx = createCtx(shell, fs, ['install', '-g', CLAUDE_CODE_PKG]);
      await npmCmd.exec(installCtx);

      shell.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-test-invalid-key-for-testing';

      const promptCtx = createCtx(shell, fs, [
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        '-p', 'say hello'
      ]);
      const exitCode = await nodeCmd.exec(promptCtx);

      expect(exitCode).toBe(1);
      expect(promptCtx.stdout).toContain('Invalid API key');
    }, 120000);

    it('step 7: claude without -p detects non-TTY stdin correctly', async () => {
      const installCtx = createCtx(shell, fs, ['install', '-g', CLAUDE_CODE_PKG]);
      await npmCmd.exec(installCtx);

      shell.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-test-invalid-key-for-testing';

      const ctx = createCtx(shell, fs, [
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      ]);
      const exitCode = await nodeCmd.exec(ctx);

      expect(exitCode).toBe(1);
      expect(ctx.stderr).toContain('Input must be provided');
    }, 120000);
  });
});
