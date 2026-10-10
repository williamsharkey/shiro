// pthread_kill of a thread blocked in a kernel call interrupts that call:
// EINTR for a handler without SA_RESTART (Open POSIX mq_timedsend_12-1).
// The main thread keeps signalling until the call ends, as the Open POSIX
// test does, and gives up after 3 s. Then a process-directed signal that
// the main thread blocks reaches a thread that doesn't (pthread_kill_8-1).
#include <errno.h>
#include <fcntl.h>
#include <mqueue.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile int handled;
static volatile int done;
static int fds[2];
static mqd_t mq;
static int which;

static void onusr1(int sig) { (void)sig; handled++; }

static volatile int got2;
static void onusr2(int sig) { (void)sig; got2 = 1; }

static void *waiter(void *arg) {
  int i;
  (void)arg;
  for (i = 0; i < 300 && !got2; ++i) usleep(10 * 1000);
  return 0;
}

static void *blocker(void *arg) {
  char c;
  int r = 0;
  struct timespec ts;
  (void)arg;
  clock_gettime(CLOCK_REALTIME, &ts);
  ts.tv_sec += 10;
  if (which == 0) r = read(fds[0], &c, 1);
  if (which == 1) r = mq_timedsend(mq, "x", 1, 0, &ts);
  if (which == 2) { struct timespec d = {10, 0}; r = nanosleep(&d, 0); }
  done = r == -1 ? errno : 1000;
  return 0;
}

static void one(const char *name) {
  pthread_t t;
  int i;
  struct timespec d = {0, 50 * 1000 * 1000};
  done = 0, handled = 0;
  pthread_create(&t, 0, blocker, 0);
  usleep(100 * 1000);
  for (i = 0; i < 60 && !done; ++i) {
    pthread_kill(t, SIGUSR1);
    nanosleep(&d, 0);
  }
  if (!done) { printf("%s not interrupted\n", name); fflush(stdout); _exit(1); }
  pthread_join(t, 0);
  printf("%s %s handled %d\n", name, done == EINTR ? "EINTR" : strerror(done), handled > 0);
}

int main(void) {
  struct sigaction sa;
  struct mq_attr attr = {0};
  char name[64];
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = onusr1;
  sigaction(SIGUSR1, &sa, 0);
  pipe(fds);
  attr.mq_maxmsg = 1, attr.mq_msgsize = 8;
  snprintf(name, sizeof(name), "/threadintr_%d", getpid());
  mq = mq_open(name, O_CREAT | O_RDWR, 0600, &attr);
  mq_send(mq, "f", 1, 0);  // full: the next send blocks
  which = 0, one("read");
  which = 1, one("mq_timedsend");
  which = 2, one("nanosleep");
  {
    pthread_t t;
    sigset_t set;
    sa.sa_handler = onusr2;
    sigaction(SIGUSR2, &sa, 0);
    sigemptyset(&set);
    sigaddset(&set, SIGUSR2);
    pthread_create(&t, 0, waiter, 0);  // (it doesn't block SIGUSR2)
    pthread_sigmask(SIG_BLOCK, &set, 0);
    kill(getpid(), SIGUSR2);
    pthread_join(t, 0);
    printf("process signal blocked by main %s\n", got2 ? "reached a thread" : "held");
  }
  mq_unlink(name);
  return 0;
}
