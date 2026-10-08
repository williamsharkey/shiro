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
                 : "cc");                                     \
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
