// CPU clock ids (Open POSIX clock_gettime_8-2, clock_getres_6-2): this
// process's and this thread's read, an id naming no process is EINVAL
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>

static const char *e(int r) { return r == 0 ? "ok" : errno == EINVAL ? "EINVAL" : "?"; }

int main(void) {
  clockid_t mine, thread;
  struct timespec ts;
  clock_getcpuclockid(0, &mine);
  pthread_getcpuclockid(pthread_self(), &thread);
  printf("process %s self %s thread %s\n", e(clock_gettime(mine, &ts)),
         e(clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &ts)), e(clock_gettime(thread, &ts)));
  printf("bogus %s %s %s\n", e(clock_gettime(-2147483648, &ts)), e(clock_getres(-1073743192, &ts)),
         e(clock_gettime(2147483647, &ts)));
  return 0;
}
