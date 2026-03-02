import { describe, it, expect, beforeEach } from 'vitest';
import { CPU, RAX, RCX, RDX, RBX, RSP, RBP, RSI, RDI, R8 } from '@shiro/x86/cpu';
import { VirtualMemory } from '@shiro/x86/memory';
import { Decoder, X86ExitSignal } from '@shiro/x86/decode';
import { parseElf64, loadElf } from '@shiro/x86/elf';
import { LinuxSyscalls, X86Exit } from '@shiro/x86/syscalls';
import { createTestShell, run } from './helpers';

// ─── Helper: build minimal ELF64 binary ─────────────────────────────────────

/**
 * Build a minimal static ELF64 x86-64 binary from raw code bytes.
 * The code is placed at vaddr 0x400000 (standard Linux text segment).
 * A stack is set up by the loader at high addresses.
 */
function buildElf64(code: Uint8Array): Uint8Array {
  const textVaddr = 0x400000;
  const entryPoint = textVaddr;

  // ELF64 header (64 bytes)
  const ehdr = new Uint8Array(64);
  const ev = new DataView(ehdr.buffer);

  // Magic
  ehdr[0] = 0x7f; ehdr[1] = 0x45; ehdr[2] = 0x4c; ehdr[3] = 0x46;
  ehdr[4] = 2;    // ELFCLASS64
  ehdr[5] = 1;    // ELFDATA2LSB
  ehdr[6] = 1;    // EV_CURRENT
  ehdr[7] = 0;    // ELFOSABI_NONE

  ev.setUint16(16, 2, true);   // e_type = ET_EXEC
  ev.setUint16(18, 62, true);  // e_machine = EM_X86_64
  ev.setUint32(20, 1, true);   // e_version = EV_CURRENT

  // e_entry (8 bytes at offset 24)
  ev.setUint32(24, entryPoint & 0xFFFFFFFF, true);
  ev.setUint32(28, 0, true);

  // e_phoff (8 bytes at offset 32) — program header offset = 64 (right after ehdr)
  ev.setUint32(32, 64, true);
  ev.setUint32(36, 0, true);

  // e_shoff = 0 (no section headers)
  ev.setUint16(52, 64, true);    // e_ehsize
  ev.setUint16(54, 56, true);    // e_phentsize
  ev.setUint16(56, 1, true);     // e_phnum = 1

  // Program header (56 bytes) — PT_LOAD
  const phdr = new Uint8Array(56);
  const pv = new DataView(phdr.buffer);

  pv.setUint32(0, 1, true);      // p_type = PT_LOAD
  pv.setUint32(4, 5, true);      // p_flags = PF_R | PF_X

  // p_offset = 120 (ehdr + phdr = 64 + 56)
  const dataOffset = 64 + 56;
  pv.setUint32(8, dataOffset, true);
  pv.setUint32(12, 0, true);

  // p_vaddr
  pv.setUint32(16, textVaddr & 0xFFFFFFFF, true);
  pv.setUint32(20, 0, true);

  // p_paddr (same as vaddr)
  pv.setUint32(24, textVaddr & 0xFFFFFFFF, true);
  pv.setUint32(28, 0, true);

  // p_filesz
  pv.setUint32(32, code.length, true);
  pv.setUint32(36, 0, true);

  // p_memsz
  pv.setUint32(40, code.length, true);
  pv.setUint32(44, 0, true);

  // p_align
  pv.setUint32(48, 0x1000, true);
  pv.setUint32(52, 0, true);

  // Combine: ehdr + phdr + code
  const result = new Uint8Array(dataOffset + code.length);
  result.set(ehdr, 0);
  result.set(phdr, 64);
  result.set(code, dataOffset);
  return result;
}

// ─── CPU Tests ──────────────────────────────────────────────────────────────

describe('x86-64 CPU', () => {
  let cpu: CPU;

  beforeEach(() => {
    cpu = new CPU();
  });

  it('registers start at zero', () => {
    expect(cpu.getReg64(RAX)).toBe(0n);
    expect(cpu.getReg64(RSP)).toBe(0n);
    expect(cpu.getReg64(RDI)).toBe(0n);
  });

  it('setReg64/getReg64 roundtrips', () => {
    cpu.setReg64(RAX, 0xDEADBEEFCAFEBABEn);
    expect(cpu.getReg64(RAX)).toBe(0xDEADBEEFCAFEBABEn);
  });

  it('setReg32 zero-extends to 64', () => {
    cpu.setReg64(RAX, 0xFFFFFFFFFFFFFFFFn);
    cpu.setReg32(RAX, 0x12345678n);
    expect(cpu.getReg64(RAX)).toBe(0x12345678n);
  });

  it('setReg16 preserves upper bits', () => {
    cpu.setReg64(RAX, 0xDEADBEEF00000000n);
    cpu.setReg16(RAX, 0x1234n);
    expect(cpu.getReg64(RAX)).toBe(0xDEADBEEF00001234n);
  });

  it('setReg8 preserves upper bits', () => {
    cpu.setReg64(RAX, 0xDEADBEEF00001200n);
    cpu.setReg8(RAX, 0x34n);
    expect(cpu.getReg64(RAX)).toBe(0xDEADBEEF00001234n);
  });

  it('flag getters/setters work', () => {
    cpu.cf = true;
    expect(cpu.cf).toBe(true);
    cpu.cf = false;
    expect(cpu.cf).toBe(false);

    cpu.zf = true;
    expect(cpu.zf).toBe(true);
    cpu.sf = true;
    expect(cpu.sf).toBe(true);
    cpu.of = true;
    expect(cpu.of).toBe(true);
  });

  it('parity8 works', () => {
    expect(CPU.parity8(0)).toBe(true);    // 0 bits set → even
    expect(CPU.parity8(1)).toBe(false);   // 1 bit set → odd
    expect(CPU.parity8(3)).toBe(true);    // 2 bits set → even
    expect(CPU.parity8(0xFF)).toBe(true); // 8 bits set → even
  });

  it('dump() returns register state', () => {
    cpu.setReg64(RAX, 42n);
    const dump = cpu.dump();
    expect(dump).toContain('rax');
    expect(dump).toContain('rip');
  });
});

// ─── Virtual Memory Tests ───────────────────────────────────────────────────

