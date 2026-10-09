// Fixture for x86-engine.test.ts (build: gcc -static -O1 -o jitfuzz jitfuzz.c).
// Differential test for Blink's wasm JIT (patch 0012): runs many x86-64 instruction forms
// on pseudo-random inputs inside hot loops and prints a checksum per group.
// The interpreter (BLINK_WJIT=0) and the JIT must print the same lines.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef uint64_t u64;
static u64 s = 88172645463325252ull;
static u64 rnd(void) {
  s ^= s << 13;
  s ^= s >> 7;
  s ^= s << 17;
  return s;
}
static u64 pick(void) {
  // bias toward edge values
  static const u64 edge[] = {0, 1, 2, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0xffff,
                             0x7fffffff, 0x80000000, 0xffffffff, 0x100000000,
                             0x7fffffffffffffff, 0x8000000000000000, -1ull, -2ull};
  u64 r = rnd();
  if ((r & 7) == 0) return edge[(r >> 3) % (sizeof(edge) / sizeof(edge[0]))];
  if ((r & 7) == 1) return rnd() & 0xff;
  if ((r & 7) == 2) return rnd() & 63;
  return rnd();
}

#define FMASK 0x8c5  // CF PF ZF SF OF (AF differs between Blink's helpers)
static u64 h;
static void mix(u64 x) {
  h ^= x;
  h *= 0x100000001b3ull;
  h ^= h >> 29;
}

#define OP2(name, insn)                                       \
  static void name(u64 a, u64 b) {                           \
    u64 f, r = a;                                             \
    asm volatile(insn "\n\tpushfq\n\tpopq %1"                 \
                 : "+r"(r), "=r"(f)                           \
                 : "r"(b)                                     \
                 : "cc", "rax", "rbx", "rcx", "rdx");         \
    mix(r);                                                   \
    mix(f & FMASK);                                           \
  }

