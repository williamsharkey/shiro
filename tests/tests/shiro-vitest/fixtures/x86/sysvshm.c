// System V shared memory as PostgreSQL uses it: a segment attached before
// fork is the same memory in the child; shm_nattch counts the attachments;
// IPC_RMID ends it once nothing is attached. Also POSIX shm (/dev/shm,
// MAP_SHARED) across fork, PostgreSQL's dynamic shared memory.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/mman.h>
#include <sys/shm.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
  int id = shmget(IPC_PRIVATE, 56, IPC_CREAT | 0600);
  printf("shmget %s\n", id >= 0 ? "ok" : strerror(errno));
  char *p = shmat(id, 0, 0);
  printf("shmat %s\n", p != (void *)-1 ? "ok" : strerror(errno));
  strcpy(p, "parent");
  struct shmid_ds ds;
  shmctl(id, IPC_STAT, &ds);
  printf("nattch %lu size %zu\n", (unsigned long)ds.shm_nattch, ds.shm_segsz);
  fflush(stdout);
  pid_t pid = fork();
  if (!pid) {
    shmctl(id, IPC_STAT, &ds);
    printf("child sees \"%s\" nattch %lu\n", p, (unsigned long)ds.shm_nattch);
    fflush(stdout);
    strcpy(p, "child");
    char *q = shmat(id, 0, SHM_RDONLY);  // a second attachment, same bytes
    printf("child second attach sees \"%s\"\n", q);
    fflush(stdout);
    shmdt(q);
    _exit(0);
  }
  waitpid(pid, 0, 0);
  shmctl(id, IPC_STAT, &ds);
  printf("parent sees \"%s\" nattch %lu\n", p, (unsigned long)ds.shm_nattch);
  printf("shmdt %d\n", shmdt(p));
  int r = shmdt(p);
  printf("shmdt again %d %s\n", r, strerror(errno));
  printf("rmid %d\n", shmctl(id, IPC_RMID, 0));
  printf("attach after rmid %s\n", shmat(id, 0, 0) == (void *)-1 ? strerror(errno) : "ok");

  int fd = shm_open("/fixture", O_CREAT | O_RDWR, 0600);
  if (fd < 0 || ftruncate(fd, 4096)) return 1;
  char *m = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  strcpy(m, "before");
  fflush(stdout);
  if (!(pid = fork())) {
    strcpy(m, "from child");
    _exit(0);
  }
  waitpid(pid, 0, 0);
  printf("posix shm \"%s\"\n", m);
  shm_unlink("/fixture");
  return 0;
}
