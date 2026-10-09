// mul/div/bit-op loop for the wasm JIT (the forms Go code uses). Build: gcc -static -O2 -o arith arith.c
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
int main(int argc, char **argv) {
  long n = argc > 1 ? atol(argv[1]) : 10000000;
  volatile uint64_t md = 1000003;
  uint64_t x = 88172645463325252ull, s = 0, m = md, bits = 0;
  struct timespec a, b;
  clock_gettime(CLOCK_MONOTONIC, &a);
  for (long i = 0; i < n; ++i) {
    x = x * 6364136223846793005ull + 1442695040888963407ull;
    s += x % m;                                              // divq
    s ^= (uint64_t)(((unsigned __int128)x * s) >> 64);      // mulq
    bits ^= 1ull << (x & 63);                                // btc
    s += __builtin_ctzll(x | 1) + (uint16_t)(s >> 3) * 3;    // bsf, 16-bit
  }
  clock_gettime(CLOCK_MONOTONIC, &b);
  printf("arith %ld s=%llu bits=%llx %ldms\n", n, (unsigned long long)s, (unsigned long long)bits,
         (long)((b.tv_sec - a.tv_sec) * 1000 + (b.tv_nsec - a.tv_nsec) / 1000000));
}
