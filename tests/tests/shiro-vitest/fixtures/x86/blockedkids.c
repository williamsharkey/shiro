// More children (same-instance fork) blocked in the kernel at once than
// Blink has kernel channels: each waits in poll() on its own pipe, and the
// parent, which needs a channel too, then writes to every pipe. With a
// fixed pool the parent's writes queued behind the blocked children until
// their polls timed out (epoll_wait15/16: "returned 0 expected 1").
#include <poll.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

#define N 12

int main(void) {
  int p[N][2], ok = 0, st;
  for (int i = 0; i < N; i++) {
    if (pipe(p[i])) return 1;
    if (!fork()) {
      struct pollfd f = {p[i][0], POLLIN, 0};
      char c;
      _exit(poll(&f, 1, 4000) == 1 && read(p[i][0], &c, 1) == 1 ? 0 : 1);
    }
  }
  usleep(300000);  // the children are in poll()
  for (int i = 0; i < N; i++) {
    if (write(p[i][1], "x", 1) != 1) return 1;
  }
  for (int i = 0; i < N; i++) {
    if (wait(&st) > 0 && WIFEXITED(st) && !WEXITSTATUS(st)) ok++;
  }
  printf("woken %d/%d\n", ok, N);
  return 0;
}
