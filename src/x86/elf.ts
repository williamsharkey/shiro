/**
 * ELF64 Parser and Loader — loads static x86-64 ELF binaries into virtual memory.
 */

import { CPU, RSP } from './cpu';
import { VirtualMemory } from './memory';

// ELF constants
const ELF_MAGIC = 0x464C457F; // \x7fELF in little-endian
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;  // Little-endian
const EM_X86_64 = 62;
const PT_LOAD = 1;
const PT_INTERP = 3;

// Stack location (high address, like Linux)
const STACK_TOP = 0x7FFFFFF00000n;
const STACK_SIZE = 0x200000; // 2MB stack

export interface ElfInfo {
  entryPoint: bigint;
  programHeaders: ProgramHeader[];
  isStaticLinked: boolean;
  machine: number;
  elfClass: number;
  phOff: number;
  phEntSize: number;
  phNum: number;
}

export interface ProgramHeader {
  type: number;
  flags: number;
  offset: number;
  vaddr: bigint;
  paddr: bigint;
  filesz: number;
  memsz: number;
  align: bigint;
}

/** Parse ELF64 header and program headers from raw bytes */
export function parseElf64(data: Uint8Array): ElfInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Validate ELF magic
  if (view.getUint32(0, true) !== ELF_MAGIC) {
    throw new Error('Not a valid ELF file (bad magic)');
  }

  // Check class (must be 64-bit)
  const elfClass = data[4];
  if (elfClass !== ELFCLASS64) {
    throw new Error(`Unsupported ELF class: ${elfClass} (expected 64-bit)`);
  }

  // Check endianness (must be little-endian)
  if (data[5] !== ELFDATA2LSB) {
    throw new Error('Only little-endian ELF files are supported');
  }

  // Check machine type
  const machine = view.getUint16(18, true);
  if (machine !== EM_X86_64) {
    throw new Error(`Unsupported architecture: ${machine} (expected x86-64 / ${EM_X86_64})`);
  }

  // Read entry point
  const entryLo = view.getUint32(24, true);
  const entryHi = view.getUint32(28, true);
  const entryPoint = BigInt(entryLo) | (BigInt(entryHi) << 32n);

  // Read program header info
  const phOffLo = view.getUint32(32, true);
  const phOffHi = view.getUint32(36, true);
  const phOff = Number(BigInt(phOffLo) | (BigInt(phOffHi) << 32n));
  const phEntSize = view.getUint16(54, true);
  const phNum = view.getUint16(56, true);

  // Parse program headers
  const programHeaders: ProgramHeader[] = [];
  let isStaticLinked = true;

  for (let i = 0; i < phNum; i++) {
    const off = phOff + i * phEntSize;
    if (off + phEntSize > data.length) break;

    const type = view.getUint32(off, true);
    const flags = view.getUint32(off + 4, true);

    const offsetLo = view.getUint32(off + 8, true);
    const offsetHi = view.getUint32(off + 12, true);
    const offset = Number(BigInt(offsetLo) | (BigInt(offsetHi) << 32n));

    const vaddrLo = view.getUint32(off + 16, true);
    const vaddrHi = view.getUint32(off + 20, true);
    const vaddr = BigInt(vaddrLo) | (BigInt(vaddrHi) << 32n);

    const paddrLo = view.getUint32(off + 24, true);
    const paddrHi = view.getUint32(off + 28, true);
    const paddr = BigInt(paddrLo) | (BigInt(paddrHi) << 32n);

    const fileszLo = view.getUint32(off + 32, true);
    const fileszHi = view.getUint32(off + 36, true);
    const filesz = Number(BigInt(fileszLo) | (BigInt(fileszHi) << 32n));

    const memszLo = view.getUint32(off + 40, true);
    const memszHi = view.getUint32(off + 44, true);
    const memsz = Number(BigInt(memszLo) | (BigInt(memszHi) << 32n));

    const alignLo = view.getUint32(off + 48, true);
    const alignHi = view.getUint32(off + 52, true);
    const align = BigInt(alignLo) | (BigInt(alignHi) << 32n);

    if (type === PT_INTERP) {
      isStaticLinked = false;
    }

    programHeaders.push({ type, flags, offset, vaddr, paddr, filesz, memsz, align });
  }

  return { entryPoint, programHeaders, isStaticLinked, machine, elfClass, phOff, phEntSize, phNum };
}

