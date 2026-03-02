/**
 * x86-64 Instruction Decoder and Executor.
 *
 * Decodes and executes x86-64 instructions one at a time.
 * Every instruction is a TypeScript function — transparent, debuggable, moddable.
 */

import { CPU, RAX, RCX, RDX, RBX, RSP, RBP, RSI, RDI, R8, FLAG_CF, FLAG_ZF, FLAG_SF, FLAG_OF, FLAG_PF, FLAG_AF, FLAG_DF } from './cpu';
import { VirtualMemory } from './memory';

const MASK8 = 0xFFn;
const MASK16 = 0xFFFFn;
const MASK32 = 0xFFFFFFFFn;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;

export class X86ExitSignal {
  constructor(public code: number) {}
}

export class X86SyscallSignal {
  // Raised when SYSCALL is hit; the runtime handles it externally
}

/** Decoded operand: either a register index or a memory address */
interface Operand {
  type: 'reg' | 'mem';
  reg?: number;      // register index (0-15)
  addr?: bigint;     // memory address (for mem operands)
}

export class Decoder {
  cpu: CPU;
  mem: VirtualMemory;
  onSyscall: (() => void) | null = null;

  // Instruction-local state (reset each step)
  private rex = 0;
  private hasRex = false;
  private prefix66 = false;  // operand size override
  private prefix67 = false;  // address size override
  private prefixF2 = false;  // REPNE
  private prefixF3 = false;  // REP/REPE
  private prefixF0 = false;  // LOCK
  private pos = 0n;

  constructor(cpu: CPU, mem: VirtualMemory) {
    this.cpu = cpu;
    this.mem = mem;
  }

  /** Execute a single instruction, advance RIP */
  step(): void {
    this.pos = this.cpu.rip;
    this.rex = 0;
    this.hasRex = false;
    this.prefix66 = false;
    this.prefix67 = false;
    this.prefixF2 = false;
    this.prefixF3 = false;
    this.prefixF0 = false;

    // 1. Consume legacy prefixes
    let prefixLoop = true;
    while (prefixLoop) {
      const b = this.readByte();
      switch (b) {
        case 0x66: this.prefix66 = true; break;
        case 0x67: this.prefix67 = true; break;
        case 0xF0: this.prefixF0 = true; break;
        case 0xF2: this.prefixF2 = true; break;
        case 0xF3: this.prefixF3 = true; break;
        case 0x2E: case 0x3E: case 0x26: case 0x36: case 0x64: case 0x65:
          // Segment override prefixes — ignored in 64-bit mode (except FS/GS)
          break;
        default:
          // Not a prefix, put it back
          this.pos -= 1n;
          prefixLoop = false;
      }
    }

    // 2. Check for REX prefix (0x40-0x4F)
    const maybRex = this.peekByte();
    if (maybRex >= 0x40 && maybRex <= 0x4F) {
      this.rex = this.readByte();
      this.hasRex = true;
    }

    // 3. Read opcode
    const op1 = this.readByte();

    // Two-byte opcode escape (0x0F)
    if (op1 === 0x0F) {
      const op2 = this.readByte();
      this.decodeTwoByteOpcode(op2);
    } else {
      this.decodeOneByteOpcode(op1);
    }

    // Update RIP
    this.cpu.rip = this.pos;
  }

  // ─── Helper methods ────────────────────────────────────────────────────────

  private readByte(): number {
    const b = this.mem.read8(this.pos);
    this.pos += 1n;
    return b;
  }

  private peekByte(): number {
    return this.mem.read8(this.pos);
  }

  private readWord(): number {
    const v = this.mem.read16(this.pos);
    this.pos += 2n;
    return v;
  }

  private readDword(): number {
    const v = this.mem.read32(this.pos);
    this.pos += 4n;
    return v;
  }

  private readQword(): bigint {
    const v = this.mem.read64(this.pos);
    this.pos += 8n;
    return v;
  }

  private readSignedByte(): number {
    const b = this.readByte();
    return b > 127 ? b - 256 : b;
  }

  private readSignedDword(): number {
    const v = this.readDword();
    return v > 0x7FFFFFFF ? v - 0x100000000 : v;
  }

  // REX bit helpers
  private get rexW(): boolean { return (this.rex & 0x08) !== 0; }
  private get rexR(): boolean { return (this.rex & 0x04) !== 0; }
  private get rexX(): boolean { return (this.rex & 0x02) !== 0; }
  private get rexB(): boolean { return (this.rex & 0x01) !== 0; }

  /** Get operand size: 64 if REX.W, 16 if 0x66 prefix, else 32 */
  private operandSize(): number {
    if (this.rexW) return 64;
    if (this.prefix66) return 16;
    return 32;
  }

  // ─── ModR/M + SIB decoding ─────────────────────────────────────────────────

  /** Decode ModR/M byte, returning reg field and rm operand */
  private decodeModRM(): { reg: number; rm: Operand } {
    const modrm = this.readByte();
    const mod = (modrm >> 6) & 3;
    let reg = (modrm >> 3) & 7;
    let rm = modrm & 7;

    // Extend with REX bits
    if (this.rexR) reg |= 8;
    if (this.rexB) rm |= 8;

    if (mod === 3) {
      // Register-register
      return { reg, rm: { type: 'reg', reg: rm } };
    }

    // Memory operand
    const addr = this.computeAddress(mod, rm & 7, this.rexB);
    return { reg, rm: { type: 'mem', addr } };
  }

  /** Compute effective address from mod and rm fields */
  private computeAddress(mod: number, rmLow3: number, hasRexB: boolean): bigint {
    let addr = 0n;
    const rm = rmLow3 | (hasRexB ? 8 : 0);

    if (rmLow3 === 4) {
      // SIB byte follows
      addr = this.decodeSIB(mod);
    } else if (mod === 0 && rmLow3 === 5) {
      // RIP-relative addressing (very common in x86-64!)
      const disp = this.readSignedDword();
      addr = this.pos + BigInt(disp); // RIP points to next instruction byte at this point
      return addr;
    } else {
      addr = this.cpu.getReg64(rm);
    }

    // Add displacement
    if (mod === 1) {
      addr += BigInt(this.readSignedByte());
    } else if (mod === 2) {
      addr += BigInt(this.readSignedDword());
    }

    return addr & MASK64;
  }

