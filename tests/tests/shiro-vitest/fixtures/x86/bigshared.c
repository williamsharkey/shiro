// A file (6 MiB by default: a big file, which the kernel holds as pages)
// mapped MAP_SHARED, written through the mapping and with pwrite, synced,
// unmapped and read back with read(): every byte as written.
//   prog [SIZE] [shm]   (shm: also /dev/shm/bigshm.bin)
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdlib.h>

static long SZ = 6 << 20;
#define PW_OFF (SZ / 2 + 200)
#define PW_LEN 3000

static unsigned char expect(long i) {
  if (i >= PW_OFF && i < PW_OFF + PW_LEN) return 'P';
  if (i >= SZ - 100) return 'E';
  if (i % 4096 == 0) return (i / 4096) & 255;
  return 0;
}

static void run(const char *path) {
  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || ftruncate(fd, SZ)) { printf("%s open/ftruncate failed\n", path); return; }
  unsigned char *m = mmap(0, SZ, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (m == MAP_FAILED) { printf("%s mmap failed\n", path); return; }
  for (long i = 0; i < SZ; i += 4096) m[i] = (i / 4096) & 255;
  memset(m + SZ - 100, 'E', 100);
  unsigned char buf[PW_LEN];
  memset(buf, 'P', sizeof buf);
  if (pwrite(fd, buf, PW_LEN, PW_OFF) != PW_LEN) printf("%s pwrite failed\n", path);
  msync(m, SZ, MS_SYNC);
  unsigned char c = 0;
  pread(fd, &c, 1, 4096 * 5);
  int seen = c == 5;
  munmap(m, SZ);
  struct stat st;
  fstat(fd, &st);
  long bad = 0, first = -1;
  static unsigned char all[6 << 20];
  lseek(fd, 0, SEEK_SET);
  long got = 0;
  for (long n; got < SZ && (n = read(fd, all + got, SZ - got)) > 0;) got += n;
  for (long i = 0; i < SZ; i++) if (all[i] != expect(i)) { bad++; if (first < 0) first = i; }
  close(fd);
  printf("%s size %ld read %ld pread-sees-map %d bad %ld first %ld\n", path, (long)st.st_size, got, seen, bad, first);
}

int main(int argc, char **argv) {
  if (argc > 1) SZ = atol(argv[1]);
  run("big.bin");
  if (argc > 2 && !strcmp(argv[2], "shm")) run("/dev/shm/bigshm.bin");
  return 0;
}
