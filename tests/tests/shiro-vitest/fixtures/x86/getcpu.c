// getcpu(2) and the legacy vsyscall page (0xffffffffff600000): HotSpot
// calls the page's getcpu when sched_getcpu fails, old static binaries its
// gettimeofday and time. CPUID leaf 1 has a family 6 signature (OpenCV
// reads the family before the feature bits).
#define _GNU_SOURCE
#include <cpuid.h>
#include <sched.h>
#include <stdio.h>
#include <sys/time.h>
#include <time.h>

int main(void) {
  unsigned cpu = 99, node = 99, a, b, c, d;
  printf("sched_getcpu %d\n", sched_getcpu());
  long r = ((long (*)(unsigned *, unsigned *, void *))0xffffffffff600800)(&cpu, &node, 0);
  printf("vsyscall getcpu %ld cpu %u node %u\n", r, cpu, node);
  time_t t1 = ((time_t (*)(time_t *))0xffffffffff600400)(0), t2 = time(0);
  printf("vsyscall time ok %d\n", t2 - t1 >= 0 && t2 - t1 <= 1);
  struct timeval tv;
  r = ((long (*)(struct timeval *, void *))0xffffffffff600000)(&tv, 0);
  printf("vsyscall gettimeofday %ld ok %d\n", r, tv.tv_sec - t2 >= -1 && tv.tv_sec - t2 <= 1);
  __cpuid(1, a, b, c, d);
  printf("cpuid family %u sse2 %d\n", ((a >> 8) & 15) + ((a >> 20) & 255), !!(d & (1 << 26)));
  return 0;
}