  /** Decode SIB byte */
  private decodeSIB(mod: number): bigint {
    const sib = this.readByte();
    const scale = 1 << ((sib >> 6) & 3);
    let index = (sib >> 3) & 7;
    let base = sib & 7;

    if (this.rexX) index |= 8;
    if (this.rexB) base |= 8;

    let addr = 0n;

    // Base register (or special cases)
    if ((base & 7) === 5 && mod === 0) {
      // No base register — use disp32
      addr = BigInt(this.readSignedDword());
    } else {
      addr = this.cpu.getReg64(base);
    }

    // Index register (RSP encoding means "no index")
    if ((index & 7) !== 4) {
      addr += this.cpu.getReg64(index) * BigInt(scale);
    }

    return addr;
  }

  // ─── Operand read/write helpers ────────────────────────────────────────────

  private readOperand(op: Operand, bits: number): bigint {
    if (op.type === 'reg') {
      switch (bits) {
        case 64: return this.cpu.getReg64(op.reg!);
        case 32: return this.cpu.getReg32(op.reg!);
        case 16: return this.cpu.getReg16(op.reg!);
        case 8:
          if (!this.hasRex && op.reg! >= 4 && op.reg! <= 7) {
            return this.cpu.getReg8High(op.reg!);
          }
          return this.cpu.getReg8(op.reg!);
      }
    }
    // Memory
    const addr = op.addr!;
    switch (bits) {
      case 64: return this.mem.read64(addr);
      case 32: return BigInt(this.mem.read32(addr));
      case 16: return BigInt(this.mem.read16(addr));
      case 8:  return BigInt(this.mem.read8(addr));
    }
    return 0n;
  }

  private writeOperand(op: Operand, val: bigint, bits: number): void {
    if (op.type === 'reg') {
      switch (bits) {
        case 64: this.cpu.setReg64(op.reg!, val); return;
        case 32: this.cpu.setReg32(op.reg!, val); return;
        case 16: this.cpu.setReg16(op.reg!, val); return;
        case 8:
          if (!this.hasRex && op.reg! >= 4 && op.reg! <= 7) {
            this.cpu.setReg8High(op.reg!, val);
          } else {
            this.cpu.setReg8(op.reg!, val);
          }
          return;
      }
    }
    const addr = op.addr!;
    switch (bits) {
      case 64: this.mem.write64(addr, val); return;
      case 32: this.mem.write32(addr, Number(val & MASK32)); return;
      case 16: this.mem.write16(addr, Number(val & MASK16)); return;
      case 8:  this.mem.write8(addr, Number(val & MASK8)); return;
    }
  }

  // ─── ALU helpers ───────────────────────────────────────────────────────────

  private mask(bits: number): bigint {
    return bits === 64 ? MASK64 : bits === 32 ? MASK32 : bits === 16 ? MASK16 : MASK8;
  }

  private signBit(bits: number): bigint {
    return 1n << BigInt(bits - 1);
  }

  /** ADD with full flag setting */
  private aluAdd(a: bigint, b: bigint, bits: number): bigint {
    const m = this.mask(bits);
    const result = (a + b) & m;
    const sb = this.signBit(bits);

    this.cpu.cf = (a + b) > m;
    this.cpu.setArithFlags(result, bits);
    this.cpu.of = ((~(a ^ b) & (a ^ result)) & sb) !== 0n;
    this.cpu.af = ((a ^ b ^ result) & 0x10n) !== 0n;
    return result;
  }

  /** SUB with full flag setting */
  private aluSub(a: bigint, b: bigint, bits: number): bigint {
    const m = this.mask(bits);
    // Perform subtraction in higher precision
    const result = ((a - b) + (m + 1n)) & m;

    this.cpu.cf = b > a; // borrow
    this.cpu.setArithFlags(result, bits);
    const sb = this.signBit(bits);
    this.cpu.of = (((a ^ b) & (a ^ result)) & sb) !== 0n;
    this.cpu.af = ((a ^ b ^ result) & 0x10n) !== 0n;
    return result;
  }

  /** AND with flag setting */
  private aluAnd(a: bigint, b: bigint, bits: number): bigint {
    const result = a & b & this.mask(bits);
    this.cpu.cf = false;
    this.cpu.of = false;
    this.cpu.setArithFlags(result, bits);
    this.cpu.af = false;
    return result;
  }

  /** OR with flag setting */
  private aluOr(a: bigint, b: bigint, bits: number): bigint {
    const result = (a | b) & this.mask(bits);
    this.cpu.cf = false;
    this.cpu.of = false;
    this.cpu.setArithFlags(result, bits);
    this.cpu.af = false;
    return result;
  }

  /** XOR with flag setting */
  private aluXor(a: bigint, b: bigint, bits: number): bigint {
    const result = (a ^ b) & this.mask(bits);
    this.cpu.cf = false;
    this.cpu.of = false;
    this.cpu.setArithFlags(result, bits);
    this.cpu.af = false;
    return result;
  }

  // ─── Stack helpers ─────────────────────────────────────────────────────────

  private push64(val: bigint): void {
    const sp = this.cpu.getReg64(RSP) - 8n;
    this.cpu.setReg64(RSP, sp);
    this.mem.write64(sp, val);
  }

  private pop64(): bigint {
    const sp = this.cpu.getReg64(RSP);
    const val = this.mem.read64(sp);
    this.cpu.setReg64(RSP, sp + 8n);
    return val;
  }

  // ─── Condition codes ──────────────────────────────────────────────────────

  /** Evaluate x86 condition code (0-15) */
  private evalCondition(cc: number): boolean {
    switch (cc) {
      case 0x0: return this.cpu.of;                                    // O
      case 0x1: return !this.cpu.of;                                   // NO
      case 0x2: return this.cpu.cf;                                    // B/NAE/C
      case 0x3: return !this.cpu.cf;                                   // NB/AE/NC
      case 0x4: return this.cpu.zf;                                    // E/Z
      case 0x5: return !this.cpu.zf;                                   // NE/NZ
      case 0x6: return this.cpu.cf || this.cpu.zf;                     // BE/NA
      case 0x7: return !this.cpu.cf && !this.cpu.zf;                   // NBE/A
      case 0x8: return this.cpu.sf;                                    // S
      case 0x9: return !this.cpu.sf;                                   // NS
      case 0xA: return this.cpu.pf;                                    // P/PE
      case 0xB: return !this.cpu.pf;                                   // NP/PO
      case 0xC: return this.cpu.sf !== this.cpu.of;                    // L/NGE
      case 0xD: return this.cpu.sf === this.cpu.of;                    // NL/GE
      case 0xE: return this.cpu.zf || (this.cpu.sf !== this.cpu.of);   // LE/NG
      case 0xF: return !this.cpu.zf && (this.cpu.sf === this.cpu.of);  // NLE/G
      default: return false;
    }
  }

