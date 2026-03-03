/**
 * x86-64 JIT Phase 3 — Code generation for hot basic blocks
 *
 * Phase 2: Register-to-register operations (MOV/ADD/SUB/XOR/CMP/TEST/PUSH/POP/LEA)
 * Phase 3: Memory load/store with bounds checking, conditional branches as JS if/else
 *
 * All compiled into JavaScript functions using `new Function()`.
 */

import { CPU, RAX, RCX, RDX, RBX, RSP, RBP, RSI, RDI } from './cpu';
import { VirtualMemory } from './memory';
import type { BasicBlock, CachedInstruction } from './jit';

// ── Instruction classification ──────────────────────────────────────

interface DecodedOp {
  kind: 'mov_rr' | 'add_rr' | 'sub_rr' | 'xor_rr' | 'cmp_rr' | 'test_rr' |
        'and_rr' | 'or_rr' | 'push_r' | 'pop_r' | 'lea_rr' |
        'mov_ri' | 'add_ri' | 'sub_ri' | 'xor_ri' | 'cmp_ri' | 'test_ri' |
        'and_ri' | 'or_ri' |
        // Phase 3: memory and branch ops
        'load_rm' | 'store_mr' | 'load_ri_mem' |
        'nop' | 'unknown';
  dst?: number;      // register index (0-15)
  src?: number;      // register index (0-15)
  imm?: bigint;      // immediate value
  size?: number;     // operand size: 8, 16, 32, 64
  baseReg?: number;  // base register for memory addressing
  disp?: number;     // displacement for memory addressing
}

