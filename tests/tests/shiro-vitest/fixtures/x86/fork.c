/* Fixture for x86-engine.test.ts: fork() without exec (memory copied, child runs alongside).
   Build: x86_64-linux-musl-gcc -static -Os -s -o fork-musl fork.c */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
int counter = 100;
int main() {
  int fds[2]; pipe(fds);
  char *heap = malloc(100000); strcpy(heap, "heap data");
  pid_t p = fork();
  if (p == 0) {
    close(fds[0]);
    counter += 1;  // must not affect the parent
    char buf[200]; int n = snprintf(buf, sizeof buf, "child: pid=%d ppid=%d counter=%d heap=%s\n", getpid(), getppid(), counter, heap);
    write(fds[1], buf, n);
    strcpy(heap, "child wrote");
    _exit(5);
  }
  close(fds[1]);
  char buf[256]; int n = read(fds[0], buf, sizeof buf - 1); buf[n > 0 ? n : 0] = 0;
  int st; waitpid(p, &st, 0);
  printf("%sparent: counter=%d heap=%s child exit=%d\n", buf, counter, heap, WEXITSTATUS(st));
  /* a child that keeps running alongside the parent (like tar's helper) */
  int a[2], b[2]; pipe(a); pipe(b);
  if (fork() == 0) {
    close(a[1]); close(b[0]);
    char c; while (read(a[0], &c, 1) == 1) { c = c - 'a' + 'A'; write(b[1], &c, 1); }
    _exit(0);
  }
  close(a[0]); close(b[1]);
  write(a[1], "hello", 5); close(a[1]);
  n = 0; while (n < 5) { int k = read(b[0], buf + n, 5 - n); if (k <= 0) break; n += k; } buf[n] = 0;
  wait(&st);
  printf("echo child: %s\n", buf);
  return 0;
}
