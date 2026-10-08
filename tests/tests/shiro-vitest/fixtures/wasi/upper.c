/* Copy stdin to stdout uppercased; prints the byte count to stderr. */
#include "rt.h"
void _start(void) {
  char buf[4096];
  u32 total = 0;
  for (;;) {
    int n = readb(0, buf, sizeof buf);
    if (n <= 0) break;
    for (int i = 0; i < n; i++) if (buf[i] >= 'a' && buf[i] <= 'z') buf[i] -= 32;
    writeb(1, buf, n);
    total += n;
  }
  puts_fd(2, "bytes: "); put_u(2, total); puts_fd(2, "\n");
  proc_exit(0);
}
