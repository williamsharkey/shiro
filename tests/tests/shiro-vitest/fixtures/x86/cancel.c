// pthread_cancel: glibc's SIGCANCEL handler acts only on SI_TKILL from its
// own pid, and asynchronous cancellation unwinds through the signal frame
// (Linux's rt_sigframe: the ucontext right above the return address).
// Open POSIX pthread_cancel_*, pthread_setcancel{state,type}_*.
#define _GNU_SOURCE
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <ucontext.h>
#include <unistd.h>

static volatile int cleaned, spin = 1, got_code, got_pid, rip_ok;
static void cleanup(void *a) { cleaned += (int)(long)a; }

static void *deferred(void *a) {
  pthread_cleanup_push(cleanup, (void *)1);
  for (;;) sleep(1);
  pthread_cleanup_pop(0);
  return 0;
}
static void *async(void *a) {
  pthread_setcanceltype(PTHREAD_CANCEL_ASYNCHRONOUS, 0);
  pthread_cleanup_push(cleanup, (void *)10);
  while (spin) {}
  pthread_cleanup_pop(0);
  return 0;
}
static void handler(int sig, siginfo_t *si, void *ctx) {
  ucontext_t *uc = ctx;
  got_code = si->si_code, got_pid = si->si_pid;
  rip_ok = uc->uc_mcontext.gregs[REG_RIP] != 0 && (void *)uc < (void *)si;
}
static void *waiter(void *a) { while (!got_code) usleep(1000); return 0; }

int main(void) {
  pthread_t t; void *r;
  pthread_create(&t, 0, deferred, 0);
  usleep(50000);
  pthread_cancel(t);
  pthread_join(t, &r);
  printf("deferred cleaned %d canceled %d\n", cleaned, r == PTHREAD_CANCELED);
  pthread_create(&t, 0, async, 0);
  usleep(50000);
  pthread_cancel(t);
  pthread_join(t, &r);
  printf("async cleaned %d canceled %d\n", cleaned, r == PTHREAD_CANCELED);
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = handler, sa.sa_flags = SA_SIGINFO;
  sigaction(SIGUSR1, &sa, 0);
  pthread_create(&t, 0, waiter, 0);
  pthread_kill(t, SIGUSR1);
  pthread_join(t, 0);
  printf("tkill code %d self %d frame %d\n", got_code, got_pid == getpid(), rip_ok);
  return 0;
}
