// mlock/munlock/mlockall and mmap errors as Linux gives them (Open POSIX
// mlock_8-1, munlock_10-1, mlockall_13-1, mmap_21-1, 23-1, 24-2)
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

static const char *e(int r) { return r == 0 ? "ok" : errno == ENOMEM ? "ENOMEM" : errno == EINVAL ? "EINVAL" : errno == ENODEV ? "ENODEV" : "?"; }
static const char *em(void *p) { return p != MAP_FAILED ? "ok" : e(-1); }

int main(void) {
  void *far = (void *)(LONG_MAX - (LONG_MAX % 4096));
  char *mine = malloc(8192);
  printf("mlock far %s mine %s\n", e(mlock(far, 4096)), e(mlock(mine, 100)));
  printf("munlock far %s mine %s\n", e(munlock(far, 4096)), e(munlock(mine, 100)));
  printf("mlockall 0 %s onfault %s current %s\n", e(mlockall(0)), e(mlockall(MCL_ONFAULT)), e(mlockall(MCL_CURRENT)));
  char name[] = "/tmp/memerrsXXXXXX";
  int fd = mkstemp(name), p[2];
  unlink(name);
  if (fd < 0 || ftruncate(fd, 4096) || pipe(p)) return 1;
  printf("mmap flags ~0 %s pipe %s huge %s\n", em(mmap(0, 4096, PROT_READ | PROT_WRITE, ~0, fd, 0)),
         em(mmap(0, 1024, PROT_READ, MAP_SHARED, p[0], 0)),
         em(mmap((void *)0x80000000, (size_t)-4096, PROT_READ | PROT_WRITE, MAP_FIXED | MAP_SHARED, fd, 0)));
  return 0;
}
