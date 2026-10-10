// scalar SSE double ops over special values (NaN, inf, zeros, denormals,
// integer limits): results and flags as hex, compared with native
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static double vals[] = {0.0, -0.0, 1.0, -1.0, 0.5, -2.5, 3.5, 1e300, -1e300, 4.9e-324, -2.2e-308,
                        2147483647.5, -2147483648.5, 9.3e18, -9.3e18, INFINITY, -INFINITY, NAN, -NAN};
#define N (sizeof(vals) / sizeof(*vals))
static uint64_t bits(double d) { uint64_t u; memcpy(&u, &d, 8); return u; }
static uint64_t h;
static void mix(uint64_t x) { h = (h ^ x) * 0x100000001b3ull; }

#define BIN(insn)                                                                  \
  for (unsigned i = 0; i < N; ++i)                                                 \
    for (unsigned j = 0; j < N; ++j) {                                             \
      double a = vals[i], b = vals[j];                                             \
      __asm__ volatile(insn " %1, %0" : "+x"(a) : "x"(b));                         \
      mix(bits(a));                                                                \
    }

int main(void) {
  for (int rep = 0; rep < 3; ++rep) {  // (again once compiled)
    h = 0xcbf29ce484222325ull;
    BIN("addsd") BIN("subsd") BIN("mulsd") BIN("divsd") BIN("minsd") BIN("maxsd")
    BIN("andpd") BIN("andnpd") BIN("orpd") BIN("xorpd")
    BIN("cmpeqsd") BIN("cmpltsd") BIN("cmplesd") BIN("cmpunordsd") BIN("cmpneqsd") BIN("cmpnltsd")
    BIN("cmpnlesd") BIN("cmpordsd")
    uint64_t arith = h;
    h = 0xcbf29ce484222325ull;
    for (unsigned i = 0; i < N; ++i) {
      for (unsigned j = 0; j < N; ++j) {
        uint64_t f1, f2;
        double a = vals[i], b = vals[j];
        __asm__ volatile("ucomisd %2, %1\n\tpushfq\n\tpop %0" : "=r"(f1) : "x"(a), "x"(b) : "cc");
        __asm__ volatile("comisd %2, %1\n\tpushfq\n\tpop %0" : "=r"(f2) : "x"(a), "x"(b) : "cc");
        mix(f1 & 0x8d5), mix(f2 & 0x8d5);
      }
    }
    uint64_t flags = h;
    h = 0xcbf29ce484222325ull;
    for (unsigned i = 0; i < N; ++i) {
      double a = vals[i], r;
      int64_t q;
      int32_t d;
      __asm__ volatile("sqrtsd %1, %0" : "=x"(r) : "x"(a)); mix(bits(r));
      __asm__ volatile("cvtsd2si %1, %0" : "=r"(q) : "x"(a)); mix(q);
      __asm__ volatile("cvttsd2si %1, %0" : "=r"(q) : "x"(a)); mix(q);
      __asm__ volatile("cvtsd2si %1, %0" : "=r"(d) : "x"(a)); mix((uint32_t)d);
      __asm__ volatile("cvttsd2si %1, %0" : "=r"(d) : "x"(a)); mix((uint32_t)d);
      float s;
      __asm__ volatile("cvtsd2ss %1, %0" : "=x"(s) : "x"(a)); { uint32_t u; memcpy(&u, &s, 4); mix(u); }
      __asm__ volatile("cvtss2sd %1, %0" : "=x"(r) : "x"(s)); mix(bits(r));
      for (int m = 0; m < 4; ++m) {
        switch (m) {
          case 0: __asm__ volatile("roundsd $0, %1, %0" : "=x"(r) : "x"(a)); break;
          case 1: __asm__ volatile("roundsd $1, %1, %0" : "=x"(r) : "x"(a)); break;
          case 2: __asm__ volatile("roundsd $2, %1, %0" : "=x"(r) : "x"(a)); break;
          default: __asm__ volatile("roundsd $3, %1, %0" : "=x"(r) : "x"(a)); break;
        }
        mix(bits(r));
      }
      int mask;
      __asm__ volatile("movmskpd %1, %0" : "=r"(mask) : "x"(a)); mix(mask);
      __asm__ volatile("cvtsi2sdq %1, %0" : "=x"(r) : "r"((int64_t)(i * 0x123456789ll - 99))); mix(bits(r));
    }
    uint64_t conv = h;
    printf("arith %016llx flags %016llx conv %016llx\n", (unsigned long long)arith, (unsigned long long)flags,
           (unsigned long long)conv);
  }
  return 0;
}
