#define _GNU_SOURCE
// Shared mappings whose length isn't a whole number of pages, as Firefox's
// 242,716-byte memfd:mozilla-ipc region: each is unmapped with its own
// length, a rounded one and in parts, and one is left for exit. Blink 0112
// asserted at memorymalloc.c:834 freeing the last, partial page. Then a
// /dev/shm object written through a mapping keeps the bytes after its last
// munmap and close (Open POSIX shm_open_28-1).
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#define ODD 242716
static int check(const char *what, char *p, long n) {
  if (p == MAP_FAILED) { perror(what); return 1; }
  memset(p, 'x', n);
  p[n - 1] = 'y';
  return 0;
}
int main(void) {
  int fd = memfd_create("mozilla-ipc", MFD_CLOEXEC);
  if (fd < 0 || ftruncate(fd, ODD)) { perror("memfd"); return 1; }
  char *p = mmap(0, ODD, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (check("memfd map", p, ODD)) return 1;
  printf("memfd munmap %d\n", munmap(p, ODD));
  p = mmap(0, ODD, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (check("memfd map 2", p, ODD)) return 1;
  char last = p[ODD - 1];
  printf("memfd sees '%c' munmap rounded %d\n", last, munmap(p, (ODD + 4095) & -4096));
  p = mmap(0, ODD, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (check("memfd map 3", p, ODD)) return 1;
  int tail = munmap(p + 57344, ODD - 57344);
  printf("memfd munmap tail %d head %d\n", tail, munmap(p, 57344));
  char *a = mmap(0, 100, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  if (check("anon map", a, 100)) return 1;
  printf("anon munmap %d\n", munmap(a, 100));
  a = mmap(0, 4096 + 100, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  if (check("anon map 2", a, 4096 + 100)) return 1;
  pid_t c = fork();
  if (c == 0) { a[4096] = 'c'; _exit(0); }
  int st;
  waitpid(c, &st, 0);
  last = a[4096];
  printf("anon after fork '%c' munmap rounded %d\n", last, munmap(a, 8192));
  shm_unlink("/shmodd");
  int sfd = shm_open("/shmodd", O_RDWR | O_CREAT, 0600);
  if (sfd < 0 || ftruncate(sfd, 1000)) { perror("shm_open"); return 1; }
  p = mmap(0, 1000, PROT_WRITE, MAP_SHARED, sfd, 0);
  if (p == MAP_FAILED) { perror("shm map"); return 1; }
  strcpy(p, "qwerty");
  munmap(p, 1000);
  close(sfd);
  sfd = shm_open("/shmodd", O_RDONLY, 0);
  char back[8] = {0};
  printf("shm after close '%s'", pread(sfd, back, 6, 0) == 6 ? back : "?");
  p = mmap(0, 1000, PROT_READ, MAP_SHARED, sfd, 0);
  printf(" mapped '%s'\n", p == MAP_FAILED ? "?" : p);
  shm_unlink("/shmodd");
  p = mmap(0, ODD, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);  // left for exit
  a = mmap(0, 100, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  if (check("memfd map 4", p, ODD) || check("anon map 3", a, 100)) return 1;
  printf("done\n");
  return 0;
}
