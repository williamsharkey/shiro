// timerfd: relative and interval timers through poll, an absolute
// CLOCK_REALTIME one through epoll, gettime, disarm, EAGAIN (uSockets'
// us_create_timer in Bun: opencode)
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/epoll.h>
#include <sys/timerfd.h>
#include <time.h>
#include <unistd.h>

static long long ms(struct timespec a, struct timespec b) {
  return (b.tv_sec - a.tv_sec) * 1000LL + (b.tv_nsec - a.tv_nsec) / 1000000;
}

int main(void) {
  uint64_t n = 0;
  struct timespec t0, t1;
  int fd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
  printf("create %d\n", fd >= 0);
  printf("unarmed read EAGAIN %d\n", read(fd, &n, 8) < 0 && errno == EAGAIN);
  struct itimerspec it = {{0, 20000000}, {0, 50000000}}, old, cur;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  printf("settime %d\n", timerfd_settime(fd, 0, &it, &old) == 0 && !old.it_value.tv_sec && !old.it_value.tv_nsec);
  timerfd_gettime(fd, &cur);
  printf("gettime armed %d interval %d\n", cur.it_value.tv_nsec > 0 && cur.it_value.tv_nsec <= 50000000, cur.it_interval.tv_nsec == 20000000);
  struct pollfd p = {fd, POLLIN, 0};
  int pr = poll(&p, 1, 2000);
  clock_gettime(CLOCK_MONOTONIC, &t1);
  printf("poll %d after>=45ms %d\n", pr == 1 && (p.revents & POLLIN), ms(t0, t1) >= 45);
  int rr = read(fd, &n, 8) == 8;
  printf("read %d count>=1 %d\n", rr, n >= 1);
  usleep(110000);
  printf("interval count>=3 %d\n", read(fd, &n, 8) == 8 && n >= 3 && n <= 8);
  struct itimerspec off = {{0, 0}, {0, 0}};
  timerfd_settime(fd, 0, &off, 0);
  timerfd_gettime(fd, &cur);
  printf("disarmed %d\n", !cur.it_value.tv_sec && !cur.it_value.tv_nsec);
  // absolute, on CLOCK_REALTIME, waited for with epoll
  int rfd = timerfd_create(CLOCK_REALTIME, 0), ep = epoll_create1(0);
  struct epoll_event ev = {.events = EPOLLIN, .data.fd = rfd}, got;
  epoll_ctl(ep, EPOLL_CTL_ADD, rfd, &ev);
  struct timespec now;
  clock_gettime(CLOCK_REALTIME, &now);
  struct itimerspec abs = {{0, 0}, {now.tv_sec, now.tv_nsec + 30000000}};
  if (abs.it_value.tv_nsec >= 1000000000) abs.it_value.tv_sec++, abs.it_value.tv_nsec -= 1000000000;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  timerfd_settime(rfd, TFD_TIMER_ABSTIME, &abs, 0);
  int er = epoll_wait(ep, &got, 1, 2000);
  clock_gettime(CLOCK_MONOTONIC, &t1);
  printf("abs epoll %d after>=20ms %d read 1 %d\n", er == 1 && got.data.fd == rfd, ms(t0, t1) >= 20, read(rfd, &n, 8) == 8 && n == 1);
  // an absolute time already past expires at once
  abs.it_value.tv_sec -= 10;
  timerfd_settime(rfd, TFD_TIMER_ABSTIME, &abs, 0);
  printf("past expires %d\n", read(rfd, &n, 8) == 8 && n == 1);
  printf("bad nsec EINVAL %d\n", timerfd_settime(rfd, 0, &(struct itimerspec){{0, 0}, {0, 1000000000}}, 0) < 0 && errno == EINVAL);
  return 0;
}
