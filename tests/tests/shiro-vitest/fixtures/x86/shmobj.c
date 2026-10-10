#define _GNU_SOURCE
// Blink 0112 (shmobj): a memfd mapped MAP_SHARED by a process and by one it
// exec'd (another Blink instance), as Firefox shares its font list: lock-prefixed
// adds, a PTHREAD_PROCESS_SHARED mutex and semaphores across the two.
#include <pthread.h>
#include <semaphore.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#define N 2000
#define PINGS 50
struct shared {
  pthread_mutex_t mu;
  sem_t ping, pong;
  long atomic, locked;
  char text[64];
};
static void work(struct shared *s) {
  for (int i = 0; i < N; i++) {
    __atomic_fetch_add(&s->atomic, 1, __ATOMIC_SEQ_CST);
    pthread_mutex_lock(&s->mu);
    s->locked++;
    pthread_mutex_unlock(&s->mu);
  }
}
int main(int argc, char **argv) {
  if (argc > 2) {  // the exec'd process: a fresh mapping of the inherited memfd
    struct shared *s = mmap(0, 8192, PROT_READ | PROT_WRITE, MAP_SHARED, atoi(argv[2]), 0);
    if (s == MAP_FAILED) { perror("child mmap"); return 1; }
    printf("child sees \"%s\"\n", s->text);
    fflush(stdout);
    for (int i = 0; i < PINGS; i++) { sem_wait(&s->ping); sem_post(&s->pong); }
    work(s);
    strcpy(s->text, "written by the child");
    return 0;
  }
  int fd = memfd_create("shmobj", 0);
  if (fd < 0 || ftruncate(fd, 8192)) { perror("memfd"); return 1; }
  struct shared *s = mmap(0, 8192, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (s == MAP_FAILED) { perror("mmap"); return 1; }
  pthread_mutexattr_t ma;
  pthread_mutexattr_init(&ma);
  pthread_mutexattr_setpshared(&ma, PTHREAD_PROCESS_SHARED);
  pthread_mutex_init(&s->mu, &ma);
  sem_init(&s->ping, 1, 0);
  sem_init(&s->pong, 1, 0);
  strcpy(s->text, "written by the parent");
  pid_t c = fork();
  if (c == 0) {
    char fds[16];
    snprintf(fds, sizeof fds, "%d", fd);
    execl(argv[0], argv[0], "child", fds, (char *)0);
    _exit(127);
  }
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  int pongs = 0;
  for (int i = 0; i < PINGS; i++) {
    sem_post(&s->ping);
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += 10;
    if (sem_timedwait(&s->pong, &ts) == 0) pongs++;
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);
  work(s);
  int st;
  waitpid(c, &st, 0);
  printf("pongs %d atomic %ld locked %ld text \"%s\" exit %d\n", pongs, s->atomic, s->locked, s->text,
         WIFEXITED(st) ? WEXITSTATUS(st) : -1);
  fprintf(stderr, "ping-pong %.2f ms per round trip\n",
          ((t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6) / PINGS);
  return 0;
}