OP2(add64, "addq %2, %0")
OP2(sub64, "subq %2, %0")
OP2(and64, "andq %2, %0")
OP2(or64, "orq %2, %0")
OP2(xor64, "xorq %2, %0")
OP2(cmp64, "cmpq %2, %0")
OP2(test64, "testq %2, %0")
OP2(adc64, "stc\n\tadcq %2, %0")
OP2(sbb64, "stc\n\tsbbq %2, %0")
OP2(add32, "addl %k2, %k0")
OP2(sub32, "subl %k2, %k0")
OP2(and32, "andl %k2, %k0")
OP2(xor32, "xorl %k2, %k0")
OP2(cmp32, "cmpl %k2, %k0")
OP2(test32, "testl %k2, %k0")
OP2(add16, "addw %w2, %w0")
OP2(sub16, "subw %w2, %w0")
OP2(cmp16, "cmpw %w2, %w0")
OP2(add8, "addb %b2, %b0")
OP2(sub8, "subb %b2, %b0")
OP2(cmp8, "cmpb %b2, %b0")
OP2(test8, "testb %b2, %b0")
OP2(and8, "andb %b2, %b0")
OP2(imul64, "imulq %2, %0")
OP2(imul32, "imull %k2, %k0")
OP2(shl64, "movq %2, %%rcx\n\tshlq %%cl, %0")
OP2(shr64, "movq %2, %%rcx\n\tshrq %%cl, %0")
OP2(sar64, "movq %2, %%rcx\n\tsarq %%cl, %0")
OP2(shl32, "movq %2, %%rcx\n\tshll %%cl, %k0")
OP2(shr32, "movq %2, %%rcx\n\tshrl %%cl, %k0")
OP2(sar32, "movq %2, %%rcx\n\tsarl %%cl, %k0")
OP2(shl8, "movq %2, %%rcx\n\tshlb %%cl, %b0")
OP2(sar8, "movq %2, %%rcx\n\tsarb %%cl, %b0")
OP2(shli64, "shlq $13, %0")
OP2(shri64, "shrq $1, %0")
OP2(sari64, "sarq $63, %0")
OP2(shli32, "shll $31, %k0")
OP2(shri32, "shrl $7, %k0")
OP2(sari32, "sarl $1, %k0")
OP2(shl0, "shlq $0, %0")
OP2(inc64, "incq %0")
OP2(dec64, "decq %0")
OP2(inc32, "incl %k0")
OP2(dec32, "decl %k0")
OP2(inc8, "incb %b0")
OP2(neg64, "negq %0")
OP2(not64, "notq %0")
OP2(addi64, "addq $-5, %0")
OP2(subi32, "subl $0x80000000, %k0")
OP2(andi64, "andq $0x7fffffff, %0")
OP2(cmpi64, "cmpq $-1, %0")
OP2(cmpi8, "cmpb $0x80, %b0")
OP2(ori16, "orw $0x8001, %w0")
OP2(imuli, "imulq $-7, %2, %0")
OP2(imuli32, "imull $100000, %k2, %k0")
OP2(movzb, "movzbl %b2, %k0")
OP2(movsb, "movsbq %b2, %0")
OP2(movzw, "movzwq %w2, %0")
OP2(movsw, "movswl %w2, %k0")
OP2(movsxd, "movslq %k2, %0")
OP2(mov32, "movl %k2, %k0")
OP2(mov16, "movw %w2, %w0")
OP2(mov8, "movb %b2, %b0")
OP2(movabs, "movabsq $0x123456789abcdef0, %0")
OP2(movi32, "movl $0xfedcba98, %k0")
OP2(cdqe, "movq %2, %%rax\n\tcltq\n\tmovq %%rax, %0")
OP2(cwde, "movq %2, %%rax\n\tcwtl\n\tmovq %%rax, %0")
OP2(cqo, "movq %2, %%rax\n\tcqto\n\tmovq %%rdx, %0")
OP2(cdq, "movq %2, %%rax\n\tmovq $-1, %%rdx\n\tcltd\n\tmovq %%rdx, %0")
OP2(lea1, "leaq 7(%0,%2,4), %0")
OP2(lea32, "leal -1(%k0,%k2,8), %k0")
OP2(leaneg, "leaq -0x80(%2), %0")
OP2(ahreg, "movq %2, %%rax\n\tmovb %%ah, %%al\n\taddb $3, %%ah\n\tmovq %%rax, %0")
OP2(bhreg, "movq %2, %%rbx\n\tsubb %%bl, %%bh\n\tmovq %%rbx, %0")
OP2(xchg, "xchgq %2, %0")
OP2(bswap, "bswapq %0")
OP2(bsf, "bsfq %2, %0")
OP2(rol, "rolq $5, %0")
OP2(btq, "btq %2, %0\n\tsetc %b0")
// 16-bit forms
OP2(and16, "andw %w2, %w0")
OP2(or16, "orw %w2, %w0")
OP2(xor16, "xorw %w2, %w0")
OP2(test16, "testw %w2, %w0")
OP2(inc16, "incw %w0")
OP2(dec16, "decw %w0")
OP2(addi16, "addw $0x7fff, %w0")
OP2(subi16, "subw $-3, %w0")
OP2(cmov16, "cmpq %2, %0\n\tcmovbw %w2, %w0")
OP2(cmovl16, "cmpw %w2, %w0\n\tcmovlw %w2, %w0")
OP2(movi16, "movw $0x8765, %w0")
OP2(movr16, "movq %2, %%rax\n\tmovw $0x1234, %%ax\n\tmovw %%ax, %w0")
// carries in
OP2(adc32, "btl $3, %k2\n\tadcl %k2, %k0")
OP2(sbb32, "btl $5, %k2\n\tsbbl %k2, %k0")
OP2(adc8, "btl $1, %k2\n\tadcb %b2, %b0")
OP2(sbb16, "btl $2, %k2\n\tsbbw %w2, %w0")
OP2(adcq0, "btq $63, %2\n\tadcq $0, %0")
OP2(sbbself, "btq $7, %2\n\tsbbq %0, %0")
OP2(adcchain, "addq %2, %0\n\tadcq %2, %0\n\tsbbq $1, %0")
// group 3
OP2(neg32, "negl %k0")
OP2(neg16, "negw %w0")
OP2(neg8, "negb %b0")
OP2(negjz, "negq %0\n\tjnz 1f\n\tmovq $77, %0\n1:")
OP2(not32, "notl %k0")
OP2(not16, "notw %w0")
OP2(mul64, "movq %0, %%rax\n\tmulq %2\n\tleaq (%%rax,%%rdx,2), %0")
OP2(mul32, "movq %0, %%rax\n\tmull %k2\n\tleaq (%%rax,%%rdx,2), %0")
OP2(mul16, "movq %0, %%rax\n\tmovq %2, %%rdx\n\tmulw %w2\n\tleaq (%%rax,%%rdx,2), %0")
OP2(mul8, "movq %0, %%rax\n\tmulb %b2\n\tmovq %%rax, %0")
OP2(imul1_64, "movq %0, %%rax\n\timulq %2\n\tleaq (%%rax,%%rdx,2), %0")
OP2(imul1_32, "movq %0, %%rax\n\timull %k2\n\tleaq (%%rax,%%rdx,2), %0")
OP2(imul1_16, "movq %0, %%rax\n\tmovq %2, %%rdx\n\timulw %w2\n\tleaq (%%rax,%%rdx,2), %0")
OP2(imul1_8, "movq %0, %%rax\n\timulb %b2\n\tmovq %%rax, %0")
// bit tests
OP2(bts64, "btsq %2, %0")
OP2(btr32, "btrl %k2, %k0")
OP2(btc64, "btcq %2, %0")
OP2(bt16, "btw %w2, %w0\n\tsetc %b0")
OP2(btsi, "btsq $45, %0")
OP2(btri32, "btrl $3, %k0")
OP2(btci, "btcq $63, %0")
OP2(bti16, "btw $9, %w0\n\tsetc %b0")
// bit scans (Blink: bsf/bsr write 0 for a zero source)
OP2(bsr, "bsrq %2, %0")
OP2(bsf32, "bsfl %k2, %k0")
OP2(bsr16, "bsrw %w2, %w0")
OP2(tzcnt64, "tzcntq %2, %0")
OP2(tzcnt32, "tzcntl %k2, %k0")
OP2(lzcnt64, "lzcntq %2, %0")
OP2(lzcnt32, "lzcntl %k2, %k0")
OP2(lzcnt16, "lzcntw %w2, %w0")

