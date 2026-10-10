// FUTEX_CMP_REQUEUE / FUTEX_REQUEUE: wake some waiters, move the rest to a
// second futex, where a later wake finds them (LTP futex_cmp_requeue01)
#include <errno.h>
#include <linux/futex.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

#define N 6
static int f1, f2;
static atomic_int woken, ready;

static long fx(int *u, int op, int val, long val2, int *u2, int val3) {
  return syscall(SYS_futex, u, op, val, val2, u2, val3);
}

static void *waiter(void *arg) {
  (void)arg;
  atomic_fetch_add(&ready, 1);
  if (!fx(&f1, FUTEX_WAIT, 0, 0, 0, 0)) atomic_fetch_add(&woken, 1);
  return 0;
}

static void settle(void) { usleep(200000); }

int main(void) {
  pthread_t t[N];
  long r;
  for (int i = 0; i < N; ++i) pthread_create(&t[i], 0, waiter, 0);
  // every waiter has started (a loaded machine takes a while), then has time to block
  while (atomic_load(&ready) < N) usleep(10000);
  settle();
  r = fx(&f1, FUTEX_CMP_REQUEUE, 0, 0, &f2, 1);
  printf("cmp mismatch %ld %d\n", r, r < 0 && errno == EAGAIN);
  r = fx(&f1, FUTEX_CMP_REQUEUE, 2, 3, &f2, 0);
  settle();
  printf("cmp_requeue %ld woken %d\n", r, atomic_load(&woken));
  r = fx(&f1, FUTEX_WAKE, 10, 0, 0, 0);
  settle();
  printf("left on f1 %ld woken %d\n", r, atomic_load(&woken));
  // the moved ones are found at the target right away
  r = fx(&f2, FUTEX_REQUEUE, 1, 10, &f1, 0);
  long r2 = fx(&f1, FUTEX_WAKE, 10, 0, 0, 0);
  for (int i = 0; i < N; ++i) pthread_join(t[i], 0);
  printf("requeue %ld then wake %ld woken %d\n", r, r2, atomic_load(&woken));
  return 0;
}