describe('x86-64 Virtual Memory', () => {
  let mem: VirtualMemory;

  beforeEach(() => {
    mem = new VirtualMemory();
  });

  it('read/write single bytes', () => {
    mem.write8(0x1000n, 0x42);
    expect(mem.read8(0x1000n)).toBe(0x42);
  });

  it('read/write 16-bit values', () => {
    mem.write16(0x2000n, 0x1234);
    expect(mem.read16(0x2000n)).toBe(0x1234);
    // Check little-endian
    expect(mem.read8(0x2000n)).toBe(0x34);
    expect(mem.read8(0x2001n)).toBe(0x12);
  });

  it('read/write 32-bit values', () => {
    mem.write32(0x3000n, 0xDEADBEEF);
    expect(mem.read32(0x3000n)).toBe(0xDEADBEEF);
  });

  it('read/write 64-bit values', () => {
    mem.write64(0x4000n, 0xDEADBEEFCAFEBABEn);
    expect(mem.read64(0x4000n)).toBe(0xDEADBEEFCAFEBABEn);
  });

  it('readString/writeString', () => {
    mem.writeString(0x5000n, 'Hello');
    expect(mem.readString(0x5000n)).toBe('Hello');
  });

  it('loadSegment loads data and zeroes BSS', () => {
    const data = new Uint8Array([1, 2, 3]);
    mem.loadSegment(0x6000n, data, 6); // memsz=6 > filesz=3
    expect(mem.read8(0x6000n)).toBe(1);
    expect(mem.read8(0x6001n)).toBe(2);
    expect(mem.read8(0x6002n)).toBe(3);
    expect(mem.read8(0x6003n)).toBe(0); // BSS
    expect(mem.read8(0x6004n)).toBe(0);
    expect(mem.read8(0x6005n)).toBe(0);
  });

  it('demand-allocates pages', () => {
    expect(mem.getAllocatedBytes()).toBe(0);
    mem.write8(0x100000n, 1);
    expect(mem.getAllocatedBytes()).toBe(4096);
  });

  it('cross-page reads work', () => {
    // Write a 32-bit value that straddles a page boundary
    const boundary = 0xFFEn; // page boundary at 0x1000
    mem.write32(boundary, 0x04030201);
    expect(mem.read8(boundary)).toBe(0x01);
    expect(mem.read8(boundary + 1n)).toBe(0x02);
    expect(mem.read8(boundary + 2n)).toBe(0x03);
    expect(mem.read8(boundary + 3n)).toBe(0x04);
    expect(mem.read32(boundary)).toBe(0x04030201);
  });
});

// ─── ELF64 Parser Tests ─────────────────────────────────────────────────────

describe('ELF64 Parser', () => {
  it('parses a valid ELF64 header', () => {
    // Minimal NOP program: just a NOP followed by exit syscall
    const code = new Uint8Array([
      0x90,                               // NOP
      0x48, 0xc7, 0xc0, 0x3c, 0x00, 0x00, 0x00, // mov rax, 60 (exit)
      0x48, 0x31, 0xff,                   // xor rdi, rdi (exit code 0)
      0x0f, 0x05,                         // syscall
    ]);
    const elf = buildElf64(code);
    const info = parseElf64(elf);

    expect(info.entryPoint).toBe(0x400000n);
    expect(info.machine).toBe(62); // EM_X86_64
    expect(info.elfClass).toBe(2);  // ELFCLASS64
    expect(info.isStaticLinked).toBe(true);
    expect(info.programHeaders.length).toBe(1);
    expect(info.programHeaders[0].type).toBe(1); // PT_LOAD
  });

  it('rejects non-ELF files', () => {
    expect(() => parseElf64(new Uint8Array([0, 0, 0, 0]))).toThrow('Not a valid ELF');
  });

  it('loadElf sets up CPU state', () => {
    const code = new Uint8Array([0x90]); // NOP
    const elf = buildElf64(code);
    const cpu = new CPU();
    const mem = new VirtualMemory();

    loadElf(elf, mem, cpu, ['test'], []);

    expect(cpu.rip).toBe(0x400000n);
    expect(cpu.getReg64(RSP)).not.toBe(0n); // Stack set up
    // argc should be on top of stack
    expect(mem.read64(cpu.getReg64(RSP))).toBe(1n); // argc = 1
  });
});

// ─── Instruction Decoder Tests ──────────────────────────────────────────────