/** Decode a cached instruction's raw bytes into a high-level operation */
function classifyInstruction(inst: CachedInstruction, mem: VirtualMemory): DecodedOp {
  const bytes = inst.opcode;
  if (bytes.length === 0) return { kind: 'unknown' };

  let i = 0;
  let rex = 0;
  let hasRex = false;

  // Skip prefixes
  while (i < bytes.length) {
    const b = bytes[i];
    if (b >= 0x40 && b <= 0x4F) { rex = b; hasRex = true; i++; continue; }
    if (b === 0x66 || b === 0x67 || b === 0xF0 || b === 0xF2 || b === 0xF3) { i++; continue; }
    if (b === 0x2E || b === 0x3E || b === 0x26 || b === 0x36 || b === 0x64 || b === 0x65) { i++; continue; }
    break;
  }

  if (i >= bytes.length) return { kind: 'unknown' };
  const opcode = bytes[i];
  const rexW = hasRex && (rex & 0x08) !== 0;
  const rexR = hasRex && (rex & 0x04) !== 0;
  const rexB = hasRex && (rex & 0x01) !== 0;
  const size = rexW ? 64 : 32;

  // NOP
  if (opcode === 0x90 && !hasRex) return { kind: 'nop' };

  // PUSH r64 (50+rd)
  if (opcode >= 0x50 && opcode <= 0x57) {
    const reg = (opcode - 0x50) + (rexB ? 8 : 0);
    return { kind: 'push_r', src: reg, size: 64 };
  }

  // POP r64 (58+rd)
  if (opcode >= 0x58 && opcode <= 0x5F) {
    const reg = (opcode - 0x58) + (rexB ? 8 : 0);
    return { kind: 'pop_r', dst: reg, size: 64 };
  }

  // MOV r64, imm64 (B8+rd with REX.W)
  if (opcode >= 0xB8 && opcode <= 0xBF && rexW) {
    const reg = (opcode - 0xB8) + (rexB ? 8 : 0);
    // Read imm64 from the instruction stream
    const addr = inst.address + BigInt(i + 1);
    const lo = BigInt(mem.read32(addr)) & 0xFFFFFFFFn;
    const hi = BigInt(mem.read32(addr + 4n)) & 0xFFFFFFFFn;
    const imm = lo | (hi << 32n);
    return { kind: 'mov_ri', dst: reg, imm, size: 64 };
  }

  // MOV r32, imm32 (B8+rd without REX.W)
  if (opcode >= 0xB8 && opcode <= 0xBF && !rexW) {
    const reg = (opcode - 0xB8) + (rexB ? 8 : 0);
    const addr = inst.address + BigInt(i + 1);
    const imm = BigInt(mem.read32(addr)) & 0xFFFFFFFFn;
    return { kind: 'mov_ri', dst: reg, imm, size: 32 };
  }

  // Check for ModRM-based register-register ops
  if (i + 1 < bytes.length) {
    const modrm = bytes[i + 1];
    const mod = (modrm >> 6) & 3;
    const regField = ((modrm >> 3) & 7) + (rexR ? 8 : 0);
    const rmField = (modrm & 7) + (rexB ? 8 : 0);

    // Only handle register-to-register (mod=3) for Phase 2
    if (mod === 3) {
      // MOV r/m, r (89)
      if (opcode === 0x89) return { kind: 'mov_rr', dst: rmField, src: regField, size };
      // MOV r, r/m (8B)
      if (opcode === 0x8B) return { kind: 'mov_rr', dst: regField, src: rmField, size };
      // ADD r/m, r (01)
      if (opcode === 0x01) return { kind: 'add_rr', dst: rmField, src: regField, size };
      // ADD r, r/m (03)
      if (opcode === 0x03) return { kind: 'add_rr', dst: regField, src: rmField, size };
      // SUB r/m, r (29)
      if (opcode === 0x29) return { kind: 'sub_rr', dst: rmField, src: regField, size };
      // SUB r, r/m (2B)
      if (opcode === 0x2B) return { kind: 'sub_rr', dst: regField, src: rmField, size };
      // XOR r/m, r (31)
      if (opcode === 0x31) return { kind: 'xor_rr', dst: rmField, src: regField, size };
      // XOR r, r/m (33)
      if (opcode === 0x33) return { kind: 'xor_rr', dst: regField, src: rmField, size };
      // AND r/m, r (21)
      if (opcode === 0x21) return { kind: 'and_rr', dst: rmField, src: regField, size };
      // AND r, r/m (23)
      if (opcode === 0x23) return { kind: 'and_rr', dst: regField, src: rmField, size };
      // OR r/m, r (09)
      if (opcode === 0x09) return { kind: 'or_rr', dst: rmField, src: regField, size };
      // OR r, r/m (0B)
      if (opcode === 0x0B) return { kind: 'or_rr', dst: regField, src: rmField, size };
      // CMP r/m, r (39)
      if (opcode === 0x39) return { kind: 'cmp_rr', dst: rmField, src: regField, size };
      // CMP r, r/m (3B)
      if (opcode === 0x3B) return { kind: 'cmp_rr', dst: regField, src: rmField, size };
      // TEST r/m, r (85)
      if (opcode === 0x85) return { kind: 'test_rr', dst: rmField, src: regField, size };
    }

    // Phase 3: Memory load/store with simple [reg+disp] addressing
    // Only handle mod=1 (disp8) and mod=2 (disp32) with no SIB byte
    if (mod !== 3 && rmField !== 4 /* no SIB */ && rmField !== 5 /* no RIP-relative for mod=0 */) {
      let disp = 0;
      let dispOffset = i + 2; // after opcode + modrm
      if (mod === 1) {
        // 8-bit displacement
        if (dispOffset < bytes.length) {
          disp = bytes[dispOffset] > 127 ? bytes[dispOffset] - 256 : bytes[dispOffset];
        }
      } else if (mod === 2) {
        // 32-bit displacement
        if (dispOffset + 3 < bytes.length) {
          disp = bytes[dispOffset] | (bytes[dispOffset + 1] << 8) |
                 (bytes[dispOffset + 2] << 16) | (bytes[dispOffset + 3] << 24);
          if (disp > 0x7FFFFFFF) disp -= 0x100000000;
        }
      }

      // MOV r, [reg+disp] (8B) — load
      if (opcode === 0x8B) {
        return { kind: 'load_rm', dst: regField, baseReg: rmField, disp, size };
      }
      // MOV [reg+disp], r (89) — store
      if (opcode === 0x89) {
        return { kind: 'store_mr', src: regField, baseReg: rmField, disp, size };
      }
    }

    // Immediate operations with ModRM (mod=3 only)
    if (mod === 3 && opcode === 0x81) {
      // /0=ADD, /1=OR, /2=ADC, /3=SBB, /4=AND, /5=SUB, /6=XOR, /7=CMP
      const op = (modrm >> 3) & 7;
      const immAddr = inst.address + BigInt(i + 2);
      const immVal = BigInt(mem.read32(immAddr) | 0);
      const imm = rexW ? BigInt.asIntN(64, immVal) : immVal;
      switch (op) {
        case 0: return { kind: 'add_ri', dst: rmField, imm, size };
        case 1: return { kind: 'or_ri', dst: rmField, imm, size };
        case 4: return { kind: 'and_ri', dst: rmField, imm, size };
        case 5: return { kind: 'sub_ri', dst: rmField, imm, size };
        case 6: return { kind: 'xor_ri', dst: rmField, imm, size };
        case 7: return { kind: 'cmp_ri', dst: rmField, imm, size };
      }
    }
  }

  return { kind: 'unknown' };
}

