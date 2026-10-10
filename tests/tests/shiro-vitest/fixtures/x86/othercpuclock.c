// Another existing process's CPU clock reads; one of no process is refused
// (Open POSIX clock_getcpuclockid_1-2 asks for init's)
#include <stdio.h>
#include <string.h>
#include <time.h>

int main(void) {
  clockid_t c;
  struct timespec ts;
  int a = clock_getcpuclockid(1, &c);
  int b = a ? -1 : clock_gettime(c, &ts);
  int none = clock_getcpuclockid(4000000, &c);
  printf("init %d read %d none %s\n", a, b, none ? strerror(none) : "ok");
  return 0;
}
