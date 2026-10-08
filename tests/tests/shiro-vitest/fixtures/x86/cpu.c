// Blink patches 0015-0017: madvise(MADV_DONTNEED), pextrw, FUTEX_WAIT_BITSET,
// getrandom(GRND_INSECURE). Build: x86_64-linux-musl-gcc -static -O2 cpu.c -o cpu-musl
#include <emmintrin.h>
#include <linux/futex.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

int main(void) {
  // pextrw zero-extends: the upper bits of the destination were left over
  uint64_t r = ~0ull;
  __m128i v = _mm_set_epi16(7, 6, 5, 4, 3, 2, -2, 0);
  __asm__("pextrw $1, %1, %k0" : "+r"(r) : "x"(v));
  printf("pextrw %#llx\n", (unsigned long long)r);

  // MADV_DONTNEED on private anonymous memory: reads back as zeros
  unsigned char *p = mmap(0, 8192, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  memset(p, 0xab, 8192);
  int rc = madvise(p, 8192, MADV_DONTNEED);
  printf("madvise %d %d %d\n", rc, p[0], p[8191]);

  // FUTEX_WAIT_BITSET with an absolute CLOCK_MONOTONIC deadline 50 ms out
  int word = 0;
  struct timespec t0, t1, dl;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  dl = t0;
  dl.tv_nsec += 50000000;
  if (dl.tv_nsec >= 1000000000) dl.tv_sec++, dl.tv_nsec -= 1000000000;
  long w = syscall(SYS_futex, &word, FUTEX_WAIT_BITSET | FUTEX_PRIVATE_FLAG, 0, &dl, 0, FUTEX_BITSET_MATCH_ANY);
  clock_gettime(CLOCK_MONOTONIC, &t1);
  long ms = (t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_nsec - t0.tv_nsec) / 1000000;
  printf("futex_wait_bitset %s %s\n", w == -1 ? "timedout" : "returned", ms >= 40 && ms < 5000 ? "on time" : "wrong time");
  printf("futex_wake_bitset %ld\n", syscall(SYS_futex, &word, FUTEX_WAKE_BITSET | FUTEX_PRIVATE_FLAG, 1, 0, 0, FUTEX_BITSET_MATCH_ANY));

  // getrandom(GRND_INSECURE)
  unsigned char buf[16];
  printf("getrandom %ld\n", syscall(SYS_getrandom, buf, sizeof(buf), 4));
  return 0;
}
