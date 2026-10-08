/* Fixture for x86-engine.test.ts (fork, posix_spawn, popen, system, exec failure).
   Build: x86_64-linux-musl-gcc -static -Os -s -o proc-musl proc.c */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <signal.h>
extern char **environ;
int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "child")) { printf("child pid=%d ppid=%d arg=%s\n", getpid(), getppid(), argc > 2 ? argv[2] : ""); return 7; }
  int st; pid_t p;
  /* fork + exec + wait */
  p = fork();
  if (p == 0) { execl(argv[0], argv[0], "child", "forked", (char*)0); _exit(127); }
  waitpid(p, &st, 0);
  printf("fork: pid>0=%d exit=%d\n", p > 0, WEXITSTATUS(st));
  /* posix_spawn with a pipe */
  int fds[2]; pipe(fds);
  posix_spawn_file_actions_t fa; posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, fds[1], 1);
  posix_spawn_file_actions_addclose(&fa, fds[0]);
  char *cargv[] = { argv[0], "child", "spawned", 0 };
  if (posix_spawn(&p, argv[0], &fa, 0, cargv, environ)) { perror("posix_spawn"); return 1; }
  close(fds[1]);
  char buf[256]; int n = read(fds[0], buf, sizeof buf - 1); buf[n > 0 ? n : 0] = 0;
  waitpid(p, &st, 0);
  printf("spawn read: %s", buf);
  printf("spawn exit=%d\n", WEXITSTATUS(st));
  /* popen through /bin/sh */
  FILE *f = popen("echo hello from sh | tr a-z A-Z", "r");
  if (!f) { perror("popen"); return 1; }
  if (fgets(buf, sizeof buf, f)) printf("popen: %s", buf);
  printf("pclose=%d\n", WEXITSTATUS(pclose(f)));
  /* system */
  printf("system=%d\n", WEXITSTATUS(system("exit 3")));
  /* exec failure in child reported */
  p = fork();
  if (p == 0) { execl("/nonexistent", "x", (char*)0); _exit(42); }
  waitpid(p, &st, 0);
  printf("execfail exit=%d\n", WEXITSTATUS(st));
  return 0;
}
