// Setting another user's process's scheduling is EPERM, reading it isn't
// (Open POSIX sched_setparam_26-1: pid 1 is root's)
#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <unistd.h>

static const char *e(int r) { return r >= 0 ? "ok" : errno == EPERM ? "EPERM" : "?"; }

int main(void) {
  struct sched_param p = {0};
  if (getuid() == 0 && setuid(65534)) return 1;
  printf("get %s getscheduler %s set %s setscheduler %s self %s\n", e(sched_getparam(1, &p)),
         e(sched_getscheduler(1)), e(sched_setparam(1, &p)), e(sched_setscheduler(1, SCHED_OTHER, &p)),
         e(sched_setparam(0, &p)));
  return 0;
}
