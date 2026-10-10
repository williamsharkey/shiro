// POSIX named semaphores (glibc: /dev/shm/sem.NAME mapped MAP_SHARED) in one
// process, across fork, and with a process it exec'd (docs/research/SHARED_MAPPINGS.md).
#include <errno.h>
#include <fcntl.h>
#include <semaphore.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "post") == 0) {  // a separate process posts
    sem_t *s = sem_open("/shirotest", 0);
    if (s == SEM_FAILED) { perror("sem_open(post)"); return 1; }
    sem_post(s);
    printf("posted\n");
    return 0;
  }
  sem_unlink("/shirotest");
  sem_t *s = sem_open("/shirotest", O_CREAT | O_EXCL, 0600, 1);
  if (s == SEM_FAILED) { perror("sem_open"); return 1; }
  int v = -1;
  sem_getvalue(s, &v); printf("initial %d\n", v);
  if (sem_wait(s) != 0) perror("sem_wait");
  sem_getvalue(s, &v); printf("after wait %d\n", v);
  printf("trywait %s\n", sem_trywait(s) == 0 ? "ok" : strerror(errno));
  pid_t c = fork();
  if (c == 0) { sem_post(s); _exit(0); }
  waitpid(c, 0, 0);
  sem_getvalue(s, &v); printf("after fork child post %d\n", v);
  if (sem_wait(s) != 0) perror("sem_wait 2");
  // an unrelated process (exec'd) posts
  c = fork();
  if (c == 0) { execl(argv[0], argv[0], "post", (char *)0); _exit(127); }
  struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts); ts.tv_sec += 5;
  int r = sem_timedwait(s, &ts);
  printf("exec'd process post seen: %s\n", r == 0 ? "yes" : strerror(errno));
  waitpid(c, 0, 0);
  sem_close(s);
  printf("unlink %d\n", sem_unlink("/shirotest"));
  return 0;
}
