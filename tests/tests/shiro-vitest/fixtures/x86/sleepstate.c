// A child blocked in pause(), nanosleep or a kernel wait shows as sleeping
// (S) in /proc/PID/stat: LTP's TST_PROCESS_STATE_WAIT(pid, 'S') waits for
// it before signalling or waking the child (pause01, signal01). Blink
// sleeps pause/nanosleep itself, so it tells the kernel.
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static char state(int pid) {
  char b[256], p[64];
  snprintf(p, sizeof(p), "/proc/%d/stat", pid);
  FILE *f = fopen(p, "r");
  if (!f) return '?';
  int n = fread(b, 1, sizeof(b) - 1, f);
  fclose(f);
  b[n] = 0;
  char *c = strrchr(b, ')');
  return c ? c[2] : '?';
}

int main(void) {
  static const char *names[] = {"pause", "nanosleep", "clock_nanosleep", "read"};
  for (int mode = 0; mode < 4; mode++) {
    int p[2];
    if (pipe(p)) return 1;
    int pid = fork();
    if (!pid) {
      struct timespec t = {3, 0};
      char c;
      if (mode == 0) pause();
      else if (mode == 1) nanosleep(&t, 0);
      else if (mode == 2) clock_nanosleep(CLOCK_MONOTONIC, 0, &t, 0);
      else if (read(p[0], &c, 1) != 1) _exit(1);
      _exit(0);
    }
    char s = '?';
    for (int i = 0; i < 200 && (s = state(pid)) != 'S'; i++) usleep(5000);
    printf("%s %c\n", names[mode], s);
    if (mode == 3 && write(p[1], "x", 1) != 1) return 1;
    if (mode < 3) kill(pid, SIGKILL);
    waitpid(pid, 0, 0);
    close(p[0]);
    close(p[1]);
  }
  return 0;
}
