// SSE2/SSSE3 integer ops as compiled code runs them (wasm SIMD): each in
// register and aligned-memory form, in loops long enough for the JIT,
// checksummed; plus glibc's SSE2 string functions
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct { uint64_t q[2]; } __attribute__((aligned(16))) v128;
static uint64_t seed = 88172645463325252ull;
static uint64_t rnd(void) { seed ^= seed << 13, seed ^= seed >> 7, seed ^= seed << 17; return seed; }

#define OP2(name, insn)                                                              \
  static uint64_t name(void) {                                                       \
    uint64_t h = 0;                                                                  \
    static v128 m;                                                                   \
    for (int i = 0; i < 2000; ++i) {                                                 \
      v128 a = {{rnd(), rnd()}}, b = {{rnd(), i & 1 ? 0 : rnd()}}, c;                \
      m = b;                                                                         \
      __asm__ volatile("movdqa %1, %%xmm0\n\tmovdqa %2, %%xmm1\n\t" insn " %%xmm1, %%xmm0\n\t" \
                       insn " %3, %%xmm0\n\tmovdqa %%xmm0, %0"                       \
                       : "=m"(c) : "m"(a), "m"(b), "m"(m) : "xmm0", "xmm1");         \
      h = h * 1000003 ^ c.q[0] ^ (c.q[1] << 1);                                      \
    }                                                                                \
    return h;                                                                        \
  }
OP2(t_paddb, "paddb") OP2(t_paddw, "paddw") OP2(t_paddd, "paddd") OP2(t_paddq, "paddq")
OP2(t_psubb, "psubb") OP2(t_psubw, "psubw") OP2(t_psubd, "psubd") OP2(t_psubq, "psubq")
OP2(t_pand, "pand") OP2(t_pandn, "pandn") OP2(t_por, "por") OP2(t_pxor, "pxor")
OP2(t_pcmpeqb, "pcmpeqb") OP2(t_pcmpeqw, "pcmpeqw") OP2(t_pcmpeqd, "pcmpeqd")
OP2(t_pcmpgtb, "pcmpgtb") OP2(t_pcmpgtw, "pcmpgtw") OP2(t_pcmpgtd, "pcmpgtd")
OP2(t_pminub, "pminub") OP2(t_pmaxub, "pmaxub")
OP2(t_unpcklbw, "punpcklbw") OP2(t_unpcklwd, "punpcklwd") OP2(t_unpckldq, "punpckldq") OP2(t_unpcklqdq, "punpcklqdq")
OP2(t_unpckhbw, "punpckhbw") OP2(t_unpckhwd, "punpckhwd") OP2(t_unpckhdq, "punpckhdq") OP2(t_unpckhqdq, "punpckhqdq")
OP2(t_pshufb, "pshufb")
OP2(t_pshufd, "pshufd $0x1b,") OP2(t_pshufd2, "pshufd $0xe4,")
OP2(t_palignr4, "palignr $4,") OP2(t_palignr16, "palignr $16,") OP2(t_palignr0, "palignr $0,")

#define SH(name, insn)                                                              \
  static uint64_t name(void) {                                                       \
    uint64_t h = 0;                                                                  \
    for (int i = 0; i < 2000; ++i) {                                                 \
      v128 a = {{rnd(), rnd()}}, c;                                                  \
      __asm__ volatile("movdqa %1, %%xmm2\n\t" insn ", %%xmm2\n\tmovdqa %%xmm2, %0"  \
                       : "=m"(c) : "m"(a) : "xmm2");                                 \
      h = h * 1000003 ^ c.q[0] ^ (c.q[1] << 1);                                      \
    }                                                                                \
    return h;                                                                        \
  }
SH(s_psrlw3, "psrlw $3") SH(s_psraw15, "psraw $15") SH(s_psllw16, "psllw $16") SH(s_psraw40, "psraw $40")
SH(s_psrld7, "psrld $7") SH(s_psrad31, "psrad $31") SH(s_pslld32, "pslld $32") SH(s_psrad99, "psrad $99")
SH(s_psrlq1, "psrlq $1") SH(s_psllq63, "psllq $63") SH(s_psrlq64, "psrlq $64") SH(s_psllq0, "psllq $0")
SH(s_psrldq3, "psrldq $3") SH(s_pslldq5, "pslldq $5") SH(s_psrldq16, "psrldq $16") SH(s_pslldq255, "pslldq $255")

