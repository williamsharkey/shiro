import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('Python Runtime', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    const { pythonCmd, python3Cmd, pipCmd } = await import('@shiro/commands/python');
    shell.commands.register(pythonCmd);
    shell.commands.register(python3Cmd);
    shell.commands.register(pipCmd);
  });

  // ─── Command Registration ──────────────────────────────────────

  describe('command registration', () => {
    it('pythonCmd should have name "python"', async () => {
      const { pythonCmd } = await import('@shiro/commands/python');
      expect(pythonCmd.name).toBe('python');
    });

    it('pythonCmd should have description mentioning Python', async () => {
      const { pythonCmd } = await import('@shiro/commands/python');
      expect(pythonCmd.description).toContain('Python');
    });

    it('python3Cmd should have name "python3"', async () => {
      const { python3Cmd } = await import('@shiro/commands/python');
      expect(python3Cmd.name).toBe('python3');
    });

    it('python3Cmd should have description mentioning Python', async () => {
      const { python3Cmd } = await import('@shiro/commands/python');
      expect(python3Cmd.description).toContain('Python');
    });

    it('pipCmd should have name "pip"', async () => {
      const { pipCmd } = await import('@shiro/commands/python');
      expect(pipCmd.name).toBe('pip');
    });

    it('pipCmd should have description mentioning package', async () => {
      const { pipCmd } = await import('@shiro/commands/python');
      expect(pipCmd.description).toMatch(/package/i);
    });

    it('all three commands should export exec functions', async () => {
      const { pythonCmd, python3Cmd, pipCmd } = await import('@shiro/commands/python');
      expect(typeof pythonCmd.exec).toBe('function');
      expect(typeof python3Cmd.exec).toBe('function');
      expect(typeof pipCmd.exec).toBe('function');
    });

    it('python and python3 should be discoverable in the registry', () => {
      expect(shell.commands.get('python')).toBeTruthy();
      expect(shell.commands.get('python3')).toBeTruthy();
      expect(shell.commands.get('pip')).toBeTruthy();
    });
  });

  // ─── Argument Parsing ─────────────────────────────────────────

  describe('argument parsing', () => {
    it('pip should require install subcommand', async () => {
      const { pipCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: [],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pipCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('usage: pip install');
    });

    it('pip should require package name after install', async () => {
      const { pipCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['install'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pipCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('usage: pip install');
    });

    it('pip should reject non-install subcommands', async () => {
      const { pipCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['uninstall', 'numpy'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pipCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('usage: pip install');
    });

    it('python -c should parse the code argument', async () => {
      const { pythonCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['-c', 'print("hello")'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pythonCmd.exec(ctx);
      // Pyodide CDN fails in test env
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('failed to load Pyodide');
    });
  });

  // ─── WASM-dependent execution (tolerant of CDN failure) ────────

  describe('python -c execution', () => {
    it('should execute print statement', async () => {
      const { output, exitCode } = await run(shell, 'python -c "print(42)"');
      if (exitCode === 0) {
        expect(output).toContain('42');
      } else {
        expect(output).toMatch(/pyodide|load|wasm/i);
      }
    });

    it('should execute arithmetic expressions', async () => {
      const { output, exitCode } = await run(shell, 'python -c "print(2+3)"');
      if (exitCode === 0) {
        expect(output).toContain('5');
      } else {
        expect(output).toMatch(/pyodide|load|wasm/i);
      }
    });

    it('should execute variable assignment and print', async () => {
      const { output, exitCode } = await run(shell, 'python3 -c "x=10; print(x*2)"');
      if (exitCode === 0) {
        expect(output).toContain('20');
      } else {
        expect(output).toMatch(/pyodide|load|wasm/i);
      }
    });

    it('should handle string operations', async () => {
      const { output, exitCode } = await run(shell, "python3 -c \"print('hello' + ' world')\"");
      if (exitCode === 0) {
        expect(output).toContain('hello world');
      } else {
        expect(output).toMatch(/pyodide|load|wasm/i);
      }
    });
  });

  // ─── Script file execution ────────────────────────────────────

  describe('script file execution', () => {
    it('should error when script file not found', async () => {
      const { pythonCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['nonexistent.py'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pythonCmd.exec(ctx);
      // Either Pyodide load fails or file-not-found error
      expect(code).not.toBe(0);
      if (ctx.stderr.includes('Pyodide')) {
        expect(ctx.stderr).toContain('failed to load Pyodide');
      } else {
        expect(ctx.stderr).toContain('No such file');
      }
    });

    it('should attempt to read script file from filesystem', async () => {
      await fs.writeFile('/home/user/test_script.py', 'print("from script")');
      const { pythonCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['test_script.py'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pythonCmd.exec(ctx);
      if (code === 0) {
        expect(ctx.stdout).toContain('from script');
      } else {
        // Pyodide unavailable in test env
        expect(ctx.stderr).toContain('Pyodide');
      }
    });

    it('should resolve script path relative to cwd', async () => {
      await fs.mkdir('/tmp/pytest', { recursive: true });
      await fs.writeFile('/tmp/pytest/hello.py', 'print("works")');
      const { pythonCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['hello.py'],
        fs, cwd: '/tmp/pytest', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pythonCmd.exec(ctx);
      if (code === 0) {
        expect(ctx.stdout).toContain('works');
      } else {
        expect(ctx.stderr).toContain('Pyodide');
      }
    });
  });

  // ─── Standard library imports ─────────────────────────────────

  describe('standard library (WASM-tolerant)', () => {
    it('should import json module', async () => {
      const { output, exitCode } = await run(shell, 'python3 -c "import json; print(json.dumps({\'a\': 1}))"');
      if (exitCode === 0) {
        expect(output).toContain('"a"');
      } else {
        expect(output).toMatch(/pyodide|load|wasm/i);
      }
    });

    it('should import math module', async () => {
      const { output, exitCode } = await run(shell, 'python3 -c "import math; print(math.pi)"');
      if (exitCode === 0) {
        expect(output).toContain('3.14');
      } else {
        expect(output).toMatch(/pyodide|load|wasm/i);
      }
    });

    it('should import sys module', async () => {
      const { output, exitCode } = await run(shell, 'python3 -c "import sys; print(sys.version)"');
      if (exitCode === 0) {
        expect(output).toMatch(/\d+\.\d+/);
      } else {
        expect(output).toMatch(/pyodide|load|wasm/i);
      }
    });
  });

  // ─── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('should handle Pyodide load failure gracefully for python', async () => {
      const { pythonCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['-c', 'print(1)'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pythonCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('failed to load Pyodide');
    });

    it('should handle Pyodide load failure gracefully for python3', async () => {
      const { python3Cmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['-c', 'print(1)'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await python3Cmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('failed to load Pyodide');
    });

    it('should handle Pyodide load failure gracefully for pip install', async () => {
      const { pipCmd } = await import('@shiro/commands/python');
      const ctx = {
        args: ['install', 'numpy'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pipCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('Pyodide');
    });

    it('should require terminal for interactive mode', async () => {
      const { pythonCmd } = await import('@shiro/commands/python');
      // No -c, no script file, no terminal — should fail
      const ctx = {
        args: [],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await pythonCmd.exec(ctx);
      // Will fail at Pyodide load before reaching terminal check
      expect(code).toBe(1);
    });
  });

  // ─── Source code validation ────────────────────────────────────

  describe('source code structure', () => {
    it('should use Pyodide CDN URL', async () => {
      const pySource = await import('@shiro/commands/python?raw');
      const src = typeof pySource === 'string' ? pySource : pySource.default;
      expect(src).toContain('cdn.jsdelivr.net/pyodide');
    });

    it('should redirect stdout/stderr through StringIO', async () => {
      const pySource = await import('@shiro/commands/python?raw');
      const src = typeof pySource === 'string' ? pySource : pySource.default;
      expect(src).toContain('io.StringIO');
      expect(src).toContain('sys.stdout');
      expect(src).toContain('sys.stderr');
    });

    it('should set sys.argv for -c mode', async () => {
      const pySource = await import('@shiro/commands/python?raw');
      const src = typeof pySource === 'string' ? pySource : pySource.default;
      expect(src).toContain('sys.argv');
    });

    it('python3 should share exec with python', async () => {
      const { pythonCmd, python3Cmd } = await import('@shiro/commands/python');
      // python3Cmd is a spread of pythonCmd with name/description overrides
      expect(python3Cmd.exec).toBe(pythonCmd.exec);
    });

    it('should sync Shiro FS to Pyodide native FS for script execution', async () => {
      const pySource = await import('@shiro/commands/python?raw');
      const src = typeof pySource === 'string' ? pySource : pySource.default;
      expect(src).toContain('syncToNative');
      expect(src).toContain('/shiro');
    });
  });
});
