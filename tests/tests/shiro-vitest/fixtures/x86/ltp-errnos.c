// Blink patches 0080/0081 (LTP conformance): errnos and state that are the kernel's
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/personality.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int err(long r) { return r < 0 ? errno : 0; }

int main(void) {
  struct rlimit rl;
  printf("rlimit-bad %d ", err(getrlimit(-1, &rl)) == EINVAL);
  getrlimit(RLIMIT_NOFILE, &rl);
  printf("nofile %lu/%lu ", (unsigned long)rl.rlim_cur, (unsigned long)rl.rlim_max);

  int p[2];
  if (pipe(p)) return 1;
  struct iovec bad = { "x", (size_t)-1 };
  printf("writev-len %d ", err(writev(p[1], &bad, 1)) == EINVAL);
  printf("pipe-sz %d ", fcntl(p[1], F_SETPIPE_SZ, 4096) == 4096 && fcntl(p[0], F_GETPIPE_SZ) == 4096);

  char *ro = mmap(0, 4096, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (write(p[1], "abcd", 4) != 4) return 1;
  printf("read-ro %d ", err(read(p[0], ro, 4)) == EFAULT);

  siginfo_t si;
  printf("waitid-opts %d ", err(waitid(P_ALL, 0, &si, WNOHANG)) == EINVAL);

  struct timespec ts;
  printf("clocks %d ", !syscall(SYS_clock_gettime, CLOCK_BOOTTIME, &ts) && !syscall(SYS_clock_gettime, CLOCK_MONOTONIC_RAW, &ts) &&
         !syscall(SYS_clock_gettime, CLOCK_REALTIME_COARSE, &ts));

  struct utsname u;
  personality(PER_LINUX | UNAME26);
  uname(&u);
  printf("uname26 %d %d ", !strncmp(u.release, "2.6.", 4), personality(0xffffffff) == (PER_LINUX | UNAME26));
  personality(PER_LINUX);

  sigset_t set, pend;
  sigemptyset(&set);
  sigaddset(&set, SIGUSR1);
  sigprocmask(SIG_BLOCK, &set, 0);
  raise(SIGUSR1);
  sigpending(&pend);
  printf("pending %d ", sigismember(&pend, SIGUSR1));

  // a write lock is seen, and refused, by another process
  int fd = open("lockfile", O_RDWR | O_CREAT, 0600);
  struct flock fl = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 10 };
  if (fcntl(fd, F_SETLK, &fl)) return 1;
  pid_t parent = getpid(), kid = fork();
  if (!kid) {
    struct flock q = { .l_type = F_RDLCK, .l_whence = SEEK_SET, .l_start = 5, .l_len = 1 };
    fcntl(fd, F_GETLK, &q);
    int seen = q.l_type == F_WRLCK && q.l_pid == parent;
    q.l_type = F_RDLCK;
    int refused = fcntl(fd, F_SETLK, &q) == -1 && (errno == EAGAIN || errno == EACCES);
    _exit(seen * 2 + refused);
  }
  int st;
  waitpid(kid, &st, 0);
  printf("locks %d\n", WEXITSTATUS(st));
  unlink("lockfile");
  return 0;
}
