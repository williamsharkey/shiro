// rol/ror by constants (SHA-1, hashes) in compiled code: values, CF/OF, and
// the other flags left by an earlier add, read by pushf; loops long enough
// for the JIT, checksummed against native
#include <stdint.h>
#include <stdio.h>

// (OF is undefined for counts other than 1: masked there)
#define R(name, insn, type, reg, fmask)                                                  \
  static uint64_t name(uint64_t seed) {                                          \
    uint64_t sum = 0;                                                            \
    for (int i = 0; i < 3000; ++i) {                                             \
      type x = (type)(seed * 0x9E3779B97F4A7C15ull >> 7);                       \
      uint64_t f;                                                                \
      seed = seed * 6364136223846793005ull + 1442695040888963407ull;             \
      __asm__ volatile("add %2, %0\n\t" insn " %0\n\tpushfq\n\tpop %1"           \
                       : "+" reg(x), "=r"(f)                                     \
                       : reg((type)seed)                                         \
                       : "cc");                                                  \
      sum = sum * 31 + (uint64_t)x + (f & (fmask));                                \
    }                                                                            \
    return sum;                                                                  \
  }

R(rol64_1, "rolq $1,", uint64_t, "r", 0x8d5)
R(rol64_5, "rolq $5,", uint64_t, "r", 0x0d5)
R(rol64_63, "rolq $63,", uint64_t, "r", 0x0d5)
R(ror64_2, "rorq $2,", uint64_t, "r", 0x0d5)
R(ror64_0, "rorq $0,", uint64_t, "r", 0x0d5)
R(rol32_5, "roll $5,", uint32_t, "r", 0x0d5)
R(rol32_31, "roll $31,", uint32_t, "r", 0x0d5)
R(ror32_2, "rorl $2,", uint32_t, "r", 0x0d5)
R(ror32_1, "rorl $1,", uint32_t, "r", 0x8d5)
R(rol8_3, "rolb $3,", uint8_t, "q", 0x0d5)
R(ror8_7, "rorb $7,", uint8_t, "q", 0x0d5)
R(rol8_8, "rolb $8,", uint8_t, "q", 0x0d5)
R(ror8_17, "rorb $17,", uint8_t, "q", 0x0d5)

int main(void) {
  printf("%016llx %016llx %016llx %016llx %016llx\n", (unsigned long long)rol64_1(1), (unsigned long long)rol64_5(2),
         (unsigned long long)rol64_63(3), (unsigned long long)ror64_2(4), (unsigned long long)ror64_0(5));
  printf("%016llx %016llx %016llx %016llx\n", (unsigned long long)rol32_5(6), (unsigned long long)rol32_31(7),
         (unsigned long long)ror32_2(8), (unsigned long long)ror32_1(9));
  printf("%016llx %016llx %016llx %016llx\n", (unsigned long long)rol8_3(10), (unsigned long long)ror8_7(11),
         (unsigned long long)rol8_8(12), (unsigned long long)ror8_17(13));
  // memory operands
  static uint32_t mem[64];
  uint64_t s = 0;
  for (int i = 0; i < 5000; ++i) {
    mem[i & 63] += i * 2654435761u;
    __asm__ volatile("roll $13, %0" : "+m"(mem[i & 63]) : : "cc");
    __asm__ volatile("rorq $3, %0" : "+m"(*(uint64_t *)&mem[(i + 2) & 62]) : : "cc");
    s = s * 33 + mem[i & 63];
  }
  printf("mem %016llx\n", (unsigned long long)s);
  return 0;
}
