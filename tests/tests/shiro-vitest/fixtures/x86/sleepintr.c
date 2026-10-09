// Blink sleeps nanosleep/clock_nanosleep/pause itself (emscripten's sleep
// is a wait nothing interrupts), so it sleeps in slices and looks for
// signals between them: a handled signal ends the sleep with EINTR and the
// time left (LTP nanosleep02, clock_nanosleep01). Then exit_group with
// threads parked in a futex, a sleep and a pipe read: the process ends
// at once (Blink ends those threads first; patch 0053).
#include <errno.h>
#include <linux/futex.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void on_usr1(int sig) {}

static long ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int sleeper(int clk) {
  struct timespec req = {5, 0}, rem = {0, 0};
  long t0 = ms();
  int r = clk ? clock_nanosleep(CLOCK_MONOTONIC, 0, &req, &rem) : nanosleep(&req, &rem);
  int e = clk ? r : (r ? errno : 0);
  printf("%s eintr %d early %d rem>3s %d\n", clk ? "clock_nanosleep" : "nanosleep", e == EINTR,
         ms() - t0 < 2000, rem.tv_sec >= 3);
  fflush(stdout);
  return 0;
}

static unsigned word;
static int p[2];
static void *park_futex(void *a) { syscall(SYS_futex, &word, FUTEX_WAIT, 0, 0, 0, 0); return 0; }
static void *park_sleep(void *a) { sleep(60); return 0; }
static void *park_read(void *a) { char c; read(p[0], &c, 1); return 0; }

int main(void) {
  signal(SIGUSR1, on_usr1);
  for (int clk = 0; clk < 2; clk++) {
    int pid = fork();
    if (!pid) _exit(sleeper(clk));
    usleep(300000);
    kill(pid, SIGUSR1);
    waitpid(pid, 0, 0);
  }
  fflush(stdout);
  if (pipe(p)) return 1;
  int pid = fork();
  if (!pid) {
    pthread_t t;
    pthread_create(&t, 0, park_futex, 0);
    pthread_create(&t, 0, park_sleep, 0);
    pthread_create(&t, 0, park_read, 0);
    usleep(200000);
    exit(7);
  }
  long t0 = ms();
  int st;
  waitpid(pid, &st, 0);
  printf("threads parked: exit %d within 3s %d\n", WEXITSTATUS(st), ms() - t0 < 3000);
  return 0;
}
