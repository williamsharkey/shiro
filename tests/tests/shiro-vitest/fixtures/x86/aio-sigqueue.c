// Blink 0084: POSIX AIO completes (glibc queues signal 0 to notify; that
// was ENOSYS and became the request's error) and sigqueue delivers.
#include <aio.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static volatile int got;
static void handler(int s) { got = s; }

int main(void) {
  int fd = open("aiof", O_RDWR | O_CREAT | O_TRUNC, 0600);
  char buf[16] = "hello aio";
  struct aiocb cb;
  memset(&cb, 0, sizeof cb);
  cb.aio_fildes = fd, cb.aio_buf = buf, cb.aio_nbytes = 9;
  if (aio_write(&cb)) return 1;
  int e, n = 0;
  while ((e = aio_error(&cb)) == EINPROGRESS && n++ < 500) usleep(10000);
  printf("aio %d %zd ", e, aio_return(&cb));
  signal(SIGUSR1, handler);
  union sigval v = { .sival_int = 7 };
  int q = sigqueue(getpid(), SIGUSR1, v);
  printf("sigqueue %d %d ", q, got == SIGUSR1);
  printf("probe %d\n", sigqueue(getpid(), 0, v));
  unlink("aiof");
  return 0;
}