  // ─── Sign extension helper ─────────────────────────────────────────────────

  private signExtend(val: bigint, fromBits: number, toBits: number): bigint {
    const signBit = 1n << BigInt(fromBits - 1);
    const fromMask = this.mask(fromBits);
    val &= fromMask;
    if ((val & signBit) !== 0n) {
      // Sign bit set — extend with 1s
      const extension = this.mask(toBits) & ~fromMask;
      return val | extension;
    }
    return val;
  }

  // ─── One-byte opcode dispatch ──────────────────────────────────────────────

  private decodeOneByteOpcode(op: number): void {
    const bits = this.operandSize();

    // ADD group: 00-05
    if (op >= 0x00 && op <= 0x05) {
      this.decodeAluGroup(op, 'add');
      return;
    }
    // OR group: 08-0D
    if (op >= 0x08 && op <= 0x0D) {
      this.decodeAluGroup(op - 0x08, 'or');
      return;
    }
    // AND group: 20-25
    if (op >= 0x20 && op <= 0x25) {
      this.decodeAluGroup(op - 0x20, 'and');
      return;
    }
    // SUB group: 28-2D
    if (op >= 0x28 && op <= 0x2D) {
      this.decodeAluGroup(op - 0x28, 'sub');
      return;
    }
    // XOR group: 30-35
    if (op >= 0x30 && op <= 0x35) {
      this.decodeAluGroup(op - 0x30, 'xor');
      return;
    }
    // CMP group: 38-3D
    if (op >= 0x38 && op <= 0x3D) {
      this.decodeAluGroup(op - 0x38, 'cmp');
      return;
    }

    // PUSH r64 (50-57)
    if (op >= 0x50 && op <= 0x57) {
      const reg = (op - 0x50) | (this.rexB ? 8 : 0);
      this.push64(this.cpu.getReg64(reg));
      return;
    }

    // POP r64 (58-5F)
    if (op >= 0x58 && op <= 0x5F) {
      const reg = (op - 0x58) | (this.rexB ? 8 : 0);
      this.cpu.setReg64(reg, this.pop64());
      return;
    }

    // MOVSXD (63) — sign-extend 32 to 64
    if (op === 0x63) {
      const { reg, rm } = this.decodeModRM();
      const val = this.readOperand(rm, 32);
      this.cpu.setReg64(reg, this.signExtend(val, 32, 64));
      return;
    }

    // PUSH imm32/imm16 (68)
    if (op === 0x68) {
      if (this.prefix66) {
        this.push64(BigInt(this.readWord()));
      } else {
        this.push64(BigInt(this.readSignedDword()) & MASK64);
      }
      return;
    }

    // IMUL r, rm, imm32 (69)
    if (op === 0x69) {
      const { reg, rm } = this.decodeModRM();
      const a = this.readOperand(rm, bits);
      const imm = BigInt(this.readSignedDword());
      const result = (a * imm) & this.mask(bits);
      this.writeOperand({ type: 'reg', reg }, result, bits);
      // Simplified flag setting
      this.cpu.cf = false;
      this.cpu.of = false;
      return;
    }

    // PUSH imm8 (6A)
    if (op === 0x6A) {
      this.push64(BigInt(this.readSignedByte()) & MASK64);
      return;
    }

    // IMUL r, rm, imm8 (6B)
    if (op === 0x6B) {
      const { reg, rm } = this.decodeModRM();
      const a = this.readOperand(rm, bits);
      const imm = BigInt(this.readSignedByte());
      const result = (a * imm) & this.mask(bits);
      this.writeOperand({ type: 'reg', reg }, result, bits);
      this.cpu.cf = false;
      this.cpu.of = false;
      return;
    }

    // Short conditional jumps (70-7F)
    if (op >= 0x70 && op <= 0x7F) {
      const cc = op & 0x0F;
      const disp = this.readSignedByte();
      if (this.evalCondition(cc)) {
        this.pos += BigInt(disp);
      }
      return;
    }

    // Group 1: ALU rm, imm8 (80) and ALU rm, imm32 (81) and ALU rm, imm8-signext (83)
    if (op === 0x80 || op === 0x81 || op === 0x83) {
      this.decodeGroup1(op);
      return;
    }

    // TEST rm8, r8 (84)
    if (op === 0x84) {
      const { reg, rm } = this.decodeModRM();
      const a = this.readOperand(rm, 8);
      const b = this.cpu.getReg8(reg);
      this.aluAnd(a, b, 8);
      return;
    }

    // TEST rm, r (85)
    if (op === 0x85) {
      const { reg, rm } = this.decodeModRM();
      const a = this.readOperand(rm, bits);
      const b = bits === 64 ? this.cpu.getReg64(reg) : bits === 32 ? this.cpu.getReg32(reg) : this.cpu.getReg16(reg);
      this.aluAnd(a, b, bits);
      return;
    }

    // XCHG rm, r (86=8bit, 87=16/32/64bit)
    if (op === 0x86 || op === 0x87) {
      const opBits = op === 0x86 ? 8 : bits;
      const { reg, rm } = this.decodeModRM();
      const a = this.readOperand(rm, opBits);
      const b = this.readOperand({ type: 'reg', reg }, opBits);
      this.writeOperand(rm, b, opBits);
      this.writeOperand({ type: 'reg', reg }, a, opBits);
      return;
    }

    // MOV rm, r (88=8bit, 89=16/32/64bit)
    if (op === 0x88) {
      const { reg, rm } = this.decodeModRM();
      this.writeOperand(rm, this.readOperand({ type: 'reg', reg }, 8), 8);
      return;
    }
    if (op === 0x89) {
      const { reg, rm } = this.decodeModRM();
      this.writeOperand(rm, this.readOperand({ type: 'reg', reg }, bits), bits);
      return;
    }

    // MOV r, rm (8A=8bit, 8B=16/32/64bit)
    if (op === 0x8A) {
      const { reg, rm } = this.decodeModRM();
      this.writeOperand({ type: 'reg', reg }, this.readOperand(rm, 8), 8);
      return;
    }
    if (op === 0x8B) {
      const { reg, rm } = this.decodeModRM();
      this.writeOperand({ type: 'reg', reg }, this.readOperand(rm, bits), bits);
      return;
    }

    // LEA r, m (8D)
    if (op === 0x8D) {
      const { reg, rm } = this.decodeModRM();
      if (rm.type === 'mem') {
        if (bits === 64 || this.rexW) {
          this.cpu.setReg64(reg, rm.addr!);
        } else {
          this.cpu.setReg32(reg, rm.addr! & MASK32);
        }
      }
      return;
    }

    // NOP (90) or XCHG rAX, r (90-97)
    if (op === 0x90) {
      // NOP (or XCHG rax, rax — same thing)
      return;
    }
    if (op >= 0x91 && op <= 0x97) {
      const reg = (op - 0x90) | (this.rexB ? 8 : 0);
      const tmp = this.cpu.getReg64(RAX);
      this.cpu.setReg64(RAX, this.cpu.getReg64(reg));
      this.cpu.setReg64(reg, tmp);
      return;
    }

    // CDQ (99): sign-extend EAX into EDX:EAX; CQO: sign-extend RAX into RDX:RAX
    if (op === 0x99) {
      if (this.rexW) {
        // CQO: RDX = signbit(RAX) ? -1 : 0
        const rax = this.cpu.getReg64(RAX);
        this.cpu.setReg64(RDX, (rax & (1n << 63n)) ? MASK64 : 0n);
      } else {
        // CDQ: EDX = signbit(EAX) ? 0xFFFFFFFF : 0
        const eax = this.cpu.getReg32(RAX);
        this.cpu.setReg32(RDX, (eax & (1n << 31n)) ? MASK32 : 0n);
      }
      return;
    }

    // CDQE (98): sign-extend EAX to RAX
    if (op === 0x98) {
      if (this.rexW) {
        // CDQE: RAX = signext32→64(EAX)
        this.cpu.setReg64(RAX, this.signExtend(this.cpu.getReg32(RAX), 32, 64));
      } else {
        // CBW/CWDE
        if (this.prefix66) {
          this.cpu.setReg16(RAX, this.signExtend(this.cpu.getReg8(RAX), 8, 16));
        } else {
          this.cpu.setReg32(RAX, this.signExtend(this.cpu.getReg16(RAX), 16, 32));
        }
      }
      return;
    }

    // MOV moffs → AL (A0), moffs → rAX (A1), AL → moffs (A2), rAX → moffs (A3)
    if (op === 0xA0) {
      const addr = this.rexW ? this.readQword() : BigInt(this.readDword());
      this.cpu.setReg8(RAX, BigInt(this.mem.read8(addr)));
      return;
    }
    if (op === 0xA1) {
      const addr = this.rexW ? this.readQword() : BigInt(this.readDword());
      if (bits === 64) this.cpu.setReg64(RAX, this.mem.read64(addr));
      else if (bits === 32) this.cpu.setReg32(RAX, BigInt(this.mem.read32(addr)));
      else this.cpu.setReg16(RAX, BigInt(this.mem.read16(addr)));
      return;
    }
    if (op === 0xA2) {
      const addr = this.rexW ? this.readQword() : BigInt(this.readDword());
      this.mem.write8(addr, Number(this.cpu.getReg8(RAX)));
      return;
    }
    if (op === 0xA3) {
      const addr = this.rexW ? this.readQword() : BigInt(this.readDword());
      if (bits === 64) this.mem.write64(addr, this.cpu.getReg64(RAX));
      else if (bits === 32) this.mem.write32(addr, Number(this.cpu.getReg32(RAX)));
      else this.mem.write16(addr, Number(this.cpu.getReg16(RAX)));
      return;
    }

    // TEST AL, imm8 (A8)
    if (op === 0xA8) {
      this.aluAnd(this.cpu.getReg8(RAX), BigInt(this.readByte()), 8);
      return;
    }

    // TEST rAX, imm (A9)
    if (op === 0xA9) {
      const imm = bits === 16 ? BigInt(this.readWord()) : BigInt(this.readSignedDword());
      const a = bits === 64 ? this.cpu.getReg64(RAX) : bits === 32 ? this.cpu.getReg32(RAX) : this.cpu.getReg16(RAX);
      this.aluAnd(a, this.signExtend(imm & this.mask(Math.min(bits, 32)), Math.min(bits, 32), bits), bits);
      return;
    }

    // REP MOVSB/MOVSQ (AA-AF — STOS, MOVS, etc.)
    if (op === 0xAA || op === 0xAB) {
      // STOSB/STOSW/STOSD/STOSQ — store AL/AX/EAX/RAX at [RDI]
      this.doStos(op === 0xAA ? 8 : bits);
      return;
    }
    if (op === 0xA4 || op === 0xA5) {
      // MOVSB/MOVSW/MOVSD/MOVSQ — copy [RSI] to [RDI]
      this.doMovs(op === 0xA4 ? 8 : bits);
      return;
    }

    // MOV r8, imm8 (B0-B7)
    if (op >= 0xB0 && op <= 0xB7) {
      const reg = (op - 0xB0) | (this.rexB ? 8 : 0);
      const imm = BigInt(this.readByte());
      if (this.hasRex || reg < 4) {
        this.cpu.setReg8(reg, imm);
      } else {
        this.cpu.setReg8High(reg, imm);
      }
      return;
    }

    // MOV r, imm (B8-BF) — r64 gets full 64-bit imm if REX.W
    if (op >= 0xB8 && op <= 0xBF) {
      const reg = (op - 0xB8) | (this.rexB ? 8 : 0);
      if (this.rexW) {
        this.cpu.setReg64(reg, this.readQword());
      } else if (this.prefix66) {
        this.cpu.setReg16(reg, BigInt(this.readWord()));
      } else {
        this.cpu.setReg32(reg, BigInt(this.readDword()));
      }
      return;
    }

    // Group 2: shift/rotate rm, imm8 (C0=8bit, C1=16/32/64bit)
    if (op === 0xC0 || op === 0xC1) {
      this.decodeGroup2(op === 0xC0 ? 8 : bits, 'imm8');
      return;
    }

    // RET near (C3)
    if (op === 0xC3) {
      this.cpu.rip = this.pop64(); // don't update pos, we set rip directly
      this.pos = this.cpu.rip;
      return;
    }

    // MOV rm, imm (C6=8bit, C7=16/32/64bit)
    if (op === 0xC6) {
      const { rm } = this.decodeModRM();
      this.writeOperand(rm, BigInt(this.readByte()), 8);
      return;
    }
    if (op === 0xC7) {
      const { rm } = this.decodeModRM();
      const imm = BigInt(this.readSignedDword());
      if (this.rexW) {
        this.writeOperand(rm, this.signExtend(imm & MASK32, 32, 64), 64);
      } else if (this.prefix66) {
        this.writeOperand(rm, BigInt(this.readWord()) & MASK16, 16); // Wrong — C7 reads 32-bit. Actually for 16 bit it reads 16.
      } else {
        this.writeOperand(rm, imm & MASK32, 32);
      }
      return;
    }

    // LEAVE (C9) — RSP = RBP; RBP = pop()
    if (op === 0xC9) {
      this.cpu.setReg64(RSP, this.cpu.getReg64(RBP));
      this.cpu.setReg64(RBP, this.pop64());
      return;
    }

    // Group 2: shift/rotate rm, 1 (D0=8bit, D1=16/32/64bit)
    if (op === 0xD0 || op === 0xD1) {
      this.decodeGroup2(op === 0xD0 ? 8 : bits, '1');
      return;
    }

    // Group 2: shift/rotate rm, CL (D2=8bit, D3=16/32/64bit)
    if (op === 0xD2 || op === 0xD3) {
      this.decodeGroup2(op === 0xD2 ? 8 : bits, 'cl');
      return;
    }

    // CALL rel32 (E8)
    if (op === 0xE8) {
      const disp = this.readSignedDword();
      this.push64(this.pos); // push return address (next instruction)
      this.pos += BigInt(disp);
      return;
    }

    // JMP rel32 (E9)
    if (op === 0xE9) {
      const disp = this.readSignedDword();
      this.pos += BigInt(disp);
      return;
    }

    // JMP rel8 (EB)
    if (op === 0xEB) {
      const disp = this.readSignedByte();
      this.pos += BigInt(disp);
      return;
    }

    // Group 3: TEST/NOT/NEG/MUL/IMUL/DIV/IDIV (F6=8bit, F7=16/32/64bit)
    if (op === 0xF6 || op === 0xF7) {
      this.decodeGroup3(op === 0xF6 ? 8 : bits);
      return;
    }

    // CLC (F8), STC (F9), CLI (FA), STI (FB), CLD (FC), STD (FD)
    if (op === 0xF8) { this.cpu.cf = false; return; }
    if (op === 0xF9) { this.cpu.cf = true; return; }
    if (op === 0xFA) { this.cpu.setFlag(9, false); return; } // CLI
    if (op === 0xFB) { this.cpu.setFlag(9, true); return; }  // STI
    if (op === 0xFC) { this.cpu.df = false; return; }
    if (op === 0xFD) { this.cpu.df = true; return; }

    // Group 5: INC/DEC/CALL/JMP/PUSH (FF)
    if (op === 0xFF) {
      this.decodeGroup5(bits);
      return;
    }

    // Group 4: INC/DEC rm8 (FE)
    if (op === 0xFE) {
      const { reg, rm } = this.decodeModRM();
      const val = this.readOperand(rm, 8);
      if ((reg & 7) === 0) {
        // INC rm8
        const result = this.aluAdd(val, 1n, 8);
        this.writeOperand(rm, result, 8);
      } else {
        // DEC rm8
        const result = this.aluSub(val, 1n, 8);
        this.writeOperand(rm, result, 8);
      }
      return;
    }

    throw new Error(`Unknown opcode: 0x${op.toString(16).padStart(2, '0')} at 0x${(this.pos - 1n).toString(16)}`);
  }