describe('x86-64 Decoder', () => {
  let cpu: CPU;
  let mem: VirtualMemory;
  let dec: Decoder;

  beforeEach(() => {
    cpu = new CPU();
    mem = new VirtualMemory();
    dec = new Decoder(cpu, mem);
    // Set up a small stack
    cpu.setReg64(RSP, 0x7FFF0000n);
    mem.allocatePages(0x7FFE0000n, 8); // 32KB stack
  });

  /** Write code at addr 0x1000 and set RIP there */
  function loadCode(bytes: number[]): void {
    const base = 0x1000n;
    for (let i = 0; i < bytes.length; i++) {
      mem.write8(base + BigInt(i), bytes[i]);
    }
    cpu.rip = base;
  }

  it('NOP advances RIP by 1', () => {
    loadCode([0x90]);
    dec.step();
    expect(cpu.rip).toBe(0x1001n);
  });

  it('MOV r64, imm64 (REX.W + B8)', () => {
    // movabs rax, 0x0123456789ABCDEF
    // REX.W = 0x48, opcode B8+0 = B8
    loadCode([0x48, 0xB8, 0xEF, 0xCD, 0xAB, 0x89, 0x67, 0x45, 0x23, 0x01]);
    dec.step();
    expect(cpu.getReg64(RAX)).toBe(0x0123456789ABCDEFn);
  });

  it('MOV r32, imm32 (B8+reg)', () => {
    // mov ecx, 0x42
    loadCode([0xB9, 0x42, 0x00, 0x00, 0x00]);
    dec.step();
    expect(cpu.getReg32(RCX)).toBe(0x42n);
  });

  it('ADD r64, r64', () => {
    cpu.setReg64(RAX, 10n);
    cpu.setReg64(RCX, 20n);
    // add rax, rcx → 48 01 C8 (REX.W ADD r/m64, r64)
    loadCode([0x48, 0x01, 0xC8]);
    dec.step();
    expect(cpu.getReg64(RAX)).toBe(30n);
  });

  it('SUB sets flags correctly', () => {
    cpu.setReg64(RAX, 5n);
    // sub eax, 5 → 83 E8 05
    loadCode([0x83, 0xE8, 0x05]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(0n);
    expect(cpu.zf).toBe(true);
    expect(cpu.cf).toBe(false);
  });

  it('CMP sets flags without modifying operand', () => {
    cpu.setReg64(RAX, 10n);
    // cmp eax, 10 → 83 F8 0A
    loadCode([0x83, 0xF8, 0x0A]);
    dec.step();
    expect(cpu.getReg64(RAX)).toBe(10n); // unchanged
    expect(cpu.zf).toBe(true);
  });

  it('XOR r64, r64 (zero register)', () => {
    cpu.setReg64(RDI, 0xFFn);
    // xor rdi, rdi → 48 31 FF
    loadCode([0x48, 0x31, 0xFF]);
    dec.step();
    expect(cpu.getReg64(RDI)).toBe(0n);
    expect(cpu.zf).toBe(true);
  });

  it('TEST r64, r64', () => {
    cpu.setReg64(RAX, 0n);
    // test rax, rax → 48 85 C0
    loadCode([0x48, 0x85, 0xC0]);
    dec.step();
    expect(cpu.zf).toBe(true);

    cpu.setReg64(RAX, 1n);
    loadCode([0x48, 0x85, 0xC0]);
    dec.step();
    expect(cpu.zf).toBe(false);
  });

  it('PUSH/POP r64', () => {
    const sp0 = cpu.getReg64(RSP);
    cpu.setReg64(RAX, 0x42n);
    // push rax (50), pop rcx (59)
    loadCode([0x50, 0x59]);
    dec.step();
    expect(cpu.getReg64(RSP)).toBe(sp0 - 8n);
    dec.step();
    expect(cpu.getReg64(RCX)).toBe(0x42n);
    expect(cpu.getReg64(RSP)).toBe(sp0);
  });

  it('JMP rel8', () => {
    // jmp +5 → EB 05
    loadCode([0xEB, 0x05]);
    dec.step();
    expect(cpu.rip).toBe(0x1002n + 5n); // base + 2 (instruction length) + 5
  });

  it('JE (ZF=1) takes branch', () => {
    cpu.zf = true;
    // je +3 → 74 03
    loadCode([0x74, 0x03]);
    dec.step();
    expect(cpu.rip).toBe(0x1002n + 3n);
  });

  it('JE (ZF=0) falls through', () => {
    cpu.zf = false;
    // je +3 → 74 03
    loadCode([0x74, 0x03]);
    dec.step();
    expect(cpu.rip).toBe(0x1002n);
  });

  it('JNE (ZF=0) takes branch', () => {
    cpu.zf = false;
    // jne +10 → 75 0A
    loadCode([0x75, 0x0A]);
    dec.step();
    expect(cpu.rip).toBe(0x1002n + 10n);
  });

  it('CALL/RET', () => {
    const sp0 = cpu.getReg64(RSP);
    // call +5 → E8 05 00 00 00
    loadCode([0xE8, 0x05, 0x00, 0x00, 0x00]);

    dec.step();
    // RIP should be at 0x1005 + 5 = 0x100A
    expect(cpu.rip).toBe(0x100An);
    // Return address (0x1005) should be on stack
    expect(mem.read64(cpu.getReg64(RSP))).toBe(0x1005n);
    expect(cpu.getReg64(RSP)).toBe(sp0 - 8n);

    // Put a RET at the target
    mem.write8(0x100An, 0xC3);
    dec.step();
    expect(cpu.rip).toBe(0x1005n);
    expect(cpu.getReg64(RSP)).toBe(sp0);
  });

  it('LEA r64, [rip+disp32]', () => {
    // lea rax, [rip+0x10] → 48 8D 05 10 00 00 00
    loadCode([0x48, 0x8D, 0x05, 0x10, 0x00, 0x00, 0x00]);
    dec.step();
    // RIP after reading instruction = 0x1007, addr = 0x1007 + 0x10 = 0x1017
    expect(cpu.getReg64(RAX)).toBe(0x1017n);
  });

  it('MOV [mem], r64 and MOV r64, [mem]', () => {
    cpu.setReg64(RAX, 0x42n);
    cpu.setReg64(RBX, 0x2000n);
    // mov [rbx], rax → 48 89 03
    loadCode([0x48, 0x89, 0x03]);
    dec.step();
    expect(mem.read64(0x2000n)).toBe(0x42n);

    // mov rcx, [rbx] → 48 8B 0B
    loadCode([0x48, 0x8B, 0x0B]);
    dec.step();
    expect(cpu.getReg64(RCX)).toBe(0x42n);
  });

  it('SHL/SHR', () => {
    cpu.setReg64(RAX, 1n);
    // shl eax, 4 → C1 E0 04
    loadCode([0xC1, 0xE0, 0x04]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(16n);

    // shr eax, 2 → C1 E8 02
    loadCode([0xC1, 0xE8, 0x02]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(4n);
  });

  it('INC/DEC via Group 5 (FF /0 and FF /1)', () => {
    cpu.setReg64(RAX, 10n);
    // inc eax → FF C0
    loadCode([0xFF, 0xC0]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(11n);

    // dec eax → FF C8
    loadCode([0xFF, 0xC8]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(10n);
  });

  it('NEG', () => {
    cpu.setReg32(RAX, 5n);
    // neg eax → F7 D8
    loadCode([0xF7, 0xD8]);
    dec.step();
    // -5 in 32-bit = 0xFFFFFFFB
    expect(cpu.getReg32(RAX)).toBe(0xFFFFFFFBn);
  });

  it('NOT', () => {
    cpu.setReg32(RAX, 0n);
    // not eax → F7 D0
    loadCode([0xF7, 0xD0]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(0xFFFFFFFFn);
  });

  it('MOVZX r32, r/m8', () => {
    cpu.setReg64(RCX, 0xFFn);
    // movzx eax, cl → 0F B6 C1
    loadCode([0x0F, 0xB6, 0xC1]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(0xFFn);
    expect(cpu.getReg64(RAX)).toBe(0xFFn); // zero-extended to 64
  });

  it('MOVSX r32, r/m8', () => {
    cpu.setReg64(RCX, 0x80n); // -128 as signed byte
    // movsx eax, cl → 0F BE C1
    loadCode([0x0F, 0xBE, 0xC1]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(0xFFFFFF80n); // sign-extended
  });

  it('MOVSXD r64, r/m32', () => {
    cpu.setReg32(RCX, 0xFFFFFFFFn); // -1 as signed dword
    // movsxd rax, ecx → 48 63 C1
    loadCode([0x48, 0x63, 0xC1]);
    dec.step();
    expect(cpu.getReg64(RAX)).toBe(0xFFFFFFFFFFFFFFFFn); // sign-extended
  });

  it('CDQ sign-extends EAX to EDX:EAX', () => {
    cpu.setReg32(RAX, 0x80000000n); // negative
    // cdq → 99
    loadCode([0x99]);
    dec.step();
    expect(cpu.getReg32(RDX)).toBe(0xFFFFFFFFn);
  });

  it('CQO sign-extends RAX to RDX:RAX', () => {
    cpu.setReg64(RAX, 0x8000000000000000n);
    // REX.W cqo → 48 99
    loadCode([0x48, 0x99]);
    dec.step();
    expect(cpu.getReg64(RDX)).toBe(0xFFFFFFFFFFFFFFFFn);
  });

  it('SETcc sets byte based on condition', () => {
    cpu.zf = true;
    cpu.setReg64(RAX, 0n);
    // sete al → 0F 94 C0
    loadCode([0x0F, 0x94, 0xC0]);
    dec.step();
    expect(cpu.getReg8(RAX)).toBe(1n);

    cpu.zf = false;
    loadCode([0x0F, 0x94, 0xC0]);
    dec.step();
    expect(cpu.getReg8(RAX)).toBe(0n);
  });

  it('CMOVcc moves only when condition is true', () => {
    cpu.setReg64(RAX, 0n);
    cpu.setReg64(RCX, 42n);
    cpu.zf = true;
    // cmove eax, ecx → 0F 44 C1
    loadCode([0x0F, 0x44, 0xC1]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(42n);

    cpu.setReg64(RAX, 0n);
    cpu.zf = false;
    loadCode([0x0F, 0x44, 0xC1]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(0n); // not moved
  });

  it('REP STOSB fills memory', () => {
    cpu.setReg64(RDI, 0x3000n);
    cpu.setReg64(RCX, 5n);
    cpu.setReg8(RAX, 0x41n); // 'A'
    cpu.df = false;
    // rep stosb → F3 AA
    loadCode([0xF3, 0xAA]);
    dec.step();

    expect(mem.read8(0x3000n)).toBe(0x41);
    expect(mem.read8(0x3001n)).toBe(0x41);
    expect(mem.read8(0x3004n)).toBe(0x41);
    expect(cpu.getReg64(RCX)).toBe(0n);
    expect(cpu.getReg64(RDI)).toBe(0x3005n);
  });

  it('REP MOVSB copies memory', () => {
    // Set up source data
    mem.writeString(0x4000n, 'Hello');
    cpu.setReg64(RSI, 0x4000n);
    cpu.setReg64(RDI, 0x5000n);
    cpu.setReg64(RCX, 5n);
    cpu.df = false;
    // rep movsb → F3 A4
    loadCode([0xF3, 0xA4]);
    dec.step();

    expect(mem.readString(0x5000n, 5)).toBe('Hello');
    expect(cpu.getReg64(RCX)).toBe(0n);
  });

  it('LEAVE restores RSP and RBP', () => {
    // Set up frame
    const savedBP = 0x6000n;
    cpu.setReg64(RBP, 0x7000n);
    // Write saved RBP at top of current frame
    mem.write64(0x7000n, savedBP);
    cpu.setReg64(RSP, 0x6FF0n);

    // leave → C9
    loadCode([0xC9]);
    dec.step();
    expect(cpu.getReg64(RSP)).toBe(0x7008n); // RBP + 8 (after pop)
    expect(cpu.getReg64(RBP)).toBe(savedBP);
  });

  it('IMUL r, rm (two operand)', () => {
    cpu.setReg64(RAX, 7n);
    cpu.setReg64(RCX, 6n);
    // imul eax, ecx → 0F AF C1
    loadCode([0x0F, 0xAF, 0xC1]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(42n);
  });

  it('SYSCALL is detected', () => {
    let syscallCalled = false;
    dec.onSyscall = () => { syscallCalled = true; };
    // syscall → 0F 05
    loadCode([0x0F, 0x05]);
    dec.step();
    expect(syscallCalled).toBe(true);
  });
});

// ─── Integration Test: Hello World ELF ──────────────────────────────────────

describe('x86-64 Hello World', () => {
  it('executes a hand-crafted hello world ELF', async () => {
    const { fs, shell } = await createTestShell();

    // Hand-assemble: write(1, msg, 14); exit(0);
    // _start:
    //   mov rdi, 1          → 48 C7 C7 01 00 00 00
    //   lea rsi, [rip+msg]  → 48 8D 35 XX XX XX XX  (disp = offset to msg from next instruction)
    //   mov rdx, 14         → 48 C7 C2 0E 00 00 00
    //   mov rax, 1          → 48 C7 C0 01 00 00 00
    //   syscall             → 0F 05
    //   mov rdi, 0          → 48 C7 C7 00 00 00 00
    //   mov rax, 60         → 48 C7 C0 3C 00 00 00
    //   syscall             → 0F 05
    // msg: db "Hello, World!\n"

    const msg = new TextEncoder().encode("Hello, World!\n");
    // Code layout:
    // 0x00: mov rdi, 1       (7 bytes)
    // 0x07: lea rsi, [rip+X] (7 bytes) → RIP after = 0x0E, msg at 0x28, disp = 0x1A
    // 0x0E: mov rdx, 14      (7 bytes)
    // 0x15: mov rax, 1       (7 bytes)
    // 0x1C: syscall           (2 bytes)
    // 0x1E: mov rdi, 0       (7 bytes)
    // 0x25: mov rax, 60      (7 bytes)
    // 0x2C: syscall           (2 bytes)
    // 0x2E: msg data         (14 bytes)

    const disp = 0x2E - 0x0E; // = 0x20
    const code = new Uint8Array([
      // mov rdi, 1
      0x48, 0xC7, 0xC7, 0x01, 0x00, 0x00, 0x00,
      // lea rsi, [rip+0x20]
      0x48, 0x8D, 0x35, disp, 0x00, 0x00, 0x00,
      // mov rdx, 14
      0x48, 0xC7, 0xC2, 0x0E, 0x00, 0x00, 0x00,
      // mov rax, 1 (sys_write)
      0x48, 0xC7, 0xC0, 0x01, 0x00, 0x00, 0x00,
      // syscall
      0x0F, 0x05,
      // mov rdi, 0
      0x48, 0xC7, 0xC7, 0x00, 0x00, 0x00, 0x00,
      // mov rax, 60 (sys_exit)
      0x48, 0xC7, 0xC0, 0x3C, 0x00, 0x00, 0x00,
      // syscall
      0x0F, 0x05,
      // msg: "Hello, World!\n"
      ...msg,
    ]);

    const elf = buildElf64(code);

    // Write ELF to filesystem as binary
    // The filesystem stores strings, but we need raw bytes for ELF
    // We'll use the x86 runtime directly instead
    const { CPU: CPUClass } = await import('@shiro/x86/cpu');
    const { VirtualMemory: VMClass } = await import('@shiro/x86/memory');
    const { Decoder: DecoderClass } = await import('@shiro/x86/decode');
    const { loadElf: loadElfFn } = await import('@shiro/x86/elf');
    const { LinuxSyscalls: SyscallsClass, X86Exit: X86ExitClass } = await import('@shiro/x86/syscalls');

    const cpu = new CPUClass();
    const mem = new VMClass();
    const decoder = new DecoderClass(cpu, mem);

    loadElfFn(elf, mem, cpu, ['hello'], []);

    let output = '';
    const syscalls = new SyscallsClass(
      cpu, mem, fs, '/home/user',
      (s: string) => { output += s; },
      (s: string) => {},
      '',
    );

    decoder.onSyscall = () => {
      (decoder as any)._pendingSyscall = true;
    };

    let exitCode = -1;
    for (let i = 0; i < 1000; i++) {
      (decoder as any)._pendingSyscall = false;
      try {
        decoder.step();
        if ((decoder as any)._pendingSyscall) {
          await syscalls.handleSyscall();
        }
      } catch (e: any) {
        if (e instanceof X86ExitClass) {
          exitCode = e.code;
          break;
        }
        throw e;
      }
    }

    expect(output).toBe("Hello, World!\n");
    expect(exitCode).toBe(0);
  });
});

// ─── Syscall Tests ──────────────────────────────────────────────────────────

describe('x86-64 Syscalls', () => {
  let cpu: CPU;
  let mem: VirtualMemory;

  beforeEach(() => {
    cpu = new CPU();
    mem = new VirtualMemory();
  });

  it('sys_write outputs to stdout', async () => {
    const { fs } = await createTestShell();
    let output = '';
    const sc = new LinuxSyscalls(cpu, mem, fs, '/', s => { output += s; }, () => {}, '');

    // Write "Hi" to fd 1
    mem.writeString(0x1000n, 'Hi');
    cpu.setReg64(RAX, 1n);  // sys_write
    cpu.setReg64(RDI, 1n);  // fd = stdout
    cpu.setReg64(RSI, 0x1000n);
    cpu.setReg64(RDX, 2n);  // length

    await sc.handleSyscall();
    expect(output).toBe('Hi');
    expect(cpu.getReg64(RAX)).toBe(2n); // bytes written
  });

  it('sys_exit throws X86Exit', async () => {
    const { fs } = await createTestShell();
    const sc = new LinuxSyscalls(cpu, mem, fs, '/', () => {}, () => {}, '');

    cpu.setReg64(RAX, 60n);  // sys_exit
    cpu.setReg64(RDI, 42n);  // exit code

    await expect(sc.handleSyscall()).rejects.toBeInstanceOf(X86Exit);
  });

  it('sys_brk manages heap', async () => {
    const { fs } = await createTestShell();
    const sc = new LinuxSyscalls(cpu, mem, fs, '/', () => {}, () => {}, '');

    // brk(0) returns current break
    cpu.setReg64(RAX, 12n);
    cpu.setReg64(RDI, 0n);
    await sc.handleSyscall();
    const currentBrk = cpu.getReg64(RAX);
    expect(currentBrk).not.toBe(0n);

    // brk(current + 4096) extends heap
    cpu.setReg64(RAX, 12n);
    cpu.setReg64(RDI, currentBrk + 4096n);
    await sc.handleSyscall();
    expect(cpu.getReg64(RAX)).toBe(currentBrk + 4096n);
  });

  it('sys_uname fills struct', async () => {
    const { fs } = await createTestShell();
    const sc = new LinuxSyscalls(cpu, mem, fs, '/', () => {}, () => {}, '');

    mem.allocatePages(0x2000n, 2);
    cpu.setReg64(RAX, 63n);
    cpu.setReg64(RDI, 0x2000n);
    await sc.handleSyscall();

    expect(mem.readString(0x2000n)).toBe('Linux');
    expect(mem.readString(0x2000n + 65n)).toBe('shiro');
  });
});

// ─── Phase 2 Tests ──────────────────────────────────────────────────────────

describe('x86-64 FS/GS Segment Override', () => {
  let cpu: CPU;
  let mem: VirtualMemory;
  let dec: Decoder;

  beforeEach(() => {
    cpu = new CPU();
    mem = new VirtualMemory();
    dec = new Decoder(cpu, mem);
    cpu.setReg64(RSP, 0x7FFF0000n);
    mem.allocatePages(0x7FFE0000n, 8);
  });

  function loadCode(bytes: number[]): void {
    const base = 0x1000n;
    for (let i = 0; i < bytes.length; i++) {
      mem.write8(base + BigInt(i), bytes[i]);
    }
    cpu.rip = base;
  }

  it('MOV rax, fs:[0x10] reads from fsBase+0x10', () => {
    cpu.fsBase = 0x5000n;
    mem.write64(0x5010n, 0xDEADBEEFn);
    // mov rax, fs:[0x10] → 64 48 8B 04 25 10 00 00 00
    // Actually: FS prefix (0x64) + REX.W (0x48) + MOV r, rm (0x8B) + ModR/M for [disp32]
    // ModR/M = 04 (SIB follows, mod=00), SIB = 25 (no index, no base = disp32)
    loadCode([0x64, 0x48, 0x8B, 0x04, 0x25, 0x10, 0x00, 0x00, 0x00]);
    dec.step();
    expect(cpu.getReg64(RAX)).toBe(0xDEADBEEFn);
  });

  it('MOV rax, gs:[rbx] reads from gsBase+rbx', () => {
    cpu.gsBase = 0x6000n;
    cpu.setReg64(RBX, 0x20n);
    mem.write64(0x6020n, 0xCAFEBABEn);
    // gs: (0x65) + REX.W (0x48) + MOV r, rm (0x8B) + ModR/M=03 (rax, [rbx])
    loadCode([0x65, 0x48, 0x8B, 0x03]);
    dec.step();
    expect(cpu.getReg64(RAX)).toBe(0xCAFEBABEn);
  });
});

describe('x86-64 Auxiliary Vector', () => {
  it('loadElf places auxv on stack with AT_PAGESZ=4096', () => {
    const code = new Uint8Array([0x90]); // NOP
    const elf = buildElf64(code);
    const cpu = new CPU();
    const mem = new VirtualMemory();

    loadElf(elf, mem, cpu, ['test'], []);

    // Walk the stack: argc, argv[0], NULL, envp NULL, then auxv
    let sp = cpu.getReg64(RSP);
    const argc = Number(mem.read64(sp));
    sp += 8n; // skip argc
    // Skip argv pointers + NULL
    for (let i = 0; i <= argc; i++) sp += 8n;
    // Skip envp NULL
    sp += 8n;

    // Now at auxv — search for AT_PAGESZ (type 6)
    let foundPageSz = false;
    for (let i = 0; i < 20; i++) {
      const type = Number(mem.read64(sp));
      const val = mem.read64(sp + 8n);
      if (type === 0) break; // AT_NULL
      if (type === 6) { // AT_PAGESZ
        expect(val).toBe(4096n);
        foundPageSz = true;
      }
      sp += 16n;
    }
    expect(foundPageSz).toBe(true);
  });

  it('loadElf places AT_ENTRY with correct entry point', () => {
    const code = new Uint8Array([0x90]);
    const elf = buildElf64(code);
    const cpu = new CPU();
    const mem = new VirtualMemory();

    loadElf(elf, mem, cpu, ['test'], []);

    let sp = cpu.getReg64(RSP);
    const argc = Number(mem.read64(sp));
    sp += 8n;
    for (let i = 0; i <= argc; i++) sp += 8n;
    sp += 8n;

    let foundEntry = false;
    for (let i = 0; i < 20; i++) {
      const type = Number(mem.read64(sp));
      const val = mem.read64(sp + 8n);
      if (type === 0) break;
      if (type === 9) { // AT_ENTRY
        expect(val).toBe(0x400000n);
        foundEntry = true;
      }
      sp += 16n;
    }
    expect(foundEntry).toBe(true);
  });
});

describe('x86-64 writev syscall', () => {
  it('writev concatenates iovecs to stdout', async () => {
    const cpu = new CPU();
    const mem = new VirtualMemory();
    const { fs } = await createTestShell();
    let output = '';
    const sc = new LinuxSyscalls(cpu, mem, fs, '/', s => { output += s; }, () => {}, '');

    // Write two strings into memory
    mem.writeString(0x2000n, 'Hello');
    mem.writeString(0x2010n, ' World');

    // Build iovec array at 0x3000: {ptr, len} × 2
    mem.write64(0x3000n, 0x2000n); // iov[0].iov_base
    mem.write64(0x3008n, 5n);      // iov[0].iov_len
    mem.write64(0x3010n, 0x2010n); // iov[1].iov_base
    mem.write64(0x3018n, 6n);      // iov[1].iov_len

    cpu.setReg64(RAX, 20n);     // sys_writev
    cpu.setReg64(RDI, 1n);      // fd = stdout
    cpu.setReg64(RSI, 0x3000n); // iov
    cpu.setReg64(RDX, 2n);      // iovcnt

    await sc.handleSyscall();
    expect(output).toBe('Hello World');
    expect(cpu.getReg64(RAX)).toBe(11n);
  });
});

describe('x86-64 getrandom syscall', () => {
  it('getrandom fills buffer with random bytes', async () => {
    const cpu = new CPU();
    const mem = new VirtualMemory();
    const { fs } = await createTestShell();
    const sc = new LinuxSyscalls(cpu, mem, fs, '/', () => {}, () => {}, '');

    mem.allocatePages(0x4000n, 1);
    cpu.setReg64(RAX, 318n);    // sys_getrandom
    cpu.setReg64(RDI, 0x4000n); // buf
    cpu.setReg64(RSI, 16n);     // buflen
    cpu.setReg64(RDX, 0n);      // flags

    await sc.handleSyscall();
    expect(cpu.getReg64(RAX)).toBe(16n);
    // At least some bytes should be non-zero (extremely unlikely all 16 are 0)
    let nonZero = false;
    for (let i = 0; i < 16; i++) {
      if (mem.read8(0x4000n + BigInt(i)) !== 0) nonZero = true;
    }
    expect(nonZero).toBe(true);
  });
});

// ─── Sprint 2 Tests: New Instructions ────────────────────────────────────────

describe('x86-64 Sprint 2 Instructions', () => {
  let cpu: CPU;
  let mem: VirtualMemory;
  let dec: Decoder;

  beforeEach(() => {
    cpu = new CPU();
    mem = new VirtualMemory();
    dec = new Decoder(cpu, mem);
    cpu.setReg64(RSP, 0x7FFF0000n);
    mem.allocatePages(0x7FFE0000n, 8);
  });

  function loadCode(bytes: number[]): void {
    const base = 0x1000n;
    for (let i = 0; i < bytes.length; i++) {
      mem.write8(base + BigInt(i), bytes[i]);
    }
    cpu.rip = base;
  }

  it('REPE CMPSB with equal strings', () => {
    mem.writeString(0x3000n, 'ABCDE');
    mem.writeString(0x4000n, 'ABCDE');
    cpu.setReg64(RSI, 0x3000n);
    cpu.setReg64(RDI, 0x4000n);
    cpu.setReg64(RCX, 5n);
    cpu.df = false;
    // repe cmpsb → F3 A6
    loadCode([0xF3, 0xA6]);
    dec.step();
    expect(cpu.getReg64(RCX)).toBe(0n);
    expect(cpu.zf).toBe(true);
  });

  it('REPE CMPSB with unequal strings', () => {
    mem.writeString(0x3000n, 'ABXDE');
    mem.writeString(0x4000n, 'ABCDE');
    cpu.setReg64(RSI, 0x3000n);
    cpu.setReg64(RDI, 0x4000n);
    cpu.setReg64(RCX, 5n);
    cpu.df = false;
    loadCode([0xF3, 0xA6]);
    dec.step();
    expect(cpu.zf).toBe(false); // stopped at mismatch
    expect(cpu.getReg64(RCX)).toBe(2n); // consumed 3 out of 5
  });

  it('REPNE SCASB finds zero (strlen)', () => {
    // String "Hello" at 0x5000 (5 chars + null = 6 bytes)
    mem.writeString(0x5000n, 'Hello');
    cpu.setReg64(RDI, 0x5000n);
    cpu.setReg64(RCX, 100n);
    cpu.setReg8(RAX, 0n); // scanning for null
    cpu.df = false;
    // repne scasb → F2 AE
    loadCode([0xF2, 0xAE]);
    dec.step();
    // RCX should be 100 - 6 = 94 (scanned 6 bytes: H, e, l, l, o, \0)
    expect(cpu.getReg64(RCX)).toBe(94n);
    expect(cpu.zf).toBe(true); // found the null
  });

  it('CMPXCHG success path (equal)', () => {
    cpu.setReg64(RAX, 42n);
    cpu.setReg64(RCX, 99n);
    mem.write64(0x6000n, 42n); // dest = 42 (matches RAX)
    cpu.setReg64(RBX, 0x6000n);
    // lock cmpxchg [rbx], rcx → F0 48 0F B1 0B
    loadCode([0xF0, 0x48, 0x0F, 0xB1, 0x0B]);
    dec.step();
    expect(cpu.zf).toBe(true);
    expect(mem.read64(0x6000n)).toBe(99n); // dest updated to RCX
    expect(cpu.getReg64(RAX)).toBe(42n);   // RAX unchanged
  });

  it('CMPXCHG failure path (not equal)', () => {
    cpu.setReg64(RAX, 42n);
    cpu.setReg64(RCX, 99n);
    mem.write64(0x6000n, 50n); // dest = 50 (doesn't match RAX)
    cpu.setReg64(RBX, 0x6000n);
    // lock cmpxchg [rbx], rcx → F0 48 0F B1 0B
    loadCode([0xF0, 0x48, 0x0F, 0xB1, 0x0B]);
    dec.step();
    expect(cpu.zf).toBe(false);
    expect(mem.read64(0x6000n)).toBe(50n); // dest unchanged
    expect(cpu.getReg64(RAX)).toBe(50n);   // RAX loaded with dest
  });

  it('PUSHF/POPF round-trip', () => {
    cpu.cf = true;
    cpu.zf = true;
    cpu.sf = false;
    // pushf → 9C
    loadCode([0x9C]);
    dec.step();
    // Modify flags
    cpu.cf = false;
    cpu.zf = false;
    // popf → 9D
    loadCode([0x9D]);
    dec.step();
    expect(cpu.cf).toBe(true);
    expect(cpu.zf).toBe(true);
  });

  it('CPUID leaf 0 returns vendor string', () => {
    cpu.setReg32(RAX, 0n);
    // cpuid → 0F A2
    loadCode([0x0F, 0xA2]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(1n); // max leaf
    // Check "GenuineIntel"
    const ebx = cpu.getReg32(RBX);
    const edx = cpu.getReg32(RDX);
    const ecx = cpu.getReg32(RCX);
    const vendor = String.fromCharCode(
      ...[ebx, edx, ecx].flatMap(v => [
        Number(v & 0xFFn), Number((v >> 8n) & 0xFFn),
        Number((v >> 16n) & 0xFFn), Number((v >> 24n) & 0xFFn),
      ])
    );
    expect(vendor).toBe('GenuineIntel');
  });

  it('CPUID leaf 1 returns feature flags with SSE2', () => {
    cpu.setReg32(RAX, 1n);
    loadCode([0x0F, 0xA2]);
    dec.step();
    const edx = cpu.getReg32(RDX);
    // SSE2 is bit 26
    expect((edx >> 26n) & 1n).toBe(1n);
  });

  it('LOOP decrements RCX and branches', () => {
    cpu.setReg64(RCX, 3n);
    cpu.setReg64(RAX, 0n);
    // Loop body: inc eax (FF C0) → loop -4 (E2 FC)
    loadCode([0xFF, 0xC0, 0xE2, 0xFC]);
    // Execute 3 iterations: each is inc+loop
    for (let i = 0; i < 6; i++) dec.step();
    expect(cpu.getReg32(RAX)).toBe(3n);
    expect(cpu.getReg64(RCX)).toBe(0n);
  });

  it('SAHF/LAHF round-trip', () => {
    cpu.cf = true;
    cpu.zf = true;
    cpu.sf = false;
    // lahf → 9F (flags → AH)
    loadCode([0x9F]);
    dec.step();
    const ah = cpu.getReg8High(4);
    // Clear flags
    cpu.cf = false;
    cpu.zf = false;
    // sahf → 9E (AH → flags)
    loadCode([0x9E]);
    dec.step();
    expect(cpu.cf).toBe(true);
    expect(cpu.zf).toBe(true);
  });
});

// ─── Sprint 3 Tests: Bit Operations + SSE2 ──────────────────────────────────

describe('x86-64 Sprint 3 Instructions', () => {
  let cpu: CPU;
  let mem: VirtualMemory;
  let dec: Decoder;

  beforeEach(() => {
    cpu = new CPU();
    mem = new VirtualMemory();
    dec = new Decoder(cpu, mem);
    cpu.setReg64(RSP, 0x7FFF0000n);
    mem.allocatePages(0x7FFE0000n, 8);
  });

  function loadCode(bytes: number[]): void {
    const base = 0x1000n;
    for (let i = 0; i < bytes.length; i++) {
      mem.write8(base + BigInt(i), bytes[i]);
    }
    cpu.rip = base;
  }

  it('BT sets CF from tested bit', () => {
    cpu.setReg64(RAX, 0b1010n);
    cpu.setReg64(RCX, 3n);
    // bt eax, ecx → 0F A3 C8
    loadCode([0x0F, 0xA3, 0xC8]);
    dec.step();
    expect(cpu.cf).toBe(true); // bit 3 is set

    cpu.setReg64(RCX, 2n);
    loadCode([0x0F, 0xA3, 0xC8]);
    dec.step();
    expect(cpu.cf).toBe(false); // bit 2 is not set
  });

  it('BTS sets CF and sets the bit', () => {
    cpu.setReg64(RAX, 0b1000n);
    cpu.setReg64(RCX, 1n);
    // bts eax, ecx → 0F AB C8
    loadCode([0x0F, 0xAB, 0xC8]);
    dec.step();
    expect(cpu.cf).toBe(false); // bit 1 was not set
    expect(cpu.getReg32(RAX)).toBe(0b1010n); // bit 1 now set
  });

  it('BTR clears the bit', () => {
    cpu.setReg64(RAX, 0b1010n);
    cpu.setReg64(RCX, 3n);
    // btr eax, ecx → 0F B3 C8
    loadCode([0x0F, 0xB3, 0xC8]);
    dec.step();
    expect(cpu.cf).toBe(true); // bit 3 was set
    expect(cpu.getReg32(RAX)).toBe(0b0010n); // bit 3 cleared
  });

  it('BTC complements the bit', () => {
    cpu.setReg64(RAX, 0b1010n);
    cpu.setReg64(RCX, 1n);
    // btc eax, ecx → 0F BB C8
    loadCode([0x0F, 0xBB, 0xC8]);
    dec.step();
    expect(cpu.cf).toBe(true); // bit 1 was set
    expect(cpu.getReg32(RAX)).toBe(0b1000n); // bit 1 toggled off
  });

  it('BSWAP 32-bit reverses bytes', () => {
    cpu.setReg32(RAX, 0x01020304n);
    // bswap eax → 0F C8
    loadCode([0x0F, 0xC8]);
    dec.step();
    expect(cpu.getReg32(RAX)).toBe(0x04030201n);
  });

  it('BSWAP 64-bit reverses bytes', () => {
    cpu.setReg64(RAX, 0x0102030405060708n);
    // bswap rax → REX.W 0F C8 → 48 0F C8
    loadCode([0x48, 0x0F, 0xC8]);
    dec.step();
    expect(cpu.getReg64(RAX)).toBe(0x0807060504030201n);
  });

  it('SHLD shifts left filling from source', () => {
    cpu.setReg64(RAX, 0xFF000000n);
    cpu.setReg64(RCX, 0x12345678n);
    // shld eax, ecx, 8 → 0F A4 C8 08
    loadCode([0x0F, 0xA4, 0xC8, 0x08]);
    dec.step();
    // EAX shifted left 8, low 8 bits filled from ECX high bits
    expect(cpu.getReg32(RAX)).toBe(0x00000012n);
  });

  it('SHRD shifts right filling from source', () => {
    cpu.setReg64(RAX, 0x12345678n);
    cpu.setReg64(RCX, 0xABn);
    // shrd eax, ecx, 8 → 0F AC C8 08
    loadCode([0x0F, 0xAC, 0xC8, 0x08]);
    dec.step();
    // EAX shifted right 8, high 8 bits filled from ECX low bits
    expect(cpu.getReg32(RAX)).toBe(0xAB123456n);
  });

  it('XORPS xmm0, xmm0 zeros the register', () => {
    cpu.setXmm(0, 0xFFFFFFFFFFFFFFFFn, 0xFFFFFFFFFFFFFFFFn);
    // xorps xmm0, xmm0 → 0F 57 C0
    loadCode([0x0F, 0x57, 0xC0]);
    dec.step();
    expect(cpu.getXmmLo(0)).toBe(0n);
    expect(cpu.getXmmHi(0)).toBe(0n);
  });

  it('MOVDQA xmm ↔ xmm/m128 round-trip', () => {
    cpu.setXmm(1, 0x1234567890ABCDEFn, 0xFEDCBA0987654321n);
    // movdqa xmm0, xmm1 → 66 0F 6F C1
    loadCode([0x66, 0x0F, 0x6F, 0xC1]);
    dec.step();
    expect(cpu.getXmmLo(0)).toBe(0x1234567890ABCDEFn);
    expect(cpu.getXmmHi(0)).toBe(0xFEDCBA0987654321n);

    // movdqa [mem], xmm0 → 66 0F 7F 03 (store to [rbx])
    cpu.setReg64(RBX, 0x8000n);
    mem.allocatePages(0x8000n, 1);
    loadCode([0x66, 0x0F, 0x7F, 0x03]);
    dec.step();
    expect(mem.read64(0x8000n)).toBe(0x1234567890ABCDEFn);
    expect(mem.read64(0x8008n)).toBe(0xFEDCBA0987654321n);
  });

  it('MOVD from GP to XMM and back', () => {
    cpu.setReg32(RAX, 0x42n);
    // movd xmm0, eax → 66 0F 6E C0
    loadCode([0x66, 0x0F, 0x6E, 0xC0]);
    dec.step();
    expect(cpu.getXmmLo(0)).toBe(0x42n);
    expect(cpu.getXmmHi(0)).toBe(0n);

    // movd ecx, xmm0 → 66 0F 7E C1
    loadCode([0x66, 0x0F, 0x7E, 0xC1]);
    dec.step();
    expect(cpu.getReg32(RCX)).toBe(0x42n);
  });
});

// ─── Sprint 4 Tests: Syscalls + End-to-End ──────────────────────────────────

describe('x86-64 Sprint 4 Syscalls', () => {
  it('readv reads scatter-gather from stdin', async () => {
    const cpu = new CPU();
    const mem = new VirtualMemory();
    const { fs } = await createTestShell();
    const sc = new LinuxSyscalls(cpu, mem, fs, '/', () => {}, () => {}, 'HelloWorld');

    // Build iovec array: 2 buffers of 5 bytes each
    mem.allocatePages(0x2000n, 1);
    mem.allocatePages(0x3000n, 1);
    mem.write64(0x4000n, 0x2000n); mem.write64(0x4008n, 5n);
    mem.write64(0x4010n, 0x3000n); mem.write64(0x4018n, 5n);

    cpu.setReg64(RAX, 19n);     // sys_readv
    cpu.setReg64(RDI, 0n);      // fd = stdin
    cpu.setReg64(RSI, 0x4000n); // iov
    cpu.setReg64(RDX, 2n);      // iovcnt

    await sc.handleSyscall();
    expect(cpu.getReg64(RAX)).toBe(10n);
    expect(mem.readString(0x2000n, 5)).toBe('Hello');
    expect(mem.readString(0x3000n, 5)).toBe('World');
  });

  it('sysinfo fills struct', async () => {
    const cpu = new CPU();
    const mem = new VirtualMemory();
    const { fs } = await createTestShell();
    const sc = new LinuxSyscalls(cpu, mem, fs, '/', () => {}, () => {}, '');

    mem.allocatePages(0x5000n, 1);
    cpu.setReg64(RAX, 99n);     // sys_sysinfo
    cpu.setReg64(RDI, 0x5000n); // buf

    await sc.handleSyscall();
    expect(cpu.getReg64(RAX)).toBe(0n);
    expect(mem.read64(0x5000n + 32n)).toBe(268435456n); // totalram = 256MB
  });
});

describe('x86-64 Musl Startup Simulation', () => {
  it('exercises auxv → arch_prctl → set_tid_address → writev → exit_group', async () => {
    const { fs } = await createTestShell();

    // Hand-assemble a program that simulates the musl startup syscall sequence:
    // 1. arch_prctl(ARCH_SET_FS, 0x800000) — set TLS base
    // 2. set_tid_address(0x800100)          — set TID pointer
    // 3. writev(1, iov, 1)                  — write "Hello" to stdout
    // 4. exit_group(0)

    const msg = new TextEncoder().encode('Hello\n');
    // Layout:
    // 0x00: mov rdi, 0x1002 (ARCH_SET_FS)       7 bytes
    // 0x07: mov rsi, 0x800000                    7 bytes
    // 0x0E: mov rax, 158 (arch_prctl)            7 bytes
    // 0x15: syscall                              2 bytes
    // 0x17: mov rdi, 0x800100                    7 bytes
    // 0x1E: mov rax, 218 (set_tid_address)       7 bytes
    // 0x25: syscall                              2 bytes
    // 0x27: lea rsi, [rip+iov]                   7 bytes → iov at 0x56
    // 0x2E: write iov_base at iov+0: lea rcx, [rip+msg] → use mov instead
    //       Actually let's build iov in data section and use absolute addressing
    //       Simpler: write "Hello\n" and iov struct in data, reference with RIP-relative
    //
    // Simplified approach: put msg and iov in the data section

    // First pass: emit code bytes to determine size, then place data after
    const codeBytes: number[] = [];
    const emit = (...bytes: number[]) => { for (const b of bytes) codeBytes.push(b); };

    // mov rdi, 0x1002 (ARCH_SET_FS)
    emit(0x48, 0xC7, 0xC7, 0x02, 0x10, 0x00, 0x00);
    // mov rsi, 0x800000
    emit(0x48, 0xC7, 0xC6, 0x00, 0x00, 0x80, 0x00);
    // mov rax, 158
    emit(0x48, 0xC7, 0xC0, 158, 0x00, 0x00, 0x00);
    // syscall
    emit(0x0F, 0x05);
    // mov rdi, 0x800100
    emit(0x48, 0xC7, 0xC7, 0x00, 0x01, 0x80, 0x00);
    // mov rax, 218 (set_tid_address)
    emit(0x48, 0xC7, 0xC0, 218, 0x00, 0x00, 0x00);
    // syscall
    emit(0x0F, 0x05);
    // mov rdi, 1 (stdout)
    emit(0x48, 0xC7, 0xC7, 0x01, 0x00, 0x00, 0x00);
    // lea rsi, [rip + disp32] — placeholder, fix up below
    const leaIdx = codeBytes.length;
    emit(0x48, 0x8D, 0x35, 0x00, 0x00, 0x00, 0x00);
    // mov rdx, 1 (iovcnt)
    emit(0x48, 0xC7, 0xC2, 0x01, 0x00, 0x00, 0x00);
    // mov rax, 20 (writev)
    emit(0x48, 0xC7, 0xC0, 20, 0x00, 0x00, 0x00);
    // syscall
    emit(0x0F, 0x05);
    // mov rdi, 0 (exit code)
    emit(0x48, 0xC7, 0xC7, 0x00, 0x00, 0x00, 0x00);
    // mov rax, 231 (exit_group)
    emit(0x48, 0xC7, 0xC0, 231, 0x00, 0x00, 0x00);
    // syscall
    emit(0x0F, 0x05);

    // Place data after code (align to 8)
    const codeEnd = codeBytes.length;
    const msgOffset = (codeEnd + 7) & ~7;
    const iovOffset = msgOffset + ((msg.length + 7) & ~7);
    const totalSize = iovOffset + 16;
    const code = new Uint8Array(totalSize);
    for (let i = 0; i < codeBytes.length; i++) code[i] = codeBytes[i];

    // Fix up lea displacement: RIP after lea = leaIdx + 7, target = iovOffset
    const leaDisp = iovOffset - (leaIdx + 7);
    code[leaIdx + 3] = leaDisp & 0xFF;
    code[leaIdx + 4] = (leaDisp >> 8) & 0xFF;
    code[leaIdx + 5] = (leaDisp >> 16) & 0xFF;
    code[leaIdx + 6] = (leaDisp >> 24) & 0xFF;

    // Write msg data
    for (let i = 0; i < msg.length; i++) code[msgOffset + i] = msg[i];

    // Write iov struct: {iov_base (8 bytes), iov_len (8 bytes)}
    // code[0] → vaddr 0x400000, so code[msgOffset] → vaddr 0x400000 + msgOffset
    const msgVaddr = 0x400000 + msgOffset;
    const iovView = new DataView(code.buffer, iovOffset, 16);
    iovView.setUint32(0, msgVaddr & 0xFFFFFFFF, true);
    iovView.setUint32(4, 0, true);
    iovView.setUint32(8, msg.length, true);
    iovView.setUint32(12, 0, true);

    const elf = buildElf64(code);

    const cpuE = new CPU();
    const memE = new VirtualMemory();
    const decoder = new Decoder(cpuE, memE);

    loadElf(elf, memE, cpuE, ['test'], ['PATH=/usr/bin']);

    let output = '';
    const syscalls = new LinuxSyscalls(
      cpuE, memE, fs, '/home/user',
      (s: string) => { output += s; },
      (s: string) => {},
      '',
    );

    decoder.onSyscall = () => {
      (decoder as any)._pendingSyscall = true;
    };

    let exitCode = -1;
    for (let i = 0; i < 5000; i++) {
      (decoder as any)._pendingSyscall = false;
      try {
        decoder.step();
        if ((decoder as any)._pendingSyscall) {
          await syscalls.handleSyscall();
        }
      } catch (e: any) {
        if (e instanceof X86Exit) {
          exitCode = e.code;
          break;
        }
        throw e;
      }
    }

    expect(output).toBe('Hello\n');
    expect(exitCode).toBe(0);
  });
});
