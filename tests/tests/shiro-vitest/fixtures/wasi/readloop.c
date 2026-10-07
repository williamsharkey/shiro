/* Interactive read loop: one fd_read per line typed (or piped), echoing
 * "got: <line>" immediately. At EOF prints "lines: N" and exits N. */
#include "rt.h"
void _start(void) {
  char buf[256];
  u32 lines = 0;
  for (;;) {
    int n = readb(0, buf, sizeof buf);
    if (n <= 0) break;
    puts_fd(1, "got: ");
    writeb(1, buf, n);
    for (int i = 0; i < n; i++) if (buf[i] == '\n') lines++;
  }
  puts_fd(1, "lines: "); put_u(1, lines); puts_fd(1, "\n");
  proc_exit(lines);
}
