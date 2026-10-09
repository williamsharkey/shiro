// /proc/self/maps: the main stack and the program's own mappings are there,
// and glibc's pthread_getattr_np (WebKit's stack bounds in Bun) works
#define _GNU_SOURCE
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void) {
  char line[512], self[64];
  int local, stack = 0, text = 0, anon = 0, lines = 0, ok = 1;
  void *p = mmap(0, 3 * 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  mprotect((char *)p + 4096, 4096, PROT_READ);
  for (int pass = 0; pass < 2; ++pass) {
    if (pass) snprintf(self, sizeof(self), "/proc/%d/maps", getpid());
    FILE *f = fopen(pass ? self : "/proc/self/maps", "r");
    if (!f) { printf("open %s failed\n", pass ? "pid" : "self"); return 1; }
    while (fgets(line, sizeof(line), f)) {
      unsigned long lo, hi;
      char perm[8];
      if (sscanf(line, "%lx-%lx %7s", &lo, &hi, perm) != 3 || lo >= hi) ok = 0;
      if (lo <= (unsigned long)&local && (unsigned long)&local < hi) stack = !!strstr(line, "[stack]") + 1;
      if (lo <= (unsigned long)main && (unsigned long)main < hi) text = perm[2] == 'x';
      if ((unsigned long)p + 4096 == lo && hi == (unsigned long)p + 8192) anon = !strcmp(perm, "r--p");
      ++lines;
    }
    fclose(f);
  }
  pthread_attr_t a;
  void *base;
  size_t size;
  int r = pthread_getattr_np(pthread_self(), &a);
  pthread_attr_getstack(&a, &base, &size);
  int inside = (char *)base <= (char *)&local && (char *)&local < (char *)base + size;
  printf("lines>4 %d well-formed %d stack %d text-x %d mprotect-split %d getattr %d inside %d\n",
         lines > 4, ok, stack, text, anon, r, inside);
  return 0;
}