  // ─── ALU group decoder (ADD/OR/AND/SUB/XOR/CMP with ModR/M) ──────────────

  private decodeAluGroup(subOp: number, operation: string): void {
    // subOp 0: rm8, r8
    // subOp 1: rm, r
    // subOp 2: r8, rm8
    // subOp 3: r, rm
    // subOp 4: AL, imm8
    // subOp 5: rAX, imm
    const bits = this.operandSize();

    const doAlu = (a: bigint, b: bigint, opBits: number): bigint => {
      switch (operation) {
        case 'add': return this.aluAdd(a, b, opBits);
        case 'or':  return this.aluOr(a, b, opBits);
        case 'and': return this.aluAnd(a, b, opBits);
        case 'sub': return this.aluSub(a, b, opBits);
        case 'xor': return this.aluXor(a, b, opBits);
        case 'cmp': this.aluSub(a, b, opBits); return a; // don't store result
        default: return 0n;
      }
    };

    if (subOp === 0) {
      const { reg, rm } = this.decodeModRM();
      const a = this.readOperand(rm, 8);
      const b = this.cpu.getReg8(reg);
      const result = doAlu(a, b, 8);
      if (operation !== 'cmp') this.writeOperand(rm, result, 8);
    } else if (subOp === 1) {
      const { reg, rm } = this.decodeModRM();
      const a = this.readOperand(rm, bits);
      const b = this.readOperand({ type: 'reg', reg }, bits);
      const result = doAlu(a, b, bits);
      if (operation !== 'cmp') this.writeOperand(rm, result, bits);
    } else if (subOp === 2) {
      const { reg, rm } = this.decodeModRM();
      const a = this.cpu.getReg8(reg);
      const b = this.readOperand(rm, 8);
      const result = doAlu(a, b, 8);
      if (operation !== 'cmp') this.cpu.setReg8(reg, result);
    } else if (subOp === 3) {
      const { reg, rm } = this.decodeModRM();
      const a = this.readOperand({ type: 'reg', reg }, bits);
      const b = this.readOperand(rm, bits);
      const result = doAlu(a, b, bits);
      if (operation !== 'cmp') this.writeOperand({ type: 'reg', reg }, result, bits);
    } else if (subOp === 4) {
      const a = this.cpu.getReg8(RAX);
      const b = BigInt(this.readByte());
      const result = doAlu(a, b, 8);
      if (operation !== 'cmp') this.cpu.setReg8(RAX, result);
    } else if (subOp === 5) {
      const a = bits === 64 ? this.cpu.getReg64(RAX) : bits === 32 ? this.cpu.getReg32(RAX) : this.cpu.getReg16(RAX);
      const immRaw = bits === 16 ? BigInt(this.readWord()) : BigInt(this.readSignedDword());
      const b = this.rexW ? this.signExtend(immRaw & MASK32, 32, 64) : immRaw & this.mask(bits);
      const result = doAlu(a, b, bits);
      if (operation !== 'cmp') {
        if (bits === 64) this.cpu.setReg64(RAX, result);
        else if (bits === 32) this.cpu.setReg32(RAX, result);
        else this.cpu.setReg16(RAX, result);
      }
    }
  }

