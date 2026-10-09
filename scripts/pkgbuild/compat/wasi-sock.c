/*
 * Sockets for wasi-sdk (preview1) programs running in tabcomputer.
 *
 * wasi-libc's preview1 build only has accept/send/recv/shutdown on sockets
 * someone else opened. The kernel guest (src/wasi/wasi-guest.ts) implements
 * WASIX's socket calls over the kernel's sockets (src/kernel/net.ts: the TCP
 * relay for the internet, the page for loopback), so this file builds the
 * BSD socket API and getaddrinfo on them: socket, connect, bind, listen,
 * accept, getsockname, getpeername, sendto, recvfrom, setsockopt,
 * getsockopt, getaddrinfo, getnameinfo, gethostbyname, gethostname.
 *
 * Constants are wasi-libc's (AF_INET 1, SOCK_STREAM 6, SOL_SOCKET
 * 0x7fffffff, ...), errno values WASI's, which WASIX calls return as is.
 */
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>
#include <wasi/api.h>

#define WASIX(name) __attribute__((import_module("wasix_32v1"), import_name(#name)))

/* __wasi_addr_port_t: tag u8 (1 inet4, 2 inet6), port u16 at 2 (host order), address bytes at 4 */
typedef struct { uint8_t bytes[110]; } __attribute__((aligned(2))) wasix_addr_port;
/* __wasi_addr_ip_t: tag u8, address bytes at 2 */
typedef struct { uint8_t bytes[18]; } __attribute__((aligned(2))) wasix_addr_ip;
/* __wasi_option_timestamp_t */
typedef struct { uint8_t tag; uint8_t _p[7]; uint64_t ns; } wasix_opt_time;

WASIX(sock_open) int32_t __shiro_sock_open(int32_t af, int32_t type, int32_t proto, int32_t *fd);
WASIX(sock_connect) int32_t __shiro_sock_connect(int32_t fd, const wasix_addr_port *addr);
WASIX(sock_bind) int32_t __shiro_sock_bind(int32_t fd, const wasix_addr_port *addr);
WASIX(sock_listen) int32_t __shiro_sock_listen(int32_t fd, int32_t backlog);
WASIX(sock_accept_v2) int32_t __shiro_sock_accept_v2(int32_t fd, int32_t fdflags, int32_t *ret, wasix_addr_port *addr);
WASIX(sock_addr_local) int32_t __shiro_sock_addr_local(int32_t fd, wasix_addr_port *addr);
WASIX(sock_addr_peer) int32_t __shiro_sock_addr_peer(int32_t fd, wasix_addr_port *addr);
WASIX(sock_send_to) int32_t __shiro_sock_send_to(int32_t fd, const __wasi_ciovec_t *iovs, int32_t n, int32_t flags,
                                                 const wasix_addr_port *addr, uint32_t *sent);
WASIX(sock_recv_from) int32_t __shiro_sock_recv_from(int32_t fd, const __wasi_iovec_t *iovs, int32_t n, int32_t flags,
                                                     uint32_t *len, uint16_t *roflags, wasix_addr_port *addr);
WASIX(sock_set_opt_flag) int32_t __shiro_sock_set_opt_flag(int32_t fd, int32_t opt, int32_t flag);
WASIX(sock_set_opt_time) int32_t __shiro_sock_set_opt_time(int32_t fd, int32_t opt, const wasix_opt_time *t);
WASIX(sock_set_opt_size) int32_t __shiro_sock_set_opt_size(int32_t fd, int32_t opt, int64_t size);
WASIX(sock_get_opt_flag) int32_t __shiro_sock_get_opt_flag(int32_t fd, int32_t opt, uint8_t *flag);
WASIX(sock_get_opt_size) int32_t __shiro_sock_get_opt_size(int32_t fd, int32_t opt, uint64_t *size);
WASIX(resolve) int32_t __shiro_resolve(const char *host, uint32_t len, int32_t port, wasix_addr_ip *addrs,
                                       uint32_t n, uint32_t *count);

