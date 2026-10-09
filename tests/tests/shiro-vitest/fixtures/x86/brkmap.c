/* Fixture for x86-engine.test.ts: the heap (brk) never grows over a
   mapping, and mmap(0) leaves it room (apt's 120 MB cache was placed at the
   break and malloc's next brk overwrote it). Build: gcc -static -O1 */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
int main(void) {
  /* fill the free space below the program, as a dynamic program's libraries do */
  mmap(0, 128 << 20, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  char *brk0 = sbrk(0);
  char *m = mmap(0, 1 << 20, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  memset(m, 0x5a, 1 << 20);
  printf("mmap(0) clear of the break: %d\n", m >= brk0 + (64 << 20) || m + (1 << 20) <= brk0);
  char *r = sbrk(256 << 10);
  if (r == (char *)-1) { printf("sbrk refused\n"); return 1; }
  memset(r, 0, 256 << 10);
  int ok = 1;
  for (int i = 0; i < (1 << 20); i++) ok &= m[i] == 0x5a;
  printf("mapping intact: %d\n", ok);
  /* a mapping placed right at the break: brk must fail, not replace it */
  char *top = sbrk(0);
  char *f = mmap(top, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
  f[0] = 0x77;
  r = sbrk(8192);
  printf("sbrk over a mapping refused: %d, mapping kept: %d\n", r == (char *)-1, f[0] == 0x77);
  return 0;
}
