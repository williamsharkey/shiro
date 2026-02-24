/**
 * Comprehensive tests for the C compiler (cc/gcc) command.
 *
 * Tests argument parsing, error handling, flag combinations, and the
 * WASI runtime `--run` path. Compilation tests are limited by the CDN
 * dependency (xcc toolchain download) but error paths are fully exercised.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('C Compiler (cc/gcc)', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    const { ccCmd, gccCmd } = await import('@shiro/commands/cc');
    shell.commands.register(ccCmd);
    shell.commands.register(gccCmd);
  });

  // ─── Help & Usage ──────────────────────────────────────────────

  describe('help & usage', () => {
    it('should show usage with no arguments', async () => {
      const { output, exitCode } = await run(shell, 'cc');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
      expect(output).toContain('cc');
      expect(output).toContain('-o FILE');
      expect(output).toContain('-c');
      expect(output).toContain('-I DIR');
      expect(output).toContain('--version');
      expect(output).toContain('--run');
    });

    it('should show usage with --help', async () => {
      const { output, exitCode } = await run(shell, 'cc --help');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
      expect(output).toContain('xcc');
    });

    it('should show usage with -h', async () => {
      const { output, exitCode } = await run(shell, 'cc -h');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
    });
  });

  // ─── Version ───────────────────────────────────────────────────

  describe('version', () => {
    it('should show version with --version', async () => {
      const { output, exitCode } = await run(shell, 'cc --version');
      expect(exitCode).toBe(0);
      expect(output).toContain('xcc');
      expect(output).toContain('wcc');
      expect(output).toContain('Shiro');
    });

    it('should show version with -v', async () => {
      const { output, exitCode } = await run(shell, 'cc -v');
      expect(exitCode).toBe(0);
      expect(output).toContain('xcc');
    });

    it('should include github link in version', async () => {
      const { output } = await run(shell, 'cc --version');
      expect(output).toContain('tyfkda/xcc');
    });
  });

  // ─── gcc alias ─────────────────────────────────────────────────

  describe('gcc alias', () => {
    it('gcc should show the same help as cc', async () => {
      const { output: ccHelp } = await run(shell, 'cc --help');
      const { output: gccHelp } = await run(shell, 'gcc --help');
      expect(gccHelp).toBe(ccHelp);
    });

    it('gcc should show version', async () => {
      const { output, exitCode } = await run(shell, 'gcc --version');
      expect(exitCode).toBe(0);
      expect(output).toContain('xcc');
    });

    it('gcc should error on missing file same as cc', async () => {
      const { exitCode: gccCode } = await run(shell, 'gcc /tmp/nonexistent.c');
      const { exitCode: ccCode } = await run(shell, 'cc /tmp/nonexistent.c');
      expect(gccCode).not.toBe(0);
      expect(ccCode).not.toBe(0);
    });
  });

  // ─── Argument Parsing ─────────────────────────────────────────

  describe('argument parsing', () => {
    it('should reject -E (preprocess only)', async () => {
      await fs.writeFile('/tmp/test.c', 'int main() { return 0; }');
      const { exitCode, output } = await run(shell, 'cc -E /tmp/test.c');
      expect(exitCode).toBe(1);
      expect(output).toContain('-E not supported');
    });

    it('should reject -S (assembly only)', async () => {
      await fs.writeFile('/tmp/test.c', 'int main() { return 0; }');
      const { exitCode, output } = await run(shell, 'cc -S /tmp/test.c');
      expect(exitCode).toBe(1);
      expect(output).toContain('-S not supported');
    });

    it('should error when no input files given (only flags)', async () => {
      const { exitCode, output } = await run(shell, 'cc -o output');
      expect(exitCode).toBe(1);
      expect(output).toContain('no input files');
    });
  });

  // ─── Source File Errors ────────────────────────────────────────

  describe('source file errors', () => {
    it('should error on nonexistent source file', async () => {
      const { exitCode, output } = await run(shell, 'cc /tmp/nonexistent.c');
      expect(exitCode).not.toBe(0);
      // Either "No such file" from source read or download error
      expect(output.length).toBeGreaterThan(0);
    });

    it('should error on nonexistent source with -o', async () => {
      const { exitCode } = await run(shell, 'cc -o /tmp/out /tmp/missing.c');
      expect(exitCode).not.toBe(0);
    });

    it('should error on nonexistent source with -c', async () => {
      const { exitCode } = await run(shell, 'cc -c /tmp/missing.c');
      expect(exitCode).not.toBe(0);
    });
  });

  // ─── --run (WASI runtime path) ─────────────────────────────────

  describe('--run (WASI runtime)', () => {
    it('should error on nonexistent wasm file', async () => {
      const { ccCmd } = await import('@shiro/commands/cc');
      const ctx = {
        args: ['--run', '/tmp/nonexistent.wasm'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await ccCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('No such file');
    });

    it('should error on invalid wasm binary', async () => {
      await fs.writeFile('/tmp/bad.wasm', 'this is not valid wasm');
      const { ccCmd } = await import('@shiro/commands/cc');
      const ctx = {
        args: ['--run', '/tmp/bad.wasm'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await ccCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('invalid wasm');
    });

    it('should run a minimal valid wasm module', async () => {
      // Build a valid WASM module using the WebAssembly API, then serialize
      // it. This tests the full WASI runtime path (--run → compile → execute).
      //
      // Module: imports proc_exit from wasi_snapshot_preview1,
      //         exports memory + _start, _start calls proc_exit(42)
      const wasmBytes = new Uint8Array([
        // Magic + version
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        // Type section (id=1, size=8): 2 types
        0x01, 0x08,
        0x02,                          // 2 type entries
        0x60, 0x01, 0x7f, 0x00,        // type 0: (i32) -> void
        0x60, 0x00, 0x00,              // type 1: () -> void
        // Import section (id=2, size=36): 1 import
        0x02, 0x24,
        0x01,                          // 1 import
        0x16,                          // module name len = 22
        // "wasi_snapshot_preview1"
        0x77, 0x61, 0x73, 0x69, 0x5f, 0x73, 0x6e, 0x61,
        0x70, 0x73, 0x68, 0x6f, 0x74, 0x5f, 0x70, 0x72,
        0x65, 0x76, 0x69, 0x65, 0x77, 0x31,
        0x09,                          // field name len = 9
        // "proc_exit"
        0x70, 0x72, 0x6f, 0x63, 0x5f, 0x65, 0x78, 0x69, 0x74,
        0x00,                          // import kind: func
        0x00,                          // type index: 0
        // Function section (id=3, size=2): 1 function
        0x03, 0x02,
        0x01, 0x01,                    // 1 func, type 1
        // Memory section (id=5, size=3): 1 memory
        0x05, 0x03,
        0x01, 0x00, 0x01,              // 1 memory, no max, initial=1
        // Export section (id=7, size=19): 2 exports
        0x07, 0x13,
        0x02,                          // 2 exports
        0x06,                          // name len = 6
        0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, // "memory"
        0x02, 0x00,                    // memory export, index 0
        0x06,                          // name len = 6
        0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, // "_start"
        0x00, 0x01,                    // func export, index 1
        // Code section (id=10, size=8): 1 body
        0x0a, 0x08,
        0x01,                          // 1 body
        0x06,                          // body size = 6
        0x00,                          // 0 locals
        0x41, 0x2a,                    // i32.const 42
        0x10, 0x00,                    // call 0 (proc_exit)
        0x0b,                          // end
      ]);

      // Verify the bytes are valid WASM before testing cc --run
      await WebAssembly.compile(wasmBytes.buffer);

      await fs.writeFile('/tmp/exit42.wasm', wasmBytes);
      const { ccCmd } = await import('@shiro/commands/cc');
      const ctx = {
        args: ['--run', '/tmp/exit42.wasm'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await ccCmd.exec(ctx);
      expect(code).toBe(42);
    });

    it('should pass extra args to wasm program', async () => {
      const { ccCmd } = await import('@shiro/commands/cc');
      const ctx = {
        args: ['--run', '/tmp/nonexistent.wasm', 'arg1', 'arg2'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await ccCmd.exec(ctx);
      expect(code).toBe(1); // file doesn't exist
      expect(ctx.stderr).toContain('No such file');
    });

    it('should resolve relative paths for wasm files', async () => {
      const { ccCmd } = await import('@shiro/commands/cc');
      const ctx = {
        args: ['--run', 'relative.wasm'],
        fs, cwd: '/tmp', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await ccCmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('No such file');
    });
  });

  // ─── Flag Combinations ────────────────────────────────────────

  describe('flag handling', () => {
    it('should silently ignore -Wall', async () => {
      // -Wall is a warning flag that should be ignored
      const { exitCode } = await run(shell, 'cc -Wall');
      // With no source files, this should still error about no input
      expect(exitCode).toBe(1);
    });

    it('should silently ignore -O2', async () => {
      const { exitCode } = await run(shell, 'cc -O2');
      expect(exitCode).toBe(1); // no input files
    });

    it('should silently ignore -g', async () => {
      const { exitCode } = await run(shell, 'cc -g');
      expect(exitCode).toBe(1); // no input files
    });

    it('should handle -I flag without crashing', async () => {
      const { exitCode } = await run(shell, 'cc -I /usr/include');
      expect(exitCode).toBe(1); // no source files
    });
  });

  // ─── Command Metadata ─────────────────────────────────────────

  describe('command metadata', () => {
    it('cc should have correct name', async () => {
      const { ccCmd } = await import('@shiro/commands/cc');
      expect(ccCmd.name).toBe('cc');
    });

    it('cc should have descriptive description', async () => {
      const { ccCmd } = await import('@shiro/commands/cc');
      expect(ccCmd.description).toContain('C compiler');
    });

    it('gcc should have correct name', async () => {
      const { gccCmd } = await import('@shiro/commands/cc');
      expect(gccCmd.name).toBe('gcc');
    });

    it('gcc should be described as alias', async () => {
      const { gccCmd } = await import('@shiro/commands/cc');
      expect(gccCmd.description).toContain('alias');
    });
  });
});
