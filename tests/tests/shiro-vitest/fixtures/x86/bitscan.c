// BSF/BSR with a zero source leave the destination unchanged (LLVM's
// ctlz/cttz rely on it: mov $127,%r8; bsr %rax,%r8; xor $63,%r8), and set
// ZF; a nonzero source writes the index. Register and memory sources.
#include <stdint.h>
#include <stdio.h>

static volatile uint64_t zero64 = 0, val64 = 0x0010000000000100ull;
static volatile uint32_t zero32 = 0, val32 = 0x00100100;
static volatile uint16_t zero16 = 0, val16 = 0x0110;

#define SCAN(op, sfx, T, src)                                              \
  do {                                                                     \
    uint64_t d = 0x1122334455667788ull;                                    \
    uint8_t zf;                                                            \
    T s = src;                                                             \
    __asm__ volatile(op sfx " %2, %" W "0; setz %1"                        \
                     : "+r"(d), "=q"(zf) : "r"(s) : "cc");                 \
    printf("%-4s %-8s reg dst=%#llx zf=%d\n", op, #src, (unsigned long long)d, zf); \
    d = 0x1122334455667788ull;                                             \
    __asm__ volatile(op sfx " %2, %" W "0; setz %1"                        \
                     : "+r"(d), "=q"(zf) : "m"(src) : "cc");               \
    printf("%-4s %-8s mem dst=%#llx zf=%d\n", op, #src, (unsigned long long)d, zf); \
  } while (0)

// LLVM's leading_zeros(x) for u64
static unsigned clz64(uint64_t x) {
  uint64_t r = 127;
  __asm__("bsr %1, %0" : "+r"(r) : "r"(x) : "cc");
  return r ^ 63;
}

int main(void) {
#define W "q"
  SCAN("bsf", "q", uint64_t, zero64);
  SCAN("bsr", "q", uint64_t, zero64);
  SCAN("bsf", "q", uint64_t, val64);
  SCAN("bsr", "q", uint64_t, val64);
#undef W
#define W "k"
  SCAN("bsf", "l", uint32_t, zero32);
  SCAN("bsr", "l", uint32_t, zero32);
  SCAN("bsf", "l", uint32_t, val32);
  SCAN("bsr", "l", uint32_t, val32);
#undef W
#define W "w"
  SCAN("bsf", "w", uint16_t, zero16);
  SCAN("bsr", "w", uint16_t, zero16);
  SCAN("bsf", "w", uint16_t, val16);
  SCAN("bsr", "w", uint16_t, val16);
  printf("clz64(0)=%u clz64(1)=%u clz64(1<<40)=%u\n", clz64(zero64), clz64(1), clz64(1ull << 40));
  // a loop, so the JIT compiles it
  unsigned sum = 0;
  for (int i = 0; i < 100000; i++) sum += clz64(i & 7 ? 0 : (uint64_t)i << 20);
  printf("loop sum=%u\n", sum);
  return 0;
}
