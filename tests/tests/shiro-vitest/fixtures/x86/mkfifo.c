// mkfifo / mknod(S_IFIFO) / mknodat from a Blink guest create kernel FIFOs;
// devices stay EPERM.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

static void show(const char *what, int r, const char *path) {
  struct stat st;
  int e = errno;
  int fifo = !stat(path, &st) && S_ISFIFO(st.st_mode);
  printf("%s=%d %s fifo=%d\n", what, r, r < 0 ? strerror(e) : "", fifo);
}

int main(void) {
  show("mkfifo", mkfifo("q1", 0644), "q1");
  show("mknod", mknod("q2", S_IFIFO | 0600, 0), "q2");
  int d = open(".", O_RDONLY | O_DIRECTORY);
  show("mknodat", mknodat(d, "q3", S_IFIFO | 0600, 0), "q3");
  int r = mknod("dev", S_IFCHR | 0600, makedev(1, 3));
  printf("chardev=%d %s\n", r, r < 0 ? strerror(errno) : "");
  r = mkfifo("q1", 0644);
  printf("again=%d %s\n", r, r < 0 ? strerror(errno) : "");
  return 0;
}
