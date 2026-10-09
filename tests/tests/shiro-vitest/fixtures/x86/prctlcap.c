#include <signal.h>
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
  // iputils' ping keeps its capabilities across setuid (PR_SET_KEEPCAPS)
  int k0 = prctl(PR_GET_KEEPCAPS), ks = prctl(PR_SET_KEEPCAPS, 1, 0, 0, 0), k1 = prctl(PR_GET_KEEPCAPS);
  r = prctl(PR_SET_KEEPCAPS, 2, 0, 0, 0);
  printf("keepcaps %d set=%d now %d, set(2)=%d %s\n", k0, ks, k1, r, r < 0 ? strerror(errno) : "");
  int sig = -1;
  r = prctl(PR_SET_PDEATHSIG, SIGTERM);
  prctl(PR_GET_PDEATHSIG, &sig);
  printf("pdeathsig set=%d now %d\n", r, sig);
  printf("dumpable %d set=%d\n", prctl(PR_GET_DUMPABLE), prctl(PR_SET_DUMPABLE, 1));
  sig = -1;
  r = prctl(PR_SET_CHILD_SUBREAPER, 1);
  prctl(PR_GET_CHILD_SUBREAPER, &sig);
  printf("subreaper set=%d now %d\n", r, sig);
  int n0 = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  r = prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
  printf("no_new_privs %d set=%d now %d\n", n0, r, prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
  printf("ambient is_set=%d\n", prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, 0, 0, 0));
  return 0;
}
