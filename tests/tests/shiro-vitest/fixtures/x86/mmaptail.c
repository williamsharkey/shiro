// A file mapping whose length ends mid-page maps the whole last page: the
// rest of it shows the file too, and a MAP_FIXED mapping of another file
// over it shows that one's (Open POSIX mmap_3-1).
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void) {
  char buf[8192];
  int fa = open("a.tmp", O_RDWR | O_CREAT | O_TRUNC, 0600);
  int fb = open("b.tmp", O_RDWR | O_CREAT | O_TRUNC, 0600);
  char *p, *q;
  memset(buf, 'a', sizeof(buf)), write(fa, buf, sizeof(buf));
  memset(buf, 'b', sizeof(buf)), write(fb, buf, sizeof(buf));
  p = mmap(0, 4096 + 2, PROT_READ | PROT_WRITE, MAP_SHARED, fa, 0);
  printf("tail %c\n", p[4096 + 2]);
  q = mmap(p, 4096 + 1, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_FIXED, fb, 0);
  printf("replaced %d tail %c\n", p == q, q[4096 + 2]);
  unlink("a.tmp"), unlink("b.tmp");
  return 0;
}
