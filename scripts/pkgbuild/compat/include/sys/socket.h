/*
 * wasi-libc's <sys/socket.h> plus the socket calls compat/wasi-sock.c
 * provides for preview1 programs in tabcomputer (over the kernel's WASIX
 * sock_* calls): socket, connect, bind, listen, getsockname, getpeername,
 * sendto, recvfrom, setsockopt, socketpair.
 */
#include_next <sys/socket.h>
#ifndef _SHIRO_SYS_SOCKET_H
#define _SHIRO_SYS_SOCKET_H
#ifdef __cplusplus
extern "C" {
#endif
#ifndef __wasilibc_use_wasip2
int socket(int, int, int);
int connect(int, const struct sockaddr *, socklen_t);
int bind(int, const struct sockaddr *, socklen_t);
int listen(int, int);
int getsockname(int, struct sockaddr *__restrict, socklen_t *__restrict);
int getpeername(int, struct sockaddr *__restrict, socklen_t *__restrict);
ssize_t sendto(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
ssize_t recvfrom(int, void *__restrict, size_t, int, struct sockaddr *__restrict, socklen_t *__restrict);
int setsockopt(int, int, int, const void *, socklen_t);
#endif
#ifndef SOMAXCONN
#define SOMAXCONN 128
#endif
#ifndef MSG_DONTWAIT
#define MSG_DONTWAIT 0x0040
#endif
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0x4000
#endif
/* Socket options (wasi-libc's preview2 values; wasi-sock.c maps them to WASIX options) */
#ifndef SO_REUSEADDR
#define SO_REUSEADDR 2
#endif
#ifndef SO_ERROR
#define SO_ERROR 4
#endif
#ifndef SO_BROADCAST
#define SO_BROADCAST 6
#endif
#ifndef SO_SNDBUF
#define SO_SNDBUF 7
#endif
#ifndef SO_RCVBUF
#define SO_RCVBUF 8
#endif
#ifndef SO_KEEPALIVE
#define SO_KEEPALIVE 9
#endif
#ifndef SO_LINGER
#define SO_LINGER 13
#endif
#ifndef SO_REUSEPORT
#define SO_REUSEPORT 15
#endif
#ifndef SO_ACCEPTCONN
#define SO_ACCEPTCONN 30
#endif
#ifndef SO_RCVTIMEO
#define SO_RCVTIMEO 66
#endif
#ifndef SO_SNDTIMEO
#define SO_SNDTIMEO 67
#endif
#ifndef SOL_TCP
#define SOL_TCP 6
#endif
#ifdef __cplusplus
}
#endif
#endif
