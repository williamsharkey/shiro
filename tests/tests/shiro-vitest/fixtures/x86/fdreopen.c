/* open() of /proc/self/fd/N and /dev/fd/N is a new description of what the
 * fd refers to (Linux; LTP splice07, bash's <(…)): a pipe's other end, a
 * file with its own offset, a memfd's contents. */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void) {
  char path[64], buf[32] = {0};
  int p[2];
  if (pipe(p)) return 1;
  snprintf(path, sizeof path, "/proc/self/fd/%d", p[0]);
  int w = open(path, O_WRONLY);  /* the write end, through the read end */
  ssize_t n = write(w, "pipe", 4);
  n = read(p[0], buf, sizeof buf - 1);
  printf("pipe %s\n", n > 0 ? buf : "?");

  int f = open("reopen.tmp", O_RDWR | O_CREAT | O_TRUNC, 0644);
  n = write(f, "file", 4);
  snprintf(path, sizeof path, "/dev/fd/%d", f);
  int g = open(path, O_RDONLY);
  memset(buf, 0, sizeof buf);
  n = read(g, buf, sizeof buf - 1);
  printf("file %s offset %ld\n", n > 0 ? buf : "?", (long)lseek(f, 0, SEEK_CUR));
  unlink("reopen.tmp");

  int m = memfd_create("x", 0);
  n = write(m, "memfd", 5);
  snprintf(path, sizeof path, "/proc/self/fd/%d", m);
  int r = open(path, O_RDONLY);
  memset(buf, 0, sizeof buf);
  n = read(r, buf, sizeof buf - 1);
  printf("memfd %s ro-write %s\n", n > 0 ? buf : "?", write(r, "x", 1) < 0 ? "refused" : "allowed");
  return 0;
}
