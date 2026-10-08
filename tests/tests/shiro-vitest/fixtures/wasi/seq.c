/* seq N: writes "line 1\n" .. "line N\n" one write per line. */
#include "rt.h"
void _start(void) {
  int argc = get_args();
  u32 n = argc > 1 ? atoi_(argvv[1]) : 10;
  for (u32 i = 1; i <= n; i++) {
    char b[32]; char *p = utoa(i, b + 31);
    puts_fd(1, "line "); puts_fd(1, p); puts_fd(1, "\n");
  }
  proc_exit(0);
}
