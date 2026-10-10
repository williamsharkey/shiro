// LD_PRELOAD (diagnostics): at exit, save every region that was mapped or mprotect'ed executable (a JIT's
// output, e.g. llvmpipe's shaders) to $DUMPX_DIR/ADDR.bin, for objdump -D -b binary -m i386:x86-64 --adjust-vma=0xADDR.
// Build: gcc -shared -fPIC -O2 -o dumpx.so dumpx.c -ldl
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>
static struct { void *a; size_t n; } regions[4096]; static int nreg;
static void note(void *a, size_t n) { for (int i = 0; i < nreg; i++) if (regions[i].a == a) { regions[i].n = n; return; } if (nreg < 4096) { regions[nreg].a = a; regions[nreg].n = n; nreg++; } }
void *mmap(void *addr, size_t len, int prot, int flags, int fd, off_t off) {
  static void *(*real)(void *, size_t, int, int, int, off_t);
  if (!real) real = dlsym(RTLD_NEXT, "mmap");
  void *r = real(addr, len, prot, flags, fd, off);
  if (r != MAP_FAILED && (prot & PROT_EXEC) && fd < 0) note(r, len);
  return r;
}
int mprotect(void *addr, size_t len, int prot) {
  static int (*real)(void *, size_t, int);
  if (!real) real = dlsym(RTLD_NEXT, "mprotect");
  int r = real(addr, len, prot);
  if (r == 0 && (prot & PROT_EXEC)) note(addr, len);
  return r;
}
__attribute__((destructor)) static void dump(void) {
  const char *dir = getenv("DUMPX_DIR");
  if (!dir) return;
  for (int i = 0; i < nreg; i++) {
    char path[256]; snprintf(path, sizeof path, "%s/%lx.bin", dir, (unsigned long)regions[i].a);
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) { ssize_t w = write(fd, regions[i].a, regions[i].n); (void)w; close(fd); }
  }
}
