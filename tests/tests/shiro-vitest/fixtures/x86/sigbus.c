// A page of a MAP_SHARED file mapping wholly past the file's end raises
// SIGBUS (BUS_ADRERR at the address) when touched, for a file and a
// /dev/shm object (Open POSIX mmap_11-2, mmap_11-3). Once the file has
// grown over the page it reads the file's bytes, and what is written within
// the file goes back to it. (The object grows by ftruncate: its pread and
// pwrite don't see its mapping yet.) A PROT_NONE mapping is SIGSEGV first
// (Open POSIX mmap_6-3).
#include <fcntl.h>
#include <setjmp.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static sigjmp_buf jb;
static volatile int code, signo;
static volatile void *addr;

static void onbus(int sig, siginfo_t *si, void *uc) {
  (void)uc;
  signo = sig, code = si->si_code, addr = si->si_addr;
  siglongjmp(jb, 1);
}

static void one(const char *name, int fd, int file) {
  char *p, c;
  long pg = sysconf(_SC_PAGESIZE);
  ftruncate(fd, pg / 2);
  p = mmap(0, 3 * pg, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (p == MAP_FAILED) { printf("%s mmap failed\n", name); return; }
  p[1] = 'a';  // within the file's (partial) last page
  code = 0;
  if (!sigsetjmp(jb, 1)) { p[2 * pg + 1] = 'x'; printf("%s no SIGBUS\n", name); }
  else printf("%s SIGBUS code %d at page %d\n", name, code, addr == p + 2 * pg + 1);
  if (!sigsetjmp(jb, 1)) { c = p[pg]; printf("%s no SIGBUS on read %d\n", name, c); }
  else printf("%s SIGBUS on read\n", name);
  // the file grows over the pages: they read its bytes
  if (file) pwrite(fd, "z", 1, 2 * pg + 5);
  else ftruncate(fd, 3 * pg);
  if (!sigsetjmp(jb, 1)) printf("%s grown: %d %d\n", name, p[pg], p[2 * pg + 5]);
  else printf("%s SIGBUS after growing\n", name);
  munmap(p, 3 * pg);
  if (!file) return;
  pread(fd, &c, 1, 1);
  printf("%s wrote back %c\n", name, c);
}

int main(void) {
  struct sigaction sa;
  char name[64];
  int fd;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = onbus;
  sa.sa_flags = SA_SIGINFO;
  sigaction(SIGBUS, &sa, 0);
  sigaction(SIGSEGV, &sa, 0);
  fd = open("sigbus.tmp", O_RDWR | O_CREAT | O_TRUNC, 0600);
  {
    char *p = mmap(0, 4096, PROT_NONE, MAP_SHARED, fd, 0);
    if (!sigsetjmp(jb, 1)) { *p = 'b'; printf("PROT_NONE no signal\n"); }
    else printf("PROT_NONE %s\n", signo == SIGSEGV ? "SIGSEGV" : "SIGBUS");
    munmap(p, 4096);
  }
  one("file", fd, 1);
  close(fd);
  unlink("sigbus.tmp");
  snprintf(name, sizeof(name), "/sigbus_%d", getpid());
  fd = shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
  one("shm", fd, 0);
  close(fd);
  shm_unlink(name);
  return 0;
}
