// A named semaphore keeps its count across sem_close and sem_open (glibc
// maps a temporary /dev/shm file, links it to the name and unlinks it; the
// mapping's bytes go back to the linked name: Open POSIX sem_close_3-2).
#include <fcntl.h>
#include <semaphore.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
  char name[64];
  int v = -1;
  sem_t *s;
  snprintf(name, sizeof(name), "/semreopen_%d", getpid());
  s = sem_open(name, O_CREAT | O_EXCL, 0600, 2);
  sem_wait(s);
  sem_close(s);
  s = sem_open(name, O_CREAT, 0600, 3);
  sem_getvalue(s, &v);
  printf("value %d\n", v);
  sem_close(s);
  sem_unlink(name);
  return 0;
}
