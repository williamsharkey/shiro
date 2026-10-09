// FUTEX_WAKE wakes at most `count` waiters and returns how many it woke;
// a timed FUTEX_WAIT_BITSET ends no earlier than its absolute deadline.
#include <errno.h>
#include <linux/futex.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#define N 6
static int word;
static atomic_int woken;

static long futex(int *uaddr, int op, int val, struct timespec *ts, int v3) {
  return syscall(SYS_futex, uaddr, op, val, ts, 0, v3);
}

static void *waiter(void *arg) {
  (void)arg;
  while (futex(&word, FUTEX_WAIT, 0, 0, 0) && errno == EINTR) {}
  atomic_fetch_add(&woken, 1);
  return 0;
}

int main(void) {
  pthread_t t[N];
  for (int i = 0; i < N; i++) pthread_create(&t[i], 0, waiter, 0);
  usleep(300000);  // let every waiter reach FUTEX_WAIT
  long a = futex(&word, FUTEX_WAKE, 2, 0, 0);
  usleep(200000);
  printf("wake(2)=%ld woken=%d\n", a, atomic_load(&woken));
  long b = futex(&word, FUTEX_WAKE, 1, 0, 0);
  usleep(200000);
  printf("wake(1)=%ld woken=%d\n", b, atomic_load(&woken));
  long c = futex(&word, FUTEX_WAKE, 100, 0, 0);
  for (int i = 0; i < N; i++) pthread_join(t[i], 0);
  printf("wake(100)=%ld woken=%d\n", c, atomic_load(&woken));
  printf("wake(none)=%ld\n", futex(&word, FUTEX_WAKE, 1, 0, 0));

  int clocks[] = {CLOCK_MONOTONIC, CLOCK_REALTIME};
  for (int i = 0; i < 2; i++) {
    struct timespec start, to, end;
    clock_gettime(clocks[i], &start);
    to = start;
    to.tv_nsec += 50010000;
    if (to.tv_nsec >= 1000000000) to.tv_sec++, to.tv_nsec -= 1000000000;
    long r = futex(&word, FUTEX_WAIT_BITSET | (i ? FUTEX_CLOCK_REALTIME : 0), 0, &to, -1);
    int e = errno;
    clock_gettime(clocks[i], &end);
    int early = end.tv_sec < to.tv_sec || (end.tv_sec == to.tv_sec && end.tv_nsec < to.tv_nsec);
    printf("%s bitset wait=%ld timedout=%d early=%d\n", i ? "realtime" : "monotonic", r, e == ETIMEDOUT, early);
  }
  return 0;
}
