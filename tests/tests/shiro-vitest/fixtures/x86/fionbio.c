// Fixture for x86-engine.test.ts: ioctl(FIONBIO) on /dev/null, a pipe and a
// file sets O_NONBLOCK (libuv does this to every fd; cmake's spawns died).
// Build: gcc -static -O1 -o fionbio fionbio.c
#include <fcntl.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>

static int check(const char *what, int fd) {
  int on = 1, off = 0;
  int a = ioctl(fd, FIONBIO, &on), fa = fcntl(fd, F_GETFL) & O_NONBLOCK;
  int b = ioctl(fd, FIONBIO, &off), fb = fcntl(fd, F_GETFL) & O_NONBLOCK;
  printf("%s %d %d %d %d\n", what, a, !!fa, b, !!fb);
  return a || !fa || b || fb;
}

int main(int argc, char **argv) {
  int p[2], bad = 0;
  if (pipe(p)) return 2;
  bad |= check("devnull", open("/dev/null", O_RDONLY));
  bad |= check("pipe", p[0]);
  bad |= check("file", open(argv[0], O_RDONLY));
  return bad;
}
