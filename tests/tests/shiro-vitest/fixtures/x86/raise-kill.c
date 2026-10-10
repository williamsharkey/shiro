// Blink 0083: raise(SIGKILL) in a child (tgkill to itself) ends it, and its
// parent's wait returns; the same from a handler whose mask names SIGKILL
// (Open POSIX sigaction_4-*). alarm(5) bails out if the wait hangs.
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static void handler(int s) { (void)s; raise(SIGKILL); _exit(7); }

static void child(int masked) {
  struct sigaction act = {0};
  act.sa_handler = handler;
  sigemptyset(&act.sa_mask);
  if (masked) sigaddset(&act.sa_mask, SIGKILL);
  sigaction(SIGABRT, &act, 0);
  if (masked < 0) raise(SIGKILL); else raise(SIGABRT);
  _exit(3);
}

int main(void) {
  alarm(5);
  for (int masked = -1; masked <= 1; masked++) {
    pid_t k = fork();
    if (!k) child(masked);
    int s;
    pid_t w = wait(&s);
    printf("%d:%d%d ", masked, w == k, WIFSIGNALED(s) && WTERMSIG(s) == SIGKILL);
  }
  printf("\n");
  return 0;
}
