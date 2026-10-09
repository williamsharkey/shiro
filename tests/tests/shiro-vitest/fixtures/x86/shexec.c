/* execve /bin/sh and /bin/bash with options before and after -c, as agent
 * CLIs do (Claude Code: sh -c -l 'cmd'); prints each run's output and status. */
#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>

static void run(int k, char *const argv[]) {
  fflush(stdout);
  pid_t pid = fork();
  if (pid == 0) {
    extern char **environ;
    execve(argv[0], argv, environ);
    _exit(127);
  }
  int st = 0;
  waitpid(pid, &st, 0);
  printf("[%d] status=%d\n", k, WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st));
}

int main(void) {
  char *a1[] = { "/bin/sh", "-c", "-l", "echo hi", 0 };
  char *a2[] = { "/bin/bash", "-l", "-c", "echo $0 $1", "a", "b", 0 };
  char *a3[] = { "/bin/sh", "-c", "-e", "false; echo not-reached", 0 };
  char *a4[] = { "/bin/sh", "--login", "-c", "echo login", 0 };
  char *a5[] = { "/bin/bash", "-lc", "echo lc", 0 };
  char *a6[] = { "/bin/sh", "-c", "-l", "--", "echo dashdash $0", "zero", 0 };
  run(1, a1); run(2, a2); run(3, a3); run(4, a4); run(5, a5); run(6, a6);
  return 0;
}
