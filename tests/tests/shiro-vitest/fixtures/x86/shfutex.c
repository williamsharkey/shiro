/* Fixture for x86-engine.test.ts: parent and child, running at once, hand over through futexes in a MAP_SHARED page (same-instance fork). Build: gcc -static -O1 */
#include <linux/futex.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static long fx(int *a, int op, int v) { return syscall(SYS_futex, a, op, v, 0, 0, 0); }
int main() {
  int *p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  pid_t c = fork();
  if (c == 0) {
    while (__atomic_load_n(&p[0], __ATOMIC_SEQ_CST) == 0) fx(&p[0], FUTEX_WAIT, 0);
    p[1] = 2;
    fx(&p[1], FUTEX_WAKE, 1);
    _exit(3);
  }
  struct timespec ts = {0, 100000000};
  nanosleep(&ts, 0);
  __atomic_store_n(&p[0], 1, __ATOMIC_SEQ_CST);
  fx(&p[0], FUTEX_WAKE, 1);
  while (__atomic_load_n(&p[1], __ATOMIC_SEQ_CST) == 0) fx(&p[1], FUTEX_WAIT, 0);
  int st;
  waitpid(c, &st, 0);
  printf("futex across fork: child wrote %d, exit %d\n", p[1], WEXITSTATUS(st));
  return 0;
}
