// a forked (same-instance) child's SA_SIGINFO handler gets the sigqueue value
// (Open POSIX sigqueue_1-1)
#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
static void h(int s, siginfo_t *i, void *u) { (void)u; _exit(10 + (s == SIGRTMIN) + 2 * (i->si_value.sival_int == 7)); }
int main(int argc, char **argv) {
  int sig = atoi(argv[1]) ? SIGRTMIN : SIGUSR1;
  pid_t c = fork();
  if (!c) {
    struct sigaction a = {0};
    a.sa_sigaction = h; a.sa_flags = SA_SIGINFO;
    sigaction(sig, &a, 0);
    for (;;) sleep(1);
  }
  sleep(1);
  sigqueue(c, sig, (union sigval){.sival_int = 7});
  int st; waitpid(c, &st, 0);
  printf("sig %d: child %s %d\n", sig, WIFEXITED(st) ? "exit" : "signal", WIFEXITED(st) ? WEXITSTATUS(st) : WTERMSIG(st));
  return 0;
}
