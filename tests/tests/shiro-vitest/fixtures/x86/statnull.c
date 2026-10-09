/* Fixture for x86-engine.test.ts: the stat family with a NULL buffer is
   EFAULT once the file is found, EBADF/ENOENT before (LTP fstat03).
   Build: gcc -static -O1 -o statnull statnull.c */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
static void show(const char *what, long r) { printf("%s=%ld %s\n", what, r, r ? strerror(errno) : ""); }
int main(void) {
  int fd = open("/tmp/statnull", O_CREAT | O_RDWR, 0600);
  show("fstat(fd, NULL)", syscall(SYS_fstat, fd, 0));
  show("fstat(-1, NULL)", syscall(SYS_fstat, -1, 0));
  show("stat(file, NULL)", syscall(SYS_stat, "/tmp/statnull", 0));
  show("stat(missing, NULL)", syscall(SYS_stat, "/tmp/statnull-missing", 0));
  show("lstat(file, NULL)", syscall(SYS_lstat, "/tmp/statnull", 0));
  show("newfstatat(file, NULL)", syscall(SYS_newfstatat, AT_FDCWD, "/tmp/statnull", 0, 0));
  unlink("/tmp/statnull");
  return 0;
}
