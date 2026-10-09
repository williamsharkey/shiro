// A signal with a handler interrupts a timed FUTEX_WAIT with EINTR (LTP
// futex_wait07): from the process's own alarm, and from a kill by its parent.
#include <errno.h>
#include <linux/futex.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void handler(int sig) { (void)sig; }

// what LTP's TST_PROCESS_STATE_WAIT reads: the state in /proc/PID/stat
static char state(pid_t pid) {
  char path[64], buf[256], *p;
  snprintf(path, sizeof path, "/proc/%d/stat", pid);
  FILE *f = fopen(path, "r");
  if (!f) return '?';
  p = fgets(buf, sizeof buf, f) ? strrchr(buf, ')') : 0;
  fclose(f);
  return p && p[1] && p[2] ? p[2] : '?';
}

static const char *wait5s(int *word) {
  struct timespec ts = {5, 0}, a, b;
  clock_gettime(CLOCK_MONOTONIC, &a);
  long r = syscall(SYS_futex, word, FUTEX_WAIT, *word, &ts, 0, 0);
  int e = errno;
  clock_gettime(CLOCK_MONOTONIC, &b);
  static char buf[64];
  snprintf(buf, sizeof buf, "%s%s", r ? strerror(e) : "woken",
           b.tv_sec - a.tv_sec >= 4 ? " (after the timeout)" : "");
  return buf;
}

int main(int argc, char **argv) {
  // nested: all of it in a forked child, like LTP's test process
  if (argc > 1) {
    pid_t top = fork();
    if (top) {
      int st;
      waitpid(top, &st, 0);
      return WEXITSTATUS(st);
    }
  }
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = handler;
  sigaction(SIGALRM, &sa, 0);
  int *word = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  printf("main tid is pid %d\n", (pid_t)syscall(SYS_gettid) == getpid());
  alarm(1);
  printf("alarm: %s\n", wait5s(word));
  fflush(stdout);
  pid_t pid = fork();
  if (!pid) {
    sigaction(SIGUSR1, &sa, 0);  // after the fork, as LTP does
    printf("child tid is pid %d\n", (pid_t)syscall(SYS_gettid) == getpid());
    fflush(stdout);
    printf("kill: %s\n", wait5s(word));
    return 0;
  }
  char s = '?';
  for (int i = 0; i < 300 && (s = state(pid)) != 'S'; i++) usleep(10000);
  printf("child state %c\n", s);
  fflush(stdout);
  kill(pid, SIGUSR1);
  int st;
  waitpid(pid, &st, 0);
  printf("child exit %d\n", WEXITSTATUS(st));
  return 0;
}
