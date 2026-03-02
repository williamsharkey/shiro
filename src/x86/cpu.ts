/**
 * x86-64 CPU State — all registers, flags, and segment bases.
 * Uses bigint for 64-bit values throughout.
 */

// RFLAGS bit positions
export const FLAG_CF = 0;   // Carry Flag
export const FLAG_PF = 2;   // Parity Flag
export const FLAG_AF = 4;   // Auxiliary Carry Flag
export const FLAG_ZF = 6;   // Zero Flag
export const FLAG_SF = 7;   // Sign Flag
export const FLAG_TF = 8;   // Trap Flag
export const FLAG_IF = 9;   // Interrupt Flag
export const FLAG_DF = 10;  // Direction Flag
export const FLAG_OF = 11;  // Overflow Flag

// Register indices (matching x86-64 encoding)
export const RAX = 0;
export const RCX = 1;
export const RDX = 2;
export const RBX = 3;
export const RSP = 4;
export const RBP = 5;
export const RSI = 6;
export const RDI = 7;
export const R8  = 8;
export const R9  = 9;
export const R10 = 10;
export const R11 = 11;
export const R12 = 12;
export const R13 = 13;
export const R14 = 14;
export const R15 = 15;

// Register names for debug output
export const REG_NAMES = [
  'rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
  'r8',  'r9',  'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
];

const MASK64 = 0xFFFFFFFFFFFFFFFFn;
const MASK32 = 0xFFFFFFFFn;
const MASK16 = 0xFFFFn;
const MASK8  = 0xFFn;

export class CPU {
  // 16 general-purpose 64-bit registers
  regs: BigInt64Array;

  // Instruction pointer
  rip: bigint = 0n;

  // RFLAGS register (only lower 32 bits used)
  rflags: number = 0x202; // IF set by default

  // Segment registers (stubs for userspace — all 0)
  cs = 0x33; ds = 0; es = 0; fs = 0; gs = 0; ss = 0x2b;

  // Segment bases (for TLS via arch_prctl)
  fsBase: bigint = 0n;
  gsBase: bigint = 0n;

  // Halted state
  halted = false;

  constructor() {
    this.regs = new BigInt64Array(16);
  }

  // Register accessors by index
  getReg64(idx: number): bigint {
    return BigInt.asUintN(64, this.regs[idx]);
  }

  setReg64(idx: number, val: bigint): void {
    this.regs[idx] = BigInt.asIntN(64, val);
  }

  getReg32(idx: number): bigint {
    return BigInt.asUintN(32, this.regs[idx]);
  }

  // Writing 32-bit zero-extends to 64 bits (x86-64 convention)
  setReg32(idx: number, val: bigint): void {
    this.regs[idx] = BigInt.asIntN(64, val & MASK32);
  }

  getReg16(idx: number): bigint {
    return BigInt.asUintN(16, this.regs[idx]);
  }

  setReg16(idx: number, val: bigint): void {
    const old = BigInt.asUintN(64, this.regs[idx]);
    this.regs[idx] = BigInt.asIntN(64, (old & ~MASK16) | (val & MASK16));
  }

  // 8-bit low byte (AL, CL, DL, BL, SPL, BPL, SIL, DIL, R8B-R15B)
  getReg8(idx: number): bigint {
    return BigInt.asUintN(8, this.regs[idx]);
  }

  setReg8(idx: number, val: bigint): void {
    const old = BigInt.asUintN(64, this.regs[idx]);
    this.regs[idx] = BigInt.asIntN(64, (old & ~MASK8) | (val & MASK8));
  }

  // 8-bit high byte (AH=4, CH=5, DH=6, BH=7) — only for legacy non-REX encodings
  getReg8High(idx: number): bigint {
    // idx 4=AH(reg0), 5=CH(reg1), 6=DH(reg2), 7=BH(reg3)
    const regIdx = idx - 4;
    return BigInt.asUintN(8, this.regs[regIdx] >> 8n);
  }

  setReg8High(idx: number, val: bigint): void {
    const regIdx = idx - 4;
    const old = BigInt.asUintN(64, this.regs[regIdx]);
    this.regs[regIdx] = BigInt.asIntN(64, (old & ~0xFF00n) | ((val & MASK8) << 8n));
  }

  // Flag helpers
  getFlag(bit: number): boolean {
    return (this.rflags & (1 << bit)) !== 0;
  }

  setFlag(bit: number, val: boolean): void {
    if (val) {
      this.rflags |= (1 << bit);
    } else {
      this.rflags &= ~(1 << bit);
    }
  }

  get cf(): boolean { return this.getFlag(FLAG_CF); }
  get pf(): boolean { return this.getFlag(FLAG_PF); }
  get af(): boolean { return this.getFlag(FLAG_AF); }
  get zf(): boolean { return this.getFlag(FLAG_ZF); }
  get sf(): boolean { return this.getFlag(FLAG_SF); }
  get of(): boolean { return this.getFlag(FLAG_OF); }
  get df(): boolean { return this.getFlag(FLAG_DF); }

  set cf(v: boolean) { this.setFlag(FLAG_CF, v); }
  set pf(v: boolean) { this.setFlag(FLAG_PF, v); }
  set af(v: boolean) { this.setFlag(FLAG_AF, v); }
  set zf(v: boolean) { this.setFlag(FLAG_ZF, v); }
  set sf(v: boolean) { this.setFlag(FLAG_SF, v); }
  set of(v: boolean) { this.setFlag(FLAG_OF, v); }
  set df(v: boolean) { this.setFlag(FLAG_DF, v); }

  /** Compute parity of low byte (set PF if even number of 1-bits) */
  static parity8(val: number): boolean {
    val ^= val >> 4;
    val ^= val >> 2;
    val ^= val >> 1;
    return (val & 1) === 0;
  }

  /** Set arithmetic flags for the result of an operation */
  setArithFlags(result: bigint, bits: number): void {
    const mask = bits === 64 ? MASK64 : bits === 32 ? MASK32 : bits === 16 ? MASK16 : MASK8;
    const signBit = 1n << BigInt(bits - 1);
    const masked = result & mask;

    this.zf = masked === 0n;
    this.sf = (masked & signBit) !== 0n;
    this.pf = CPU.parity8(Number(masked & 0xFFn));
  }

  /** Dump register state for debugging */
  dump(): string {
    const lines: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      const r1 = REG_NAMES[i].padEnd(4);
      const v1 = this.getReg64(i).toString(16).padStart(16, '0');
      const r2 = REG_NAMES[i + 1].padEnd(4);
      const v2 = this.getReg64(i + 1).toString(16).padStart(16, '0');
      lines.push(`${r1}= 0x${v1}  ${r2}= 0x${v2}`);
    }
    lines.push(`rip = 0x${this.rip.toString(16).padStart(16, '0')}  rflags= 0x${this.rflags.toString(16).padStart(8, '0')}`);
    lines.push(`flags: ${this.cf ? 'CF ' : ''}${this.zf ? 'ZF ' : ''}${this.sf ? 'SF ' : ''}${this.of ? 'OF ' : ''}${this.pf ? 'PF ' : ''}${this.af ? 'AF ' : ''}${this.df ? 'DF ' : ''}`);
    return lines.join('\n');
  }

  reset(): void {
    for (let i = 0; i < 16; i++) this.regs[i] = 0n;
    this.rip = 0n;
    this.rflags = 0x202;
    this.halted = false;
    this.fsBase = 0n;
    this.gsBase = 0n;
  }
}