/* WASIX socket options */
enum { OPT_REUSE_PORT = 1, OPT_REUSE_ADDR = 2, OPT_NO_DELAY = 3, OPT_BROADCAST = 6, OPT_LISTENING = 10,
       OPT_LAST_ERROR = 11, OPT_KEEP_ALIVE = 12, OPT_RECV_BUF = 15, OPT_SEND_BUF = 16,
       OPT_RECV_TIMEOUT = 19, OPT_SEND_TIMEOUT = 20, OPT_TYPE = 25 };

static int fail(int e) { errno = e; return -1; }

/* ── addresses ─────────────────────────────────────────────────────── */

static int to_wasix(const struct sockaddr *sa, socklen_t len, wasix_addr_port *out) {
  memset(out, 0, sizeof *out);
  if (!sa) return EINVAL;
  if (sa->sa_family == AF_INET && len >= sizeof(struct sockaddr_in)) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)sa;
    uint16_t port = ntohs(in->sin_port);
    out->bytes[0] = 1;
    memcpy(out->bytes + 2, &port, 2);
    memcpy(out->bytes + 4, &in->sin_addr, 4);
    return 0;
  }
  if (sa->sa_family == AF_INET6 && len >= sizeof(struct sockaddr_in6)) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)sa;
    uint16_t port = ntohs(in6->sin6_port);
    out->bytes[0] = 2;
    memcpy(out->bytes + 2, &port, 2);
    memcpy(out->bytes + 4, &in6->sin6_addr, 16);
    return 0;
  }
  return EAFNOSUPPORT;
}

static void from_wasix(const wasix_addr_port *a, struct sockaddr *sa, socklen_t *len) {
  if (!sa || !len) return;
  uint16_t port;
  memcpy(&port, a->bytes + 2, 2);
  if (a->bytes[0] == 2) {
    struct sockaddr_in6 in6;
    memset(&in6, 0, sizeof in6);
    in6.sin6_family = AF_INET6;
    in6.sin6_port = htons(port);
    memcpy(&in6.sin6_addr, a->bytes + 4, 16);
    memcpy(sa, &in6, *len < sizeof in6 ? *len : sizeof in6);
    *len = sizeof in6;
  } else {
    struct sockaddr_in in;
    memset(&in, 0, sizeof in);
    in.sin_family = AF_INET;
    in.sin_port = htons(port);
    memcpy(&in.sin_addr, a->bytes + 4, 4);
    memcpy(sa, &in, *len < sizeof in ? *len : sizeof in);
    *len = sizeof in;
  }
}

/* ── the socket calls ──────────────────────────────────────────────── */

int socket(int domain, int type, int protocol) {
  int af = domain == AF_INET ? 1 : domain == AF_INET6 ? 2 : 0;
  if (!af) return fail(EAFNOSUPPORT);
  int kind = type & ~(SOCK_NONBLOCK | SOCK_CLOEXEC);
  int st = kind == SOCK_STREAM ? 1 : kind == SOCK_DGRAM ? 2 : 0;
  if (!st) return fail(EPROTOTYPE);
  int32_t fd;
  int r = __shiro_sock_open(af, st, protocol, &fd);
  if (r) return fail(r);
  if (type & SOCK_NONBLOCK) fcntl(fd, F_SETFL, O_NONBLOCK);
  return fd;
}

int connect(int fd, const struct sockaddr *sa, socklen_t len) {
  wasix_addr_port a;
  int r = to_wasix(sa, len, &a);
  if (!r) r = __shiro_sock_connect(fd, &a);
  return r ? fail(r) : 0;
}

int bind(int fd, const struct sockaddr *sa, socklen_t len) {
  wasix_addr_port a;
  int r = to_wasix(sa, len, &a);
  if (!r) r = __shiro_sock_bind(fd, &a);
  return r ? fail(r) : 0;
}

int listen(int fd, int backlog) {
  int r = __shiro_sock_listen(fd, backlog);
  return r ? fail(r) : 0;
}

int accept4(int fd, struct sockaddr *__restrict sa, socklen_t *__restrict len, int flags) {
  wasix_addr_port a;
  int32_t nfd;
  int r = __shiro_sock_accept_v2(fd, flags & SOCK_NONBLOCK ? __WASI_FDFLAGS_NONBLOCK : 0, &nfd, &a);
  if (r) return fail(r);
  from_wasix(&a, sa, len);
  return nfd;
}

