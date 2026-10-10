#define _GNU_SOURCE
// memfd seals through Blink (0118) to the kernel's memfds: Firefox seals its
// shared memory against growing and shrinking
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
static void show(const char *what, long r) {
  printf("%s %ld%s%s ", what, r, r < 0 ? " " : "", r < 0 ? strerrorname_np(errno) : "");
}
int main(void) {
  int fd = memfd_create("sealed", MFD_ALLOW_SEALING), p[2];
  if (fd < 0 || write(fd, "hello", 5) != 5) { perror("memfd"); return 1; }
  show("seals", fcntl(fd, F_GET_SEALS));
  show("add", fcntl(fd, F_ADD_SEALS, F_SEAL_GROW | F_SEAL_SHRINK));
  show("seals", fcntl(fd, F_GET_SEALS));
  show("truncate", ftruncate(fd, 1));
  show("grow", pwrite(fd, "x", 1, 5));
  show("overwrite", pwrite(fd, "H", 1, 0));
  show("seal", fcntl(fd, F_ADD_SEALS, F_SEAL_SEAL));
  show("again", fcntl(fd, F_ADD_SEALS, F_SEAL_WRITE));
  printf("\n");
  int plain = memfd_create("plain", 0);
  show("plain seals", fcntl(plain, F_GET_SEALS));
  show("add", fcntl(plain, F_ADD_SEALS, F_SEAL_GROW));
  if (pipe(p)) return 1;
  show("pipe", fcntl(p[0], F_GET_SEALS));
  printf("\n");
  return 0;
}