// divides (flags are undefined): 128-bit dividends take Blink's slow path
static void div64(u64 a, u64 b) {
  u64 d = b | 1, hi = (b & 0x100) ? (a >> 7) % d : 0, q, r;
  asm volatile("divq %4" : "=a"(q), "=d"(r) : "0"(a), "1"(hi), "r"(d) : "cc");
  mix(q);
  mix(r);
}
static void idiv64(u64 a, u64 b) {
  int64_t d = (int64_t)(b | 1), hi = (int64_t)a >> 63, q, r;
  if (d == -1) d = 3;
  if (b & 0x100) d = (int64_t)(b | 1ull << 62) & INT64_MAX, hi = 1;
  asm volatile("idivq %4" : "=a"(q), "=d"(r) : "0"(a), "1"(hi), "r"(d) : "cc");
  mix(q);
  mix(r);
}
static void div32(u64 a, u64 b) {
  u64 d = (b | 1) & 0xffffffff, hi = ((b & 0x100) ? (a >> 32) % d : 0) | (b << 32), q, r;
  asm volatile("divl %k4" : "=a"(q), "=d"(r) : "0"(a), "1"(hi), "r"(d) : "cc");
  mix(q);
  mix(r);
}
static void idiv32(u64 a, u64 b) {
  int32_t d = (int32_t)(b | 1);
  if (d == -1) d = 7;
  u64 hi = (u64)((int64_t)(int32_t)a >> 32), q, r;
  asm volatile("idivl %k4" : "=a"(q), "=d"(r) : "0"(a), "1"(hi), "r"((u64)d) : "cc");
  mix(q);
  mix(r);
}
static u64 dmem[2];
static void divmem(u64 a, u64 b) {
  u64 q, r;
  dmem[1] = b | 1;
  asm volatile("divq 8(%4)" : "=a"(q), "=d"(r) : "0"(a), "1"(0ull), "r"(dmem) : "cc", "memory");
  mix(q);
  mix(r);
}

// bit tests on memory, with register offsets reaching outside the operand
static u64 barr[16];
static void btmem(u64 a, u64 b) {
  u64 f, off = (u64)((long)(b % 512) - 256);
  for (int i = 0; i < 16; ++i) barr[i] = a ^ (i * 0x9e3779b97f4a7c15ull);
  asm volatile("btsq %1, (%2)\n\t"
               "btrl %k1, 4(%2)\n\t"
               "btcw %w1, (%2)\n\t"
               "btsl $31, 8(%2)\n\t"
               "btcq $5, -8(%2)\n\t"
               "btq %1, (%2)\n\t"
               "pushfq\n\tpopq %0"
               : "=&r"(f)
               : "r"(off), "r"(barr + 8)
               : "cc", "memory");
  mix(f & 1);
  for (int i = 0; i < 16; ++i) mix(barr[i]);
}

