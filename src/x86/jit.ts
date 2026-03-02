/**
 * x86-64 JIT Basic Block Cache
 *
 * Identifies basic blocks (sequences of instructions ending at jumps/calls/rets),
 * caches decoded instruction arrays, and optionally compiles to JavaScript functions.
 *
 * Phase 1: Block identification + decode caching (skip re-decode overhead)
 * Phase 2: Code generation (compiled JS functions for hot blocks)
 */

import { CPU, REG_NAMES, RAX, RCX, RDX, RBX, RSP, RBP, RSI, RDI } from './cpu';
import { VirtualMemory } from './memory';

/** A decoded instruction within a basic block */
export interface CachedInstruction {
  address: bigint;
  length: number;       // byte length of this instruction
  opcode: number[];     // raw opcode bytes (for display/debug)
  mnemonic: string;     // human-readable mnemonic (e.g. "MOV", "ADD")
  isBranch: boolean;    // is this a branch/jump?
  isCall: boolean;
  isReturn: boolean;
  isSyscall: boolean;
}

/** A basic block: linear sequence of instructions with single entry/exit */
export interface BasicBlock {
  startAddr: bigint;
  endAddr: bigint;          // address after last instruction
  instructions: CachedInstruction[];
  execCount: number;        // how many times this block has been executed
  compiledFn: Function | null;  // JIT-compiled JS function (Phase 2)
  byteHash: number;         // hash of the block's bytes for invalidation
}

/** JIT block cache */
export class BlockCache {
  private cache: Map<string, BasicBlock> = new Map();  // keyed by hex address string
  private maxBlocks = 4096;

  /** Get a cached block or null */
  get(addr: bigint): BasicBlock | null {
    return this.cache.get(addr.toString(16)) || null;
  }

  /** Store a basic block */
  put(block: BasicBlock): void {
    if (this.cache.size >= this.maxBlocks) {
      // Evict least-executed blocks
      let minKey = '';
      let minCount = Infinity;
      for (const [key, blk] of this.cache) {
        if (blk.execCount < minCount) {
          minCount = blk.execCount;
          minKey = key;
        }
      }
      if (minKey) this.cache.delete(minKey);
    }
    this.cache.set(block.startAddr.toString(16), block);
  }

  /** Invalidate blocks that overlap with a memory write */
  invalidate(writeAddr: bigint, writeLen: number): void {
    const writeEnd = writeAddr + BigInt(writeLen);
    for (const [key, block] of this.cache) {
      // If the write overlaps with this block's address range, invalidate
      if (writeAddr < block.endAddr && writeEnd > block.startAddr) {
        this.cache.delete(key);
      }
    }
  }

  /** Check if a block is still valid by re-hashing its bytes */
  validate(block: BasicBlock, mem: VirtualMemory): boolean {
    return computeByteHash(mem, block.startAddr, block.endAddr) === block.byteHash;
  }

  /** Clear all cached blocks */
  clear(): void {
    this.cache.clear();
  }

  /** Get cache statistics */
  stats(): { size: number; totalExecs: number; compiledCount: number } {
    let totalExecs = 0;
    let compiledCount = 0;
    for (const block of this.cache.values()) {
      totalExecs += block.execCount;
      if (block.compiledFn) compiledCount++;
    }
    return { size: this.cache.size, totalExecs, compiledCount };
  }
}

/** Compute a simple hash of memory bytes for invalidation detection */
function computeByteHash(mem: VirtualMemory, start: bigint, end: bigint): number {
  let hash = 0x811c9dc5; // FNV-1a offset basis
  for (let addr = start; addr < end; addr++) {
    hash ^= mem.read8(addr);
    hash = Math.imul(hash, 0x01000193); // FNV-1a prime
    hash = hash >>> 0; // keep as uint32
  }
  return hash;
}

/** Identify a basic block starting at the given address */
export function identifyBlock(mem: VirtualMemory, startAddr: bigint, maxInstructions: number = 256): BasicBlock {
  const instructions: CachedInstruction[] = [];
  let addr = startAddr;

  for (let i = 0; i < maxInstructions; i++) {
    const inst = decodeOneInstruction(mem, addr);
    instructions.push(inst);
    addr += BigInt(inst.length);

    // Block ends at branch, call, return, or syscall
    if (inst.isBranch || inst.isCall || inst.isReturn || inst.isSyscall) {
      break;
    }
  }

  const endAddr = addr;
  return {
    startAddr,
    endAddr,
    instructions,
    execCount: 0,
    compiledFn: null,
    byteHash: computeByteHash(mem, startAddr, endAddr),
  };
}

