// raise of a blocked real-time signal queues each instance (Open POSIX
// sigwait_2-1); SIGKILL/SIGSTOP never enter the mask (sigprocmask_10-1);
// sigaltstack modes and a disabled stack read back as none (sigaltstack_2-1, 11-1)
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
  sigset_t m, p, cur;
  siginfo_t si;
  stack_t ss, old;
  int s, a, b;
  sigemptyset(&m); sigaddset(&m, SIGRTMIN);
  sigprocmask(SIG_SETMASK, &m, 0);
  raise(SIGRTMIN); raise(SIGRTMIN);
  sigwait(&m, &a);
  sigpending(&p);
  int still = sigismember(&p, SIGRTMIN);
  memset(&si, 0, sizeof(si));
  b = sigwaitinfo(&m, &si);
  struct timespec z = {0, 0};
  int third = sigtimedwait(&m, 0, &z);
  printf("rt %d %d pending %d signo %d third %d %s\n", a == SIGRTMIN, b == SIGRTMIN, still, si.si_signo == SIGRTMIN, third, third < 0 && errno == EAGAIN ? "EAGAIN" : "?");
  sigemptyset(&m); sigaddset(&m, SIGKILL); sigaddset(&m, SIGSTOP); sigaddset(&m, SIGUSR1);
  int r = sigprocmask(SIG_SETMASK, &m, 0);
  sigprocmask(SIG_SETMASK, 0, &cur);
  printf("mask %d kill %d stop %d usr1 %d\n", r, sigismember(&cur, SIGKILL), sigismember(&cur, SIGSTOP), sigismember(&cur, SIGUSR1));
  ss.ss_sp = malloc(SIGSTKSZ); ss.ss_size = SIGSTKSZ; ss.ss_flags = SS_DISABLE | SS_ONSTACK;
  r = sigaltstack(&ss, 0);
  printf("both %d %s\n", r, r < 0 && errno == EINVAL ? "EINVAL" : "?");
  ss.ss_flags = SS_DISABLE;
  r = sigaltstack(&ss, 0);
  sigaltstack(0, &old);
  printf("disable %d sp %d size %d flags %d\n", r, old.ss_sp == 0, (int)old.ss_size, old.ss_flags);
  return 0;
}
