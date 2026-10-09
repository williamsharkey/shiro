// SSE4.1 and SSE4.2 against native: random operands through every
// instruction (register and memory forms, every immediate that matters),
// one hash per instruction family. Build with -msse4.2.
#include <nmmintrin.h>
#include <smmintrin.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint64_t seed = 0x9e3779b97f4a7c15ull;
static uint64_t rnd(void) {
  seed ^= seed << 13;
  seed ^= seed >> 7;
  seed ^= seed << 17;
  return seed;
}

// mostly small values from a few classes, so compares and string ops match
static __m128i rv(void) {
  uint8_t b[16];
  int kind = rnd() % 4;
  for (int i = 0; i < 16; ++i) {
    uint64_t r = rnd();
    switch (kind) {
      case 0: b[i] = r; break;                   // anything
      case 1: b[i] = "abc\0xyz,"[r % 8]; break;  // short strings with zeros
      case 2: b[i] = r % 3 ? r % 4 : 0x80 | (r % 4); break;
      default: b[i] = r % 5 ? 'a' + r % 6 : 0; break;
    }
  }
  __m128i v;
  memcpy(&v, b, 16);
  return v;
}

static const float kF[] = {0.f, -0.f, 0.5f, -0.5f, 1.5f, 2.5f, -2.5f, 1e30f, -1e-30f,
                           3.7f, -3.7f, 8388607.5f, 1.f / 0.f, -1.f / 0.f};
static const double kD[] = {0., -0., 0.5, -0.5, 1.5, 2.5, -2.5, 1e300, -1e-300,
                            3.7, -3.7, 4503599627370495.5, 1. / 0., -1. / 0.};
static __m128 rps(void) {
  float f[4];
  for (int i = 0; i < 4; ++i) {
    f[i] = rnd() % 2 ? kF[rnd() % 14] : (float)((int64_t)rnd() % 20000) / 64.f;
  }
  return _mm_loadu_ps(f);
}
static __m128d rpd(void) {
  double d[2];
  for (int i = 0; i < 2; ++i) {
    d[i] = rnd() % 2 ? kD[rnd() % 14] : (double)((int64_t)rnd() % 2000000) / 1024.;
  }
  return _mm_loadu_pd(d);
}

static uint64_t h;
static void mix(const void *p, size_t n) {
  const uint8_t *b = p;
  for (size_t i = 0; i < n; ++i) h = (h ^ b[i]) * 0x100000001b3ull;
}
#define MIX(x)                \
  do {                        \
    __typeof__(x) t_ = (x);   \
    mix(&t_, sizeof(t_));     \
  } while (0)
static void report(const char *name) {
  printf("%-10s %016llx\n", name, (unsigned long long)h);
  h = 0xcbf29ce484222325ull;
}

#define N 400
#define I2(M, b) M(b) M(b + 1)
#define I4(M, b) I2(M, b) I2(M, b + 2)
#define I8(M, b) I4(M, b) I4(M, b + 4)
#define I16(M, b) I8(M, b) I8(M, b + 8)
#define I32(M, b) I16(M, b) I16(M, b + 16)
#define I64(M, b) I32(M, b) I32(M, b + 32)
#define I128(M, b) I64(M, b) I64(M, b + 64)

static __m128i mem[2] __attribute__((aligned(16)));
static volatile int sink;

