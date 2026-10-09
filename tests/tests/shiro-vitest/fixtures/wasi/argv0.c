/* Prints argv[0] (a program run through a symlink keeps the link's name). */
#include "rt.h"
void _start(void) {
  if (get_args() > 0) { puts_fd(1, "argv0="); puts_fd(1, argvv[0]); puts_fd(1, "\n"); }
  proc_exit(0);
}
