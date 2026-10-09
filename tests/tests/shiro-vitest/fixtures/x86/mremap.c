/* Fixture for x86-engine.test.ts: mremap (apt's DynamicMMap grows its cache
   with MREMAP_MAYMOVE). Build: gcc -static -O1 -o mremap mremap.c */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
int main(void) {
  size_t a = 24 << 20, b = 48 << 20;
  char *p = mmap(0, a, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  memset(p, 7, a);
  /* something mapped right after: growing has to move */
  char *g = mmap(p + a, 4096, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
  char *q = mremap(p, a, b, 0);
  printf("no MAYMOVE: %s\n", q == MAP_FAILED ? strerror(errno) : "ok");
  q = mremap(p, a, b, MREMAP_MAYMOVE);
  if (q == MAP_FAILED) { printf("mremap failed: %s\n", strerror(errno)); return 1; }
  memset(q + a, 9, b - a);
  printf("moved=%d first=%d mid=%d last=%d\n", q != p, q[0], q[a - 1], q[b - 1]);
  /* the old range is free again */
  char *r = mmap(p, 4096, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
  printf("old range free=%d\n", r == p);
  /* shrink in place; the tail is free */
  char *s = mremap(q, b, a, 0);
  r = mmap(q + a, 4096, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
  printf("shrunk same=%d tail free=%d last=%d\n", s == q, r == q + a, s[a - 1]);
  /* MREMAP_FIXED to a chosen place */
  char *t = mmap(0, 1 << 20, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  munmap(t, 1 << 20);
  char *u = mremap(s, 4096, 8192, MREMAP_MAYMOVE | MREMAP_FIXED, t);
  printf("fixed at=%d first=%d\n", u == t, u == MAP_FAILED ? -1 : u[0]);
  /* a read-only mapping keeps its contents when it moves */
  char *v = mmap(0, 8192, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  v[100] = 42;
  mprotect(v, 8192, PROT_READ);
  mmap(v + 8192, 4096, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
  char *w = mremap(v, 8192, 65536, MREMAP_MAYMOVE);
  printf("readonly moved=%d byte=%d\n", w != v, w == MAP_FAILED ? -1 : w[100]);
  (void)g;
  return 0;
}
