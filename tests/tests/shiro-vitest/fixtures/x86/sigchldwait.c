// A SIGCHLD that comes just as the parent blocks in epoll_wait ends the
// wait (libuv's self-pipe, as cmake's process runner uses: it blocks every
// signal around a spawn, so a quick child's SIGCHLD is held until the mask
// is restored, right before epoll_wait). The signal could reach the kernel
// before the call did, so nothing interrupted the call: Blink's direct
// channels (patch 0065) then ask the page to. Half the rounds hold it.
// (The window is narrow; compat-dev's cmake test is the one that hit it.)
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/epoll.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
static int pipefd[2];
static void onchld(int sig) { (void)sig; char c = 1; if (write(pipefd[1], &c, 1)) {} }

int main(int argc, char **argv) {
  if (argc > 1) {  // a child: exit at varying moments around the parent's epoll_wait
    usleep(atoi(argv[1]));
    return 0;
  }
  int timeouts = 0, rounds = 60;
  if (pipe(pipefd)) return 1;
  struct sigaction sa = {0};
  sa.sa_handler = onchld;
  sa.sa_flags = SA_RESTART;
  sigaction(SIGCHLD, &sa, 0);
  int ep = epoll_create1(0);
  struct epoll_event ev = {.events = EPOLLIN, .data.fd = pipefd[0]}, out;
  epoll_ctl(ep, EPOLL_CTL_ADD, pipefd[0], &ev);
  for (int i = 0; i < rounds; i++) {
    char us[16];
    snprintf(us, sizeof us, "%d", (i & 1) ? 0 : (i % 20) * 100);
    char *cargv[] = {argv[0], us, 0};
    pid_t pid;
    sigset_t all, old;
    sigfillset(&all);
    if (i & 1) sigprocmask(SIG_BLOCK, &all, &old);
    if (posix_spawn(&pid, argv[0], 0, 0, cargv, environ)) return 2;
    if (i & 1) {
      usleep(3000);
      sigprocmask(SIG_SETMASK, &old, 0);
    }
    int n;
    do n = epoll_wait(ep, &out, 1, 2000); while (n < 0 && errno == EINTR);
    if (n == 0) timeouts++;
    char c;
    if (read(pipefd[0], &c, 1) < 0) return 3;
    waitpid(pid, 0, 0);
  }
  printf("rounds %d timeouts %d\n", rounds, timeouts);
  return 0;
}