int accept(int fd, struct sockaddr *__restrict sa, socklen_t *__restrict len) { return accept4(fd, sa, len, 0); }

int getsockname(int fd, struct sockaddr *__restrict sa, socklen_t *__restrict len) {
  wasix_addr_port a;
  int r = __shiro_sock_addr_local(fd, &a);
  if (r) return fail(r);
  from_wasix(&a, sa, len);
  return 0;
}

int getpeername(int fd, struct sockaddr *__restrict sa, socklen_t *__restrict len) {
  wasix_addr_port a;
  int r = __shiro_sock_addr_peer(fd, &a);
  if (r) return fail(r);
  from_wasix(&a, sa, len);
  return 0;
}

static int riflags(int flags) {
  return (flags & MSG_PEEK ? 1 : 0) | (flags & MSG_WAITALL ? 2 : 0) | (flags & MSG_DONTWAIT ? 4 : 0);
}

ssize_t sendto(int fd, const void *buf, size_t n, int flags, const struct sockaddr *sa, socklen_t len) {
  if (!sa) return send(fd, buf, n, flags);
  wasix_addr_port a;
  int r = to_wasix(sa, len, &a);
  if (r) return fail(r);
  __wasi_ciovec_t iov = { buf, n };
  uint32_t sent;
  r = __shiro_sock_send_to(fd, &iov, 1, flags & MSG_DONTWAIT ? 4 : 0, &a, &sent);
  return r ? fail(r) : (ssize_t)sent;
}

ssize_t recvfrom(int fd, void *__restrict buf, size_t n, int flags, struct sockaddr *__restrict sa, socklen_t *__restrict len) {
  __wasi_iovec_t iov = { buf, n };
  uint32_t got;
  uint16_t ro;
  wasix_addr_port a;
  memset(&a, 0, sizeof a);
  int r = __shiro_sock_recv_from(fd, &iov, 1, riflags(flags), &got, &ro, &a);
  if (r) return fail(r);
  if (sa && len) {
    if (a.bytes[0]) from_wasix(&a, sa, len);
    else *len = 0;
  }
  return got;
}

int setsockopt(int fd, int level, int name, const void *val, socklen_t len) {
  int on = val && len >= sizeof(int) ? *(const int *)val != 0 : 0;
  int r = 0;
  if (level == SOL_SOCKET) {
    switch (name) {
    case SO_REUSEADDR: r = __shiro_sock_set_opt_flag(fd, OPT_REUSE_ADDR, on); break;
    case SO_KEEPALIVE: r = __shiro_sock_set_opt_flag(fd, OPT_KEEP_ALIVE, on); break;
    case SO_BROADCAST: r = __shiro_sock_set_opt_flag(fd, OPT_BROADCAST, on); break;
    case SO_RCVBUF: case SO_SNDBUF:
      r = __shiro_sock_set_opt_size(fd, name == SO_RCVBUF ? OPT_RECV_BUF : OPT_SEND_BUF, val && len >= sizeof(int) ? *(const int *)val : 0);
      break;
    case SO_RCVTIMEO: case SO_SNDTIMEO: {
      wasix_opt_time t = { 0 };
      if (val && len >= sizeof(struct timeval)) {
        const struct timeval *tv = val;
        uint64_t ns = (uint64_t)tv->tv_sec * 1000000000ull + (uint64_t)tv->tv_usec * 1000ull;
        t.tag = ns ? 1 : 0;
        t.ns = ns;
      }
      r = __shiro_sock_set_opt_time(fd, name == SO_RCVTIMEO ? OPT_RECV_TIMEOUT : OPT_SEND_TIMEOUT, &t);
      break;
    }
    default: break; /* accepted and ignored, as many stacks do for options they don't model */
    }
  } else if (level == IPPROTO_TCP && name == TCP_NODELAY) {
    r = __shiro_sock_set_opt_flag(fd, OPT_NO_DELAY, on);
  }
  return r ? fail(r) : 0;
}

