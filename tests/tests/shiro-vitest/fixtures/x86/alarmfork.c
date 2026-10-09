/* Fixture for x86-engine.test.ts: alarms are per process (fork clears the child's; its SIGALRM is its own; the parent's stays). Build: gcc -static -O1 */
#include <signal.h>
#include <stdio.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>
static volatile int got;
static void on(int s) { got = s; }
int main() {
  signal(SIGALRM, on);
  unsigned r = alarm(30);
  pid_t c = fork();
  if (c == 0) {
    unsigned left = alarm(0);           /* fork clears the child's alarm */
    struct itimerval it = {{0, 0}, {0, 200000}};
    setitimer(ITIMER_REAL, &it, 0);
    pause();
    _exit(left == 0 && got == SIGALRM ? 0 : 1);
  }
  int st;
  waitpid(c, &st, 0);
  unsigned p = alarm(0);
  printf("first alarm %u, child ok %d, parent's alarm still set %d\n", r, WEXITSTATUS(st) == 0, p >= 29 && p <= 30);
  return 0;
}
