// AF_UNIX path sockets in Shiro: bind/listen/accept, connect from a forked
// child, SCM_RIGHTS, SO_PEERCRED, S_ISSOCK. Build:
//   x86_64-linux-musl-gcc -static -O2 unix.c -o unix-musl
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define PATH "/tmp/shiro-unix.sock"

int main(void) {
  struct sockaddr_un sa = {.sun_family = AF_UNIX};
  strcpy(sa.sun_path, PATH);
  unlink(PATH);
  int l = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (bind(l, (struct sockaddr *)&sa, sizeof(sa)) || listen(l, 4)) { perror("bind/listen"); return 1; }
  pid_t child = fork();
  if (!child) {
    int c = socket(AF_UNIX, SOCK_STREAM, 0), p[2];
    if (connect(c, (struct sockaddr *)&sa, sizeof(sa))) { perror("connect"); _exit(1); }
    pipe(p);
    char cbuf[CMSG_SPACE(sizeof(int))];
    struct iovec iov = {.iov_base = "hi", .iov_len = 2};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = cbuf, .msg_controllen = sizeof(cbuf)};
    struct cmsghdr *cm = CMSG_FIRSTHDR(&msg);
    cm->cmsg_level = SOL_SOCKET, cm->cmsg_type = SCM_RIGHTS, cm->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(cm), &p[1], sizeof(int));
    if (sendmsg(c, &msg, 0) != 2) { perror("sendmsg"); _exit(1); }
    close(p[1]);
    char buf[64] = {0};
    int n = 0, k;
    while ((k = read(p[0], buf + n, sizeof(buf) - 1 - n)) > 0) n += k;
    printf("client: %s", buf);
    _exit(0);
  }
  int a = accept4(l, 0, 0, SOCK_CLOEXEC);
  struct ucred uc;
  socklen_t ul = sizeof(uc);
  getsockopt(a, SOL_SOCKET, SO_PEERCRED, &uc, &ul);
  char data[16] = {0}, cbuf[CMSG_SPACE(sizeof(int)) * 2];
  struct iovec iov = {.iov_base = data, .iov_len = sizeof(data)};
  struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = cbuf, .msg_controllen = sizeof(cbuf)};
  ssize_t n = recvmsg(a, &msg, MSG_CMSG_CLOEXEC);
  struct cmsghdr *cm = CMSG_FIRSTHDR(&msg);
  int fd = -1;
  if (cm && cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SCM_RIGHTS) memcpy(&fd, CMSG_DATA(cm), sizeof(int));
  struct stat st;
  stat(PATH, &st);
  printf("server: %zd bytes '%s' fd %s peercred %s socket file %s\n", n, data, fd > 2 ? "ok" : "missing",
         uc.pid == child && uc.uid == getuid() ? "ok" : "wrong", S_ISSOCK(st.st_mode) ? "ok" : "wrong");
  fflush(stdout);
  dprintf(fd, "via the passed fd\n");
  close(fd);
  int status;
  waitpid(child, &status, 0);
  unlink(PATH);
  return WEXITSTATUS(status);
}