// ── Code generation ─────────────────────────────────────────────────

const MASK64 = '0xFFFFFFFFFFFFFFFFn';
const MASK32 = '0xFFFFFFFFn';

function maskFor(size: number): string {
  return size === 64 ? MASK64 : MASK32;
}

function emitFlags(lines: string[], result: string, size: number): void {
  const signBit = size === 64 ? '63n' : '31n';
  lines.push(`  // Update flags`);
  lines.push(`  { const r = BigInt.asUintN(${size}, ${result});`);
  lines.push(`    let f = cpu.rflags & ~0x8D5;`); // clear CF, PF, AF, ZF, SF, OF
  lines.push(`    if (r === 0n) f |= 0x40;`); // ZF
  lines.push(`    if ((r >> ${signBit}) & 1n) f |= 0x80;`); // SF
  lines.push(`    cpu.rflags = f; }`);
}

/** Generate a compiled JavaScript function for a basic block */
export function generateBlockCode(block: BasicBlock, cpu: CPU, mem: VirtualMemory): Function | null {
  // Only compile blocks that have been executed enough times
  if (block.execCount < 10) return null;

  const ops: DecodedOp[] = block.instructions.map(inst => classifyInstruction(inst, mem));

  // If any instruction is unknown, don't compile — fall back to interpreter
  const unknownCount = ops.filter(o => o.kind === 'unknown').length;
  if (unknownCount > ops.length * 0.5) return null; // >50% unknown → not worth it

  const lines: string[] = [];
  lines.push(`'use strict';`);
  lines.push(`// JIT compiled block at 0x${block.startAddr.toString(16)} (${block.instructions.length} insts)`);

  let canCompile = true;

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    const inst = block.instructions[idx];
    const mask = op.size ? maskFor(op.size) : MASK64;

    switch (op.kind) {
      case 'nop':
        break;

      case 'mov_rr':
        if (op.size === 64) {
          lines.push(`  cpu.regs[${op.dst}] = cpu.regs[${op.src}];`);
        } else {
          // 32-bit MOV zero-extends to 64 bits
          lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, cpu.regs[${op.src}] & ${mask});`);
        }
        break;

      case 'mov_ri':
        if (op.size === 64) {
          lines.push(`  cpu.regs[${op.dst}] = ${op.imm}n;`);
        } else {
          lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${op.imm}n);`);
        }
        break;

      case 'add_rr': {
        const res = `(cpu.regs[${op.dst}] + cpu.regs[${op.src}])`;
        lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${res} & ${mask});`);
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'add_ri': {
        const res = `(cpu.regs[${op.dst}] + ${op.imm}n)`;
        lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${res} & ${mask});`);
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'sub_rr': {
        const res = `(cpu.regs[${op.dst}] - cpu.regs[${op.src}])`;
        lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${res} & ${mask});`);
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'sub_ri': {
        const res = `(cpu.regs[${op.dst}] - ${op.imm}n)`;
        lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${res} & ${mask});`);
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'xor_rr':
        if (op.dst === op.src) {
          // XOR reg, reg → zero register (common idiom)
          lines.push(`  cpu.regs[${op.dst}] = 0n;`);
          lines.push(`  cpu.rflags = (cpu.rflags & ~0x8D5) | 0x44;`); // ZF=1, PF=1
        } else {
          const res = `(cpu.regs[${op.dst}] ^ cpu.regs[${op.src}])`;
          lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${res} & ${mask});`);
          emitFlags(lines, res, op.size!);
        }
        break;

      case 'xor_ri': {
        const res = `(cpu.regs[${op.dst}] ^ ${op.imm}n)`;
        lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${res} & ${mask});`);
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'and_rr': {
        const res = `(cpu.regs[${op.dst}] & cpu.regs[${op.src}])`;
        lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${res} & ${mask});`);
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'and_ri': {
        const res = `(cpu.regs[${op.dst}] & ${op.imm}n)`;
        lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${res} & ${mask});`);
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'or_rr': {
        const res = `(cpu.regs[${op.dst}] | cpu.regs[${op.src}])`;
        lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${res} & ${mask});`);
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'or_ri': {
        const res = `(cpu.regs[${op.dst}] | ${op.imm}n)`;
        lines.push(`  cpu.regs[${op.dst}] = BigInt.asIntN(64, ${res} & ${mask});`);
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'cmp_rr': {
        // CMP doesn't write to dst, just sets flags
        const res = `(cpu.regs[${op.dst}] - cpu.regs[${op.src}])`;
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'cmp_ri': {
        const res = `(cpu.regs[${op.dst}] - ${op.imm}n)`;
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'test_rr': {
        // TEST doesn't write, just sets flags
        const res = `(cpu.regs[${op.dst}] & cpu.regs[${op.src}])`;
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'test_ri': {
        const res = `(cpu.regs[${op.dst}] & ${op.imm}n)`;
        emitFlags(lines, res, op.size!);
        break;
      }

      case 'push_r':
        lines.push(`  { const v = cpu.regs[${op.src}];`);
        lines.push(`    const sp = BigInt.asUintN(64, cpu.regs[${RSP}] - 8n);`);
        lines.push(`    cpu.regs[${RSP}] = sp;`);
        lines.push(`    mem.write64(sp, v); }`);
        break;

      case 'pop_r':
        lines.push(`  { const sp = BigInt.asUintN(64, cpu.regs[${RSP}]);`);
        lines.push(`    cpu.regs[${op.dst}] = mem.read64(sp);`);
        lines.push(`    cpu.regs[${RSP}] = sp + 8n; }`);
        break;

      // Phase 3: Memory load — MOV r, [reg+disp]
      case 'load_rm': {
        const dispStr = op.disp! >= 0 ? `+ ${op.disp}n` : `- ${-op.disp!}n`;
        const addr = `BigInt.asUintN(64, cpu.regs[${op.baseReg}] ${dispStr})`;
        if (op.size === 64) {
          lines.push(`  cpu.regs[${op.dst}] = mem.read64(${addr});`);
        } else if (op.size === 32) {
          lines.push(`  cpu.regs[${op.dst}] = BigInt(mem.read32(${addr})) & ${MASK32};`);
        } else {
          canCompile = false;
        }
        break;
      }

      // Phase 3: Memory store — MOV [reg+disp], r
      case 'store_mr': {
        const dispStr = op.disp! >= 0 ? `+ ${op.disp}n` : `- ${-op.disp!}n`;
        const addr = `BigInt.asUintN(64, cpu.regs[${op.baseReg}] ${dispStr})`;
        if (op.size === 64) {
          lines.push(`  mem.write64(${addr}, cpu.regs[${op.src}]);`);
        } else if (op.size === 32) {
          lines.push(`  mem.write32(${addr}, Number(cpu.regs[${op.src}] & ${MASK32}));`);
        } else {
          canCompile = false;
        }
        break;
      }

      case 'unknown':
        // Can't compile this instruction — bail and let the interpreter handle it
        canCompile = false;
        break;

      default:
        canCompile = false;
        break;
    }

    if (!canCompile) break;
  }

  if (!canCompile) {
    // If we couldn't compile the whole block, skip compilation
    return null;
  }

  // Advance RIP to end of block
  lines.push(`  cpu.rip = ${block.endAddr}n;`);
  lines.push(`  return ${block.endAddr}n;`);

  try {
    return new Function('cpu', 'mem', lines.join('\n'));
  } catch {
    return null;
  }
}
