// ITIMER_VIRTUAL/ITIMER_PROF are per process and a fork child starts with
// none (Open POSIX fork_13-1)
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  struct itimerval it = {{0, 0}, {10, 0}}, got;
  int a = setitimer(ITIMER_VIRTUAL, &it, 0), b = setitimer(ITIMER_PROF, &it, 0);
  getitimer(ITIMER_VIRTUAL, &got);
  printf("set %d %d parent armed %d\n", a, b, got.it_value.tv_sec > 0);
  if (fork() == 0) {
    struct itimerval v, p;
    getitimer(ITIMER_VIRTUAL, &v), getitimer(ITIMER_PROF, &p);
    printf("child virtual %ld prof %ld\n", (long)(v.it_value.tv_sec + v.it_value.tv_usec), (long)(p.it_value.tv_sec + p.it_value.tv_usec));
    _exit(0);
  }
  wait(0);
  return 0;
}
