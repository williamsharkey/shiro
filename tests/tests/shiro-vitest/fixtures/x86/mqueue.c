// Blink 0088 + kernel mqueue.ts: POSIX message queues (Open POSIX mq_*):
// priority order, a full queue, a child blocked in mq_receive until the
// parent sends, unlink.
#include <errno.h>
#include <fcntl.h>
#include <mqueue.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
  struct mq_attr at = { .mq_maxmsg = 2, .mq_msgsize = 32 };
  char name[64], buf[32];
  unsigned prio;
  snprintf(name, sizeof name, "/shiro-mq-%d", getpid());
  mqd_t q = mq_open(name, O_RDWR | O_CREAT | O_EXCL, 0600, &at);
  if (q == (mqd_t)-1) { perror("mq_open"); return 1; }
  mq_send(q, "low", 3, 1);
  mq_send(q, "high", 4, 7);
  struct mq_attr na = { .mq_flags = O_NONBLOCK }, old;
  mq_setattr(q, &na, &old);
  printf("full %d ", mq_send(q, "x", 1, 0) == -1 && errno == EAGAIN);
  ssize_t n = mq_receive(q, buf, sizeof buf, &prio);
  printf("first %.*s/%u ", (int)n, buf, prio);
  n = mq_receive(q, buf, sizeof buf, &prio);
  printf("second %.*s/%u ", (int)n, buf, prio);
  na.mq_flags = 0;
  mq_setattr(q, &na, 0);
  pid_t k = fork();
  if (!k) {
    n = mq_receive(q, buf, sizeof buf, &prio);  // blocks until the parent sends
    _exit(n == 4 && !memcmp(buf, "late", 4) ? 0 : 1);
  }
  usleep(100000);
  mq_send(q, "late", 4, 0);
  int st;
  waitpid(k, &st, 0);
  printf("blocked %d ", WIFEXITED(st) && WEXITSTATUS(st) == 0);
  printf("unlink %d\n", mq_unlink(name) == 0 && mq_open(name, O_RDONLY) == (mqd_t)-1 && errno == ENOENT);
  return 0;
}
