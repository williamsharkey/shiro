/* Interactive peer: ping N (default 3) times "ping i\n" on fd 1, each time
 * waiting for a reply line on fd 0 and copying it to fd 2; then closes fd 1
 * and copies whatever else arrives on fd 0 to fd 2 until EOF. A peer that
 * reads all its input before replying deadlocks it. */
#include "rt.h"
static int readline(char *buf, int cap) {
  int len = 0;
  while (len < cap) {
    int n = readb(0, buf + len, 1);
    if (n <= 0) break;
    len += n;
    if (buf[len - 1] == '\n') break;
  }
  return len;
}
void _start(void) {
  int argc = get_args();
  u32 n = argc > 1 ? atoi_(argvv[1]) : 3;
  char buf[256];
  for (u32 i = 1; i <= n; i++) {
    /* one write per line, so a reader gets whole lines */
    char line[32], num[16];
    char *d = utoa(i, num + 15);
    int len = 0;
    for (const char *s = "ping "; *s; s++) line[len++] = *s;
    while (*d) line[len++] = *d++;
    line[len++] = '\n';
    writeb(1, line, len);
    len = readline(buf, sizeof buf);
    if (len <= 0) { puts_fd(2, "no reply\n"); proc_exit(1); }
    writeb(2, buf, len);
  }
  fd_close(1);
  for (;;) {
    int len = readb(0, buf, sizeof buf);
    if (len <= 0) break;
    writeb(2, buf, len);
  }
  proc_exit(0);
}
