/* Fixture for x86-engine.test.ts: cmpps/cmppd/cmpss/cmpsd write all-ones
   masks (Blink stored -1.0, so GTK's branch-free bezier solve never
   converged). Build: gcc -static -O1 -o ssecmp ssecmp.c */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
static int pred(int imm, double x, double y) {
  switch (imm) {
    case 0: return x == y;
    case 1: return x < y;
    case 2: return x <= y;
    case 3: return isnan(x) || isnan(y);
    case 4: return !(x == y);
    case 5: return !(x < y);
    case 6: return !(x <= y);
    default: return !(isnan(x) || isnan(y));
  }
}
#define CMPSD(i) case i: __asm__("cmpsd $" #i ", %1, %0" : "+x"(a) : "x"(b)); break;
#define CMPPD(i) case i: __asm__("cmppd $" #i ", %1, %0" : "+x"(a) : "x"(b)); break;
#define CMPSS(i) case i: __asm__("cmpss $" #i ", %1, %0" : "+x"(a) : "x"(b)); break;
#define CMPPS(i) case i: __asm__("cmpps $" #i ", %1, %0" : "+x"(a) : "x"(b)); break;
typedef double v2d __attribute__((vector_size(16)));
typedef float v4f __attribute__((vector_size(16)));
int main(void) {
  double vals[] = {0.5, 0.75, -1.0, 0.0, NAN, INFINITY};
  int bad = 0, n = 0;
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j)
      for (int imm = 0; imm < 8; ++imm) {
        double x = vals[i], y = vals[j];
        uint64_t want = pred(imm, x, y) ? ~0ull : 0, got[2], hi = 0x1234567811223344ull;
        uint32_t wantf = pred(imm, (float)x, (float)y) ? ~0u : 0, gotf[4];
        v2d a = {x, x}, b = {y, y};
        memcpy((char *)&a + 8, &hi, 8);
        switch (imm) { CMPSD(0) CMPSD(1) CMPSD(2) CMPSD(3) CMPSD(4) CMPSD(5) CMPSD(6) CMPSD(7) }
        memcpy(got, &a, 16);
        bad += got[0] != want || got[1] != hi;
        a = (v2d){x, y}; b = (v2d){y, y};
        switch (imm) { CMPPD(0) CMPPD(1) CMPPD(2) CMPPD(3) CMPPD(4) CMPPD(5) CMPPD(6) CMPPD(7) }
        memcpy(got, &a, 16);
        bad += got[0] != want || got[1] != (pred(imm, y, y) ? ~0ull : 0);
        {
          v4f a = {(float)x, 9.f, 9.f, 9.f}, b = {(float)y, 0.f, 0.f, 0.f};
          switch (imm) { CMPSS(0) CMPSS(1) CMPSS(2) CMPSS(3) CMPSS(4) CMPSS(5) CMPSS(6) CMPSS(7) }
          memcpy(gotf, &a, 16);
          bad += gotf[0] != wantf || gotf[1] != 0x41100000u;
          a = (v4f){(float)x, (float)x, (float)x, (float)x}; b = (v4f){(float)y, (float)y, (float)y, (float)y};
          switch (imm) { CMPPS(0) CMPPS(1) CMPPS(2) CMPPS(3) CMPPS(4) CMPPS(5) CMPPS(6) CMPPS(7) }
          memcpy(gotf, &a, 16);
          for (int k = 0; k < 4; ++k) bad += gotf[k] != wantf;
        }
        ++n;
      }
  printf("ssecmp %d cases, %d wrong\n", n, bad);
  return bad != 0;
}
