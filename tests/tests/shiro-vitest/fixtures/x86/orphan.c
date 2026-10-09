/* Fixture for x86-engine.test.ts: kill -9 of a child spinning in guest code, SIGTERM to a pausing one, and (with an argument) a child that outlives its parent. Build: gcc -static -O1 */
#include <stdio.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
int main(int argc, char **argv) {
  if (argc > 1) {  /* parent exits first; the child writes a file later */
    if (fork() == 0) {
      usleep(300000);
      int fd = open("/tmp/orphan.out", O_WRONLY | O_CREAT | O_TRUNC, 0644);
      (void)!write(fd, "child outlived parent\n", 22);
      close(fd);
      _exit(0);
    }
    return 0;
  }
  pid_t c = fork();
  if (c == 0) { for (;;) ; }  /* spins in guest code until killed */
  usleep(100000);
  kill(c, SIGKILL);
  int st;
  waitpid(c, &st, 0);
  printf("killed spinning child: signaled=%d sig=%d\n", WIFSIGNALED(st), WTERMSIG(st));
  pid_t d = fork();
  if (d == 0) { signal(SIGTERM, SIG_DFL); pause(); _exit(1); }
  usleep(100000);
  kill(d, SIGTERM);
  waitpid(d, &st, 0);
  printf("SIGTERM to pausing child: signaled=%d sig=%d\n", WIFSIGNALED(st), WTERMSIG(st));
  return 0;
}
