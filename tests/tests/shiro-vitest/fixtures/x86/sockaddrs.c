// Socket address lengths and a few path/file answers Blink gives itself:
// - an abstract AF_UNIX name bound with the whole sockaddr_un keeps its
//   trailing NULs: getsockname's length (110) connects again (LTP bind04)
// - AF_NETLINK addresses are 12 bytes (libmnl's bind check, glibc's
//   getifaddrs), when the kernel has netlink
// - /proc/self/exe is the resolved path when started through a symlink
//   (ld.so's $ORIGIN: uv's python venvs)
// - fallocate is EOPNOTSUPP, which Go's linker falls back from
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/netlink.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(void) {
  struct sockaddr_un a = {AF_UNIX}, b;
  socklen_t l = sizeof(b);
  memcpy(a.sun_path, "\0shiro-abstract", 15);
  int s = socket(AF_UNIX, SOCK_STREAM, 0), c = socket(AF_UNIX, SOCK_STREAM, 0);
  int bound = !bind(s, (void *)&a, sizeof(a)) && !listen(s, 1);
  getsockname(s, (void *)&b, &l);
  printf("abstract bound %d len %d connect %d\n", bound, (int)l, !connect(c, (void *)&b, l));

  int n = socket(AF_NETLINK, SOCK_RAW, NETLINK_ROUTE);
  if (n < 0) {
    printf("netlink unsupported\n");
  } else {
    struct sockaddr_nl nl = {AF_NETLINK}, got;
    socklen_t nll = sizeof(got);
    memset(&got, 0, sizeof(got));
    bind(n, (void *)&nl, sizeof(nl));
    getsockname(n, (void *)&got, &nll);
    printf("netlink len %d family %d\n", (int)nll, got.nl_family);
  }

  char exe[512];
  ssize_t e = readlink("/proc/self/exe", exe, sizeof(exe) - 1);
  exe[e > 0 ? e : 0] = 0;
  printf("exe %s\n", exe);

  int fd = open("falloc.tmp", O_CREAT | O_RDWR | O_TRUNC, 0644);
  int r = fallocate(fd, 0, 0, 4096);
  printf("fallocate %d %s\n", r, r ? strerrorname_np(errno) : "ok");
  unlink("falloc.tmp");
  return 0;
}
