/* Fixture for x86-engine.test.ts: a child exits (exit_group) while its other
   threads run; they must end with it (the counter in shared memory stops).
   Build: gcc -static -O1 -pthread -o mtchild mtchild.c */
#include <pthread.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
static volatile long *counter;
static void *worker(void *a) { for (;;) { ++*counter; usleep(1000); } return a; }
static void *sleeper(void *a) { for (;;) pause(); return a; }
int main() {
  counter = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  for (int round = 0; round < 2; ++round) {
    pid_t c = fork();
    if (c == 0) {
      pthread_t t1, t2;
      pthread_create(&t1, 0, worker, 0);
      pthread_create(&t2, 0, sleeper, 0);
      while (*counter < 5) usleep(1000);
      _exit(10 + round);  /* exit_group with two other threads running */
    }
    int st;
    waitpid(c, &st, 0);
    usleep(100000);
    long a = *counter;
    usleep(300000);
    long b = *counter;
    printf("round %d: child exit %d, its threads stopped %d\n", round, WEXITSTATUS(st), a == b);
    *counter = 0;
  }
  return 0;
}
