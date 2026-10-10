// memfd_create: an anonymous file that reads back what was written, maps
// MAP_SHARED, and is named /memfd:NAME in /proc/self/fd
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
int main(void) {
  int fd = memfd_create("shiro-test", MFD_CLOEXEC);
  if (fd < 0) { perror("memfd_create"); return 1; }
  char buf[64] = {0}, link[256] = {0}, path[64];
  int w = write(fd, "hello memfd", 11);
  int t = ftruncate(fd, 4096);
  int r = pread(fd, buf, 11, 0);
  char *p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
  ssize_t k = readlink(path, link, sizeof(link) - 1);
  printf("write %d trunc %d read %d '%s' map '%.5s' cloexec %d name %s\n", w, t, r, buf,
         p == MAP_FAILED ? "fail" : p, !!(fcntl(fd, F_GETFD) & FD_CLOEXEC),
         k > 0 && strstr(link, "memfd:shiro-test") ? "ok" : link);
  return 0;
}
