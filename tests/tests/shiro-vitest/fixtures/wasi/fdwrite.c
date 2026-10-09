/* fdwrite FD TEXT: write TEXT and a newline to descriptor FD (an inherited
 * one, not opened here); exit 0, or 1 if the write fails. */
#include "rt.h"
void _start(void) {
  int argc = get_args();
  if (argc < 3) proc_exit(2);
  int fd = atoi_(argvv[1]);
  const char *t = argvv[2];
  if (writeb(fd, t, slen(t)) < 0 || writeb(fd, "\n", 1) < 0) proc_exit(1);
  proc_exit(0);
}
