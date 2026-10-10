/* fcntl leases (LTP fcntl27): a read lease on a file open for writing is
 * EAGAIN; on a read-only open it is granted, and F_GETLEASE reports it.
 * Expected: rdwr/wronly EAGAIN, "rdonly rdlck ok get 0", "unlck ok get 2".
 * Needs Blink to pass F_SETLEASE/F_GETLEASE (1024/1025) to the kernel. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static const char *res(int r) { return r < 0 ? strerror(errno) : "ok"; }

int main(void) {
  int w = open("lease.tmp", O_RDWR | O_CREAT | O_TRUNC, 0777);
  printf("rdwr rdlck %s\n", res(fcntl(w, F_SETLEASE, F_RDLCK)));
  close(w);
  w = open("lease.tmp", O_WRONLY, 0);
  printf("wronly rdlck %s\n", res(fcntl(w, F_SETLEASE, F_RDLCK)));
  close(w);
  int r = open("lease.tmp", O_RDONLY);
  const char *a = res(fcntl(r, F_SETLEASE, F_RDLCK));
  printf("rdonly rdlck %s get %d\n", a, fcntl(r, F_GETLEASE));
  a = res(fcntl(r, F_SETLEASE, F_UNLCK));
  printf("unlck %s get %d\n", a, fcntl(r, F_GETLEASE));
  close(r);
  unlink("lease.tmp");
  return 0;
}
