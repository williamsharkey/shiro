/* A /dev/shm object's fd and its MAP_SHARED mapping are one file: pread sees
 * what the mapping wrote (while mapped and after munmap), the mapping sees
 * what pwrite wrote, and an fd opened while it is mapped sees it too
 * (conformance's report from Open POSIX's shm_open cases). */
#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>

static char at(int fd, off_t off) {
  char c = 0;
  return pread(fd, &c, 1, off) == 1 && c ? c : '0';
}

int main(void) {
  const char *name = "/shmpread-test";
  shm_unlink(name);
  int fd = shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
  if (fd < 0) { perror("shm_open"); return 1; }
  if (ftruncate(fd, 12288)) { perror("ftruncate"); return 1; }
  char *p = mmap(0, 12288, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (p == MAP_FAILED) { perror("mmap"); return 1; }
  p[1] = 'a';
  p[8193] = 'z';
  printf("mapped pread %c\n", at(fd, 1));
  char c = 'w';
  if (pwrite(fd, &c, 1, 2) != 1) perror("pwrite");
  printf("mapping sees pwrite %c\n", p[2] ? p[2] : '0');
  close(fd);
  p[3] = 'q';
  fd = shm_open(name, O_RDWR, 0);
  printf("reopened while mapped %c%c\n", at(fd, 1), at(fd, 3));
  munmap(p, 12288);
  printf("after munmap pread %c %c %c %c\n", at(fd, 1), at(fd, 8193), at(fd, 2), at(fd, 3));
  close(fd);
  fd = shm_open(name, O_RDWR, 0);
  printf("reopened pread %c%c%c\n", at(fd, 1), at(fd, 2), at(fd, 3));
  close(fd);
  shm_unlink(name);
  return 0;
}
