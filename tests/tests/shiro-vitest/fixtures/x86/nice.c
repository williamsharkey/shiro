// getpriority/setpriority keep a nice value per process (pam_limits sets it
// for every su/runuser session; emscripten's stubs said -ENODEV/EPERM):
// raw syscall 20 - nice, inherited on fork, only root may lower it
#include <errno.h>
#include <stdio.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
int main(void) {
  errno = 0;
  int g0 = getpriority(PRIO_PROCESS, 0), e0 = errno;
  long raw = syscall(SYS_getpriority, PRIO_PROCESS, 0);
  int s0 = setpriority(PRIO_PROCESS, 0, 0);
  int s5 = setpriority(PRIO_PROCESS, 0, 5), g5 = getpriority(PRIO_PROCESS, 0);
  int st, pid = fork();
  if (!pid) _exit(getpriority(PRIO_PROCESS, 0));
  waitpid(pid, &st, 0);
  int lower = setpriority(PRIO_PROCESS, 0, 2), le = errno;
  printf("get %d errno %d raw %ld set0 %d set5 %d get %d child %d lower-as-%s %s\n", g0, e0, raw, s0, s5, g5,
         WEXITSTATUS(st), geteuid() ? "user" : "root",
         geteuid() ? (lower == -1 && le == EACCES ? "EACCES" : "?") : (lower == 0 ? "ok" : "?"));
  return 0;
}
