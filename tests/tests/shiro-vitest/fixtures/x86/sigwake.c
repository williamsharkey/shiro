// A signal that arrives while the guest is between kernel calls must still
// wake the epoll_wait it goes into next (its handler writes a self-pipe):
// a child sends SIGUSR1 and waits for an ack; the parent spins a random
// while (between calls), then sleeps in epoll_wait. A lost wakeup leaves it
// asleep until alarm(). (The rawepoll SIGWINCH flake.)
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#define ROUNDS 300
static int sp[2];
static volatile int rounds;
static void on_usr1(int s) { (void)s; write(sp[1], "x", 1); }
static void on_alarm(int s) { (void)s; dprintf(1, "lost wakeup after %d rounds\n", rounds); _exit(1); }
static void spin(unsigned us) {
  struct timespec t0, t;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  do clock_gettime(CLOCK_MONOTONIC, &t);
  while ((t.tv_sec - t0.tv_sec) * 1000000 + (t.tv_nsec - t0.tv_nsec) / 1000 < us);
}
int main(void) {
  int ack[2];
  if (pipe2(sp, O_NONBLOCK) || pipe(ack)) return 1;
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_usr1;
  sa.sa_flags = SA_RESTART;
  sigaction(SIGUSR1, &sa, 0);
  pid_t parent = getpid(), c = fork();
  if (c == 0) {
    srand(2);
    char b;
    for (int i = 0; i < ROUNDS; i++) {
      kill(parent, SIGUSR1);
      if (read(ack[0], &b, 1) != 1) _exit(1);
      usleep(rand() % 1500);
    }
    _exit(0);
  }
  signal(SIGALRM, on_alarm);
  alarm(60);
  srand(1);
  int ep = epoll_create1(0);
  struct epoll_event ev = { .events = EPOLLIN, .data.fd = sp[0] };
  epoll_ctl(ep, EPOLL_CTL_ADD, sp[0], &ev);
  char buf[64];
  for (rounds = 0; rounds < ROUNDS;) {
    spin(rand() % 1500);  // between calls: the signal may come now
    struct epoll_event got;
    int n = epoll_wait(ep, &got, 1, -1);
    if (n < 0 && errno == EINTR) continue;
    if (n == 1 && read(sp[0], buf, sizeof buf) > 0) {
      rounds++;
      write(ack[1], "a", 1);
    }
  }
  waitpid(c, 0, 0);
  printf("%d wakeups\n", rounds);
  return 0;
}