/** Decode a single instruction at the given address — minimal decoder for block boundaries */
function decodeOneInstruction(mem: VirtualMemory, addr: bigint): CachedInstruction {
  let pos = addr;
  let rex = 0;
  let hasRex = false;
  let prefix66 = false;
  let prefixF2 = false;
  let prefixF3 = false;

  // Read prefixes
  let byte = mem.read8(pos);
  while (true) {
    if (byte === 0x66) { prefix66 = true; pos++; byte = mem.read8(pos); continue; }
    if (byte === 0x67) { pos++; byte = mem.read8(pos); continue; }
    if (byte === 0xF0) { pos++; byte = mem.read8(pos); continue; }
    if (byte === 0xF2) { prefixF2 = true; pos++; byte = mem.read8(pos); continue; }
    if (byte === 0xF3) { prefixF3 = true; pos++; byte = mem.read8(pos); continue; }
    if (byte === 0x2E || byte === 0x3E || byte === 0x26 || byte === 0x36 || byte === 0x64 || byte === 0x65) {
      pos++; byte = mem.read8(pos); continue;
    }
    if (byte >= 0x40 && byte <= 0x4F) { rex = byte; hasRex = true; pos++; byte = mem.read8(pos); continue; }
    break;
  }

  const opcode = byte;
  let mnemonic = 'UNKNOWN';
  let isBranch = false;
  let isCall = false;
  let isReturn = false;
  let isSyscall = false;
  let length = 1;

  // Determine instruction type and approximate length
  if (opcode === 0xC3 || opcode === 0xCB) {
    mnemonic = 'RET'; isReturn = true; length = 1;
  } else if (opcode === 0xC2) {
    mnemonic = 'RET'; isReturn = true; length = 3; // RET imm16
  } else if (opcode === 0xE8) {
    mnemonic = 'CALL'; isCall = true; length = 5; // CALL rel32
  } else if (opcode === 0xE9) {
    mnemonic = 'JMP'; isBranch = true; length = 5; // JMP rel32
  } else if (opcode === 0xEB) {
    mnemonic = 'JMP'; isBranch = true; length = 2; // JMP rel8
  } else if (opcode >= 0x70 && opcode <= 0x7F) {
    mnemonic = 'Jcc'; isBranch = true; length = 2; // Jcc rel8
  } else if (opcode === 0x0F) {
    const opcode2 = mem.read8(pos + 1n);
    if (opcode2 >= 0x80 && opcode2 <= 0x8F) {
      mnemonic = 'Jcc'; isBranch = true;
      length = 2 + 4; // 0F 8x + rel32
    } else if (opcode2 === 0x05) {
      mnemonic = 'SYSCALL'; isSyscall = true; length = 2;
    } else {
      // Two-byte opcode — estimate length based on ModRM
      mnemonic = `0F ${opcode2.toString(16)}`;
      length = estimateInstructionLength(mem, pos, hasRex, true);
    }
  } else if (opcode === 0xFF) {
    const modrm = mem.read8(pos + 1n);
    const reg = (modrm >> 3) & 7;
    if (reg === 2) { mnemonic = 'CALL'; isCall = true; }
    else if (reg === 4) { mnemonic = 'JMP'; isBranch = true; }
    length = estimateInstructionLength(mem, pos, hasRex, false);
  } else {
    // Regular instruction — estimate length
    length = estimateInstructionLength(mem, pos, hasRex, false);
    mnemonic = `OP ${opcode.toString(16)}`;
  }

  const totalLength = Number(pos - addr) + length;
  const opcodeBytes: number[] = [];
  for (let i = 0; i < Math.min(totalLength, 8); i++) {
    opcodeBytes.push(mem.read8(addr + BigInt(i)));
  }

  return {
    address: addr,
    length: totalLength,
    opcode: opcodeBytes,
    mnemonic,
    isBranch,
    isCall,
    isReturn,
    isSyscall,
  };
}

