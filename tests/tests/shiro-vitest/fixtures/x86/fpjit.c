// Blink 0116: SSE float arithmetic (ss/sd/ps/pd), ucomis/comis flags,
// movd/movq and leave in compiled code: special values (NaN, ±0, ±inf,
// denormals) through loops long enough to be compiled, against native
#include <emmintrin.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
static uint64_t h = 1469598103934665603ull;
// computed NaNs' sign and payload are the engine's choice in wasm (x86 picks
// one by rule): every NaN result counts as one value here
static void canon(void *p, int n, int dbl) {
  unsigned char *c = p;
  for (int i = 0; i < n; i += dbl ? 8 : 4) {
    if (dbl) { double v; memcpy(&v, c + i, 8); if (isnan(v)) memcpy(c + i, &(uint64_t){0x7ff8000000000000ull}, 8); }
    else { float v; memcpy(&v, c + i, 4); if (isnan(v)) memcpy(c + i, &(uint32_t){0x7fc00000u}, 4); }
  }
}
static void mix(const void *p, int n) { const unsigned char *c = p; for (int i = 0; i < n; i++) h = (h ^ c[i]) * 1099511628211ull; }
static double D[] = {0.0, -0.0, 1.0, -1.5, 3.25, 1e308, -1e308, 5e-324, -5e-324, 2.2250738585072014e-308, INFINITY, -INFINITY, NAN, -NAN, 1e-10, 7.0};
static float F[] = {0.0f, -0.0f, 1.0f, -1.5f, 3.25f, 3e38f, -3e38f, 1e-45f, -1e-45f, 1.17549435e-38f, INFINITY, -INFINITY, NAN, -NAN, 1e-10f, 7.0f};
#define ND 16
__attribute__((noinline)) static double sd_ops(double x, double y) {
  __m128d a = _mm_set_sd(x), b = _mm_set_sd(y), r[8];
  r[0] = _mm_add_sd(a, b); r[1] = _mm_sub_sd(a, b); r[2] = _mm_mul_sd(a, b); r[3] = _mm_div_sd(a, b);
  r[4] = _mm_min_sd(a, b); r[5] = _mm_max_sd(a, b); r[6] = _mm_sqrt_sd(a, b); r[7] = _mm_unpacklo_pd(a, b);
  canon(r, sizeof r, 1);
  mix(r, sizeof r);
  return _mm_cvtsd_f64(r[0]);
}
__attribute__((noinline)) static void ss_ops(float x, float y) {
  __m128 a = _mm_set_ps(9, 8, 7, x), b = _mm_set_ps(5, 4, 3, y), r[7];
  r[0] = _mm_add_ss(a, b); r[1] = _mm_sub_ss(a, b); r[2] = _mm_mul_ss(a, b); r[3] = _mm_div_ss(a, b);
  r[4] = _mm_min_ss(a, b); r[5] = _mm_max_ss(a, b); r[6] = _mm_sqrt_ss(b);
  canon(r, sizeof r, 0);
  mix(r, sizeof r);
}
__attribute__((noinline)) static void p_ops(const double *x, const float *y) {
  __m128d a = _mm_loadu_pd(x), b = _mm_loadu_pd(x + 1), r[7];
  __m128 c = _mm_loadu_ps(y), e = _mm_loadu_ps(y + 2), s[7];
  r[0] = _mm_add_pd(a, b); r[1] = _mm_sub_pd(a, b); r[2] = _mm_mul_pd(a, b); r[3] = _mm_div_pd(a, b);
  r[4] = _mm_min_pd(a, b); r[5] = _mm_max_pd(a, b); r[6] = _mm_sqrt_pd(a);
  s[0] = _mm_add_ps(c, e); s[1] = _mm_sub_ps(c, e); s[2] = _mm_mul_ps(c, e); s[3] = _mm_div_ps(c, e);
  s[4] = _mm_min_ps(c, e); s[5] = _mm_max_ps(c, e); s[6] = _mm_sqrt_ps(c);
  canon(r, sizeof r, 1); canon(s, sizeof s, 0);
  mix(r, sizeof r); mix(s, sizeof s);
}
__attribute__((noinline)) static int ucom(double x, double y) {
  int f = 0;
  f |= _mm_ucomieq_sd(_mm_set_sd(x), _mm_set_sd(y)) << 0;
  f |= _mm_ucomilt_sd(_mm_set_sd(x), _mm_set_sd(y)) << 1;
  f |= _mm_ucomile_sd(_mm_set_sd(x), _mm_set_sd(y)) << 2;
  f |= _mm_ucomigt_sd(_mm_set_sd(x), _mm_set_sd(y)) << 3;
  f |= _mm_ucomineq_sd(_mm_set_sd(x), _mm_set_sd(y)) << 4;
  f |= (x < y) << 5; f |= (x >= y) << 6; f |= (x != y) << 7; f |= (x == y) << 8;
  f |= isunordered(x, y) << 9;
  return f;
}
__attribute__((noinline)) static int comf(float x, float y) {
  int f = 0;
  f |= _mm_comieq_ss(_mm_set_ss(x), _mm_set_ss(y)) << 0;
  f |= _mm_comilt_ss(_mm_set_ss(x), _mm_set_ss(y)) << 1;
  f |= _mm_comige_ss(_mm_set_ss(x), _mm_set_ss(y)) << 2;
  f |= (x > y) << 3; f |= (x <= y) << 4;
  return f;
}
__attribute__((noinline, optimize("no-omit-frame-pointer"))) static long framed(long a, volatile long *p) {
  volatile long buf[4] = {a, a + 1, a + 2, a + 3};
  *p += buf[a & 3];
  return buf[(a + 1) & 3];
}
int main(void) {
  volatile long acc = 0;
  for (int rep = 0; rep < 300; rep++) {
    for (int i = 0; i < ND; i++) {
      for (int j = 0; j < ND; j++) {
        double r = sd_ops(D[i], D[j]);
        if (isnan(r)) r = NAN;
        ss_ops(F[i], F[j]);
        int u = ucom(D[i], D[j]), c = 0;
        if (!isnan(F[i]) && !isnan(F[j])) c = comf(F[i], F[j]);  // (comis of NaN would raise IE)
        mix(&u, 4); mix(&c, 4);
        // movq/movd through general registers and memory
        long long bits; memcpy(&bits, &r, 8);
        __m128i v = _mm_cvtsi64_si128(bits ^ j), w = _mm_cvtsi32_si128((int)bits + i);
        long long back = _mm_cvtsi128_si64(v); int back32 = _mm_cvtsi128_si32(w);
        __m128i q = _mm_loadl_epi64((const __m128i *)&D[i]); _mm_storel_epi64((__m128i *)&bits, q);
        __m128i mq = _mm_move_epi64(_mm_set_epi64x(-1, back));
        mix(&back, 8); mix(&back32, 4); mix(&bits, 8); mix(&mq, 16);
        acc += framed(i * ND + j, &acc);
      }
      p_ops(&D[i < ND - 2 ? i : 0], &F[i < ND - 4 ? i : 0]);
    }
  }
  printf("hash %016llx acc %ld\n", (unsigned long long)h, (long)acc);
  return 0;
}
