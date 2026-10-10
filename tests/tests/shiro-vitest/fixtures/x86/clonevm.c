// clone(CLONE_VM | CLONE_PARENT_SETTID | SIGCHLD) on a stack of its own: a
// process sharing its parent's memory (LTP clone08). ptid holds the child's
// pid before it runs, what it writes the parent sees, and the parent reaps it.
#define _GNU_SOURCE
#include <sched.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static pid_t ptid;
static volatile int shared;
static char stack[64 * 1024] __attribute__((aligned(16)));

static int child(void *arg) {
  (void)arg;
  shared = ptid == syscall(SYS_getpid) ? 1 : 2;
  syscall(SYS_exit, 7);
  return 0;
}

int main(void) {
  int st;
  pid_t pid = clone(child, stack + sizeof(stack), CLONE_VM | CLONE_PARENT_SETTID | SIGCHLD, 0, &ptid);
  if (pid < 0) { perror("clone"); return 1; }
  if (waitpid(pid, &st, 0) != pid) { perror("waitpid"); return 1; }
  printf("ptid %d shared %d exit %d\n", ptid == pid, shared, WIFEXITED(st) ? WEXITSTATUS(st) : -1);
  return 0;
}
