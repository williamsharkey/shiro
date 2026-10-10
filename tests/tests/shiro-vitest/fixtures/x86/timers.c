#define _GNU_SOURCE
// Blink 0089 (and 0086) + kernel posixtimers.ts: a POSIX timer's signal, taken with
// sigtimedwait while blocked, with its overruns; sched_* as Linux answers
// an unprivileged process (Open POSIX timer_*, sigwait*, sched_*).
#include <errno.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>

int main(void) {
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, SIGUSR1);
  sigprocmask(SIG_BLOCK, &set, 0);
  struct sigevent sev = { .sigev_notify = SIGEV_SIGNAL, .sigev_signo = SIGUSR1 };
  timer_t t;
  if (timer_create(CLOCK_MONOTONIC, &sev, &t)) { perror("timer_create"); return 1; }
  struct itimerspec its = { .it_interval = { 0, 20000000 }, .it_value = { 0, 20000000 } };
  timer_settime(t, 0, &its, 0);
  usleep(150000);
  struct timespec ts = { 1, 0 };
  int sig = sigtimedwait(&set, 0, &ts);
  printf("timer %d overruns %d ", sig == SIGUSR1, timer_getoverrun(t) >= 3);
  timer_delete(t);
  ts.tv_sec = 0, ts.tv_nsec = 30000000;
  printf("timeout %d ", sigtimedwait(&set, 0, &ts) == -1 && errno == EAGAIN);
  struct sched_param p = { 0 };
  int policy = sched_getscheduler(0);
  printf("sched %d %d %d %d\n", policy == SCHED_OTHER && !sched_getparam(0, &p) && p.sched_priority == 0,
         sched_get_priority_max(SCHED_FIFO) == 99, sched_setscheduler(0, SCHED_FIFO, &(struct sched_param){ 10 }) == -1 && errno == EPERM,
         sched_setscheduler(0, SCHED_BATCH, &p) == 0 && sched_getscheduler(0) == SCHED_BATCH);
  return 0;
}
