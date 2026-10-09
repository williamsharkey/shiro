// glibc's resolver: an A query for each of two names sent with one
// sendmmsg to the DNS server, both answers read with recvmmsg
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>

int main(int argc, char **argv) {
  setvbuf(stdout, 0, _IONBF, 0);
  int s = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK, 0);
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(53)};
  inet_pton(AF_INET, argc > 1 ? argv[1] : "10.0.2.3", &a.sin_addr);
  connect(s, (void *)&a, sizeof(a));
  unsigned char q0[] = {0x11, 0x11, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 4, 'e', 'c', 'h', 'o', 4, 't', 'e', 's', 't', 0, 0, 1, 0, 1};
  unsigned char q1[sizeof(q0)];
  memcpy(q1, q0, sizeof(q0));
  q1[0] = q1[1] = 0x22;
  q1[13] = 'x';  // xcho.test: no such name
  struct iovec v[2] = {{q0, sizeof(q0)}, {q1, sizeof(q1)}};
  struct mmsghdr out[2];
  memset(out, 0, sizeof(out));
  for (int i = 0; i < 2; ++i) out[i].msg_hdr.msg_iov = &v[i], out[i].msg_hdr.msg_iovlen = 1;
  int r = sendmmsg(s, out, 2, MSG_NOSIGNAL);
  printf("sendmmsg=%d lens %u %u %s\n", r, out[0].msg_len, out[1].msg_len, r < 0 ? strerror(errno) : "");
  if (r < 0) return 1;
  unsigned char b[2][512];
  struct iovec w[2] = {{b[0], 512}, {b[1], 512}};
  struct mmsghdr in[2];
  int got = 0, ids = 0;
  for (int tries = 0; got < 2 && tries < 500; ++tries) {
    memset(in, 0, sizeof(in));
    for (int i = 0; i < 2; ++i) in[i].msg_hdr.msg_iov = &w[i], in[i].msg_hdr.msg_iovlen = 1;
    r = recvmmsg(s, in, 2 - got, 0, 0);
    if (r < 0) {
      if (errno != EAGAIN) { printf("recvmmsg: %s\n", strerror(errno)); return 1; }
      struct timespec ts = {0, 10000000};
      nanosleep(&ts, 0);
      continue;
    }
    for (int i = 0; i < r; ++i) {
      ids |= b[i][0] == 0x11 ? 1 : b[i][0] == 0x22 ? 2 : 4;
      printf("answer %#x rcode %d answers %d len>12 %d\n", b[i][0], b[i][3] & 15, b[i][7], in[i].msg_len > 12);
    }
    got += r;
  }
  printf("got %d ids %d\n", got, ids);
  return 0;
}
