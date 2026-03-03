/**
 * x86-64 Runtime — top-level entry point for executing ELF binaries.
 * Connects the CPU, memory, decoder, ELF loader, and syscalls together.
 */

import { CPU, REG_NAMES } from './cpu';
import { VirtualMemory } from './memory';
import { Decoder } from './decode';
import { loadElf, parseElf64, elfInfoString } from './elf';
import { LinuxSyscalls, X86Exit } from './syscalls';
import type { FileSystem } from '../filesystem';

const MAX_INSTRUCTIONS = 100_000_000; // Safety limit: 100M instructions

export interface X86Context {
  fs: FileSystem;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  stdin: string;
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
}

export interface DebugOptions {
  breakpoints?: bigint[];     // addresses to break at
  watchpoints?: bigint[];     // memory addresses to watch for writes
  dumpAddr?: bigint;          // hex dump start address
  dumpSize?: number;          // hex dump size (bytes)
  maxSteps?: number;          // max instructions to execute
}

/** Execute an ELF64 binary in the x86-64 emulator */
export async function executeElf(
  path: string,
  args: string[],
  ctx: X86Context,
): Promise<number> {
  // Read the ELF binary
  let elfData: Uint8Array;
  try {
    const raw = await ctx.fs.readFile(path);
    if (raw instanceof Uint8Array) {
      elfData = raw;
    } else {
      // String — convert to bytes
      const encoder = new TextEncoder();
      elfData = encoder.encode(raw as string);
    }
  } catch (e: any) {
    ctx.writeStderr(`shiro: ${path}: ${e.message}\r\n`);
    return 1;
  }

  // Set up emulator
  const cpu = new CPU();
  const mem = new VirtualMemory();
  const decoder = new Decoder(cpu, mem);

  // Build argv (program name + args)
  const argv = [path, ...args];

  // Build envp from shell environment
  const envp = Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`);

  // Load ELF into memory
  try {
    const info = loadElf(elfData, mem, cpu, argv, envp);
    if (!info.isStaticLinked) {
      ctx.writeStderr(`shiro: ${path}: dynamically-linked ELF binaries are not supported (need static linking)\r\n`);
      return 126;
    }
  } catch (e: any) {
    ctx.writeStderr(`shiro: ${path}: ${e.message}\r\n`);
    return 126;
  }

  // Set up syscall handling
  const syscalls = new LinuxSyscalls(
    cpu, mem, ctx.fs, ctx.cwd,
    ctx.writeStdout, ctx.writeStderr,
    ctx.stdin,
  );

  decoder.onSyscall = () => {
    // Mark that a syscall needs to be handled
    (decoder as any)._pendingSyscall = true;
  };

  // Execute
  let instructionCount = 0;
  try {
    while (!cpu.halted && instructionCount < MAX_INSTRUCTIONS) {
      (decoder as any)._pendingSyscall = false;
      decoder.step();
      instructionCount++;

      if ((decoder as any)._pendingSyscall) {
        await syscalls.handleSyscall();
      }
    }

    if (instructionCount >= MAX_INSTRUCTIONS) {
      ctx.writeStderr(`shiro: ${path}: exceeded instruction limit (${MAX_INSTRUCTIONS})\r\n`);
      return 1;
    }
  } catch (e: any) {
    if (e instanceof X86Exit) {
      return e.code;
    }
    ctx.writeStderr(`shiro: ${path}: ${e.message}\r\n`);
    return 1;
  }

  return 0;
}

/** Execute an ELF64 binary from a pre-loaded Uint8Array (for xpkg cached binaries) */
export async function executeElfFromBytes(
  elfData: Uint8Array,
  argv0: string,
  args: string[],
  ctx: X86Context,
): Promise<number> {
  const cpu = new CPU();
  const mem = new VirtualMemory();
  const decoder = new Decoder(cpu, mem);

  const argv = [argv0, ...args];
  const envp = Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`);

  try {
    const info = loadElf(elfData, mem, cpu, argv, envp);
    if (!info.isStaticLinked) {
      ctx.writeStderr(`shiro: ${argv0}: dynamically-linked ELF binaries are not supported (need static linking)\r\n`);
      return 126;
    }
  } catch (e: any) {
    ctx.writeStderr(`shiro: ${argv0}: ${e.message}\r\n`);
    return 126;
  }

  const syscalls = new LinuxSyscalls(
    cpu, mem, ctx.fs, ctx.cwd,
    ctx.writeStdout, ctx.writeStderr,
    ctx.stdin,
  );

  decoder.onSyscall = () => {
    (decoder as any)._pendingSyscall = true;
  };

  let instructionCount = 0;
  try {
    while (!cpu.halted && instructionCount < MAX_INSTRUCTIONS) {
      (decoder as any)._pendingSyscall = false;
      decoder.step();
      instructionCount++;

      if ((decoder as any)._pendingSyscall) {
        await syscalls.handleSyscall();
      }
    }

    if (instructionCount >= MAX_INSTRUCTIONS) {
      ctx.writeStderr(`shiro: ${argv0}: exceeded instruction limit (${MAX_INSTRUCTIONS})\r\n`);
      return 1;
    }
  } catch (e: any) {
    if (e instanceof X86Exit) {
      return e.code;
    }
    ctx.writeStderr(`shiro: ${argv0}: ${e.message}\r\n`);
    return 1;
  }

  return 0;
}

/** Get ELF info without executing */
export function getElfInfo(data: Uint8Array): string {
  const info = parseElf64(data);
  return elfInfoString(info);
}

