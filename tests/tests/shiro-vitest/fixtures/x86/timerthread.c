// A SIGEV_THREAD timer runs its function in another thread with its value,
// each time it expires (glibc: a helper thread waits in sigwaitinfo for a
// SIGEV_THREAD_ID timer's signal); a fork child doesn't inherit the timer
// (Open POSIX fork_18-1).
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static pthread_t main_thread;
static volatile int runs, value, other;

static void notify(union sigval v) {
  value = v.sival_int;
  other = !pthread_equal(pthread_self(), main_thread);
  runs++;
}

int main(void) {
  struct sigevent se;
  struct itimerspec its;
  timer_t t;
  int i, st;
  main_thread = pthread_self();
  memset(&se, 0, sizeof(se));
  se.sigev_notify = SIGEV_THREAD;
  se.sigev_notify_function = notify;
  se.sigev_value.sival_int = 42;
  if (timer_create(CLOCK_MONOTONIC, &se, &t)) { perror("timer_create"); return 1; }
  memset(&its, 0, sizeof(its));
  its.it_value.tv_nsec = 100 * 1000 * 1000;
  its.it_interval.tv_nsec = 100 * 1000 * 1000;
  timer_settime(t, 0, &its, 0);
  for (i = 0; i < 300 && runs < 3; ++i) usleep(10 * 1000);
  memset(&its, 0, sizeof(its));
  timer_settime(t, 0, &its, 0);
  printf("runs %d value %d other thread %d\n", runs >= 3, value, other);
  fflush(stdout);
  // armed again across a fork: only the parent's runs
  its.it_value.tv_nsec = 200 * 1000 * 1000;
  timer_settime(t, 0, &its, 0);
  runs = 0;
  if (!fork()) {
    usleep(500 * 1000);
    printf("child runs %d\n", runs);
    fflush(stdout);
    _exit(0);
  }
  wait(&st);
  printf("parent runs %d\n", runs);
  timer_delete(t);
  return 0;
}
