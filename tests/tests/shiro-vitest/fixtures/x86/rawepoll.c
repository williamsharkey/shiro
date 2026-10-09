// A TUI's input loop the way Bun and libuv run one (native Claude Code):
// stdin in raw mode and O_NONBLOCK, waited on with epoll alongside a
// self-pipe that a SIGWINCH handler writes to. Prints each key and each new
// window size (TIOCGWINSZ after the signal); 'q' quits.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <time.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static int sigpipe_w = -1;

static void on_winch(int sig) {
  (void)sig;
  int e = errno;
  if (write(sigpipe_w, "w", 1) < 0) {}
  errno = e;
}

// Bun's other threads: they sleep, and wait on futexes, while the main one reads
static void *idle(void *arg) {
  (void)arg;
  for (;;) { struct timespec t = { 0, 50 * 1000 * 1000 }; nanosleep(&t, 0); }
  return 0;
}

static int loop(void);

static void *loop_thread(void *arg) { (void)arg; exit(loop()); }

static int in = 0;

// argv[1]: "threads" adds idle threads; "offmain" also runs the loop on another thread;
// "reopen" reads a new description of the tty, opened the way libuv's uv_tty_init does
int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "";
  if (strcmp(mode, "reopen") == 0) {
    char path[64];
    // libuv: ttyname_r, else /proc/self/fd/0; O_RDWR so it can be made non-blocking alone
    if (ttyname_r(0, path, sizeof path) != 0) strcpy(path, "/proc/self/fd/0");
    in = open(path, O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (in < 0) { perror(path); return 1; }
    printf("reopened %s\r\n", path);
  }
  if (strcmp(mode, "threads") == 0 || strcmp(mode, "offmain") == 0) {
    pthread_t t;
    for (int i = 0; i < 3; i++) pthread_create(&t, 0, idle, 0);
  }
  if (strcmp(mode, "offmain") == 0) {
    pthread_t t;
    pthread_create(&t, 0, loop_thread, 0);
    pthread_join(t, 0);
  }
  return loop();
}

static int loop(void) {
  struct termios old, raw;
  if (tcgetattr(in, &old) < 0) { perror("tcgetattr"); return 1; }
  raw = old;
  raw.c_lflag &= ~(ICANON | ECHO | ISIG | IEXTEN);
  raw.c_iflag &= ~(IXON | ICRNL);
  raw.c_cc[VMIN] = 1;
  raw.c_cc[VTIME] = 0;
  // TCSADRAIN (TCSETSW) as libuv's uv_tty_set_mode
  if (tcsetattr(in, TCSADRAIN, &raw) < 0) { perror("tcsetattr"); return 1; }
  fcntl(in, F_SETFL, fcntl(in, F_GETFL) | O_NONBLOCK);

  int sp[2];
  if (pipe2(sp, O_NONBLOCK | O_CLOEXEC) < 0) { perror("pipe2"); return 1; }
  sigpipe_w = sp[1];
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_winch;
  sa.sa_flags = SA_RESTART;
  sigaction(SIGWINCH, &sa, 0);

  int ep = epoll_create1(EPOLL_CLOEXEC);
  struct epoll_event ev = { .events = EPOLLIN, .data.fd = in };
  epoll_ctl(ep, EPOLL_CTL_ADD, in, &ev);
  ev.data.fd = sp[0];
  epoll_ctl(ep, EPOLL_CTL_ADD, sp[0], &ev);

  struct winsize ws;
  ioctl(1, TIOCGWINSZ, &ws);
  printf("size %dx%d\r\nready\r\n", ws.ws_row, ws.ws_col);
  fflush(stdout);
  for (;;) {
    struct epoll_event got[4];
    int n = epoll_wait(ep, got, 4, -1);
    if (n < 0) { if (errno == EINTR) continue; perror("epoll_wait"); return 1; }
    for (int i = 0; i < n; i++) {
      char buf[64];
      if (got[i].data.fd == sp[0]) {
        while (read(sp[0], buf, sizeof buf) > 0) {}
        ioctl(1, TIOCGWINSZ, &ws);
        printf("winch %dx%d\r\n", ws.ws_row, ws.ws_col);
      } else {
        ssize_t r;
        while ((r = read(in, buf, sizeof buf)) > 0) {
          for (ssize_t k = 0; k < r; k++) {
            printf("key %d\r\n", buf[k]);
            if (buf[k] == 'q') { tcsetattr(in, TCSADRAIN, &old); printf("bye\r\n"); return 0; }
          }
        }
        if (r < 0 && errno != EAGAIN) { perror("read"); return 1; }
      }
      fflush(stdout);
    }
  }
}