  // ─── Group 1: ALU rm, imm (80/81/83) ──────────────────────────────────────

  private decodeGroup1(op: number): void {
    const { reg: aluOp, rm } = this.decodeModRM();
    const opBits = op === 0x80 ? 8 : this.operandSize();
    const a = this.readOperand(rm, opBits);

    let imm: bigint;
    if (op === 0x80) {
      imm = BigInt(this.readByte());
    } else if (op === 0x83) {
      // Sign-extend 8-bit immediate
      imm = BigInt(this.readSignedByte());
      if (imm < 0n) imm = this.signExtend(imm & MASK8, 8, opBits);
    } else {
      // 81: 32-bit immediate (or 16-bit if prefix66)
      imm = opBits === 16 ? BigInt(this.readWord()) : BigInt(this.readSignedDword());
      if (this.rexW && (imm & (1n << 31n))) imm = this.signExtend(imm & MASK32, 32, 64);
    }

    let result: bigint;
    switch (aluOp & 7) {
      case 0: result = this.aluAdd(a, imm, opBits); break;  // ADD
      case 1: result = this.aluOr(a, imm, opBits); break;   // OR
      case 2: { // ADC
        const carry = this.cpu.cf ? 1n : 0n;
        result = this.aluAdd(a, imm + carry, opBits);
        break;
      }
      case 3: { // SBB
        const carry = this.cpu.cf ? 1n : 0n;
        result = this.aluSub(a, imm + carry, opBits);
        break;
      }
      case 4: result = this.aluAnd(a, imm, opBits); break;  // AND
      case 5: result = this.aluSub(a, imm, opBits); break;  // SUB
      case 6: result = this.aluXor(a, imm, opBits); break;  // XOR
      case 7: this.aluSub(a, imm, opBits); return;          // CMP (no store)
      default: return;
    }
    this.writeOperand(rm, result!, opBits);
  }

