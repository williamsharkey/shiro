// A /dev/shm object mapped MAP_SHARED (Blink's remote pages, 0112): a byte
// written to every page through the mapping (more pages than a thread keeps
// leased: 0121), a pwrite through the fd that the mapping must see, msync,
// munmap, then every byte read back with read().
//   prog SIZE...
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static long SZ;
#define PW_OFF (SZ / 2 + 200)
#define PW_LEN 3000

static unsigned char expect(long i) {
  if (i >= PW_OFF && i < PW_OFF + PW_LEN) return 'P';
  if (i >= SZ - 100) return 'E';
  if (i % 4096 == 0) return (i / 4096) & 255;
  return 0;
}

int main(int argc, char **argv) {
  static unsigned char all[6 << 20], buf[PW_LEN];
  for (int a = 1; a < argc; a++) {
    SZ = atol(argv[a]);
    int fd = open("/dev/shm/shmremote", O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd < 0 || ftruncate(fd, SZ)) { perror("shm"); return 1; }
    unsigned char *m = mmap(0, SZ, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (m == MAP_FAILED) { perror("mmap"); return 1; }
    for (long i = 0; i < SZ; i += 4096) m[i] = (i / 4096) & 255;
    memset(m + SZ - 100, 'E', 100);
    memset(buf, 'P', sizeof buf);
    if (pwrite(fd, buf, PW_LEN, PW_OFF) != PW_LEN) puts("pwrite failed");
    msync(m, SZ, MS_SYNC);
    unsigned char c = 0;
    if (pread(fd, &c, 1, 4096 * 5) != 1) puts("pread failed");
    int sees = c == 5 && m[PW_OFF] == 'P';
    munmap(m, SZ);
    long got = 0, bad = 0, first = -1;
    lseek(fd, 0, SEEK_SET);
    for (long n; got < SZ && (n = read(fd, all + got, SZ - got)) > 0;) got += n;
    for (long i = 0; i < SZ; i++) if (all[i] != expect(i)) { bad++; if (first < 0) first = i; }
    close(fd);
    unlink("/dev/shm/shmremote");
    printf("%ld: read %ld map-and-fd-agree %d bad %ld first %ld\n", SZ, got, sees, bad, first);
  }
  return 0;
}
