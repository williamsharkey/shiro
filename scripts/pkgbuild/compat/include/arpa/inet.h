/* wasi-libc's <arpa/inet.h> plus inet_ntoa/inet_aton (compat/wasi-sock.c). */
#include_next <arpa/inet.h>
#ifndef _SHIRO_ARPA_INET_H
#define _SHIRO_ARPA_INET_H
#ifdef __cplusplus
extern "C" {
#endif
char *inet_ntoa(struct in_addr);
int inet_aton(const char *, struct in_addr *);
#ifdef __cplusplus
}
#endif
#endif