  // ─── Group 2: shift/rotate rm (C0/C1/D0/D1/D2/D3) ─────────────────────────

  private decodeGroup2(opBits: number, countSource: 'imm8' | '1' | 'cl'): void {
    const { reg: op, rm } = this.decodeModRM();
    let count: number;
    if (countSource === 'imm8') count = this.readByte() & 0x3F;
    else if (countSource === '1') count = 1;
    else count = Number(this.cpu.getReg8(RCX)) & 0x3F;

    if (count === 0) return; // no-op

    const val = this.readOperand(rm, opBits);
    const m = this.mask(opBits);
    let result: bigint;

    switch (op & 7) {
      case 0: // ROL
        result = ((val << BigInt(count)) | (val >> BigInt(opBits - count))) & m;
        this.cpu.cf = (result & 1n) !== 0n;
        break;
      case 1: // ROR
        result = ((val >> BigInt(count)) | (val << BigInt(opBits - count))) & m;
        this.cpu.cf = ((result >> BigInt(opBits - 1)) & 1n) !== 0n;
        break;
      case 4: // SHL/SAL
        result = (val << BigInt(count)) & m;
        this.cpu.cf = ((val >> BigInt(opBits - count)) & 1n) !== 0n;
        this.cpu.setArithFlags(result, opBits);
        break;
      case 5: // SHR
        result = (val >> BigInt(count)) & m;
        this.cpu.cf = ((val >> BigInt(count - 1)) & 1n) !== 0n;
        this.cpu.setArithFlags(result, opBits);
        break;
      case 7: // SAR
        {
          const sb = this.signBit(opBits);
          let v = val;
          for (let i = 0; i < count; i++) {
            this.cpu.cf = (v & 1n) !== 0n;
            const sign = v & sb;
            v = (v >> 1n) | sign;
          }
          result = v & m;
          this.cpu.setArithFlags(result, opBits);
        }
        break;
      default:
        return; // RCL, RCR not implemented yet
    }
    this.writeOperand(rm, result!, opBits);
  }

  // ─── Group 3: TEST/NOT/NEG/MUL/IMUL/DIV/IDIV (F6/F7) ─────────────────────

