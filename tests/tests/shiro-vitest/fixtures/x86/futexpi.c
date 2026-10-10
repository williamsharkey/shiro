// PI futexes (pthread mutexes with PTHREAD_PRIO_INHERIT: TBB, OpenEXR,
// Blender, where glibc aborted on EINVAL) and FUTEX_WAKE_OP
#define _GNU_SOURCE
#include <errno.h>
#include <linux/futex.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static long fx(uint32_t *u, int op, uint32_t val, const void *ts, uint32_t *u2, uint32_t val3) {
  return syscall(SYS_futex, u, op, val, ts, u2, val3);
}
#define T(name, call) do { errno = 0; long r = call; printf("%s %ld %d\n", name, r, r < 0 ? errno : 0); } while (0)

static pthread_mutex_t mu;
static long counter;

static void *worker(void *arg) {
  (void)arg;
  for (int i = 0; i < 2000; ++i) {
    pthread_mutex_lock(&mu);
    long c = counter;
    if (!(i % 97)) sched_yield();
    counter = c + 1;
    pthread_mutex_unlock(&mu);
  }
  return 0;
}

static struct timespec ts;
static void *timed(void *p) {
  *(int *)p = pthread_mutex_timedlock(&mu, &ts);
  return 0;
}

int main(void) {
  uint32_t u = 0, u2 = 0, tid = syscall(SYS_gettid);
  T("WAKE_OP", fx(&u, FUTEX_WAKE_OP_PRIVATE, 1, (void *)1, &u2, FUTEX_OP(FUTEX_OP_SET, 5, FUTEX_OP_CMP_GT, 1)));
  printf("u2 %u\n", u2);
  T("LOCK_PI", fx(&u, FUTEX_LOCK_PI_PRIVATE, 0, 0, 0, 0));
  printf("owner is me %d\n", u == tid);
  T("LOCK_PI again", fx(&u, FUTEX_LOCK_PI_PRIVATE, 0, 0, 0, 0));
  T("UNLOCK_PI", fx(&u, FUTEX_UNLOCK_PI_PRIVATE, 0, 0, 0, 0));
  printf("word %u\n", u);
  T("UNLOCK_PI unowned", fx(&u, FUTEX_UNLOCK_PI_PRIVATE, 0, 0, 0, 0));
  T("TRYLOCK_PI", fx(&u, FUTEX_TRYLOCK_PI_PRIVATE, 0, 0, 0, 0));
  T("UNLOCK_PI", fx(&u, FUTEX_UNLOCK_PI_PRIVATE, 0, 0, 0, 0));
  // contended, through glibc
  pthread_mutexattr_t a;
  pthread_mutexattr_init(&a);
  pthread_mutexattr_setprotocol(&a, PTHREAD_PRIO_INHERIT);
  pthread_mutex_init(&mu, &a);
  pthread_t t[4];
  for (int i = 0; i < 4; ++i) pthread_create(&t[i], 0, worker, 0);
  for (int i = 0; i < 4; ++i) pthread_join(t[i], 0);
  printf("counter %ld\n", counter);
  // a timed lock on a held PI mutex times out
  pthread_mutex_lock(&mu);
  clock_gettime(CLOCK_REALTIME, &ts);
  ts.tv_nsec += 100000000;
  if (ts.tv_nsec >= 1000000000) ts.tv_sec++, ts.tv_nsec -= 1000000000;
  pthread_t th;
  int rc = -1;
  pthread_create(&th, 0, timed, &rc);
  pthread_join(th, 0);
  printf("timedlock %d\n", rc);
  pthread_mutex_unlock(&mu);
  return 0;
}
