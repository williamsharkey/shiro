#define _GNU_SOURCE
// A writable MAP_SHARED mapping of a 27 MB kernel file, as apt maps
// pkgcache.bin: scattered writes reach the file at msync and munmap, and only
// what this process changed goes back (a child's writes through its own
// mapping stay). Blink keeps a hash per 128 bytes, not a copy (0120).
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#define SIZE (27 << 20)
static unsigned long sum(int fd) {
  static char b[1 << 16];
  unsigned long h = 0;
  ssize_t n;
  lseek(fd, 0, SEEK_SET);
  while ((n = read(fd, b, sizeof b)) > 0)
    for (ssize_t i = 0; i < n; i++) h = h * 31 + (unsigned char)b[i];
  return h;
}
int main(void) {
  int fd = open("cache.bin", O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || ftruncate(fd, SIZE)) { perror("file"); return 1; }
  char *p = mmap(0, SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (p == MAP_FAILED) { perror("mmap"); return 1; }
  for (long i = 0; i < SIZE; i += 4093) p[i] = (char)(i * 7);  // scattered
  memcpy(p + 1000, "header", 6);
  printf("msync %d", msync(p, SIZE, MS_SYNC));
  char h[7] = {0};
  pread(fd, h, 6, 1000);
  printf(" file '%s'", h);
  pid_t c = fork();
  if (c == 0) {  // its own mapping: writes the last page, which the parent leaves alone
    char *q = mmap(0, SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    memcpy(q + SIZE - 5, "child", 5);
    munmap(q, SIZE);
    _exit(0);
  }
  int st;
  waitpid(c, &st, 0);
  p[2000] = 'P';
  munmap(p, SIZE);
  char t[6] = {0}, u = 0;
  pread(fd, t, 5, SIZE - 5);
  pread(fd, &u, 1, 2000);
  printf(" child '%s' parent '%c' sum %lx\n", t, u, sum(fd));
  return 0;
}