  private decodeGroup3(opBits: number): void {
    const { reg: op, rm } = this.decodeModRM();
    const val = this.readOperand(rm, opBits);

    switch (op & 7) {
      case 0: case 1: {
        // TEST rm, imm
        const imm = opBits === 8 ? BigInt(this.readByte()) : opBits === 16 ? BigInt(this.readWord()) : BigInt(this.readDword());
        this.aluAnd(val, imm, opBits);
        break;
      }
      case 2: {
        // NOT rm
        this.writeOperand(rm, ~val & this.mask(opBits), opBits);
        break;
      }
      case 3: {
        // NEG rm (0 - val)
        const result = this.aluSub(0n, val, opBits);
        this.writeOperand(rm, result, opBits);
        this.cpu.cf = val !== 0n;
        break;
      }
      case 4: {
        // MUL rm — unsigned multiply (RDX:RAX = RAX * rm)
        const a = opBits === 64 ? this.cpu.getReg64(RAX) :
                  opBits === 32 ? this.cpu.getReg32(RAX) :
                  opBits === 16 ? this.cpu.getReg16(RAX) : this.cpu.getReg8(RAX);
        const product = a * val;
        if (opBits === 64) {
          this.cpu.setReg64(RAX, product & MASK64);
          this.cpu.setReg64(RDX, (product >> 64n) & MASK64);
          this.cpu.cf = this.cpu.of = (product >> 64n) !== 0n;
        } else if (opBits === 32) {
          this.cpu.setReg64(RAX, product & MASK64); // zero-extends
          this.cpu.setReg64(RDX, 0n);
          this.cpu.setReg32(RDX, (product >> 32n) & MASK32);
          this.cpu.cf = this.cpu.of = (product >> 32n) !== 0n;
        } else if (opBits === 16) {
          this.cpu.setReg16(RAX, product & MASK16);
          this.cpu.setReg16(RDX, (product >> 16n) & MASK16);
          this.cpu.cf = this.cpu.of = (product >> 16n) !== 0n;
        } else {
          // 8-bit: AX = AL * rm8
          this.cpu.setReg16(RAX, product & MASK16);
          this.cpu.cf = this.cpu.of = (product >> 8n) !== 0n;
        }
        break;
      }
      case 5: {
        // IMUL rm — signed multiply (single operand form)
        const signed = (v: bigint, b: number) => {
          const sb = 1n << BigInt(b - 1);
          return (v & sb) ? v - (1n << BigInt(b)) : v;
        };
        const a = signed(opBits === 64 ? this.cpu.getReg64(RAX) :
                          opBits === 32 ? this.cpu.getReg32(RAX) :
                          opBits === 16 ? this.cpu.getReg16(RAX) : this.cpu.getReg8(RAX), opBits);
        const b = signed(val, opBits);
        const product = a * b;
        const m = this.mask(opBits);
        if (opBits === 64) {
          this.cpu.setReg64(RAX, product & MASK64);
          this.cpu.setReg64(RDX, ((product >> 64n) & MASK64));
        } else if (opBits === 32) {
          this.cpu.setReg32(RAX, product & MASK32);
          this.cpu.setReg32(RDX, (product >> 32n) & MASK32);
        } else if (opBits === 16) {
          this.cpu.setReg16(RAX, product & MASK16);
          this.cpu.setReg16(RDX, (product >> 16n) & MASK16);
        } else {
          this.cpu.setReg16(RAX, product & MASK16);
        }
        // CF=OF set if high half is not sign extension of low half
        const low = product & m;
        const signExt = signed(low, opBits);
        this.cpu.cf = this.cpu.of = product !== signExt;
        break;
      }
      case 6: {
        // DIV rm — unsigned divide
        if (val === 0n) throw new Error('Division by zero');
        if (opBits === 64) {
          const dividend = (this.cpu.getReg64(RDX) << 64n) | this.cpu.getReg64(RAX);
          this.cpu.setReg64(RAX, dividend / val);
          this.cpu.setReg64(RDX, dividend % val);
        } else if (opBits === 32) {
          const dividend = (this.cpu.getReg32(RDX) << 32n) | this.cpu.getReg32(RAX);
          this.cpu.setReg32(RAX, dividend / val);
          this.cpu.setReg32(RDX, dividend % val);
        } else if (opBits === 16) {
          const dividend = (this.cpu.getReg16(RDX) << 16n) | this.cpu.getReg16(RAX);
          this.cpu.setReg16(RAX, dividend / val);
          this.cpu.setReg16(RDX, dividend % val);
        } else {
          const dividend = this.cpu.getReg16(RAX);
          this.cpu.setReg8(RAX, dividend / val);
          this.cpu.setReg8High(4, dividend % val); // AH
        }
        break;
      }
      case 7: {
        // IDIV rm — signed divide
        if (val === 0n) throw new Error('Division by zero');
        const signed = (v: bigint, b: number): bigint => {
          const sb = 1n << BigInt(b - 1);
          return (v & sb) ? v - (1n << BigInt(b)) : v;
        };
        const m = this.mask(opBits);
        if (opBits === 64) {
          const dividend = signed((this.cpu.getReg64(RDX) << 64n) | this.cpu.getReg64(RAX), 128);
          const divisor = signed(val, 64);
          const quot = dividend / divisor;
          const rem = dividend - quot * divisor;
          this.cpu.setReg64(RAX, quot & MASK64);
          this.cpu.setReg64(RDX, rem & MASK64);
        } else if (opBits === 32) {
          const dividend = signed((this.cpu.getReg32(RDX) << 32n) | this.cpu.getReg32(RAX), 64);
          const divisor = signed(val, 32);
          const quot = dividend / divisor;
          const rem = dividend - quot * divisor;
          this.cpu.setReg32(RAX, quot & MASK32);
          this.cpu.setReg32(RDX, rem & MASK32);
        } else if (opBits === 16) {
          const dividend = signed((this.cpu.getReg16(RDX) << 16n) | this.cpu.getReg16(RAX), 32);
          const divisor = signed(val, 16);
          const quot = dividend / divisor;
          const rem = dividend - quot * divisor;
          this.cpu.setReg16(RAX, quot & MASK16);
          this.cpu.setReg16(RDX, rem & MASK16);
        } else {
          const dividend = signed(this.cpu.getReg16(RAX), 16);
          const divisor = signed(val, 8);
          const quot = dividend / divisor;
          const rem = dividend - quot * divisor;
          this.cpu.setReg8(RAX, quot & MASK8);
          this.cpu.setReg8High(4, rem & MASK8);
        }
        break;
      }
    }
  }

  // ─── Group 5: INC/DEC/CALL/JMP/PUSH (FF) ──────────────────────────────────

  private decodeGroup5(bits: number): void {
    const { reg: op, rm } = this.decodeModRM();
    switch (op & 7) {
      case 0: {
        // INC rm
        const val = this.readOperand(rm, bits);
        const savedCF = this.cpu.cf;
        const result = this.aluAdd(val, 1n, bits);
        this.cpu.cf = savedCF; // INC doesn't affect CF
        this.writeOperand(rm, result, bits);
        break;
      }
      case 1: {
        // DEC rm
        const val = this.readOperand(rm, bits);
        const savedCF = this.cpu.cf;
        const result = this.aluSub(val, 1n, bits);
        this.cpu.cf = savedCF; // DEC doesn't affect CF
        this.writeOperand(rm, result, bits);
        break;
      }
      case 2: {
        // CALL rm64 (indirect call)
        const target = this.readOperand(rm, 64);
        this.push64(this.pos);
        this.pos = target;
        break;
      }
      case 4: {
        // JMP rm64 (indirect jump)
        this.pos = this.readOperand(rm, 64);
        break;
      }
      case 6: {
        // PUSH rm
        this.push64(this.readOperand(rm, 64));
        break;
      }
      default:
        throw new Error(`Unimplemented Group 5 sub-op: ${op & 7}`);
    }
  }

  // ─── String operations ─────────────────────────────────────────────────────

  private doMovs(opBits: number): void {
    const byteCount = opBits >> 3;
    const dir = this.cpu.df ? -BigInt(byteCount) : BigInt(byteCount);

    const doOne = () => {
      const src = this.cpu.getReg64(RSI);
      const dst = this.cpu.getReg64(RDI);
      if (opBits === 8) this.mem.write8(dst, this.mem.read8(src));
      else if (opBits === 32) this.mem.write32(dst, this.mem.read32(src));
      else if (opBits === 64) this.mem.write64(dst, this.mem.read64(src));
      else this.mem.write16(dst, this.mem.read16(src));
      this.cpu.setReg64(RSI, (src + dir) & MASK64);
      this.cpu.setReg64(RDI, (dst + dir) & MASK64);
    };

    if (this.prefixF3) {
      // REP MOVSB/D/Q
      let rcx = this.cpu.getReg64(RCX);
      while (rcx > 0n) {
        doOne();
        rcx--;
      }
      this.cpu.setReg64(RCX, 0n);
    } else {
      doOne();
    }
  }

