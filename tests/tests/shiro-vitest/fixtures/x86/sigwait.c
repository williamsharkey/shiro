// sigwait/sigtimedwait/sigwaitinfo (VLC's main thread waits in sigwait for
// SIGINT/HUP/QUIT/TERM and quits when it returns)
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static pthread_t main_thread;

static void *killer(void *arg) {
  (void)arg;
  usleep(100000);
  pthread_kill(main_thread, SIGTERM);
  return 0;
}

int main(void) {
  sigset_t set;
  siginfo_t si;
  struct timespec a, b, ts = {0, 200000000};
  int sig = -1, r;
  sigemptyset(&set);
  sigaddset(&set, SIGINT), sigaddset(&set, SIGHUP), sigaddset(&set, SIGQUIT);
  sigaddset(&set, SIGTERM), sigaddset(&set, SIGALRM), sigaddset(&set, SIGUSR1);
  pthread_sigmask(SIG_BLOCK, &set, 0);
  // a process signal the kernel holds
  clock_gettime(CLOCK_MONOTONIC, &a);
  alarm(1);
  r = sigwait(&set, &sig);
  clock_gettime(CLOCK_MONOTONIC, &b);
  printf("sigwait %d %d waited %d\n", r, sig, b.tv_sec - a.tv_sec + (b.tv_nsec - a.tv_nsec) / 1e9 > 0.5);
  // one sent to this thread
  main_thread = pthread_self();
  pthread_t t;
  pthread_create(&t, 0, killer, 0);
  sig = -1;
  r = sigwait(&set, &sig);
  pthread_join(t, 0);
  printf("pthread_kill %d %d\n", r, sig);
  // already pending, with its siginfo
  kill(getpid(), SIGUSR1);
  memset(&si, 0, sizeof(si));
  r = sigwaitinfo(&set, &si);
  printf("sigwaitinfo %d signo %d code %d\n", r, si.si_signo, si.si_code);
  // a timeout, and a poll
  clock_gettime(CLOCK_MONOTONIC, &a);
  r = sigtimedwait(&set, 0, &ts);
  clock_gettime(CLOCK_MONOTONIC, &b);
  double dt = b.tv_sec - a.tv_sec + (b.tv_nsec - a.tv_nsec) / 1e9;
  printf("timeout %d %s %d\n", r, r < 0 && errno == EAGAIN ? "EAGAIN" : strerror(errno), dt > 0.15 && dt < 1.5);
  ts.tv_nsec = 0;
  r = sigtimedwait(&set, 0, &ts);
  printf("poll %d %s\n", r, r < 0 && errno == EAGAIN ? "EAGAIN" : strerror(errno));
  return 0;
}