int getsockopt(int fd, int level, int name, void *__restrict val, socklen_t *__restrict len) {
  if (!val || !len || *len < sizeof(int)) return fail(EINVAL);
  int out = 0, r = 0;
  if (level == SOL_SOCKET && name == SO_TYPE) {
    struct stat st;
    if (fstat(fd, &st)) return -1;
    if (!S_ISSOCK(st.st_mode)) return fail(ENOTSOCK);
    uint64_t t = 0;
    r = __shiro_sock_get_opt_size(fd, OPT_TYPE, &t);
    out = r || t != 2 ? SOCK_STREAM : SOCK_DGRAM; /* SO_TYPE: Linux 1 stream, 2 datagram */
    r = 0;
  } else if (level == SOL_SOCKET && name == SO_ERROR) {
    uint64_t e = 0;
    r = __shiro_sock_get_opt_size(fd, OPT_LAST_ERROR, &e);
    out = (int)e;
  } else if (level == SOL_SOCKET && (name == SO_RCVBUF || name == SO_SNDBUF)) {
    uint64_t s = 0;
    r = __shiro_sock_get_opt_size(fd, name == SO_RCVBUF ? OPT_RECV_BUF : OPT_SEND_BUF, &s);
    out = (int)s;
  } else if (level == SOL_SOCKET && (name == SO_REUSEADDR || name == SO_KEEPALIVE || name == SO_ACCEPTCONN)) {
    uint8_t f = 0;
    r = __shiro_sock_get_opt_flag(fd, name == SO_REUSEADDR ? OPT_REUSE_ADDR : name == SO_KEEPALIVE ? OPT_KEEP_ALIVE : OPT_LISTENING, &f);
    out = f;
  } else if (level == IPPROTO_TCP && name == TCP_NODELAY) {
    uint8_t f = 0;
    r = __shiro_sock_get_opt_flag(fd, OPT_NO_DELAY, &f);
    out = f;
  }
  if (r) return fail(r);
  *(int *)val = out;
  *len = sizeof(int);
  return 0;
}

/* ── names ─────────────────────────────────────────────────────────── */

int h_errno;

static int service_port(const char *serv, int numeric_only, int *port) {
  if (!serv || !*serv) { *port = 0; return 0; }
  char *end;
  long p = strtol(serv, &end, 10);
  if (!*end && p >= 0 && p < 65536) { *port = (int)p; return 0; }
  if (numeric_only) return EAI_NONAME;
  static const struct { const char *name; int port; } known[] = {
    { "http", 80 }, { "https", 443 }, { "ftp", 21 }, { "ssh", 22 }, { "smtp", 25 }, { "domain", 53 },
    { "imap", 143 }, { "imaps", 993 }, { "pop3", 110 }, { "git", 9418 },
  };
  for (size_t i = 0; i < sizeof known / sizeof *known; i++) {
    if (!strcmp(serv, known[i].name)) { *port = known[i].port; return 0; }
  }
  return EAI_SERVICE;
}

static struct addrinfo *new_ai(int family, const void *addr, int port, const struct addrinfo *hints, int socktype) {
  size_t salen = family == AF_INET6 ? sizeof(struct sockaddr_in6) : sizeof(struct sockaddr_in);
  struct addrinfo *ai = calloc(1, sizeof *ai + salen);
  if (!ai) return NULL;
  ai->ai_family = family;
  ai->ai_socktype = socktype;
  ai->ai_protocol = hints && hints->ai_protocol ? hints->ai_protocol : socktype == SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP;
  ai->ai_addrlen = salen;
  ai->ai_addr = (struct sockaddr *)(ai + 1);
  if (family == AF_INET6) {
    struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)ai->ai_addr;
    in6->sin6_family = AF_INET6;
    in6->sin6_port = htons(port);
    memcpy(&in6->sin6_addr, addr, 16);
  } else {
    struct sockaddr_in *in = (struct sockaddr_in *)ai->ai_addr;
    in->sin_family = AF_INET;
    in->sin_port = htons(port);
    memcpy(&in->sin_addr, addr, 4);
  }
  return ai;
}

