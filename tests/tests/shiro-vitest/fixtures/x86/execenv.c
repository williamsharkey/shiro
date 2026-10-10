/* execve's envp is the new program's whole environment: nothing added (LTP execve01). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "child")) {
    int n = 0;
    for (char **e = environ; *e; e++) n++;
    printf("child env %d PATH %s ONLY %s\n", n, getenv("PATH") ? getenv("PATH") : "(none)", getenv("ONLY") ? getenv("ONLY") : "(none)");
    return 0;
  }
  char *args[] = {argv[0], "child", NULL};
  char *envp[] = {"ONLY=1", NULL};
  if (argc > 1 && !strcmp(argv[1], "fork")) {  /* LTP's way: from a fork child */
    pid_t pid = fork();
    if (pid == 0) {
      execve(argv[0], args, envp);
      perror("execve");
      _exit(1);
    }
    int st;
    waitpid(pid, &st, 0);
    return 0;
  }
  execve(argv[1] && !strcmp(argv[1], "self") ? "/proc/self/exe" : argv[0], args, envp);
  perror("execve");
  return 1;
}