// a cmp whose consumer is separated from it by a page-crossing load (the
// load exits to the interpreter, which must see the flags)
static char *page;
static void cmpcross(u64 a, u64 b) {
  int off = 4096 - 4 + (b & 3);  // (no store first: it would exit too)
  u64 x, r = 0;
  asm volatile("cmpq %3, %2\n\t"
               "movq (%4), %1\n\t"
               "setb %b0"
               : "+r"(r), "=&r"(x)
               : "r"(a), "r"(b), "r"(page + off)
               : "cc", "memory");
  mix(r);
  mix(x);
}

static const char *ccnames = "o no b ae e ne be a s ns p np l ge le g";

#define CC(cc)                                                         \
  static void set_##cc(u64 a, u64 b) {                                 \
    u64 r = 0, r2 = 0, r3 = 0, r4 = a;                                 \
    asm volatile("cmpq %3, %4\n\tset" #cc " %b0\n\t"                   \
                 "testl %k3, %k4\n\tset" #cc " %b1\n\t"                \
                 "subb %b3, %b4\n\tset" #cc " %b2\n\t"                 \
                 "cmpq %3, %4\n\tcmov" #cc " %3, %4"                   \
                 : "+r"(r), "+r"(r2), "+r"(r3), "+r"(b), "+r"(r4)      \
                 :                                                     \
                 : "cc");                                              \
    mix(r);                                                            \
    mix(r2 << 1);                                                      \
    mix(r3 << 2);                                                      \
    mix(r4);                                                           \
  }                                                                    \
  static void j_##cc(u64 a, u64 b) {                                   \
    u64 r = 0;                                                         \
    asm volatile("cmpl %k2, %k1\n\tj" #cc " 1f\n\tmovq $1, %0\n1:"      \
                 : "+r"(r)                                             \
                 : "r"(a), "r"(b)                                      \
                 : "cc");                                              \
    mix(r);                                                            \
  }

CC(o) CC(no) CC(b) CC(ae) CC(e) CC(ne) CC(be) CC(a)
CC(s) CC(ns) CC(p) CC(np) CC(l) CC(ge) CC(le) CC(g)

// memory forms
static u64 mem[64];
static void memops(u64 a, u64 b) {
  int i = b & 63;
  u64 f;
  mem[i] = a;
  asm volatile("addq %2, (%3,%4,8)\n\t"
               "subl %k2, 4(%3,%4,8)\n\t"
               "incb 3(%3,%4,8)\n\t"
               "notq (%3,%4,8)\n\t"
               "shlq $3, (%3,%4,8)\n\t"
               "cmpw $7, 2(%3,%4,8)\n\t"
               "pushfq\n\tpopq %0\n\t"
               "pushq (%3,%4,8)\n\t"
               "popq %1"
               : "=&r"(f), "=&r"(a)
               : "r"(b), "r"(mem), "r"((u64)i)
               : "cc", "memory");
  mix(f & FMASK);
  mix(a);
  mix(mem[i]);
}

// unaligned / page-crossing access
static char *page;
static void crossing(u64 a, u64 b) {
  int off = 4096 - 8 + (b & 15);
  u64 x;
  memcpy(page + off, &a, 8);
  asm volatile("movq (%1), %0\n\taddq $1, (%1)" : "=&r"(x) : "r"(page + off) : "memory", "cc");
  mix(x);
  memcpy(&x, page + off, 8);
  mix(x);
}

// a function call/ret and indirect call
static u64 __attribute__((noinline)) callee(u64 a) {
  return a * 3 + 1;
}
static u64 (*volatile fp)(u64) = callee;
static void calls(u64 a, u64 b) {
  mix(callee(a ^ b));
  mix(fp(a + b));
}

// loops of different shapes
static void loops(u64 a, u64 b) {
  u64 x = a, n = b & 255;
  for (u64 i = 0; i < n; ++i) x = x * 6364136223846793005ull + i;
  mix(x);
  int k = 0;
  while ((a >>= 1) != 0) ++k;
  mix(k);
  long c = 0;
  for (int i = (int)(b & 31); i > -5; --i) c += i * (long)i;
  mix(c);
}