/** Format a hex memory dump */
export function hexDump(mem: VirtualMemory, startAddr: bigint, size: number): string {
  const lines: string[] = [];
  for (let off = 0; off < size; off += 16) {
    const addr = startAddr + BigInt(off);
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16 && off + i < size; i++) {
      const byte = mem.read8(addr + BigInt(i));
      hex += byte.toString(16).padStart(2, '0') + ' ';
      ascii += (byte >= 0x20 && byte <= 0x7e) ? String.fromCharCode(byte) : '.';
    }
    lines.push(`0x${addr.toString(16).padStart(8, '0')}  ${hex.padEnd(48)} |${ascii}|`);
  }
  return lines.join('\n');
}

/** Format register diff between two snapshots */
function regDiff(prevRegs: BigInt64Array, cpu: CPU): string {
  const changes: string[] = [];
  for (let i = 0; i < 16; i++) {
    const prev = BigInt.asUintN(64, prevRegs[i]);
    const curr = BigInt.asUintN(64, cpu.regs[i]);
    if (prev !== curr) {
      changes.push(`  ${REG_NAMES[i]}: 0x${prev.toString(16)} → 0x${curr.toString(16)}`);
    }
  }
  return changes.length > 0 ? changes.join('\n') : '';
}

/** Snapshot current register state */
function snapshotRegs(cpu: CPU): BigInt64Array {
  const snap = new BigInt64Array(16);
  for (let i = 0; i < 16; i++) snap[i] = cpu.regs[i];
  return snap;
}

/** Debug-mode execution: step through with register dumps */
export async function debugElf(
  path: string,
  args: string[],
  ctx: X86Context,
  opts?: DebugOptions,
): Promise<number> {
  let elfData: Uint8Array;
  try {
    const raw = await ctx.fs.readFile(path);
    if (raw instanceof Uint8Array) elfData = raw;
    else elfData = new TextEncoder().encode(raw as string);
  } catch (e: any) {
    ctx.writeStderr(`shiro: ${path}: ${e.message}\r\n`);
    return 1;
  }

  const cpu = new CPU();
  const mem = new VirtualMemory();
  const decoder = new Decoder(cpu, mem);

  const argv = [path, ...args];
  const envp = Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`);

  try {
    loadElf(elfData, mem, cpu, argv, envp);
  } catch (e: any) {
    ctx.writeStderr(`shiro: ${path}: ${e.message}\r\n`);
    return 126;
  }

  const syscalls = new LinuxSyscalls(
    cpu, mem, ctx.fs, ctx.cwd,
    ctx.writeStdout, ctx.writeStderr,
    ctx.stdin,
  );

  decoder.onSyscall = () => {
    (decoder as any)._pendingSyscall = true;
  };

  const breakpoints = new Set(opts?.breakpoints || []);
  const watchpoints = opts?.watchpoints || [];
  const maxSteps = opts?.maxSteps || 1000;

  // If dump requested, show memory dump and return
  if (opts?.dumpAddr !== undefined) {
    const size = opts.dumpSize || 64;
    ctx.writeStdout(hexDump(mem, opts.dumpAddr, size) + '\r\n');
    return 0;
  }

  let count = 0;
  let prevRegs = snapshotRegs(cpu);

  try {
    while (!cpu.halted && count < maxSteps) {
      const rip = cpu.rip;

      // Check breakpoints
      if (count > 0 && breakpoints.has(rip)) {
        ctx.writeStdout(`\r\nBreakpoint hit at 0x${rip.toString(16).padStart(8, '0')} (after ${count} instructions)\r\n`);
        ctx.writeStdout(cpu.dump().split('\n').map(l => '  ' + l).join('\r\n') + '\r\n');
        return 0;
      }

      // Snapshot watchpoints before step
      const watchBefore = watchpoints.map(addr => mem.read8(addr));

      // Print current instruction address
      const ripStr = rip.toString(16).padStart(8, '0');
      const byte = mem.read8(rip).toString(16).padStart(2, '0');
      ctx.writeStdout(`[${count.toString().padStart(4)}] 0x${ripStr}: ${byte}  `);

      (decoder as any)._pendingSyscall = false;
      decoder.step();
      count++;

      if ((decoder as any)._pendingSyscall) {
        ctx.writeStdout(`SYSCALL #${cpu.getReg64(0)}\r\n`);
        await syscalls.handleSyscall();
      } else {
        ctx.writeStdout(`\r\n`);
      }

      // Check watchpoints after step
      for (let wi = 0; wi < watchpoints.length; wi++) {
        const newVal = mem.read8(watchpoints[wi]);
        if (newVal !== watchBefore[wi]) {
          ctx.writeStdout(`  Watchpoint 0x${watchpoints[wi].toString(16)}: ${watchBefore[wi]} → ${newVal}\r\n`);
        }
      }

      // Show register diff
      const diff = regDiff(prevRegs, cpu);
      if (diff) {
        ctx.writeStdout(diff.split('\n').map(l => l).join('\r\n') + '\r\n');
      }
      prevRegs = snapshotRegs(cpu);

      // Print full register state every 10 instructions
      if (count % 10 === 0) {
        ctx.writeStdout(cpu.dump().split('\n').map(l => '  ' + l).join('\r\n') + '\r\n');
      }
    }
  } catch (e: any) {
    if (e instanceof X86Exit) {
      ctx.writeStdout(`\r\nExit: ${e.code} (after ${count} instructions)\r\n`);
      ctx.writeStdout(cpu.dump().split('\n').map(l => '  ' + l).join('\r\n') + '\r\n');
      return e.code;
    }
    ctx.writeStderr(`\r\nError at instruction ${count}: ${e.message}\r\n`);
    ctx.writeStdout(cpu.dump().split('\n').map(l => '  ' + l).join('\r\n') + '\r\n');
    return 1;
  }

  return 0;
}