int main(void) {
  h = 0xcbf29ce484222325ull;

  for (int n = 0; n < N; ++n) {
    __m128i a = rv(), b = rv(), k = rv();
    MIX(_mm_blendv_epi8(a, b, k));
    MIX(_mm_blendv_ps(_mm_castsi128_ps(a), _mm_castsi128_ps(b), _mm_castsi128_ps(k)));
    MIX(_mm_blendv_pd(_mm_castsi128_pd(a), _mm_castsi128_pd(b), _mm_castsi128_pd(k)));
    mem[0] = b;
    MIX(_mm_blendv_epi8(a, *(volatile __m128i *)&mem[0], k));
  }
  report("blendv");

  for (int n = 0; n < N; ++n) {
    __m128i a = rv(), b = rnd() % 3 ? rv() : _mm_andnot_si128(a, rv());
    MIX(_mm_testz_si128(a, b));
    MIX(_mm_testc_si128(a, b));
    MIX(_mm_testnzc_si128(a, b));
    mem[0] = b;
    MIX(_mm_testz_si128(a, *(volatile __m128i *)&mem[0]));
  }
  report("ptest");

  for (int n = 0; n < N; ++n) {
    __m128i a = _mm_set_epi64x(rnd(), rnd());
    MIX(_mm_cvtepi8_epi16(a));
    MIX(_mm_cvtepi8_epi32(a));
    MIX(_mm_cvtepi8_epi64(a));
    MIX(_mm_cvtepi16_epi32(a));
    MIX(_mm_cvtepi16_epi64(a));
    MIX(_mm_cvtepi32_epi64(a));
    MIX(_mm_cvtepu8_epi16(a));
    MIX(_mm_cvtepu8_epi32(a));
    MIX(_mm_cvtepu8_epi64(a));
    MIX(_mm_cvtepu16_epi32(a));
    MIX(_mm_cvtepu16_epi64(a));
    MIX(_mm_cvtepu32_epi64(a));
    // memory forms (8, 4 and 2 bytes, unaligned)
    uint8_t buf[24];
    memcpy(buf + 3, &a, 16);
    __m128i r;
    __asm__ volatile("pmovsxbw %1, %0" : "=x"(r) : "m"(*(uint64_t *)(buf + 3)));
    MIX(r);
    __asm__ volatile("pmovzxbd %1, %0" : "=x"(r) : "m"(*(uint32_t *)(buf + 3)));
    MIX(r);
    __asm__ volatile("pmovsxbq %1, %0" : "=x"(r) : "m"(*(uint16_t *)(buf + 3)));
    MIX(r);
    __asm__ volatile("pmovzxwq %1, %0" : "=x"(r) : "m"(*(uint32_t *)(buf + 3)));
    MIX(r);
    __asm__ volatile("pmovsxdq %1, %0" : "=x"(r) : "m"(*(uint64_t *)(buf + 3)));
    MIX(r);
  }
  report("pmovx");

  for (int n = 0; n < N; ++n) {
    __m128i a = _mm_set_epi64x(rnd(), rnd()), b = rnd() % 4 ? _mm_set_epi64x(rnd(), rnd()) : a;
    if (rnd() % 2) b = _mm_insert_epi64(b, _mm_extract_epi64(a, 0), 0);
    MIX(_mm_mul_epi32(a, b));
    MIX(_mm_cmpeq_epi64(a, b));
    MIX(_mm_cmpgt_epi64(a, b));
    MIX(_mm_packus_epi32(a, b));
    MIX(_mm_min_epi8(a, b));
    MIX(_mm_max_epi8(a, b));
    MIX(_mm_min_epu16(a, b));
    MIX(_mm_max_epu16(a, b));
    MIX(_mm_min_epi32(a, b));
    MIX(_mm_max_epi32(a, b));
    MIX(_mm_min_epu32(a, b));
    MIX(_mm_max_epu32(a, b));
    MIX(_mm_minpos_epu16(a));
    MIX(_mm_minpos_epu16(rv()));
    MIX(_mm_mullo_epi32(a, b));
  }
  report("int");

#define ROUNDS(i)                                       \
  MIX(_mm_round_ps(x, (i)));                            \
  MIX(_mm_round_pd(y, (i)));                            \
  MIX(_mm_round_ss(x2, x, (i)));                        \
  MIX(_mm_round_sd(y2, y, (i)));
  for (int n = 0; n < N; ++n) {
    __m128 x = rps(), x2 = rps();
    __m128d y = rpd(), y2 = rpd();
    I16(ROUNDS, 0)
    // MXCSR rounding control (imm8 bit 2)
    unsigned csr = _mm_getcsr();
    _mm_setcsr((csr & ~0x6000) | (rnd() % 4) << 13);
    MIX(_mm_round_ps(x, 4));
    MIX(_mm_round_sd(y2, y, 4));
    _mm_setcsr(csr);
  }
  report("round");

#define BLENDS(i)                         \
  MIX(_mm_blend_ps(x, x2, (i) & 15));     \
  MIX(_mm_blend_pd(y, y2, (i) & 3));      \
  MIX(_mm_blend_epi16(a, b, (i)));
  for (int n = 0; n < N / 4; ++n) {
    __m128 x = rps(), x2 = rps();
    __m128d y = rpd(), y2 = rpd();
    __m128i a = rv(), b = rv();
    I128(BLENDS, 0)
    I128(BLENDS, 128)
  }
  report("blend");

#define EXTRACT(i)                                   \
  MIX(_mm_extract_epi8(a, (i)));                     \
  MIX(_mm_extract_epi16(a, (i) & 7));                \
  MIX(_mm_extract_epi32(a, (i) & 3));                \
  MIX(_mm_extract_epi64(a, (i) & 1));                \
  MIX(_mm_extract_ps(_mm_castsi128_ps(a), (i) & 3)); \
  MIX(_mm_insert_epi8(a, (int)rnd(), (i)));          \
  MIX(_mm_insert_epi32(a, (int)rnd(), (i) & 3));     \
  MIX(_mm_insert_epi64(a, (long long)rnd(), (i) & 1));
  for (int n = 0; n < N; ++n) {
    __m128i a = _mm_set_epi64x(rnd(), rnd());
    I16(EXTRACT, 0)
    // memory destinations and sources, unaligned
    uint8_t buf[24] = {0};
    __asm__ volatile("pextrb $5, %1, %0" : "=m"(buf[1]) : "x"(a));
    __asm__ volatile("pextrw $3, %1, %0" : "=m"(*(uint16_t *)(buf + 3)) : "x"(a));
    __asm__ volatile("pextrd $2, %1, %0" : "=m"(*(uint32_t *)(buf + 5)) : "x"(a));
    __asm__ volatile("pextrq $1, %1, %0" : "=m"(*(uint64_t *)(buf + 9)) : "x"(a));
    __asm__ volatile("extractps $3, %1, %0" : "=m"(*(uint32_t *)(buf + 17)) : "x"(a));
    mix(buf, sizeof(buf));
    __m128i r = a;
    __asm__ volatile("pinsrb $9, %1, %0" : "+x"(r) : "m"(buf[7]));
    __asm__ volatile("pinsrd $1, %1, %0" : "+x"(r) : "m"(*(uint32_t *)(buf + 6)));
    __asm__ volatile("pinsrq $0, %1, %0" : "+x"(r) : "m"(*(uint64_t *)(buf + 11)));
    MIX(r);
    // 32-bit register destinations are zero extended
    uint64_t g = rnd();
    __asm__ volatile("pextrb $7, %1, %k0" : "+r"(g) : "x"(a));
    MIX(g);
    g = rnd();
    __asm__ volatile("pextrd $3, %1, %k0" : "+r"(g) : "x"(a));
    MIX(g);
    g = rnd();
    __asm__ volatile("extractps $1, %1, %k0" : "+r"(g) : "x"(a));
    MIX(g);
    g = rnd();
    __asm__ volatile(".byte 0x66,0x0f,0x3a,0x15,0xc0,0x06" : "+a"(g) : "x"(a));  // pextrw $6,%xmm0,%eax
  }
  report("insext");

#define INSERTPS(i) MIX(_mm_insert_ps(x, x2, (i)));
  for (int n = 0; n < N / 8; ++n) {
    __m128 x = rps(), x2 = rps();
    I128(INSERTPS, 0)
    I128(INSERTPS, 128)
    float f = (float)(int)rnd();
    __m128 r = x;
    __asm__ volatile("insertps $0x9a, %1, %0" : "+x"(r) : "m"(f));
    MIX(r);
  }
  report("insertps");

#define DPS(i) MIX(_mm_dp_ps(x, x2, (i)));
#define DPD(i) MIX(_mm_dp_pd(y, y2, (i)));
  for (int n = 0; n < N / 8; ++n) {
    __m128 x = rps(), x2 = rps();
    __m128d y = rpd(), y2 = rpd();
    I128(DPS, 0)
    I128(DPS, 128)
    I64(DPD, 0)
  }
  report("dp");

#define MPSAD(i) MIX(_mm_mpsadbw_epu8(a, b, (i)));
  for (int n = 0; n < N; ++n) {
    __m128i a = _mm_set_epi64x(rnd(), rnd()), b = _mm_set_epi64x(rnd(), rnd());
    I8(MPSAD, 0)
  }
  report("mpsadbw");

  for (int n = 0; n < N * 4; ++n) {
    uint64_t c = rnd(), v = rnd();
    MIX(_mm_crc32_u8((uint32_t)c, v));
    MIX(_mm_crc32_u16((uint32_t)c, v));
    MIX(_mm_crc32_u32((uint32_t)c, v));
    MIX(_mm_crc32_u64(c, v));
  }
  report("crc32");

#define ESTR(i)                                                    \
  MIX(_mm_cmpestri(a, la, b, lb, (i)));                            \
  MIX(_mm_cmpestrm(a, la, b, lb, (i)));                            \
  MIX(_mm_cmpestrc(a, la, b, lb, (i)) | _mm_cmpestrz(a, la, b, lb, (i)) << 1 | \
      _mm_cmpestrs(a, la, b, lb, (i)) << 2 | _mm_cmpestro(a, la, b, lb, (i)) << 3);
#define ISTR(i)                                                    \
  MIX(_mm_cmpistri(a, b, (i)));                                    \
  MIX(_mm_cmpistrm(a, b, (i)));                                    \
  MIX(_mm_cmpistrc(a, b, (i)) | _mm_cmpistrz(a, b, (i)) << 1 |     \
      _mm_cmpistrs(a, b, (i)) << 2 | _mm_cmpistro(a, b, (i)) << 3);
  for (int n = 0; n < N / 2; ++n) {
    __m128i a = rv(), b = rv();
    int la = (int)(rnd() % 41) - 20, lb = (int)(rnd() % 41) - 20;
    I128(ESTR, 0)
  }
  report("pcmpestr");
  for (int n = 0; n < N / 2; ++n) {
    __m128i a = rv(), b = rv();
    I128(ISTR, 0)
  }
  report("pcmpistr");
  // 64-bit lengths (REX.W): rax/rdx beyond 32 bits
  for (int n = 0; n < N; ++n) {
    __m128i a = rv(), b = rv();
    long long la = (long long)(rnd() % 3) << 32 | (rnd() % 20), lb = -(long long)(rnd() % 20);
    int r;
    __asm__ volatile("pcmpestri $0x0c, %3, %1" : "=c"(r) : "x"(a), "a"(la), "x"(b), "d"(lb) : "cc");
    MIX(r);
    __asm__ volatile("rex.w pcmpestri $0x44, %3, %1" : "=c"(r) : "x"(a), "a"(la), "x"(b), "d"(lb) : "cc");
    MIX(r);
    mem[1] = b;
    __asm__ volatile("pcmpistri $0x08, %2, %1" : "=c"(r) : "x"(a), "m"(mem[1]) : "cc");
    MIX(r);
  }
  report("pcmpstr64");

  // agent-clis' repro (Bun's first SSE4 instructions)
  {
    static volatile int64_t v64 = 0x1122334455667788LL;
    static volatile int v32 = 7;
    __m128i z = _mm_setzero_si128();
    __m128i a = _mm_insert_epi64(z, v64, 0);
    printf("pinsrq %d\n", _mm_extract_epi64(a, 0) == 0x1122334455667788LL);
    const char hay[16] = "hello, world!!!", nd[16] = ",";
    printf("pcmpestri %d\n", _mm_cmpestri(_mm_loadu_si128((void *)nd), 1,
                                          _mm_loadu_si128((void *)hay), 15,
                                          _SIDD_CMP_EQUAL_ANY));
    printf("crc32 %#x\n", _mm_crc32_u32(0, v32));
  }
  return 0;
}
