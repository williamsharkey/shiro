/* cat FILE [OUT]: read FILE via path_open (no preloading) to stdout;
 * with OUT, also write "copied N\n" to OUT. */
#include "rt.h"
void _start(void) {
  int argc = get_args();
  if (argc < 2) proc_exit(2);
  int root = root_fd();
  const char *path = argvv[1];
  if (*path == '/') path++;
  int fd;
  if (path_open(root, 1, path, slen(path), 0, (1ull << 1) | (1ull << 2), 0, 0, &fd)) { puts_fd(2, "open failed\n"); proc_exit(1); }
  char buf[1024];
  u32 total = 0;
  for (;;) {
    int n = readb(fd, buf, sizeof buf);
    if (n <= 0) break;
    writeb(1, buf, n);
    total += n;
  }
  fd_close(fd);
  if (argc > 2) {
    const char *out = argvv[2];
    if (*out == '/') out++;
    int ofd;
    /* O_CREAT|O_TRUNC, rights FD_WRITE */
    if (path_open(root, 1, out, slen(out), 1 | 8, 1ull << 6, 0, 0, &ofd)) proc_exit(3);
    puts_fd(ofd, "copied "); put_u(ofd, total); puts_fd(ofd, "\n");
    fd_close(ofd);
  }
  proc_exit(0);
}
