// SA_SIGINFO handlers see the sender, si_code and sigqueue's value, and every
// queued instance of a real-time signal is delivered, in order (Open POSIX
// sigqueue 4-1 to 8-1)
#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

static volatile int n, vals[16], codes[16], pids[16];

static void handler(int sig, siginfo_t *si, void *uc) {
  (void)uc;
  if (n < 16) vals[n] = si->si_value.sival_int, codes[n] = si->si_code, pids[n] = si->si_pid == getpid() && si->si_signo == sig;
  ++n;
}

int main(void) {
  struct sigaction sa = {0};
  sigset_t set;
  sa.sa_sigaction = handler;
  sa.sa_flags = SA_SIGINFO;
  sigaction(SIGRTMIN, &sa, 0);
  sigaction(SIGUSR1, &sa, 0);
  // one sigqueue
  sigqueue(getpid(), SIGUSR1, (union sigval){.sival_int = 42});
  printf("sigqueue: n %d value %d code %d pid %d\n", n, vals[0], codes[0], pids[0]);
  // kill
  n = 0;
  kill(getpid(), SIGUSR1);
  printf("kill: n %d code %d pid %d\n", n, codes[0], pids[0]);
  // five real-time instances while blocked
  n = 0;
  sigemptyset(&set);
  sigaddset(&set, SIGRTMIN);
  sigprocmask(SIG_BLOCK, &set, 0);
  for (int i = 0; i < 5; ++i) sigqueue(getpid(), SIGRTMIN, (union sigval){.sival_int = 100 + i});
  printf("blocked: n %d\n", n);
  sigprocmask(SIG_UNBLOCK, &set, 0);
  printf("unblocked: n %d values", n);
  for (int i = 0; i < n && i < 16; ++i) printf(" %d", vals[i]);
  printf(" codes %d\n", codes[0]);
  return 0;
}
