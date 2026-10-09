// CPU-time clocks (GHC's runtime reads CLOCK_THREAD_CPUTIME_ID and the
// pthread_getcpuclockid id) and epoll_wait with maxevents above 4096
// (Redis passes maxclients + 128): both worked natively, failed in Blink
#define _GNU_SOURCE
#include <pthread.h>
#include <stdio.h>
#include <sys/epoll.h>
#include <time.h>
#include <unistd.h>

static int ok(clockid_t c) {
  struct timespec a, b, r;
  if (clock_gettime(c, &a) || clock_getres(c, &r)) return 0;
  for (volatile long i = 0; i < 2000000; i++) {}
  if (clock_gettime(c, &b)) return 0;
  return (b.tv_sec > a.tv_sec || (b.tv_sec == a.tv_sec && b.tv_nsec >= a.tv_nsec)) && r.tv_sec == 0 && r.tv_nsec > 0;
}

int main(void) {
  clockid_t pc, tc;
  int gp = clock_getcpuclockid(0, &pc), gt = pthread_getcpuclockid(pthread_self(), &tc);
  printf("process %d thread %d getcpuclockid %d %d pid-clock %d thread-clock %d\n", ok(CLOCK_PROCESS_CPUTIME_ID),
         ok(CLOCK_THREAD_CPUTIME_ID), gp, gt, !gp && ok(pc), !gt && ok(tc));
  int ep = epoll_create1(0);
  static struct epoll_event ev[10000];
  printf("epoll_wait maxevents 10000: %d\n", epoll_wait(ep, ev, 10000, 0));
  return 0;
}
