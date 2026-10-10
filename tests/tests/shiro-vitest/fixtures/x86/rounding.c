#define _GNU_SOURCE
// Directed rounding (fesetround: MXCSR.RC), as CGAL checks at startup
// ("Wrong rounding: did you forget -frounding-math?"): SSE add, sub, mul,
// div, sqrt and the conversions in every mode, scalar and packed, single and
// double (Blink 0119; its x87 long double is a double, so x87 isn't here).
// Build with -frounding-math.
#include <fenv.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <emmintrin.h>
static volatile double one = 1, three = 3, tiny = 0x1p-60, big = 0x1p60, two = 2, m1 = -1;
static volatile float onef = 1, threef = 3, tinyf = 0x1p-30f;
static unsigned long long bits(double d) { unsigned long long u; memcpy(&u, &d, 8); return u; }
static unsigned bitsf(float f) { unsigned u; memcpy(&u, &f, 4); return u; }
int main(void) {
  static const int modes[] = {FE_TONEAREST, FE_UPWARD, FE_DOWNWARD, FE_TOWARDZERO};
  static const char *names[] = {"near", "up", "down", "zero"};
  for (int i = 0; i < 4; i++) {
    fesetround(modes[i]);
    double add = one + tiny, sub = one - tiny, nsub = m1 - tiny, mul = (one / three) * three, div = one / three, ndiv = m1 / three;
    double sq = sqrt(two), cvt = (double)(big + 1);
    float fadd = onef + tinyf, fdiv = onef / threef, fcvt = (float)div;
    long long ll = __builtin_llrint(2.5);  // cvtsd2si follows the mode
    __m128d p = _mm_div_pd(_mm_set_pd(m1, one), _mm_set_pd(three, three));
    double pd[2];
    _mm_storeu_pd(pd, p);
    printf("%s add %llx sub %llx nsub %llx mul %llx div %llx ndiv %llx sqrt %llx cvt %llx fadd %x fdiv %x fcvt %x rint %lld pd %llx %llx\n",
           names[i], bits(add), bits(sub), bits(nsub), bits(mul), bits(div), bits(ndiv), bits(sq), bits(cvt), bitsf(fadd),
           bitsf(fdiv), bitsf(fcvt), ll, bits(pd[0]), bits(pd[1]));
  }
  // many operands, wide exponents and signs (subnormals, overflow, exact
  // cancellation): a hash of every result per mode
  for (int i = 0; i < 4; i++) {
    fesetround(modes[i]);
    unsigned long long h = 0, x = 88172645463325252ull;
    for (int k = 0; k < 20000; k++) {
      double v[2];
      for (int j = 0; j < 2; j++) {
        x ^= x << 13, x ^= x >> 7, x ^= x << 17;
        unsigned long long u = x;
        if ((u & 7) == 0) u = (u & 0x800fffffffffffffull) | (((u >> 52) & 0x7f) + 1) << 52;  // tiny
        else if ((u & 7) == 1) u = (u & 0x800fffffffffffffull) | (0x7fe - ((u >> 52) & 0x7)) << 52;  // huge
        else u = (u & 0x800fffffffffffffull) | (0x3ff - 30 + ((u >> 52) & 63)) << 52;
        memcpy(&v[j], &u, 8);
      }
      volatile double a = v[0], b = (k % 97 == 0) ? -v[0] : v[1];
      volatile float fa = a, fb = b;
      double r[5] = {a + b, a - b, a * b, a / b, sqrt(fabs(a))};
      float q[5] = {fa + fb, fa - fb, fa * fb, fa / fb, sqrtf(fabsf(fa))};
      for (int j = 0; j < 5; j++) h = (h ^ bits(r[j])) * 0x100000001b3ull, h = (h ^ bitsf(q[j])) * 0x100000001b3ull;
      h = (h ^ bitsf((float)a)) * 0x100000001b3ull;
    }
    printf("%s hash %016llx\n", names[i], h);
  }
  fesetround(FE_TONEAREST);
  return 0;
}
