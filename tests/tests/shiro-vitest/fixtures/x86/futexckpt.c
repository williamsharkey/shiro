// LTP checkpoints: 8 forked children wait on a futex in MAP_SHARED memory (a
// file mapping or anonymous) and the parent wakes until it has counted 8
// wakes. A woken waiter used to stay counted until it finished, so a wake in
// that window was counted twice and the last child timed out (patch 0075).
#include <errno.h>
#include <fcntl.h>
#include <linux/futex.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static long fx(volatile int *a, int op, int v, struct timespec *t) { return syscall(SYS_futex, a, op, v, t, 0, 0); }
int main(int argc, char **argv) {
  int useFile = argc > 1 && argv[1][0] == 'f', rounds = argc > 2 ? atoi(argv[2]) : 10, bad = 0;
  for (int r = 0; r < rounds; r++) {
    volatile int *p;
    if (useFile) {
      char name[64]; snprintf(name, sizeof name, "/tmp/ckpt%d", r);
      int fd = open(name, O_RDWR | O_CREAT | O_TRUNC, 0600);
      if (ftruncate(fd, 4096)) return 2;
      p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
      close(fd); unlink(name);
    } else {
      p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    }
    pid_t kids[8];
    for (int i = 0; i < 8; i++) {
      if (!(kids[i] = fork())) {
        struct timespec t = {10, 0};
        long rc = fx(p, FUTEX_WAIT, 0, &t);
        _exit(rc == 0 ? 3 : 10 + errno);
      }
    }
    int woken = 0, ms = 0;
    while (woken < 8 && ms < 10000) { woken += fx(p, FUTEX_WAKE, 0x7fffffff, 0); if (woken < 8) { usleep(1000); ms++; } }
    int ok = 0;
    for (int i = 0; i < 8; i++) { int st; waitpid(kids[i], &st, 0); if (WIFEXITED(st) && WEXITSTATUS(st) == 3) ok++; else printf("  kid %d status %d\n", i, WIFEXITED(st) ? WEXITSTATUS(st) : -WTERMSIG(st)); }
    if (woken != 8 || ok != 8) { bad++; printf("round %d: woken %d ok %d after %d ms\n", r, woken, ok, ms); }
    munmap((void *)p, 4096);
  }
  printf("%s: %d of %d rounds bad\n", useFile ? "file" : "anon", bad, rounds);
  return 0;
}
