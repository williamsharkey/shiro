// MAP_HUGETLB with no huge pages reserved is ENOMEM (PostgreSQL's
// huge_pages=try then maps ordinary pages)
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <sys/mman.h>
int main(void) {
  void *p = mmap(0, 1 << 22, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);
  printf("hugetlb %s %d\n", p == MAP_FAILED ? "failed" : "mapped", p == MAP_FAILED ? errno : 0);
  p = mmap(0, 1 << 22, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  printf("plain %s\n", p == MAP_FAILED ? "failed" : "mapped");
  return 0;
}
