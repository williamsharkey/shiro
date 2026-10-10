// Blink 0114: llvmpipe's SSE4.1 forms (unix/gui's dump): pblendvb, ptest+jcc, pinsrd from
// memory, extractps to memory, cvtsi2ss, movshdup, pminud/pmaxud, cmpnleps,
// unpckhpd, with REX registers (asm, so the encodings are LLVM's)
#include <stdio.h>
#include <stdint.h>
#include <string.h>
typedef struct { uint32_t u[4]; } V;
static void P(const char *n, V v) { printf("%-10s %08x %08x %08x %08x\n", n, v.u[0], v.u[1], v.u[2], v.u[3]); }
static V A = {{0x3f800000, 0xbf800000, 0x40490fdb, 0x00000000}}, B = {{0x40000000, 0x3f000000, 0xc0490fdb, 0x80000000}};
static V M = {{0x80ff0080, 0x00000000, 0xffffffff, 0x7f7f8080}};
int main(void) {
  V r; uint32_t mem[8] = {11, 22, 33, 44, 55, 66, 77, 88}; float fm[4] = {0};
  // pblendvb xmm0 mask, REX source (xmm13)
  __asm__ volatile("movdqu %1,%%xmm1\n movdqu %2,%%xmm13\n movdqu %3,%%xmm0\n pblendvb %%xmm0,%%xmm13,%%xmm1\n movdqu %%xmm1,%0" : "=m"(r) : "m"(A), "m"(B), "m"(M) : "xmm0", "xmm1", "xmm13");
  P("pblendvb", r);
  __asm__ volatile("movdqu %1,%%xmm9\n movdqu %2,%%xmm0\n blendvps %%xmm0,%%xmm9,%%xmm9\n movdqu %3,%%xmm10\n blendvps %%xmm0,%%xmm10,%%xmm9\n movdqu %%xmm9,%0" : "=m"(r) : "m"(A), "m"(M), "m"(B) : "xmm0", "xmm9", "xmm10");
  P("blendvps", r);
  // ptest: ZF and CF for several pairs
  V z = {{0, 0, 0, 0}}, ones = {{~0u, ~0u, ~0u, ~0u}};
  V pairs[][2] = {{z, z}, {M, z}, {M, M}, {M, ones}, {ones, M}, {A, B}};
  for (int i = 0; i < 6; i++) {
    uint8_t zf, cf, ja;
    __asm__ volatile("movdqu %3,%%xmm12\n movdqu %4,%%xmm3\n ptest %%xmm3,%%xmm12\n setz %0\n setc %1\n seta %2" : "=r"(zf), "=r"(cf), "=r"(ja) : "m"(pairs[i][0]), "m"(pairs[i][1]) : "xmm3", "xmm12", "cc");
    printf("ptest%d zf=%d cf=%d a=%d\n", i, zf, cf, ja);
  }
  // pinsrd from memory with SIB, REX
  { long base = (long)mem, idx = 8;
    __asm__ volatile("movdqu %1,%%xmm3\n mov %2,%%r9\n mov %3,%%rdx\n pinsrd $1,(%%r9,%%rdx,1),%%xmm3\n pinsrd $3,4(%%r9,%%rdx,2),%%xmm3\n movdqu %%xmm3,%0" : "=m"(r) : "m"(A), "r"(base), "r"(idx) : "xmm3", "r9", "rdx");
    P("pinsrd", r); }
  // extractps to memory and to register, REX
  __asm__ volatile("movdqu %1,%%xmm11\n extractps $1,%%xmm11,%0\n extractps $2,%%xmm11,4+%0\n extractps $3,%%xmm11,%%eax\n mov %%eax,8+%0" : "=m"(fm) : "m"(B) : "xmm11", "eax");
  { V t; memcpy(t.u, fm, 12); t.u[3] = 0; P("extractps", t); }
  // cvtsi2ss 32 and 64, keeps upper lanes
  { int x = -7; long y = 123456789012L;
    __asm__ volatile("movdqu %1,%%xmm0\n cvtsi2ss %2,%%xmm0\n movdqu %%xmm0,%0" : "=m"(r) : "m"(A), "r"(x) : "xmm0"); P("cvtsi2ss", r);
    __asm__ volatile("movdqu %1,%%xmm8\n cvtsi2ssq %2,%%xmm8\n movdqu %%xmm8,%0" : "=m"(r) : "m"(A), "r"(y) : "xmm8"); P("cvtsi2ssq", r);
    __asm__ volatile("movdqu %1,%%xmm0\n cvtsi2ssl %2,%%xmm0\n movdqu %%xmm0,%0" : "=m"(r) : "m"(A), "m"(mem[2]) : "xmm0"); P("cvtsi2ssm", r); }
  __asm__ volatile("movdqu %1,%%xmm14\n movshdup %%xmm14,%%xmm2\n movdqu %%xmm2,%0" : "=m"(r) : "m"(A) : "xmm2", "xmm14"); P("movshdup", r);
  __asm__ volatile("movshdup %1,%%xmm2\n movdqu %%xmm2,%0" : "=m"(r) : "m"(B) : "xmm2"); P("movshdupm", r);
  __asm__ volatile("movsldup %1,%%xmm2\n movdqu %%xmm2,%0" : "=m"(r) : "m"(B) : "xmm2"); P("movsldup", r);
  __asm__ volatile("movdqu %1,%%xmm4\n movdqu %2,%%xmm15\n pminud %%xmm15,%%xmm4\n movdqu %%xmm4,%0" : "=m"(r) : "m"(A), "m"(B) : "xmm4", "xmm15"); P("pminud", r);
  __asm__ volatile("movdqu %1,%%xmm4\n movdqu %2,%%xmm15\n pmaxud %%xmm15,%%xmm4\n movdqu %%xmm4,%0" : "=m"(r) : "m"(A), "m"(B) : "xmm4", "xmm15"); P("pmaxud", r);
  __asm__ volatile("movdqu %1,%%xmm4\n movdqu %2,%%xmm15\n pminsd %%xmm15,%%xmm4\n movdqu %%xmm4,%0" : "=m"(r) : "m"(A), "m"(B) : "xmm4", "xmm15"); P("pminsd", r);
  __asm__ volatile("movdqu %1,%%xmm4\n movdqu %2,%%xmm15\n pmulld %%xmm15,%%xmm4\n movdqu %%xmm4,%0" : "=m"(r) : "m"(A), "m"(B) : "xmm4", "xmm15"); P("pmulld", r);
  for (int pr = 0; pr < 8; pr++) {
    switch (pr) {
#define CMP(k) case k: __asm__ volatile("movdqu %1,%%xmm10\n movdqu %2,%%xmm9\n cmpps $" #k ",%%xmm9,%%xmm10\n movdqu %%xmm10,%0" : "=m"(r) : "m"(A), "m"(B) : "xmm9", "xmm10"); break;
      CMP(0) CMP(1) CMP(2) CMP(3) CMP(4) CMP(5) CMP(6) CMP(7)
    }
    char n[16]; snprintf(n, sizeof n, "cmpps%d", pr); P(n, r);
  }
  __asm__ volatile("movdqu %1,%%xmm10\n cmpnleps %2,%%xmm10\n movdqu %%xmm10,%0" : "=m"(r) : "m"(A), "m"(B) : "xmm10"); P("cmpnlepsm", r);
  __asm__ volatile("movdqu %1,%%xmm5\n movdqu %2,%%xmm13\n unpckhpd %%xmm13,%%xmm5\n movdqu %%xmm5,%0" : "=m"(r) : "m"(A), "m"(B) : "xmm5", "xmm13"); P("unpckhpd", r);
  __asm__ volatile("movdqu %1,%%xmm5\n unpcklpd %2,%%xmm5\n movdqu %%xmm5,%0" : "=m"(r) : "m"(A), "m"(B) : "xmm5"); P("unpcklpd", r);
  __asm__ volatile("movdqu %1,%%xmm5\n movdqu %2,%%xmm6\n punpckhqdq %%xmm6,%%xmm5\n movdqu %%xmm5,%0" : "=m"(r) : "m"(A), "m"(B) : "xmm5", "xmm6"); P("punpckhqdq", r);
  __asm__ volatile("movdqu %1,%%xmm5\n pextrd $2,%%xmm5,%%eax\n pextrd $3,%%xmm5,4+%0\n mov %%eax,%0" : "=m"(r) : "m"(B) : "xmm5", "eax"); r.u[2] = r.u[3] = 0; P("pextrd", r);
  __asm__ volatile("movdqu %1,%%xmm5\n movdqu %2,%%xmm7\n insertps $0x9d,%%xmm7,%%xmm5\n movdqu %%xmm5,%0" : "=m"(r) : "m"(A), "m"(B) : "xmm5", "xmm7"); P("insertps", r);
  __asm__ volatile("movdqu %1,%%xmm5\n insertps $0x60,%2,%%xmm5\n movdqu %%xmm5,%0" : "=m"(r) : "m"(A), "m"(mem[1]) : "xmm5"); P("insertpsm", r);
  __asm__ volatile("movdqu %1,%%xmm5\n movdqu %2,%%xmm7\n packssdw %%xmm7,%%xmm5\n packuswb %%xmm5,%%xmm5\n movdqu %%xmm5,%0" : "=m"(r) : "m"(M), "m"(mem) : "xmm5", "xmm7"); P("packs", r);
  return 0;
}
