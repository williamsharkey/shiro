// rep movs/stos of every element size against native: overlapping copies
// both ways (also by less than an element), elements straddling pages,
// DF=1, and a zero count; hashes the buffers and the final rdi/rsi/rcx.
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

static uint64_t h = 0xcbf29ce484222325ull;
static uint8_t *base;
static void mix(const void *p, size_t n) {
  const uint8_t *b = p;
  for (size_t i = 0; i < n; ++i) h = (h ^ b[i]) * 0x100000001b3ull;
}

#define MOVS(sfx)                                                              \
  static void movs##sfx(uint8_t *d, const uint8_t *s, uint64_t c, int down) {  \
    uint64_t r[3];                                                             \
    if (down) __asm__ volatile("std");                                         \
    __asm__ volatile("rep movs" #sfx : "+D"(d), "+S"(s), "+c"(c)::"memory");   \
    __asm__ volatile("cld");                                                   \
    r[0] = d - base, r[1] = s - base, r[2] = c;                        \
    mix(r, sizeof(r));                                                         \
  }                                                                            \
  static void stos##sfx(uint8_t *d, uint64_t v, uint64_t c, int down) {        \
    uint64_t r[2];                                                             \
    if (down) __asm__ volatile("std");                                         \
    __asm__ volatile("rep stos" #sfx : "+D"(d), "+c"(c) : "a"(v) : "memory");  \
    __asm__ volatile("cld");                                                   \
    r[0] = d - base, r[1] = c;                                            \
    mix(r, sizeof(r));                                                         \
  }
MOVS(b)
MOVS(w)
MOVS(l)
MOVS(q)

int main(void) {
  // three pages; addresses are hashed relative to the buffer
  uint8_t *buf = base = mmap(0, 3 * 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  uint64_t seed = 1;
  int offs[] = {0, 1, 3, 7, 4090, 4093, 4095, 4096 - 16};
  long deltas[] = {-64, -9, -8, -5, -1, 1, 5, 8, 9, 64, 3000};
  uint64_t counts[] = {0, 1, 2, 7, 8, 100, 513};
  void (*mv[])(uint8_t *, const uint8_t *, uint64_t, int) = {movsb, movsw, movsl, movsq};
  void (*st[])(uint8_t *, uint64_t, uint64_t, int) = {stosb, stosw, stosl, stosq};
  for (int e = 0; e < 4; ++e) {
    for (unsigned o = 0; o < sizeof(offs) / sizeof(*offs); ++o) {
      for (unsigned d = 0; d < sizeof(deltas) / sizeof(*deltas); ++d) {
        for (unsigned c = 0; c < sizeof(counts) / sizeof(*counts); ++c) {
          for (int down = 0; down < 2; ++down) {
            for (int i = 0; i < 3 * 4096; ++i) buf[i] = (seed = seed * 6364136223846793005ull + 1) >> 56;
            long n = (long)counts[c] << e;
            long src = 4096 + offs[o], dst = src + deltas[d];
            if (down) src += n - (1 << e), dst += n - (1 << e);
            long lo = (down ? dst - n : dst), hi = (down ? dst + (1 << e) : dst + n);
            long slo = (down ? src - n : src), shi = (down ? src + (1 << e) : src + n);
            if (lo < 0 || hi > 3 * 4096 || slo < 0 || shi > 3 * 4096) continue;
            mv[e](buf + dst, buf + src, counts[c], down);
            mix(buf, 3 * 4096);
            st[e](buf + dst, 0x0102030405060708ull + seed, counts[c], down);
            mix(buf, 3 * 4096);
          }
        }
      }
    }
    printf("size %d %016llx\n", 1 << e, (unsigned long long)h);
  }
  return 0;
}
