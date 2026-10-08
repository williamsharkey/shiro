/* One user (compat/wasi-proc.c): the name from $USER, home from $HOME. */
#ifndef _SHIRO_PWD_H
#define _SHIRO_PWD_H
#include <sys/types.h>
#ifdef __cplusplus
extern "C" {
#endif
struct passwd { char *pw_name, *pw_passwd; uid_t pw_uid; gid_t pw_gid; char *pw_gecos, *pw_dir, *pw_shell; };
struct passwd *getpwnam(const char *);
struct passwd *getpwuid(uid_t);
void setpwent(void);
void endpwent(void);
struct passwd *getpwent(void);
#ifdef __cplusplus
}
#endif
#endif
