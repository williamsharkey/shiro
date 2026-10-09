/* Fixture for x86-engine.test.ts: signalfd as PostgreSQL 17's latch uses it.
   Blocked SIGUSR1 and SIGURG (ignored by default) are read from the fd; poll sees it readable. */
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <sys/signalfd.h>
#include <unistd.h>
int main(void) {
  sigset_t set;
  sigemptyset(&set); sigaddset(&set, SIGUSR1); sigaddset(&set, SIGURG);
  sigprocmask(SIG_BLOCK, &set, 0);
  int fd = signalfd(-1, &set, SFD_NONBLOCK | SFD_CLOEXEC);
  if (fd < 0) { perror("signalfd"); return 1; }
  struct signalfd_siginfo si[2];
  printf("empty %d", read(fd, si, sizeof si) < 0 && errno == EAGAIN);
  kill(getpid(), SIGUSR1);
  kill(getpid(), SIGURG);
  struct pollfd p = { fd, POLLIN, 0 };
  printf(" poll %d", poll(&p, 1, 1000) == 1 && (p.revents & POLLIN));
  ssize_t n = read(fd, si, sizeof si);
  printf(" read %zd signo %u %u pid-ok %d", n, si[0].ssi_signo, si[1].ssi_signo, si[0].ssi_pid == (unsigned)getpid() || si[0].ssi_pid == 0);
  printf(" again-empty %d\n", read(fd, si, sizeof si) < 0 && errno == EAGAIN);
  return 0;
}
