// uname: the Shiro kernel's release, version and host name (Node's
// os.release(), glibc's minimum-kernel check), Blink's sysname and machine
#include <stdio.h>
#include <string.h>
#include <sys/utsname.h>
int main(void) {
  struct utsname u;
  if (uname(&u)) return 1;
  printf("sysname %s machine %s release-6.1 %d version-SMP %d nodename-in-release %d\n", u.sysname, u.machine,
         !strncmp(u.release, "6.1.0-", 6), strstr(u.version, "SMP") != 0, strstr(u.release, u.nodename) != 0);
  return 0;
}
