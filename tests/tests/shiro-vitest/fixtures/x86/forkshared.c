/* Fixture for x86-engine.test.ts: MAP_SHARED memory stays shared with a
   forked child (LTP keeps its results there); once it's unmapped, fork is a
   real copy again. Build: gcc -static -O1 -o forkshared forkshared.c */
#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
int counter = 100;
int main() {
  setvbuf(stdout, 0, _IONBF, 0);
  int *p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  *p = 0;
  if (fork() == 0) { *p = 42; _exit(0); }
  wait(0);
  printf("anon shared %d\n", *p);
  int fd = open("/tmp/forkshared.dat", O_RDWR | O_CREAT | O_TRUNC, 0600);
  ftruncate(fd, 4096);
  int *q = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  q[1] = 1;
  if (fork() == 0) { q[1] = 7; _exit(0); }
  wait(0);
  printf("file shared %d\n", q[1]);
  munmap(p, 4096);
  munmap(q, 4096);
  close(fd);
  unlink("/tmp/forkshared.dat");
  int fds[2];
  pipe(fds);
  pid_t c = fork();
  if (c == 0) {
    counter += 1;  // a real fork: the parent keeps 100
    char b = 'x';
    write(fds[1], &b, 1);
    for (;;) pause();  // runs alongside the parent until killed
  }
  char b;
  read(fds[0], &b, 1);
  kill(c, 9);
  waitpid(c, 0, 0);
  printf("private after unmap %d\n", counter);
  return 0;
}
