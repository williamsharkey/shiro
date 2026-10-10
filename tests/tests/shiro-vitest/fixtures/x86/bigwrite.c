// A write bigger than a kernel channel's data area goes whole to a regular
// file, as on Linux, linked or unlinked (Open POSIX aio_suspend_1-1 writes
// 10 MiB to an unlinked file and checks the count): Blink splits it into
// chunks of the data area, and each must come back whole.
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
  long len = 10L << 20;
  char *b = malloc(len);
  for (long i = 0; i < len; i++) b[i] = (char)(i * 7 + (i >> 20));
  int fd = open("w.tmp", O_CREAT | O_RDWR | O_EXCL, 0600);
  unlink("w.tmp");
  printf("unlinked %ld\n", (long)write(fd, b, len));
  close(fd);
  fd = open("w.tmp", O_CREAT | O_RDWR | O_TRUNC, 0600);
  printf("write %ld\n", (long)write(fd, b, len));
  printf("pwrite %ld\n", (long)pwrite(fd, b, 3L << 20, 1));
  char c;
  if (pread(fd, &c, 1, (2L << 20) + 1) != 1) return 1;
  printf("byte %d\n", c == b[2L << 20]);
  printf("size %ld\n", (long)lseek(fd, 0, SEEK_END));
  close(fd);
  unlink("w.tmp");
  return 0;
}
