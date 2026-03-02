/**
 * x86-64 Runtime — top-level entry point for executing ELF binaries.
 * Connects the CPU, memory, decoder, ELF loader, and syscalls together.
 */

import { CPU } from './cpu';
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

/** Get ELF info without executing */
export function getElfInfo(data: Uint8Array): string {
  const info = parseElf64(data);
  return elfInfoString(info);
}

/** Debug-mode execution: step through with register dumps */
export async function debugElf(
  path: string,
  args: string[],
  ctx: X86Context,
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

  let count = 0;
  const MAX_DEBUG = 1000; // Much smaller limit for debug mode
  try {
    while (!cpu.halted && count < MAX_DEBUG) {
      // Print current instruction address
      const rip = cpu.rip.toString(16).padStart(8, '0');
      const byte = mem.read8(cpu.rip).toString(16).padStart(2, '0');
      ctx.writeStdout(`[${count.toString().padStart(4)}] 0x${rip}: ${byte}  `);

      (decoder as any)._pendingSyscall = false;
      decoder.step();
      count++;

      if ((decoder as any)._pendingSyscall) {
        ctx.writeStdout(`SYSCALL #${cpu.getReg64(0)}\r\n`);
        await syscalls.handleSyscall();
      } else {
        ctx.writeStdout(`\r\n`);
      }

      // Print register state every 10 instructions
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
