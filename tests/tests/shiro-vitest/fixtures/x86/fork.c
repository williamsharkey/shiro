// Fixture for x86-engine.test.ts: fork() is a real copy (Blink patch 0013).
// Build: gcc -static -O1 -o fork fork.c
//   ./fork copy     the child changes memory and exits without exec; the
//                   parent's memory is unchanged, the exit status arrives
//   ./fork pipe     pipe + fork + dup2 + exec in the child, parent reads
//                   (the perl `open STDOUT, ">&W"; exec` pattern)
//   ./fork nested   a fork child forks again
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int counter = 1;
static char heapmsg[64];

static int copy(void) {
  char *heap = malloc(1 << 20);
  int st, fds[2];
  memset(heap, 'p', 1 << 20);
  strcpy(heapmsg, "parent");
  if (pipe(fds)) return 1;
  pid_t pid = fork();
  if (pid < 0) return 2;
  if (!pid) {
    close(fds[0]);
    counter = 100;  // must not reach the parent
    memset(heap, 'c', 1 << 20);
    strcpy(heapmsg, "child");
    char buf[64];
    int n = snprintf(buf, sizeof buf, "child sees %d %c %s\n", counter, heap[12345], heapmsg);
    if (write(fds[1], buf, n) != n) _exit(9);
    _exit(7);  // no exec
  }
  close(fds[1]);
  char buf[128] = {0};
  int n = 0, r;
  while ((r = read(fds[0], buf + n, sizeof buf - 1 - n)) > 0) n += r;
  if (waitpid(pid, &st, 0) != pid) return 3;
  printf("%sparent sees %d %c %s status %d\n", buf, counter, heap[12345], heapmsg,
         WIFEXITED(st) ? WEXITSTATUS(st) : -1);
  return 0;
}

static int pipeexec(void) {
  int fds[2], st;
  if (pipe(fds)) return 1;
  pid_t pid = fork();
  if (!pid) {
    close(fds[0]);
    dup2(fds[1], 1);
    close(fds[1]);
    execl("/bin/sh", "sh", "-c", "echo from-exec", (char *)0);
    _exit(127);
  }
  close(fds[1]);
  char buf[64] = {0};
  int n = 0, r;
  while ((r = read(fds[0], buf + n, sizeof buf - 1 - n)) > 0) n += r;
  waitpid(pid, &st, 0);
  printf("pipe got: %s", buf);
  return 0;
}

static int nested(void) {
  int st;
  pid_t a = fork();
  if (!a) {
    counter = 2;
    pid_t b = fork();
    if (!b) {
      counter += 40;
      _exit(counter);  // 42
    }
    waitpid(b, &st, 0);
    _exit(WEXITSTATUS(st) + counter);  // 44
  }
  waitpid(a, &st, 0);
  printf("nested status %d counter %d\n", WEXITSTATUS(st), counter);
  return 0;
}

int main(int argc, char **argv) {
  const char *what = argc > 1 ? argv[1] : "";
  setvbuf(stdout, 0, _IONBF, 0);
  if (!strcmp(what, "copy")) return copy();
  if (!strcmp(what, "pipe")) return pipeexec();
  if (!strcmp(what, "nested")) return nested();
  fprintf(stderr, "usage: fork copy|pipe|nested\n");
  return 2;
}
