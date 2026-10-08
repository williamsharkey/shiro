// Fixture for x86-engine.test.ts: edge cases for Blink's wasm JIT (patch 0012).
// Build: gcc -static -O1 -pthread -o jit jit.c
//   ./jit smc      code rewritten between runs (W^X flips and an RWX page)
//   ./jit signal   SIGUSR1 handlers run while a hot loop spins
//   ./jit fault    SIGSEGV in a hot loop; the handler fixes the page, the loop resumes
//   ./jit threads  four threads run the same hot code on shared data
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

typedef int (*fn_t)(int);

// mov $imm32, %eax; add %edi, %eax; ret
static void emit(unsigned char *p, int imm) {
  p[0] = 0xb8;
  memcpy(p + 1, &imm, 4);
  p[5] = 0x01;
  p[6] = 0xf8;
  p[7] = 0xc3;
}

static long hot(fn_t f, int n) {
  long s = 0;
  for (int i = 0; i < n; ++i) s += f(i & 7);
  return s;
}

static int smc(void) {
  long a, b, c, d;
  unsigned char *p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  emit(p, 1000);
  mprotect(p, 4096, PROT_READ | PROT_EXEC);
  a = hot((fn_t)p, 100000);  // hot enough to be compiled
  mprotect(p, 4096, PROT_READ | PROT_WRITE);
  emit(p, 2000);
  mprotect(p, 4096, PROT_READ | PROT_EXEC);
  b = hot((fn_t)p, 100000);
  // an RWX page rewritten in place, no mprotect in between
  unsigned char *q = mmap(0, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  emit(q, 3000);
  c = hot((fn_t)q, 100000);
  emit(q, 4000);
  d = hot((fn_t)q, 100000);
  // munmap + mmap at the same address with different code
  munmap(p, 4096);
  p = mmap(p, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
  emit(p, 5000);
  mprotect(p, 4096, PROT_READ | PROT_EXEC);
  long e = hot((fn_t)p, 100000);
  printf("smc %ld %ld %ld %ld %ld\n", a, b, c, d, e);
  return !(a == 100350000 && b == 200350000 && c == 300350000 && d == 400350000 && e == 500350000);
}

static volatile sig_atomic_t ticks;
static void on_usr1(int sig) {
  (void)sig;
  ++ticks;
}

static void *pinger(void *arg) {
  struct timespec ts = {0, 5000000};
  (void)arg;
  for (int i = 0; i < 5; ++i) {
    nanosleep(&ts, 0);
    kill(getpid(), SIGUSR1);
  }
  return 0;
}

static int signal_test(void) {
  struct sigaction sa = {0};
  unsigned long x = 1, n = 0;
  pthread_t t;
  sa.sa_handler = on_usr1;
  sigaction(SIGUSR1, &sa, 0);
  pthread_create(&t, 0, pinger, 0);
  while (ticks < 5) {  // the loop only ends if the handler runs
    x = x * 6364136223846793005ul + 1442695040888963407ul;
    x ^= x >> 13;
    ++n;
  }
  pthread_join(t, 0);
  printf("signal ticks=%d spun=%s\n", (int)ticks, n > 1000 ? "yes" : "no");
  return ticks < 5;
}

static long *volatile page;
static volatile int faults;
static void on_segv(int sig, siginfo_t *si, void *uc) {
  (void)sig;
  (void)uc;
  ++faults;
  if ((char *)si->si_addr < (char *)page || (char *)si->si_addr >= (char *)page + 4096) _exit(3);
  mprotect((void *)page, 4096, PROT_READ | PROT_WRITE);
}

static int fault_test(void) {
  struct sigaction sa = {0};
  long sum = 0;
  sa.sa_sigaction = on_segv;
  sa.sa_flags = SA_SIGINFO;
  sigaction(SIGSEGV, &sa, 0);
  page = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  for (int round = 0; round < 3; ++round) {
    for (int i = 0; i < 100000; ++i) {
      if (i == 50000) mprotect((void *)page, 4096, PROT_READ);
      page[i & 511] += i;  // faults once per round, the handler unprotects
      sum += page[(i * 7) & 511];
    }
  }
  printf("fault faults=%d sum=%ld\n", faults, sum);
  return faults != 3;
}

static atomic_long counter;
static long plain[4];
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static long locked;

static void *worker(void *arg) {
  long id = (long)arg;
  for (int i = 0; i < 200000; ++i) {
    atomic_fetch_add(&counter, 1);
    plain[id] += i & 3;
    if (!(i & 1023)) {
      pthread_mutex_lock(&lock);
      ++locked;
      pthread_mutex_unlock(&lock);
    }
  }
  return 0;
}

static int threads_test(void) {
  pthread_t t[4];
  for (long i = 0; i < 4; ++i) pthread_create(&t[i], 0, worker, (void *)i);
  for (int i = 0; i < 4; ++i) pthread_join(t[i], 0);
  printf("threads counter=%ld plain=%ld,%ld,%ld,%ld locked=%ld\n", (long)counter, plain[0], plain[1], plain[2], plain[3], locked);
  return !(counter == 800000 && plain[0] == 300000 && plain[3] == 300000 && locked == 4 * 196);
}

int main(int argc, char **argv) {
  const char *what = argc > 1 ? argv[1] : "";
  if (!strcmp(what, "smc")) return smc();
  if (!strcmp(what, "signal")) return signal_test();
  if (!strcmp(what, "fault")) return fault_test();
  if (!strcmp(what, "threads")) return threads_test();
  fprintf(stderr, "usage: jit smc|signal|fault|threads\n");
  return 2;
}
