// A file bigger than SHIROFS's direct-read threshold (public/engines/blink/
// host.mjs), read every way Blink can: pread, SEEK_END, private and shared
// mappings at an offset, a sequential read (which loads it whole), writes.
// big.bin holds byte i = (i * 7 + (i >> 12)) & 255.
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

// Every 61st byte (and the last): emulating a loop over all of them takes seconds
static unsigned sum(const unsigned char *p, long n) {
  unsigned s = 0;
  for (long i = 0; i < n; i += 61) s = s * 31 + p[i];
  if (n) s = s * 31 + p[n - 1];
  return s;
}

int main(void) {
  static unsigned char buf[4096];
  int fd = open("big.bin", O_RDONLY);
  if (fd < 0) { perror("open"); return 1; }
  long size = lseek(fd, 0, SEEK_END);
  printf("size %ld\n", size);
  ssize_t n = pread(fd, buf, 16, 2 * 1048576 + 5);
  printf("pread %zd %u\n", n, sum(buf, n));
  n = pread(fd, buf, 4096, size - 10);
  printf("tail %zd %u\n", n, sum(buf, n));

  unsigned char *p = mmap(0, 1048576 + 123, PROT_READ, MAP_PRIVATE, fd, 1048576);
  if (p == MAP_FAILED) { perror("mmap"); return 1; }
  printf("private %u\n", sum(p, 1048576 + 123));
  munmap(p, 1048576 + 123);
  p = mmap(0, size, PROT_READ, MAP_SHARED, fd, 0);
  if (p == MAP_FAILED) { perror("mmap shared"); return 1; }
  printf("shared %u\n", sum(p, size));
  munmap(p, size);

  // Sequential reads: the whole file, in 4 KiB pieces
  lseek(fd, 0, SEEK_SET);
  unsigned s = 0;
  long total = 0;
  while ((n = read(fd, buf, sizeof buf)) > 0) {
    s = s * 31 + sum(buf, n);
    total += n;
  }
  printf("read %ld %u\n", total, s);
  close(fd);

  fd = open("big.bin", O_RDWR);
  if (pwrite(fd, "WXYZ", 4, size - 4) != 4) { perror("pwrite"); return 1; }
  close(fd);
  fd = open("trunc.bin", O_WRONLY | O_TRUNC);
  if (fd < 0 || write(fd, "x", 1) != 1) { perror("trunc"); return 1; }
  close(fd);
  return 0;
}
