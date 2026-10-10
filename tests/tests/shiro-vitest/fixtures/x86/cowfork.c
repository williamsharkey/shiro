// fork's pages are copied on write: parent and child each keep their own
// view of the heap, stack, brk and data after either writes; mprotect,
// madvise(DONTNEED), mremap and signal frames after fork act on one side
#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static int data[4096] = {1};  // .data
static volatile int sigs;
static void onusr(int s) { (void)s; volatile char frame[2000]; frame[0] = 1; frame[1999] = frame[0]; ++sigs; }

static long sum(const unsigned char *p, size_t n) { long s = 0; for (size_t i = 0; i < n; ++i) s += p[i] * (long)(i % 7 + 1); return s; }

int main(void) {
  size_t n = 8 << 20;
  unsigned char *heap = malloc(n);  // mmap'd
  unsigned char *small = malloc(4000);  // brk
  unsigned char *map = mmap(0, 1 << 20, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  for (size_t i = 0; i < n; ++i) heap[i] = i * 3;
  memset(small, 7, 4000);
  memset(map, 9, 1 << 20);
  for (int i = 0; i < 4096; ++i) data[i] = i;
  long h0 = sum(heap, n), s0 = sum(small, 4000), m0 = sum(map, 1 << 20), d0 = sum((void *)data, sizeof(data));
  int fds[2], go[2];
  if (pipe(fds) || pipe(go)) return 1;
  signal(SIGUSR1, onusr);
  pid_t c = fork();
  if (!c) {
    char ok = 0;
    read(go[0], &ok, 1);  // the parent has written meanwhile
    int same = sum(heap, n) == h0 && sum(small, 4000) == s0 && sum(map, 1 << 20) == m0 && sum((void *)data, sizeof(data)) == d0;
    memset(heap, 0x55, n);  // the child's own copies
    small[0] = 1, data[5] = -1;
    raise(SIGUSR1);  // a signal frame on the (shared) stack
    mprotect(map, 4096, PROT_READ);
    mprotect(map, 4096, PROT_READ | PROT_WRITE);
    map[1] = 42;
    madvise(map + 8192, 4096, MADV_DONTNEED);  // zeros, in the child only
    unsigned char *m2 = mremap(map, 1 << 20, 2 << 20, MREMAP_MAYMOVE);
    int moved = m2 != MAP_FAILED && m2[1] == 42 && m2[8192] == 0 && m2[100000] == 9;
    m2[5] = 77;
    // a grandchild sees the child's values
    pid_t g = fork();
    if (!g) _exit(heap[100] == 0x55 && m2[5] == 77 && data[5] == -1 ? 0 : 3);
    int gs;
    waitpid(g, &gs, 0);
    char r = same && moved && sigs == 1 && WIFEXITED(gs) && !WEXITSTATUS(gs) ? 'y' : 'n';
    write(fds[1], &r, 1);
    _exit(0);
  }
  // the parent writes while the child waits
  memset(heap + 4096, 0xAA, n / 2);
  small[1] = 3, data[7] = 99, map[3] = 5;
  write(go[1], "x", 1);
  char r = 0;
  read(fds[0], &r, 1);
  int st;
  waitpid(c, &st, 0);
  heap[4096] = heap[4096];  // still writable here
  int mine = heap[0] == 0 && heap[4096] == 0xAA && small[0] == 7 && small[1] == 3 && data[5] == 5 && data[7] == 99 &&
             map[1] == 9 && map[3] == 5 && map[8192] == 9;
  // many children, each writing one page
  int kids_ok = 1;
  for (int k = 0; k < 8; ++k) {
    pid_t q = fork();
    if (!q) { heap[k * 65536] = 1; _exit(heap[n - 1] == (unsigned char)((n - 1) * 3) ? 0 : 1); }
    waitpid(q, &st, 0);
    kids_ok &= WIFEXITED(st) && !WEXITSTATUS(st);
  }
  int after = heap[0] == 0 && heap[65536] == 0xAA && heap[n - 1] == (unsigned char)((n - 1) * 3);
  // a child that execs
  pid_t e = fork();
  if (!e) { execl("/bin/true", "true", (char *)0); _exit(5); }
  waitpid(e, &st, 0);
  printf("child view %c, parent view %d, children %d, after %d, exec %d\n", r, mine, kids_ok, after,
         WIFEXITED(st) ? WEXITSTATUS(st) : -1);
  return 0;
}
