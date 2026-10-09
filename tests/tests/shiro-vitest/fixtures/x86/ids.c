// uids and gids are the kernel's (real, effective and saved ids, groups):
// a root process switches to nobody and back through the saved uid, then
// drops it for good (su, runuser, PostgreSQL's initdb); a user can't setuid(0)
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
  uid_t r, e, s;
  gid_t gr, ge, gs, groups[8], g1[2] = {65534, 100};
  if (geteuid()) {
    int rc = setuid(0), err = errno;
    printf("user %d: setuid(0) %d %s\n", getuid() != 0, rc, err == EPERM ? "EPERM" : "?");
    return 0;
  }
  int sg = setgroups(2, g1);
  int ng = getgroups(8, groups);
  int both = ng == 2 && groups[0] + groups[1] == 65634 && (groups[0] == 100 || groups[1] == 100);
  printf("root: setgroups %d getgroups %d {100,65534} %d\n", sg, ng, both);
  int g = setresgid(65534, 65534, 65534);
  int u = setresuid(65534, 65534, 0);
  getresuid(&r, &e, &s);
  getresgid(&gr, &ge, &gs);
  printf("setresgid %d setresuid %d: uid %d euid %d saved %d gid %d egid %d\n", g, u, r, e, s, gr, ge);
  int back = seteuid(0);
  printf("seteuid(0) via saved %d: euid %d uid %d\n", back, geteuid(), getuid());
  int drop = setresuid(65534, 65534, 65534);
  int again = setuid(0), err = errno;
  printf("dropped %d: setuid(0) %d %s\n", drop, again, err == EPERM ? "EPERM" : "?");
  return 0;
}