/** Load ELF segments into virtual memory and set up initial stack */
export function loadElf(
  data: Uint8Array,
  mem: VirtualMemory,
  cpu: CPU,
  argv: string[],
  envp: string[],
): ElfInfo {
  const info = parseElf64(data);

  // Load PT_LOAD segments into virtual memory
  for (const ph of info.programHeaders) {
    if (ph.type !== PT_LOAD) continue;
    const segData = data.slice(ph.offset, ph.offset + ph.filesz);
    mem.loadSegment(ph.vaddr, segData, ph.memsz);
  }

  // Set up stack
  const stackPages = Math.ceil(STACK_SIZE / 4096);
  const stackBase = STACK_TOP - BigInt(STACK_SIZE);
  mem.allocatePages(stackBase, stackPages);

  // Build Linux-style stack layout (grows downward):
  //   [high]
  //   env strings (null-terminated)
  //   arg strings (null-terminated)
  //   NULL (end of envp)
  //   envp[n-1] ... envp[0]   (pointers)
  //   NULL (end of argv)
  //   argv[argc-1] ... argv[0] (pointers)
  //   argc
  //   [low] ← RSP
  let sp = STACK_TOP - 8n; // start near top

  // Write environment strings and collect their addresses
  const envAddrs: bigint[] = [];
  for (const env of envp) {
    const bytes = new TextEncoder().encode(env);
    sp -= BigInt(bytes.length + 1);
    mem.writeBytes(sp, bytes);
    mem.write8(sp + BigInt(bytes.length), 0);
    envAddrs.push(sp);
  }

  // Write argument strings and collect their addresses
  const argAddrs: bigint[] = [];
  for (const arg of argv) {
    const bytes = new TextEncoder().encode(arg);
    sp -= BigInt(bytes.length + 1);
    mem.writeBytes(sp, bytes);
    mem.write8(sp + BigInt(bytes.length), 0);
    argAddrs.push(sp);
  }

  // Align SP to 8 bytes
  sp &= ~7n;

  // Write 16 random bytes for AT_RANDOM
  sp -= 16n;
  const randAddr = sp;
  for (let i = 0; i < 16; i++) {
    mem.write8(sp + BigInt(i), (Math.random() * 256) | 0);
  }

  // Calculate phdr address — find which PT_LOAD segment contains the program headers
  let phdrAddr = 0n;
  for (const ph of info.programHeaders) {
    if (ph.type === PT_LOAD && info.phOff >= ph.offset && info.phOff < ph.offset + ph.filesz) {
      phdrAddr = ph.vaddr + BigInt(info.phOff - ph.offset);
      break;
    }
  }

  // Write auxiliary vector (pairs of uint64: type, value)
  const auxv: [number, bigint][] = [
    [3,  phdrAddr],                     // AT_PHDR
    [4,  BigInt(info.phEntSize)],       // AT_PHENT
    [5,  BigInt(info.phNum)],           // AT_PHNUM
    [6,  4096n],                        // AT_PAGESZ
    [9,  info.entryPoint],              // AT_ENTRY
    [11, 1000n],                        // AT_UID
    [12, 1000n],                        // AT_EUID
    [13, 1000n],                        // AT_GID
    [14, 1000n],                        // AT_EGID
    [16, 0n],                           // AT_HWCAP
    [25, randAddr],                     // AT_RANDOM
    [26, 0n],                           // AT_HWCAP2
    [0,  0n],                           // AT_NULL (terminator)
  ];

  // Write auxv in reverse so they appear in order on the stack
  for (let i = auxv.length - 1; i >= 0; i--) {
    sp -= 16n;
    mem.write64(sp, BigInt(auxv[i][0]));
    mem.write64(sp + 8n, auxv[i][1]);
  }

  // Write envp array (pointers + NULL terminator)
  sp -= 8n;
  mem.write64(sp, 0n); // NULL terminator
  for (let i = envAddrs.length - 1; i >= 0; i--) {
    sp -= 8n;
    mem.write64(sp, envAddrs[i]);
  }

  // Write argv array (pointers + NULL terminator)
  sp -= 8n;
  mem.write64(sp, 0n); // NULL terminator
  for (let i = argAddrs.length - 1; i >= 0; i--) {
    sp -= 8n;
    mem.write64(sp, argAddrs[i]);
  }

  // Write argc
  sp -= 8n;
  mem.write64(sp, BigInt(argv.length));

  // Align RSP to 16 bytes (Linux ABI requirement before _start)
  sp &= ~0xFn;

  // Set CPU state
  cpu.rip = info.entryPoint;
  cpu.setReg64(RSP, sp);

  return info;
}

/** Get a human-readable summary of ELF info */
export function elfInfoString(info: ElfInfo): string {
  const lines = [
    `ELF64 x86-64 binary`,
    `Entry point: 0x${info.entryPoint.toString(16)}`,
    `Linking: ${info.isStaticLinked ? 'static' : 'dynamic (interpreter required)'}`,
    `Program headers: ${info.programHeaders.length}`,
  ];
  for (const ph of info.programHeaders) {
    const typeName = ph.type === PT_LOAD ? 'LOAD' : ph.type === PT_INTERP ? 'INTERP' : `0x${ph.type.toString(16)}`;
    const flags = `${ph.flags & 4 ? 'R' : '-'}${ph.flags & 2 ? 'W' : '-'}${ph.flags & 1 ? 'X' : '-'}`;
    lines.push(`  ${typeName.padEnd(8)} vaddr=0x${ph.vaddr.toString(16).padStart(12, '0')} memsz=0x${ph.memsz.toString(16)} filesz=0x${ph.filesz.toString(16)} ${flags}`);
  }
  return lines.join('\n');
}
