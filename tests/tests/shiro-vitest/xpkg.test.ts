import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('xpkg — x86-64 binary package manager', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  describe('xpkg help', () => {
    it('shows usage on --help', async () => {
      const { output, exitCode } = await run(shell, 'xpkg --help');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage: xpkg');
      expect(output).toContain('install');
      expect(output).toContain('search');
      expect(output).toContain('remove');
    });

    it('shows usage on no args', async () => {
      const { output, exitCode } = await run(shell, 'xpkg');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage: xpkg');
    });
  });

  describe('xpkg available', () => {
    it('lists all available packages', async () => {
      const { output, exitCode } = await run(shell, 'xpkg available');
      expect(exitCode).toBe(0);
      expect(output).toContain('busybox');
      expect(output).toContain('dash');
      expect(output).toContain('tree');
      expect(output).toContain('file');
      expect(output).toContain('bc');
      expect(output).toContain('packages available');
    });
  });

  describe('xpkg search', () => {
    it('finds packages by name', async () => {
      const { output, exitCode } = await run(shell, 'xpkg search busybox');
      expect(exitCode).toBe(0);
      expect(output).toContain('busybox');
    });

    it('finds packages by description', async () => {
      const { output, exitCode } = await run(shell, 'xpkg search calculator');
      expect(exitCode).toBe(0);
      expect(output).toContain('bc');
    });

    it('returns no results for unknown query', async () => {
      const { output, exitCode } = await run(shell, 'xpkg search zzzznonexistent');
      expect(exitCode).toBe(0);
      expect(output).toContain('No packages found');
    });

    it('errors on missing query', async () => {
      const { output, exitCode } = await run(shell, 'xpkg search');
      expect(exitCode).toBe(1);
    });
  });

  describe('xpkg info', () => {
    it('shows package details', async () => {
      const { output, exitCode } = await run(shell, 'xpkg info busybox');
      expect(exitCode).toBe(0);
      expect(output).toContain('Name:');
      expect(output).toContain('busybox');
      expect(output).toContain('Version:');
      expect(output).toContain('x86-64 (musl-static)');
      expect(output).toContain('Applets:');
    });

    it('shows info for non-applet package', async () => {
      const { output, exitCode } = await run(shell, 'xpkg info bc');
      expect(exitCode).toBe(0);
      expect(output).toContain('bc');
      expect(output).toContain('calculator');
    });

    it('errors on unknown package', async () => {
      const { output, exitCode } = await run(shell, 'xpkg info nonexistent');
      expect(exitCode).toBe(1);
    });

    it('errors on missing name', async () => {
      const { output, exitCode } = await run(shell, 'xpkg info');
      expect(exitCode).toBe(1);
    });
  });

  describe('xpkg list (empty)', () => {
    it('shows no packages installed', async () => {
      const { output, exitCode } = await run(shell, 'xpkg list');
      expect(exitCode).toBe(0);
      expect(output).toContain('No x86 packages installed');
    });
  });

  describe('xpkg unknown subcommand', () => {
    it('errors on unknown subcommand', async () => {
      const { output, exitCode } = await run(shell, 'xpkg frobnicate');
      expect(exitCode).toBe(1);
      expect(output).toContain('unknown command');
    });
  });
});

// ── x86-packages module tests ───────────────────────────────────────

describe('x86-packages module', () => {
  it('findX86Package finds by name', async () => {
    const { findX86Package } = await import('@shiro/x86-packages');
    const pkg = findX86Package('busybox');
    expect(pkg).toBeDefined();
    expect(pkg!.name).toBe('busybox');
    expect(pkg!.applets).toBeDefined();
    expect(pkg!.applets!.length).toBeGreaterThan(10);
  });

  it('findX86Package finds by applet name', async () => {
    const { findX86Package } = await import('@shiro/x86-packages');
    const pkg = findX86Package('awk');
    expect(pkg).toBeDefined();
    expect(pkg!.name).toBe('busybox');
  });

  it('findX86Package returns undefined for unknown', async () => {
    const { findX86Package } = await import('@shiro/x86-packages');
    expect(findX86Package('nonexistent')).toBeUndefined();
  });

  it('searchX86Packages matches description', async () => {
    const { searchX86Packages } = await import('@shiro/x86-packages');
    const results = searchX86Packages('shell');
    expect(results.some(p => p.name === 'dash')).toBe(true);
  });

  it('listX86Available returns all packages', async () => {
    const { listX86Available } = await import('@shiro/x86-packages');
    const all = listX86Available();
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(all.map(p => p.name)).toContain('busybox');
  });

  it('clearX86Cache does not throw', async () => {
    const { clearX86Cache } = await import('@shiro/x86-packages');
    expect(() => clearX86Cache()).not.toThrow();
    expect(() => clearX86Cache('busybox')).not.toThrow();
  });
});

