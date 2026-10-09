// CLOCK_REALTIME and gettimeofday have sub-ms resolution, so two reads
// microseconds apart don't differ by a whole ms. vim's typeahead check
// computes its wait as 0 - elapsed(start) and blocks for a key when that
// is -1 (the "vim stall" with a ms-resolution clock).
#include <stdio.h>
#include <sys/time.h>
#include <time.h>

static long elapsed(struct timeval *start) {  // vim's elapsed()
  struct timeval now;
  gettimeofday(&now, NULL);
  return (now.tv_sec - start->tv_sec) * 1000L + (now.tv_usec - start->tv_usec) / 1000L;
}

int main(void) {
  struct timespec ts, prev = {0, 0};
  struct timeval tv;
  int subms_ts = 0, subms_tv = 0, back = 0, valid = 1, jumps = 0, pairs = 50000;
  for (int i = 0; i < 2000; i++) {
    clock_gettime(CLOCK_REALTIME, &ts);
    gettimeofday(&tv, NULL);
    if (ts.tv_nsec < 0 || ts.tv_nsec >= 1000000000 || tv.tv_usec < 0 || tv.tv_usec >= 1000000) valid = 0;
    if (ts.tv_nsec % 1000000) subms_ts = 1;
    if (tv.tv_usec % 1000) subms_tv = 1;
    if (prev.tv_sec && (ts.tv_sec - prev.tv_sec) * 1000000000L + (ts.tv_nsec - prev.tv_nsec) < -3000000L) back = 1;
    prev = ts;
  }
  time_t now = time(NULL);
  clock_gettime(CLOCK_REALTIME, &ts);
  gettimeofday(&tv, NULL);
  for (int i = 0; i < pairs; i++) {
    struct timeval start;
    gettimeofday(&start, NULL);
    if (elapsed(&start) != 0) jumps++;
  }
  printf("valid %d subms clock_gettime %d gettimeofday %d backwards %d near time() %d %d back-to-back elapsed!=0 rare %d\n",
         valid, subms_ts, subms_tv, back, ts.tv_sec - now <= 1 && now - ts.tv_sec <= 1,
         tv.tv_sec - now <= 1 && now - tv.tv_sec <= 1, jumps <= 5);
  if (jumps > 5) printf("jumps %d/%d\n", jumps, pairs);
  return 0;
}
