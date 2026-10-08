/* POSIX functions wasi-libc declares but does not define. Linked into
 * recipes that need them (see common.sh: COMPAT_SRC). */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* mkstemp(): replace the trailing XXXXXX and create the file exclusively. */
int mkstemp(char *tmpl) {
  static const char chars[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  size_t len = strlen(tmpl);
  if (len < 6 || memcmp(tmpl + len - 6, "XXXXXX", 6) != 0) { errno = EINVAL; return -1; }
  for (int attempt = 0; attempt < 100; attempt++) {
    unsigned char rnd[6];
    if (getentropy(rnd, sizeof rnd) != 0) return -1;
    for (int i = 0; i < 6; i++) tmpl[len - 6 + i] = chars[rnd[i] % (sizeof chars - 1)];
    int fd = open(tmpl, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0 || errno != EEXIST) return fd;
  }
  errno = EEXIST;
  return -1;
}

/* tmpfile(): a real file under /tmp, unlinked once opened. */
FILE *tmpfile(void) {
  char name[] = "/tmp/tmpfileXXXXXX";
  int fd = mkstemp(name);
  if (fd < 0) return NULL;
  unlink(name);
  FILE *f = fdopen(fd, "w+");
  if (!f) close(fd);
  return f;
}