  private doStos(opBits: number): void {
    const byteCount = opBits >> 3;
    const dir = this.cpu.df ? -BigInt(byteCount) : BigInt(byteCount);

    const val = opBits === 8 ? this.cpu.getReg8(RAX) :
                opBits === 32 ? this.cpu.getReg32(RAX) :
                opBits === 64 ? this.cpu.getReg64(RAX) : this.cpu.getReg16(RAX);

    const doOne = () => {
      const dst = this.cpu.getReg64(RDI);
      if (opBits === 8) this.mem.write8(dst, Number(val));
      else if (opBits === 32) this.mem.write32(dst, Number(val & MASK32));
      else if (opBits === 64) this.mem.write64(dst, val);
      else this.mem.write16(dst, Number(val & MASK16));
      this.cpu.setReg64(RDI, (dst + dir) & MASK64);
    };

    if (this.prefixF3) {
      // REP STOSB/D/Q
      let rcx = this.cpu.getReg64(RCX);
      while (rcx > 0n) {
        doOne();
        rcx--;
      }
      this.cpu.setReg64(RCX, 0n);
    } else {
      doOne();
    }
  }

  // ─── Two-byte opcode dispatch (0F xx) ──────────────────────────────────────

  private decodeTwoByteOpcode(op2: number): void {
    const bits = this.operandSize();

    // SYSCALL (0F 05)
    if (op2 === 0x05) {
      // Save return address and flags per SYSCALL convention
      this.cpu.setReg64(RCX, this.pos); // RCX = next RIP
      this.cpu.regs[R8 + 3] = BigInt.asIntN(64, BigInt(this.cpu.rflags)); // R11 = RFLAGS
      if (this.onSyscall) {
        this.onSyscall();
      }
      return;
    }

    // Long conditional jumps (0F 80-8F)
    if (op2 >= 0x80 && op2 <= 0x8F) {
      const cc = op2 & 0x0F;
      const disp = this.readSignedDword();
      if (this.evalCondition(cc)) {
        this.pos += BigInt(disp);
      }
      return;
    }

    // SETcc rm8 (0F 90-9F)
    if (op2 >= 0x90 && op2 <= 0x9F) {
      const cc = op2 & 0x0F;
      const { rm } = this.decodeModRM();
      this.writeOperand(rm, this.evalCondition(cc) ? 1n : 0n, 8);
      return;
    }

    // CMOVcc r, rm (0F 40-4F)
    if (op2 >= 0x40 && op2 <= 0x4F) {
      const cc = op2 & 0x0F;
      const { reg, rm } = this.decodeModRM();
      if (this.evalCondition(cc)) {
        this.writeOperand({ type: 'reg', reg }, this.readOperand(rm, bits), bits);
      } else {
        // Read but discard (for side effects like memory access validation)
        this.readOperand(rm, bits);
      }
      return;
    }

    // IMUL r, rm (0F AF)
    if (op2 === 0xAF) {
      const { reg, rm } = this.decodeModRM();
      const a = this.readOperand({ type: 'reg', reg }, bits);
      const b = this.readOperand(rm, bits);
      const result = (a * b) & this.mask(bits);
      this.writeOperand({ type: 'reg', reg }, result, bits);
      // Simplified flags
      this.cpu.cf = false;
      this.cpu.of = false;
      return;
    }

    // MOVZX r, rm8 (0F B6)
    if (op2 === 0xB6) {
      const { reg, rm } = this.decodeModRM();
      const val = this.readOperand(rm, 8);
      if (this.rexW) this.cpu.setReg64(reg, val);
      else this.cpu.setReg32(reg, val);
      return;
    }

    // MOVZX r, rm16 (0F B7)
    if (op2 === 0xB7) {
      const { reg, rm } = this.decodeModRM();
      const val = this.readOperand(rm, 16);
      if (this.rexW) this.cpu.setReg64(reg, val);
      else this.cpu.setReg32(reg, val);
      return;
    }

    // MOVSX r, rm8 (0F BE)
    if (op2 === 0xBE) {
      const { reg, rm } = this.decodeModRM();
      const val = this.readOperand(rm, 8);
      const sext = this.signExtend(val, 8, this.rexW ? 64 : 32);
      if (this.rexW) this.cpu.setReg64(reg, sext);
      else this.cpu.setReg32(reg, sext);
      return;
    }

    // MOVSX r, rm16 (0F BF)
    if (op2 === 0xBF) {
      const { reg, rm } = this.decodeModRM();
      const val = this.readOperand(rm, 16);
      const sext = this.signExtend(val, 16, this.rexW ? 64 : 32);
      if (this.rexW) this.cpu.setReg64(reg, sext);
      else this.cpu.setReg32(reg, sext);
      return;
    }

    // NOP (0F 1F /0 — multi-byte NOP)
    if (op2 === 0x1F) {
      this.decodeModRM(); // consume but ignore
      return;
    }

    // UD2 (0F 0B) — invalid opcode (used as breakpoint/assert)
    if (op2 === 0x0B) {
      throw new Error('UD2: Undefined instruction at 0x' + (this.pos - 2n).toString(16));
    }

    // BSF (0F BC), BSR (0F BD) — bit scan forward/reverse
    if (op2 === 0xBC) {
      const { reg, rm } = this.decodeModRM();
      const val = this.readOperand(rm, bits);
      if (val === 0n) {
        this.cpu.zf = true;
      } else {
        this.cpu.zf = false;
        let bit = 0;
        let v = val;
        while ((v & 1n) === 0n) { v >>= 1n; bit++; }
        this.writeOperand({ type: 'reg', reg }, BigInt(bit), bits);
      }
      return;
    }
    if (op2 === 0xBD) {
      const { reg, rm } = this.decodeModRM();
      const val = this.readOperand(rm, bits);
      if (val === 0n) {
        this.cpu.zf = true;
      } else {
        this.cpu.zf = false;
        let bit = bits - 1;
        while (bit >= 0 && ((val >> BigInt(bit)) & 1n) === 0n) bit--;
        this.writeOperand({ type: 'reg', reg }, BigInt(bit), bits);
      }
      return;
    }

    throw new Error(`Unknown two-byte opcode: 0F ${op2.toString(16).padStart(2, '0')} at 0x${(this.pos - 2n).toString(16)}`);
  }
}
