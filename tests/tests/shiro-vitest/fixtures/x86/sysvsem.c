// System V semaphores as Audacity's single-instance lock and PostgreSQL use
// them: values, GETALL/SETALL, a semop that blocks until another process's
// SEM_UNDO gives the unit back at its exit, semtimedop's timeout, IPC_NOWAIT
// and IPC_RMID.
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/sem.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
union semun { int val; struct semid_ds *buf; unsigned short *array; };
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
int main(void) {
  int id = semget(IPC_PRIVATE, 2, IPC_CREAT | 0600);
  printf("semget %s\n", id >= 0 ? "ok" : strerror(errno));
  union semun u;
  u.val = 1;
  int sv = semctl(id, 0, SETVAL, u);
  printf("setval %d getval %d\n", sv, semctl(id, 0, GETVAL));
  unsigned short all[2] = {1, 0}, got[2] = {9, 9};
  u.array = all;
  semctl(id, 0, SETALL, u);
  u.array = got;
  semctl(id, 0, GETALL, u);
  struct semid_ds ds;
  u.buf = &ds;
  semctl(id, 0, IPC_STAT, u);
  printf("getall %d %d nsems %lu\n", got[0], got[1], (unsigned long)ds.sem_nsems);
  fflush(stdout);
  pid_t pid = fork();
  if (!pid) {  // takes the unit with SEM_UNDO and exits holding it
    struct sembuf take = {0, -1, SEM_UNDO};
    semop(id, &take, 1);
    usleep(150000);
    _exit(0);
  }
  usleep(50000);
  struct sembuf take = {0, -1, 0}, nowait = {0, -1, IPC_NOWAIT};
  int r = semop(id, &nowait, 1);
  printf("nowait while held %d %s\n", r, r ? strerror(errno) : "");
  double t0 = now();
  r = semop(id, &take, 1);  // blocks until the child's exit undoes its take
  printf("blocking semop %d after child exit %d\n", r, now() - t0 > 50);
  waitpid(pid, 0, 0);
  struct sembuf one = {1, -1, 0};
  struct timespec tmo = {0, 50 * 1000000};
  t0 = now();
  r = semtimedop(id, &one, 1, &tmo);
  printf("semtimedop %d %s waited %d\n", r, strerror(errno), now() - t0 >= 45);
  printf("rmid %d\n", semctl(id, 0, IPC_RMID));
  r = semop(id, &take, 1);
  printf("semop after rmid %d %s\n", r, strerror(errno));
  return 0;
}