/* One entry per address and socket type (stream and datagram unless hinted). */
static int push_addr(struct addrinfo ***tail, int family, const void *addr, int port, const struct addrinfo *hints) {
  int want = hints ? hints->ai_socktype : 0;
  int types[2] = { SOCK_STREAM, SOCK_DGRAM };
  for (int i = 0; i < 2; i++) {
    if (want && want != types[i]) continue;
    struct addrinfo *ai = new_ai(family, addr, port, hints, types[i]);
    if (!ai) return EAI_MEMORY;
    **tail = ai;
    *tail = &ai->ai_next;
  }
  return 0;
}

int getaddrinfo(const char *__restrict node, const char *__restrict serv, const struct addrinfo *__restrict hints,
                struct addrinfo **__restrict res) {
  int family = hints ? hints->ai_family : AF_UNSPEC;
  int flags = hints ? hints->ai_flags : 0;
  if (family != AF_UNSPEC && family != AF_INET && family != AF_INET6) return EAI_FAMILY;
  if (!node && !serv) return EAI_NONAME;
  int port, e = service_port(serv, flags & AI_NUMERICSERV, &port);
  if (e) return e;
  struct addrinfo *head = NULL, **tail = &head;
  unsigned char a4[4], a6[16];
  if (!node) {
    /* passive: the wildcard address; otherwise loopback */
    int passive = flags & AI_PASSIVE;
    if (family != AF_INET) {
      memset(a6, 0, 16);
      if (!passive) a6[15] = 1;
      if ((e = push_addr(&tail, AF_INET6, a6, port, hints))) goto fail;
    }
    if (family != AF_INET6) {
      uint32_t v = htonl(passive ? INADDR_ANY : INADDR_LOOPBACK);
      memcpy(a4, &v, 4);
      if ((e = push_addr(&tail, AF_INET, a4, port, hints))) goto fail;
    }
  } else if (inet_pton(AF_INET, node, a4) == 1) {
    if (family == AF_INET6) return EAI_NONAME;
    if ((e = push_addr(&tail, AF_INET, a4, port, hints))) goto fail;
  } else if (inet_pton(AF_INET6, node, a6) == 1) {
    if (family == AF_INET) return EAI_NONAME;
    if ((e = push_addr(&tail, AF_INET6, a6, port, hints))) goto fail;
  } else {
    if (flags & AI_NUMERICHOST) return EAI_NONAME;
    wasix_addr_ip addrs[8];
    uint32_t n = 0;
    int r = __shiro_resolve(node, strlen(node), port, addrs, 8, &n);
    if (r) { errno = r; return r == ENOENT || r == EHOSTUNREACH ? EAI_NONAME : EAI_FAIL; }
    for (uint32_t i = 0; i < n; i++) {
      int fam = addrs[i].bytes[0] == 2 ? AF_INET6 : AF_INET;
      if (family != AF_UNSPEC && family != fam) continue;
      if ((e = push_addr(&tail, fam, addrs[i].bytes + 2, port, hints))) goto fail;
    }
    if (!head) return EAI_NONAME;
  }
  if (head && (flags & AI_CANONNAME) && node) head->ai_canonname = strdup(node);
  *res = head;
  return 0;
fail:
  freeaddrinfo(head);
  return e;
}

void freeaddrinfo(struct addrinfo *ai) {
  while (ai) {
    struct addrinfo *next = ai->ai_next;
    free(ai->ai_canonname);
    free(ai);
    ai = next;
  }
}

const char *gai_strerror(int e) {
  switch (e) {
  case EAI_BADFLAGS: return "Invalid flags";
  case EAI_NONAME: return "Name does not resolve";
  case EAI_AGAIN: return "Try again";
  case EAI_FAIL: return "Non-recoverable error";
  case EAI_FAMILY: return "Unrecognized address family or invalid length";
  case EAI_SOCKTYPE: return "Unrecognized socket type";
  case EAI_SERVICE: return "Unrecognized service";
  case EAI_MEMORY: return "Out of memory";
  case EAI_SYSTEM: return "System error";
  case EAI_OVERFLOW: return "Overflow";
  default: return "Unknown error";
  }
}

