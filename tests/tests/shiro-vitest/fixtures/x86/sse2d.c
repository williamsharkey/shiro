// SSE2 double ops over edge values (±0, denormals, ±inf, NaN, out-of-range
// conversions), hashed per op: x86-engine.test.ts compares with native. sqrtpd
// and the float -> int conversions were wrong (librsvg gradients, patch 0073)
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
static double V[] = {0.0, -0.0, 1.0, -1.5, 3.25, 1e300, -1e-310, INFINITY, -INFINITY, NAN, 0.1, 16.0};
#define N (int)(sizeof(V) / sizeof(V[0]))
static uint64_t B(double d) { uint64_t u; memcpy(&u, &d, 8); return u; }
#define SS(name, insn) \
  static double name(double a, double b) { __asm__(insn " %1, %0" : "+x"(a) : "x"(b)); return a; }
SS(addsd, "addsd") SS(subsd, "subsd") SS(mulsd, "mulsd") SS(divsd, "divsd")
SS(minsd, "minsd") SS(maxsd, "maxsd") SS(sqrtsd, "sqrtsd")
SS(andpd, "andpd") SS(andnpd, "andnpd") SS(orpd, "orpd") SS(xorpd, "xorpd")
SS(unpcklpd, "unpcklpd") SS(unpckhpd, "unpckhpd")
SS(cmpeq, "cmpeqsd") SS(cmplt, "cmpltsd") SS(cmple, "cmplesd") SS(cmpunord, "cmpunordsd")
SS(cmpneq, "cmpneqsd") SS(cmpnlt, "cmpnltsd") SS(cmpnle, "cmpnlesd") SS(cmpord, "cmpordsd")
SS(addpd, "addpd") SS(mulpd, "mulpd") SS(minpd, "minpd") SS(maxpd, "maxpd") SS(divpd, "divpd")
SS(subpd, "subpd") SS(sqrtpd, "sqrtpd")
static int ucomi(double a, double b) { uint64_t f; __asm__("ucomisd %1, %2; pushfq; pop %0" : "=r"(f) : "x"(b), "x"(a)); return f & 0x8c5; }
static int comi(double a, double b) { uint64_t f; __asm__("comisd %1, %2; pushfq; pop %0" : "=r"(f) : "x"(b), "x"(a)); return f & 0x8c5; }
static int64_t cvtt(double a) { int64_t r; __asm__("cvttsd2si %1, %0" : "=r"(r) : "x"(a)); return r; }
static int64_t cvt(double a) { int64_t r; __asm__("cvtsd2si %1, %0" : "=r"(r) : "x"(a)); return r; }
static int32_t cvtt32(double a) { int32_t r; __asm__("cvttsd2si %1, %0" : "=r"(r) : "x"(a)); return r; }
static float cvtss(double a) { float r; __asm__("cvtsd2ss %1, %0" : "=x"(r) : "x"(a)); return r; }
static double cvtsd(float a) { double r; __asm__("cvtss2sd %1, %0" : "=x"(r) : "x"(a)); return r; }
static double shufpd(double a, double b) { __asm__("shufpd $1, %1, %0" : "+x"(a) : "x"(b)); return a; }
static uint64_t h = 1469598103934665603ull;
static void mix(uint64_t x) { h = (h ^ x) * 1099511628211ull; }
int main(void) {
  double (*f[])(double, double) = {addsd, subsd, mulsd, divsd, minsd, maxsd, sqrtsd, andpd, andnpd, orpd, xorpd,
    unpcklpd, unpckhpd, cmpeq, cmplt, cmple, cmpunord, cmpneq, cmpnlt, cmpnle, cmpord, addpd, mulpd, minpd, maxpd,
    divpd, subpd, sqrtpd, shufpd};
  const char *n[] = {"addsd", "subsd", "mulsd", "divsd", "minsd", "maxsd", "sqrtsd", "andpd", "andnpd", "orpd", "xorpd",
    "unpcklpd", "unpckhpd", "cmpeqsd", "cmpltsd", "cmplesd", "cmpunordsd", "cmpneqsd", "cmpnltsd", "cmpnlesd", "cmpordsd",
    "addpd", "mulpd", "minpd", "maxpd", "divpd", "subpd", "sqrtpd", "shufpd"};
  for (int k = 0; k < (int)(sizeof(f) / sizeof(f[0])); k++) {
    h = 1469598103934665603ull;
    for (int i = 0; i < N; i++) for (int j = 0; j < N; j++) mix(B(f[k](V[i], V[j])));
    printf("%-10s %016llx\n", n[k], (unsigned long long)h);
  }
  h = 1469598103934665603ull;
  for (int i = 0; i < N; i++) for (int j = 0; j < N; j++) { mix(ucomi(V[i], V[j])); }
  printf("%-10s %016llx\n", "ucomisd", (unsigned long long)h);
  h = 1469598103934665603ull;
  for (int i = 0; i < N; i++) for (int j = 0; j < N; j++) { mix(comi(V[i], V[j])); }
  printf("%-10s %016llx\n", "comisd", (unsigned long long)h);
  h = 1469598103934665603ull;
  for (int i = 0; i < N; i++) { mix(cvtt(V[i])); mix(cvt(V[i])); mix(cvtt32(V[i])); float s = cvtss(V[i]); uint32_t u; memcpy(&u, &s, 4); mix(u); mix(B(cvtsd(s))); }
  printf("%-10s %016llx\n", "cvt", (unsigned long long)h);
  return 0;
}
