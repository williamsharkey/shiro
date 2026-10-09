/* Fixture for x86-engine.test.ts: prctl PR_SET_NAME/PR_GET_NAME (perl's
   $0 = ...), PR_CAPBSET_READ, and capget/capset (libcap's cap_get_proc).
   Build: gcc -static -O1 -o prctlcap prctlcap.c */
#include <errno.h>
#include <linux/capability.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(void) {
  char name[16] = {0};
  prctl(PR_GET_NAME, name);
  printf("default name %s\n", name);
  int r = prctl(PR_SET_NAME, "renamed-thread-name-long");
  memset(name, 0, sizeof(name));
  prctl(PR_GET_NAME, name);
  printf("set %d name %s\n", r, name);
  printf("capbset_read(0)=%d capbset_read(40)=%d\n", prctl(PR_CAPBSET_READ, 0), prctl(PR_CAPBSET_READ, 40));
  r = prctl(PR_CAPBSET_READ, 64);
  printf("capbset_read(64)=%d %s\n", r, r < 0 ? strerror(errno) : "");
  struct __user_cap_header_struct h = {0, 0};
  struct __user_cap_data_struct d[2];
  r = syscall(SYS_capget, &h, 0);
  printf("capget(version 0)=%d %s, version %#x\n", r, r < 0 ? strerror(errno) : "", h.version);
  r = syscall(SYS_capget, &h, d);
  printf("capget=%d full=%d\n", r, d[0].effective == 0xffffffff && d[1].permitted == 0x1ff);
  r = syscall(SYS_capset, &h, d);
  printf("capset=%d\n", r);
  return 0;
}