// ── JIT Phase 2 codegen tests ───────────────────────────────────────

describe('JIT Phase 2 codegen', () => {
  it('generateBlockCode returns null for cold blocks', async () => {
    const { generateBlockCode } = await import('@shiro/x86/jit-codegen');
    const { CPU } = await import('@shiro/x86/cpu');
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const cpu = new CPU();
    const mem = new VirtualMemory();
    const block = {
      startAddr: 0x1000n,
      endAddr: 0x1010n,
      instructions: [],
      execCount: 2,
      compiledFn: null,
      byteHash: 0,
    };
    const fn = generateBlockCode(block, cpu, mem);
    expect(fn).toBeNull();
  });

  it('generateBlockCode compiles NOP blocks', async () => {
    const { generateBlockCode } = await import('@shiro/x86/jit-codegen');
    const { CPU } = await import('@shiro/x86/cpu');
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const cpu = new CPU();
    const mem = new VirtualMemory();

    // Write a NOP at 0x1000
    mem.write8(0x1000n, 0x90);

    const block = {
      startAddr: 0x1000n,
      endAddr: 0x1001n,
      instructions: [{
        address: 0x1000n,
        length: 1,
        opcode: [0x90],
        mnemonic: 'NOP',
        isBranch: false, isCall: false, isReturn: false, isSyscall: false,
      }],
      execCount: 20,
      compiledFn: null,
      byteHash: 0,
    };
    const fn = generateBlockCode(block, cpu, mem);
    expect(fn).toBeDefined();
    expect(typeof fn).toBe('function');

    // Execute and verify RIP is advanced
    (fn as any)(cpu, mem);
    expect(cpu.rip).toBe(0x1001n);
  });

  it('generateBlockCode compiles XOR reg,reg (zero idiom)', async () => {
    const { generateBlockCode } = await import('@shiro/x86/jit-codegen');
    const { CPU, RAX } = await import('@shiro/x86/cpu');
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const cpu = new CPU();
    const mem = new VirtualMemory();

    cpu.regs[RAX] = 0x12345678n;

    // XOR EAX, EAX: 31 C0
    mem.write8(0x1000n, 0x31);
    mem.write8(0x1001n, 0xC0);

    const block = {
      startAddr: 0x1000n,
      endAddr: 0x1002n,
      instructions: [{
        address: 0x1000n,
        length: 2,
        opcode: [0x31, 0xC0],
        mnemonic: 'XOR',
        isBranch: false, isCall: false, isReturn: false, isSyscall: false,
      }],
      execCount: 20,
      compiledFn: null,
      byteHash: 0,
    };
    const fn = generateBlockCode(block, cpu, mem);
    expect(fn).toBeDefined();
    (fn as any)(cpu, mem);
    expect(BigInt.asUintN(64, cpu.regs[RAX])).toBe(0n);
    // ZF should be set
    expect(cpu.rflags & 0x40).toBeTruthy();
  });

  it('generateBlockCode compiles PUSH/POP', async () => {
    const { generateBlockCode } = await import('@shiro/x86/jit-codegen');
    const { CPU, RAX, RSP } = await import('@shiro/x86/cpu');
    const { VirtualMemory } = await import('@shiro/x86/memory');
    const cpu = new CPU();
    const mem = new VirtualMemory();

    cpu.regs[RAX] = 42n;
    cpu.regs[RSP] = 0x7FFF00n;

    // PUSH RAX: 50, POP RAX: 58
    mem.write8(0x1000n, 0x50);
    mem.write8(0x1001n, 0x58);

    const block = {
      startAddr: 0x1000n,
      endAddr: 0x1002n,
      instructions: [
        {
          address: 0x1000n, length: 1, opcode: [0x50],
          mnemonic: 'PUSH', isBranch: false, isCall: false, isReturn: false, isSyscall: false,
        },
        {
          address: 0x1001n, length: 1, opcode: [0x58],
          mnemonic: 'POP', isBranch: false, isCall: false, isReturn: false, isSyscall: false,
        },
      ],
      execCount: 20,
      compiledFn: null,
      byteHash: 0,
    };
    const fn = generateBlockCode(block, cpu, mem);
    expect(fn).toBeDefined();
    (fn as any)(cpu, mem);
    expect(cpu.regs[RAX]).toBe(42n);
    expect(cpu.regs[RSP]).toBe(0x7FFF00n);
  });
});
