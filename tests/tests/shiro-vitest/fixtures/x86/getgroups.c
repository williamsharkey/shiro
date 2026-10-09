/* Fixture for x86-engine.test.ts: getgroups under Shiro (coreutils id).
   Build: gcc -static -O1 -o getgroups getgroups.c */
#include <stdio.h>
#include <unistd.h>
int main(void) {
  gid_t g[64];
  int n = getgroups(0, NULL);
  int m = getgroups(64, g);
  printf("getgroups(0)=%d getgroups(64)=%d is-gid=%d\n", n, m, m > 0 && g[0] == getgid());
  return 0;
}
