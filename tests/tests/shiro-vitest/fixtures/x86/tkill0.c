// pthread_kill(self, 0) and tgkill of signal 0 probe the thread (Open
// POSIX pthread_kill_2-1, 3-1)
#define _GNU_SOURCE
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(void) {
  printf("pthread_kill %d tgkill %ld tkill %ld\n", pthread_kill(pthread_self(), 0),
         syscall(SYS_tgkill, getpid(), gettid(), 0), syscall(SYS_tkill, gettid(), 0));
  return 0;
}