// SSE moves and xors (memmove/memclr in Go and libc use them)
static unsigned char sbuf[8192] __attribute__((aligned(16)));
static void sse_moves(u64 a, u64 b) {
  int off = (int)(b % 4060), off2 = (int)((a >> 7) % 4040) + 4096;
  u64 r0, r1;
  memcpy(sbuf + off, &a, 8);
  memcpy(sbuf + off + 8, &b, 8);
  asm volatile("movups (%2), %%xmm1\n\t"
               "movdqu %%xmm1, (%3)\n\t"
               "movsd 8(%2), %%xmm2\n\t"
               "pxor %%xmm1, %%xmm2\n\t"
               "movaps %%xmm2, %%xmm3\n\t"
               "xorps %%xmm1, %%xmm3\n\t"
               "movupd %%xmm3, 16(%3)\n\t"
               "movsd %%xmm2, 32(%3)\n\t"
               "movdqu 16(%3), %%xmm4\n\t"
               "movq %%xmm4, %0\n\t"
               "movhlps %%xmm4, %%xmm4\n\t"
               "movq %%xmm4, %1"
               : "=&r"(r0), "=&r"(r1)
               : "r"(sbuf + off), "r"(sbuf + off2)
               : "xmm1", "xmm2", "xmm3", "xmm4", "memory");
  mix(r0);
  mix(r1);
  memcpy(&r0, sbuf + off2 + 32, 8);
  mix(r0);
}

typedef void (*op_f)(u64, u64);
static const struct {
  const char *name;
  op_f f;
} kOps[] = {
#define E(x) {#x, x}
    E(add64),  E(sub64),   E(and64),  E(or64),   E(xor64),   E(cmp64),
    E(test64), E(adc64),   E(sbb64),  E(add32),  E(sub32),   E(and32),
    E(xor32),  E(cmp32),   E(test32), E(add16),  E(sub16),   E(cmp16),
    E(add8),   E(sub8),    E(cmp8),   E(test8),  E(and8),    E(imul64),
    E(imul32), E(shl64),   E(shr64),  E(sar64),  E(shl32),   E(shr32),
    E(sar32),  E(shl8),    E(sar8),   E(shli64), E(shri64),  E(sari64),
    E(shli32), E(shri32),  E(sari32), E(shl0),   E(inc64),   E(dec64),
    E(inc32),  E(dec32),   E(inc8),   E(neg64),  E(not64),   E(addi64),
    E(subi32), E(andi64),  E(cmpi64), E(cmpi8),  E(ori16),   E(imuli),
    E(imuli32), E(movzb),  E(movsb),  E(movzw),  E(movsw),   E(movsxd),
    E(mov32),  E(mov16),   E(mov8),   E(movabs), E(movi32),  E(cdqe),
    E(cwde),   E(cqo),     E(cdq),    E(lea1),   E(lea32),   E(leaneg),
    E(ahreg),  E(bhreg),   E(xchg),   E(bswap),  E(bsf),     E(rol),
    E(btq),
    E(and16),  E(or16),    E(xor16),  E(test16), E(inc16),   E(dec16),
    E(addi16), E(subi16),  E(cmov16), E(cmovl16), E(movi16), E(movr16),
    E(adc32),  E(sbb32),   E(adc8),   E(sbb16),  E(adcq0),   E(sbbself),
    E(adcchain), E(neg32), E(neg16),  E(neg8),   E(negjz),   E(not32),
    E(not16),  E(mul64),   E(mul32),  E(mul16),  E(mul8),    E(imul1_64),
    E(imul1_32), E(imul1_16), E(imul1_8), E(bts64), E(btr32), E(btc64),
    E(bt16),   E(btsi),    E(btri32), E(btci),   E(bti16),   E(bsr),
    E(bsf32),  E(bsr16),   E(tzcnt64), E(tzcnt32), E(lzcnt64), E(lzcnt32),
    E(lzcnt16), E(div64),  E(idiv64), E(div32),  E(idiv32),  E(divmem),
    E(btmem),  E(cmpcross),
    E(set_o),  E(set_no),  E(set_b),  E(set_ae), E(set_e),   E(set_ne),
    E(set_be), E(set_a),   E(set_s),  E(set_ns), E(set_p),   E(set_np),
    E(set_l),  E(set_ge),  E(set_le), E(set_g),  E(j_o),     E(j_no),
    E(j_b),    E(j_ae),    E(j_e),    E(j_ne),   E(j_be),    E(j_a),
    E(j_s),    E(j_ns),    E(j_p),    E(j_np),   E(j_l),     E(j_ge),
    E(j_le),   E(j_g),     E(memops), E(crossing), E(calls), E(loops), E(sse_moves),
};

int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 2000;
  page = aligned_alloc(4096, 8192);
  (void)ccnames;
  for (unsigned k = 0; k < sizeof(kOps) / sizeof(kOps[0]); ++k) {
    h = 0;
    for (int i = 0; i < n; ++i) {
      u64 a = pick(), b = pick();
      kOps[k].f(a, b);
    }
    printf("%-10s %016llx\n", kOps[k].name, (unsigned long long)h);
  }
  return 0;
}
