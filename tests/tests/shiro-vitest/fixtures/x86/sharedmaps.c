// MAP_SHARED mappings of a /dev/shm file (shm_open): a write-only mapping
// takes writes (x86 has no write-only pages), a second mapping sees the
// first's bytes, and what a child wrote and left mapped at its exit is the
// file's (Open POSIX shm_open_1-1, 5-1)
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
  int fd = shm_open("/sharedmaps_test", O_RDWR | O_CREAT, 0600);
  if (fd < 0 || ftruncate(fd, 4096)) return 1;
  char *w = mmap(0, 4096, PROT_WRITE, MAP_SHARED, fd, 0);
  strcpy(w, "qwerty");
  char *r = mmap(0, 4096, PROT_READ, MAP_SHARED, fd, 0);
  printf("second %s\n", r);
  munmap(r, 4096);
  pid_t pid = fork();
  if (pid == 0) {
    char *c = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    strcpy(c + 100, "from child");
    _exit(0);
  }
  waitpid(pid, 0, 0);
  r = mmap(0, 4096, PROT_READ, MAP_SHARED, fd, 0);
  printf("child %s\n", r + 100);
  shm_unlink("/sharedmaps_test");
  return 0;
}
