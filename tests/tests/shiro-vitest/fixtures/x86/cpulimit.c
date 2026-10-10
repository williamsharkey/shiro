// RLIMIT_CPU (LTP setrlimit06): a process over its soft limit gets SIGXCPU
// (and again each second after it), and SIGKILL at its hard limit; the
// limits are inherited by a fork child, and time asleep doesn't count.
#include <signal.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile int *xcpu;

static void onxcpu(int sig) { (void)sig; ++*xcpu; }

int main(void) {
  struct rlimit rl = {1, 2}, got;
  int st;
  xcpu = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  signal(SIGXCPU, onxcpu);
  if (!fork()) {
    if (setrlimit(RLIMIT_CPU, &rl)) { perror("setrlimit"); _exit(1); }
    getrlimit(RLIMIT_CPU, &got);
    printf("limit %ld %ld\n", (long)got.rlim_cur, (long)got.rlim_max);
    fflush(stdout);
    sleep(1);  // asleep: not CPU time
    printf("after sleep %d\n", *xcpu);
    fflush(stdout);
    if (!fork()) {  // inherited
      alarm(20);
      for (;;) {}
    }
    wait(&st);
    printf("grandchild %s xcpu %d\n", WIFSIGNALED(st) && WTERMSIG(st) == SIGKILL ? "SIGKILL" : "other", *xcpu > 0);
    fflush(stdout);
    _exit(0);
  }
  wait(&st);
  return 0;
}
