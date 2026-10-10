// What a process asks the kernel about itself and others, as Linux answers
// (Blink 0516): another pid's CPU affinity is ESRCH when it doesn't exist
// (LTP sched_getaffinity01); a signal to a thread that has exited is ESRCH
// (tgkill03); brk keeps the address asked for (brk01); timer slack is per
// thread, and a fork child starts from its parent's (prctl08); the main
// thread's name is /proc/self/comm and survives fork (prctl05); stat of
// NULL is EFAULT (lstat02); a memfd sealed against writes can't be mapped
// shared and writable (memfd_create01).
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static pid_t dead;
static void *thread(void *a) { dead = syscall(SYS_gettid); return a; }

static void comm(const char *who) {
  char b[32] = {0};
  int fd = open("/proc/self/comm", O_RDONLY);
  if (read(fd, b, sizeof(b) - 1) < 0) b[0] = 0;
  close(fd);
  b[strcspn(b, "\n")] = 0;
  printf("%s comm %s\n", who, b);
}

int main(void) {
  cpu_set_t set;
  pthread_t t;
  struct stat st;
  int st2;
  printf("affinity other %d\n", sched_getaffinity(1 << 22, sizeof(set), &set) < 0 ? errno : 0);
  pthread_create(&t, 0, thread, 0);
  pthread_join(t, 0);
  usleep(100000);
  printf("tgkill dead %d\n", syscall(SYS_tgkill, getpid(), dead, 0) < 0 ? errno : 0);
  char *b0 = sbrk(0);
  printf("brk exact %d\n", syscall(SYS_brk, b0 + 4095) == (long)(b0 + 4095));
  prctl(PR_SET_TIMERSLACK, 70000);
  prctl(PR_SET_NAME, "renamed");
  comm("parent");
  printf("slack %d\n", prctl(PR_GET_TIMERSLACK));
  fflush(stdout);
  if (!fork()) {
    prctl(PR_SET_TIMERSLACK, 0);
    printf("child slack default %d\n", prctl(PR_GET_TIMERSLACK));
    comm("child");
    fflush(stdout);
    _exit(0);
  }
  wait(&st2);
  printf("lstat null %d\n", syscall(SYS_lstat, 0, &st) < 0 ? errno : 0);
  int m = memfd_create("sealed", MFD_ALLOW_SEALING);
  ftruncate(m, 4096);
  fcntl(m, F_ADD_SEALS, F_SEAL_WRITE);
  printf("sealed map %d\n", mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, m, 0) == MAP_FAILED ? errno : 0);
  return 0;
}