static uint64_t t_pmovmskb(void) {
  uint64_t h = 0;
  for (int i = 0; i < 2000; ++i) {
    v128 a = {{rnd(), rnd()}};
    uint64_t r = 0xdeadbeefdeadbeefull;
    __asm__ volatile("movdqa %1, %%xmm3\n\tpmovmskb %%xmm3, %0" : "+r"(r) : "m"(a) : "xmm3");
    h = h * 1000003 ^ r;
  }
  return h;
}

static uint64_t t_moves(void) {
  static v128 src[8], dst[8];
  uint64_t h = 0;
  for (int i = 0; i < 3000; ++i) {
    src[i & 7].q[0] = rnd(), src[i & 7].q[1] = rnd();
    __asm__ volatile("movdqa %1, %%xmm4\n\tmovaps %%xmm4, %0\n\tmovaps %0, %%xmm5\n\tmovdqa %%xmm5, %2"
                     : "=m"(dst[i & 7]) : "m"(src[i & 7]), "m"(dst[(i + 1) & 7]) : "xmm4", "xmm5");
    h = h * 1000003 ^ dst[i & 7].q[0] ^ dst[(i + 1) & 7].q[1];
  }
  return h;
}

static sigjmp_buf jb;
static void onsegv(int sig) { (void)sig; siglongjmp(jb, 1); }

int main(void) {
  // a misaligned movdqa operand is #GP: SIGSEGV
  static char raw[64] __attribute__((aligned(16)));
  int faults = 0;
  signal(SIGSEGV, onsegv);
  for (int i = 0; i < 300; ++i) {
    if (!sigsetjmp(jb, 1)) {
      __asm__ volatile("movdqa %0, %%xmm6" : : "m"(*(v128 *)(raw + (i % 3 == 0 ? 16 : 8))) : "xmm6");
    } else {
      ++faults;
    }
  }
  printf("misaligned faults %d\nmoves %016llx\n", faults, (unsigned long long)t_moves());
  uint64_t (*f[])(void) = {t_paddb, t_paddw, t_paddd, t_paddq, t_psubb, t_psubw, t_psubd, t_psubq, t_pand, t_pandn,
                           t_por, t_pxor, t_pcmpeqb, t_pcmpeqw, t_pcmpeqd, t_pcmpgtb, t_pcmpgtw, t_pcmpgtd, t_pminub,
                           t_pmaxub, t_unpcklbw, t_unpcklwd, t_unpckldq, t_unpcklqdq, t_unpckhbw, t_unpckhwd,
                           t_unpckhdq, t_unpckhqdq, t_pshufb, t_pshufd, t_pshufd2, t_palignr4, t_palignr16, t_palignr0,
                           s_psrlw3, s_psraw15, s_psllw16, s_psraw40, s_psrld7, s_psrad31, s_pslld32, s_psrad99,
                           s_psrlq1, s_psllq63, s_psrlq64, s_psllq0, s_psrldq3, s_pslldq5, s_psrldq16, s_pslldq255,
                           t_pmovmskb};
  uint64_t all = 0;
  for (unsigned i = 0; i < sizeof(f) / sizeof(*f); ++i) {
    uint64_t h = f[i]();
    printf("%02u %016llx\n", i, (unsigned long long)h);
    all = all * 31 + h;
  }
  // glibc's SSE2 string functions over many lengths and alignments
  static char buf[4096];
  uint64_t s = 0;
  for (int i = 0; i < 4000; ++i) {
    int off = rnd() % 64, len = rnd() % 300;
    memset(buf + off, 'a' + i % 26, len);
    buf[off + len] = 0;
    s = s * 33 + strlen(buf + off) + (memchr(buf + off, 'a' + (i + 3) % 26, len) != 0) + (strchr(buf + off, 'z') != 0);
  }
  printf("strings %016llx\nall %016llx\n", (unsigned long long)s, (unsigned long long)all);
  return 0;
}
