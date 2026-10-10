// A fork child's CPU-time clocks and times() start again from 0, and they
// move forward (Open POSIX fork_22-1, fork_8-1); so does a new thread's
// CPU-time clock. The parent's tms_cutime, getrusage(RUSAGE_CHILDREN) and
// wait4's rusage count the children it reaped; sleeping isn't CPU time.
#include <pthread.h>
#include <stdio.h>
#include <sys/resource.h>
#include <sys/times.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static double secs(clockid_t c) {
  struct timespec ts;
  clock_gettime(c, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void *thread(void *arg) {
  *(double *)arg = secs(CLOCK_THREAD_CPUTIME_ID);
  return 0;
}

int main(void) {
  struct tms t0, t;
  clock_t start = times(&t0), now;
  long hz = sysconf(_SC_CLK_TCK);
  double th;
  pthread_t p;
  int st;
  // work for 1.2 s of the clock times() returns
  do now = times(&t); while (now - start < hz * 12 / 10);
  printf("parent process %d thread %d utime %d\n", secs(CLOCK_PROCESS_CPUTIME_ID) >= 1,
         secs(CLOCK_THREAD_CPUTIME_ID) >= 1, t.tms_utime + t.tms_stime >= hz);
  pthread_create(&p, 0, thread, &th);
  pthread_join(p, 0);
  printf("new thread %d\n", th < 0.5);
  fflush(stdout);
  if (!fork()) {
    times(&t);
    printf("child process %d thread %d utime %d\n", secs(CLOCK_PROCESS_CPUTIME_ID) < 0.5,
           secs(CLOCK_THREAD_CPUTIME_ID) < 0.5, t.tms_utime + t.tms_stime < hz / 2);
    do times(&t); while (t.tms_utime + t.tms_stime <= 0);
    printf("child moves\n");
    fflush(stdout);
    _exit(0);
  }
  struct rusage ru;
  wait4(-1, &st, 0, &ru);
  times(&t);
  printf("wait4 %d\n", ru.ru_utime.tv_sec * 1000000 + ru.ru_utime.tv_usec > 0);
  getrusage(RUSAGE_CHILDREN, &ru);
  printf("children utime %d cutime %d\n", ru.ru_utime.tv_sec * 1000000 + ru.ru_utime.tv_usec > 0, t.tms_cutime + t.tms_cstime > 0);
  if (!fork()) {
    sleep(1);
    _exit(0);
  }
  wait4(-1, &st, 0, &ru);
  printf("sleeping child %d\n", ru.ru_utime.tv_sec * 1000000 + ru.ru_utime.tv_usec < 500000);
  return 0;
}