/** Estimate total instruction length from opcode position (rough heuristic) */
function estimateInstructionLength(mem: VirtualMemory, opcodePos: bigint, hasRex: boolean, isTwoByte: boolean): number {
  const startOff = isTwoByte ? 2 : 1;
  const modrmPos = opcodePos + BigInt(startOff);

  // Check if this instruction has a ModRM byte
  const opcode = mem.read8(opcodePos);
  // Most instructions with ModRM: ADD/OR/ADC/SBB/AND/SUB/XOR/CMP, MOV, etc.
  const hasModRM = needsModRM(opcode, isTwoByte, mem.read8(opcodePos + 1n));
  if (!hasModRM) {
    // Instructions without ModRM: MOV reg,imm, PUSH/POP, etc.
    if (opcode >= 0xB8 && opcode <= 0xBF) {
      return startOff + (hasRex && (mem.read8(opcodePos - 1n) & 0x08) ? 8 : 4); // MOV reg, imm32/64
    }
    if (opcode >= 0xB0 && opcode <= 0xB7) return startOff + 1; // MOV r8, imm8
    if (opcode >= 0x50 && opcode <= 0x5F) return startOff; // PUSH/POP
    return startOff; // Default: just opcode
  }

  const modrm = mem.read8(modrmPos);
  const mod = (modrm >> 6) & 3;
  const rm = modrm & 7;

  let len = startOff + 1; // opcode(s) + modrm

  // SIB byte needed?
  if (mod !== 3 && rm === 4) len++; // SIB

  // Displacement
  if (mod === 0 && rm === 5) len += 4; // [disp32]
  else if (mod === 1) len += 1; // [reg + disp8]
  else if (mod === 2) len += 4; // [reg + disp32]

  // Check for immediate operands
  if (hasImmediateOperand(opcode, isTwoByte)) {
    len += 4; // Most immediates are 32-bit
  }

  return len;
}

/** Check if an opcode needs a ModRM byte */
function needsModRM(opcode: number, isTwoByte: boolean, byte2: number): boolean {
  if (isTwoByte) return true; // Almost all 0F xx instructions have ModRM
  // Single-byte opcodes that DON'T have ModRM:
  if (opcode >= 0x50 && opcode <= 0x5F) return false; // PUSH/POP
  if (opcode >= 0xB0 && opcode <= 0xBF) return false; // MOV imm
  if (opcode >= 0x70 && opcode <= 0x7F) return false; // Jcc
  if (opcode === 0xE8 || opcode === 0xE9 || opcode === 0xEB) return false; // CALL/JMP
  if (opcode === 0xC3 || opcode === 0xCB || opcode === 0xC2) return false; // RET
  if (opcode === 0x90) return false; // NOP
  if (opcode === 0xCC || opcode === 0xCD) return false; // INT
  if (opcode >= 0xE0 && opcode <= 0xE3) return false; // LOOPx
  return true; // Default: has ModRM
}

/** Check if an opcode has an immediate operand after ModRM */
function hasImmediateOperand(opcode: number, isTwoByte: boolean): boolean {
  if (isTwoByte) return false; // Most 0F xx don't have immediates after ModRM
  if (opcode === 0x69) return true; // IMUL r, r/m, imm32
  if (opcode === 0x81) return true; // ADD/OR/ADC/SBB/AND/SUB/XOR/CMP r/m, imm32
  if (opcode === 0xC7) return true; // MOV r/m, imm32
  return false;
}

/** Compile a basic block into a JavaScript function (Phase 2 — hot-path optimization) */
export function compileBlock(block: BasicBlock, cpu: CPU, mem: VirtualMemory): Function | null {
  // Only compile blocks that have been executed enough times
  if (block.execCount < 10) return null;

  // For now, generate a simple function that replays the block's effects
  // This is a scaffold for future full compilation
  const lines: string[] = [];
  lines.push('// JIT compiled block at 0x' + block.startAddr.toString(16));

  for (const inst of block.instructions) {
    lines.push(`// ${inst.mnemonic} @ 0x${inst.address.toString(16)}`);
  }

  // The compiled function advances RIP to the block's end
  lines.push(`cpu.rip = ${block.endAddr}n;`);
  lines.push(`return ${block.endAddr}n;`);

  try {
    const fn = new Function('cpu', 'mem', lines.join('\n'));
    return fn;
  } catch {
    return null;
  }
}
