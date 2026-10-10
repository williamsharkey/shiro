// A buffer another thread is still writing (to a pipe nobody reads yet) is
// freed: a 256 KiB glibc chunk, so munmap. The write's page locks went back
// before its thread took the GIL again (Blink 0122); munmap waited for them
// holding the GIL, which deadlocked (Open POSIX aio_cancel_6-1).
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#define N (256 << 10)
static int p[2];
static char *buf;
static long wrote, got;
static void *writer(void *a) {
  for (long n; wrote < N && (n = write(p[1], buf + wrote, N - wrote)) > 0;) wrote += n;
  return 0;
}
static void *reader(void *a) {
  static char b[1 << 16];
  usleep(200000);
  for (long n; (n = read(p[0], b, sizeof b)) > 0;) got += n;  // until the write end closes
  return 0;
}
int main(void) {
  pthread_t w, r;
  buf = malloc(N);
  memset(buf, 'x', N);
  if (pipe(p)) return 1;
  pthread_create(&w, 0, writer, 0);
  pthread_create(&r, 0, reader, 0);
  usleep(100000);  // the writer is blocked in write() on buf
  free(buf);
  pthread_join(w, 0);  // (Linux: the write stops short where buf went)
  close(p[1]);
  pthread_join(r, 0);
  printf("writer and reader done: %s\n", got == wrote ? "read what was written" : "mismatch");
  return 0;
}
