// LTP's checkpoints: two processes (fork) or threads ping-pong on one
// futex word whose value never changes. Each side wakes the other with
// FUTEX_WAKE (retrying until it woke someone) and then waits itself. A
// wake must go to the side already waiting, not to the waker's own wait
// that starts right after it (fork04, waitpid13: tst_checkpoint_wait
// ETIMEDOUT).
#include <errno.h>
#include <linux/futex.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define ROUNDS 30
static unsigned *word;

static int wait1(void) {
  struct timespec t = {1, 0};
  for (;;) {
    long r = syscall(SYS_futex, word, FUTEX_WAIT, *word, &t, 0, 0);
    if (!r) return 0;
    if (errno != EINTR) return -errno;
  }
}

static int wake1(void) {
  for (int i = 0; i < 1000; i++) {
    if (syscall(SYS_futex, word, FUTEX_WAKE, 1, 0, 0, 0) == 1) return 0;
    usleep(1000);
  }
  return -1;
}

static int side(int first) {
  int bad = 0;
  for (int i = 0; i < ROUNDS; i++) {
    if (first || i) bad += wake1() != 0;
    bad += wait1() != 0;
  }
  if (!first) bad += wake1() != 0;
  return bad;
}

static void *thr(void *a) { return (void *)(long)side(0); }

int main(void) {
  word = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  int st, pid = fork();
  if (!pid) _exit(side(0));
  usleep(50000);  // the child waits first
  int pbad = side(1);
  waitpid(pid, &st, 0);
  printf("fork: parent bad %d child bad %d\n", pbad, WIFEXITED(st) ? WEXITSTATUS(st) : -1);
  pthread_t t;
  void *tbad;
  pthread_create(&t, 0, thr, 0);
  usleep(50000);
  pbad = side(1);
  pthread_join(t, &tbad);
  printf("threads: main bad %d thread bad %ld\n", pbad, (long)tbad);
  return 0;
}