int getnameinfo(const struct sockaddr *__restrict sa, socklen_t salen, char *__restrict host, socklen_t hostlen,
                char *__restrict serv, socklen_t servlen, int flags) {
  (void)flags;
  const void *addr;
  int port;
  if (sa->sa_family == AF_INET && salen >= sizeof(struct sockaddr_in)) {
    addr = &((const struct sockaddr_in *)sa)->sin_addr;
    port = ntohs(((const struct sockaddr_in *)sa)->sin_port);
  } else if (sa->sa_family == AF_INET6 && salen >= sizeof(struct sockaddr_in6)) {
    addr = &((const struct sockaddr_in6 *)sa)->sin6_addr;
    port = ntohs(((const struct sockaddr_in6 *)sa)->sin6_port);
  } else {
    return EAI_FAMILY;
  }
  /* No reverse DNS: hosts are always numeric */
  if (host && hostlen && !inet_ntop(sa->sa_family, addr, host, hostlen)) return EAI_OVERFLOW;
  if (serv && servlen && snprintf(serv, servlen, "%d", port) >= (int)servlen) return EAI_OVERFLOW;
  return 0;
}

struct hostent *gethostbyname(const char *name) {
  static struct hostent he;
  static char *addrs[2], *aliases[1];
  static unsigned char addr[4];
  static char hname[256];
  struct addrinfo hints = { 0 }, *res;
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(name, NULL, &hints, &res)) { h_errno = HOST_NOT_FOUND; return NULL; }
  memcpy(addr, &((struct sockaddr_in *)res->ai_addr)->sin_addr, 4);
  freeaddrinfo(res);
  snprintf(hname, sizeof hname, "%s", name);
  addrs[0] = (char *)addr; addrs[1] = NULL; aliases[0] = NULL;
  he.h_name = hname; he.h_aliases = aliases; he.h_addrtype = AF_INET; he.h_length = 4; he.h_addr_list = addrs;
  return &he;
}

struct hostent *gethostbyaddr(const void *addr, socklen_t len, int type) {
  (void)addr; (void)len; (void)type;
  h_errno = HOST_NOT_FOUND;
  return NULL;
}

struct servent *getservbyname(const char *name, const char *proto) {
  static struct servent se;
  static char *aliases[1];
  static char sname[32], sproto[8];
  int port;
  if (service_port(name, 0, &port) || !port) return NULL;
  snprintf(sname, sizeof sname, "%s", name);
  snprintf(sproto, sizeof sproto, "%s", proto ? proto : "tcp");
  aliases[0] = NULL;
  se.s_name = sname; se.s_aliases = aliases; se.s_port = htons(port); se.s_proto = sproto;
  return &se;
}

struct servent *getservbyport(int port, const char *proto) {
  (void)port; (void)proto;
  return NULL;
}

struct protoent *getprotobyname(const char *name) {
  static struct protoent pe;
  static char *aliases[1];
  static char pname[8];
  int num = !strcmp(name, "tcp") ? IPPROTO_TCP : !strcmp(name, "udp") ? IPPROTO_UDP : !strcmp(name, "ip") ? 0 : -1;
  if (num < 0) return NULL;
  snprintf(pname, sizeof pname, "%s", name);
  aliases[0] = NULL;
  pe.p_name = pname; pe.p_aliases = aliases; pe.p_proto = num;
  return &pe;
}

const char *hstrerror(int e) {
  return e == HOST_NOT_FOUND ? "Unknown host" : e == TRY_AGAIN ? "Host name lookup failure" : "Unknown error";
}

int gethostname(char *name, size_t len) {
  const char *h = getenv("HOSTNAME");
  if (!h || !*h) h = "localhost";
  if (strlen(h) >= len) return fail(ENAMETOOLONG);
  strcpy(name, h);
  return 0;
}

char *inet_ntoa(struct in_addr in) {
  static char buf[INET_ADDRSTRLEN];
  return (char *)inet_ntop(AF_INET, &in, buf, sizeof buf);
}

int inet_aton(const char *s, struct in_addr *in) {
  return inet_pton(AF_INET, s, in) == 1;
}
