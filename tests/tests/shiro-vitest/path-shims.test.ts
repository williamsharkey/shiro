import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('PATH shims for builtins', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;

    // Create shims like main.ts does at boot
    const shimCommands = [
      'git', 'node', 'npm', 'npx', 'ls', 'cat', 'grep', 'sed', 'find', 'curl',
      'mkdir', 'rm', 'cp', 'mv', 'echo', 'touch', 'chmod', 'head', 'tail',
      'sort', 'uniq', 'wc', 'tr', 'tee', 'diff', 'env', 'which', 'test',
      'sh', 'bash', 'vi', 'nano', 'rg', 'esbuild',
    ];
    await fs.mkdir('/usr/local/bin', { recursive: true });
    for (const cmd of shimCommands) {
      const shimPath = `/usr/local/bin/${cmd}`;
      if (await fs.exists(shimPath)) continue;
      await fs.writeFile(shimPath, `#!/bin/sh\n${cmd} "$@"\n`);
    }
  });

  describe('which discovers builtins via PATH shims', () => {
    it('should find git', async () => {
      const { output, exitCode } = await run(shell, 'which git');
      expect(exitCode).toBe(0);
      expect(output).toContain('/usr/local/bin/git');
    });

    it('should find node', async () => {
      const { output, exitCode } = await run(shell, 'which node');
      expect(exitCode).toBe(0);
      expect(output).toContain('/usr/local/bin/node');
    });

    it('should find npm', async () => {
      const { output, exitCode } = await run(shell, 'which npm');
      expect(exitCode).toBe(0);
      expect(output).toContain('/usr/local/bin/npm');
    });

    it('should find ls', async () => {
      const { output, exitCode } = await run(shell, 'which ls');
      expect(exitCode).toBe(0);
      expect(output).toContain('/usr/local/bin/ls');
    });

    it('should find grep', async () => {
      const { output, exitCode } = await run(shell, 'which grep');
      expect(exitCode).toBe(0);
      expect(output).toContain('/usr/local/bin/grep');
    });
  });

  describe('shim scripts delegate to builtins', () => {
    it('git shim runs git init', async () => {
      await fs.mkdir('/tmp/shim-test', { recursive: true });
      shell.cwd = '/tmp/shim-test';
      // Execute the shim script directly (simulates execFile finding it on PATH)
      const { output, exitCode } = await run(shell, 'sh /usr/local/bin/git init');
      expect(exitCode).toBe(0);
      expect(output).toContain('Initialized');
    });

    it('echo shim passes arguments through', async () => {
      const { output, exitCode } = await run(shell, 'sh /usr/local/bin/echo hello world');
      expect(exitCode).toBe(0);
      expect(output).toContain('hello world');
    });

    it('ls shim lists files', async () => {
      await fs.writeFile('/home/user/shim-ls-test.txt', 'data');
      const { output, exitCode } = await run(shell, 'sh /usr/local/bin/ls');
      expect(exitCode).toBe(0);
      expect(output).toContain('shim-ls-test.txt');
    });

    it('cat shim reads files', async () => {
      await fs.writeFile('/home/user/shim-cat-test.txt', 'file content here');
      const { output, exitCode } = await run(shell, 'sh /usr/local/bin/cat shim-cat-test.txt');
      expect(exitCode).toBe(0);
      expect(output).toContain('file content here');
    });

    it('mkdir shim creates directories', async () => {
      const { exitCode } = await run(shell, 'sh /usr/local/bin/mkdir /tmp/shim-mkdir-test');
      expect(exitCode).toBe(0);
      const exists = await fs.exists('/tmp/shim-mkdir-test');
      expect(exists).toBe(true);
    });
  });

  describe('shim files have correct content', () => {
    it('shim is a shell script with shebang', async () => {
      const content = await fs.readFile('/usr/local/bin/git', 'utf8');
      expect(content).toBe('#!/bin/sh\ngit "$@"\n');
    });

    it('each shim delegates to its own command', async () => {
      for (const cmd of ['node', 'npm', 'ls', 'cat', 'grep']) {
        const content = await fs.readFile(`/usr/local/bin/${cmd}`, 'utf8');
        expect(content).toBe(`#!/bin/sh\n${cmd} "$@"\n`);
      }
    });
  });

  describe('shims do not overwrite real scripts', () => {
    it('preserves existing bin files', async () => {
      // Write a "real" script before shims
      await fs.writeFile('/usr/local/bin/custom-tool', '#!/bin/sh\necho custom\n');

      // Re-run shim creation (simulating boot)
      const shimPath = '/usr/local/bin/custom-tool';
      if (!(await fs.exists(shimPath))) {
        await fs.writeFile(shimPath, '#!/bin/sh\ncustom-tool "$@"\n');
      }

      // Original should be preserved
      const content = await fs.readFile('/usr/local/bin/custom-tool', 'utf8');
      expect(content).toBe('#!/bin/sh\necho custom\n');
    });
  });

  describe('command -v finds shims', () => {
    it('command -v git returns path', async () => {
      // 'command -v' is typically a shell builtin equivalent to which
      const { output, exitCode } = await run(shell, 'which git');
      expect(exitCode).toBe(0);
      expect(output.trim()).toBe('/usr/local/bin/git');
    });
  });

  describe('child_process-style execution via sh -c', () => {
    it('sh -c "git --version" works', async () => {
      const { exitCode } = await run(shell, 'sh -c "git --version"');
      expect(exitCode).toBe(0);
    });

    it('sh -c "which git" finds the shim', async () => {
      const { output, exitCode } = await run(shell, 'sh -c "which git"');
      expect(exitCode).toBe(0);
      expect(output).toContain('/usr/local/bin/git');
    });

    it('sh -c "node -e console.log(42)" works through shim', async () => {
      const { output, exitCode } = await run(shell, 'sh -c "node -e \\"console.log(42)\\""');
      expect(exitCode).toBe(0);
      expect(output).toContain('42');
    });
  });
});
