// A /dev/shm object unlinked before it's mapped (Open POSIX mmap_7-4): the
// parent's MAP_SHARED store is what a fork child's MAP_PRIVATE map of the
// same fd reads, and what read() on the fd returns.
#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
int main(void) {
  int fd = shm_open("/shmunlinked", O_RDWR | O_CREAT | O_EXCL, 0600);
  shm_unlink("/shmunlinked");
  if (fd < 0 || ftruncate(fd, 1024)) { perror("shm"); return 1; }
  char *p = mmap(0, 1024, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (p == MAP_FAILED) { perror("mmap"); return 1; }
  p[0] = 'a';
  pid_t c = fork();
  if (c == 0) {
    char *q = mmap(0, 1024, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0), r = 0;
    if (pread(fd, &r, 1, 0) != 1) r = '?';
    printf("child private map '%c' pread '%c'\n", q == MAP_FAILED ? '?' : q[0], r);
    fflush(stdout);
    _exit(0);
  }
  waitpid(c, 0, 0);
  return 0;
}
