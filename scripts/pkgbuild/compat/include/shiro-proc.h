/* Process calls wasi-libc leaves out, for programs built for Shiro
 * (force-included with -include; implemented in wasi-proc.c over the
 * kernel's WASIX imports). */
#ifndef _SHIRO_PROC_H
#define _SHIRO_PROC_H
#include <sys/types.h>
#ifdef __cplusplus
extern "C" {
#endif
int pipe(int[2]);
int pipe2(int[2], int);
int dup(int);
int dup2(int, int);
int dup3(int, int, int);
int execv(const char *, char *const[]);
int execvp(const char *, char *const[]);
int execve(const char *, char *const[], char *const[]);
int execvpe(const char *, char *const[], char *const[]);
int execl(const char *, const char *, ...);
int execlp(const char *, const char *, ...);
int kill(pid_t, int);
int killpg(pid_t, int);
pid_t getppid(void);
char *getlogin(void);
pid_t getpgrp(void);
pid_t setsid(void);
int setpgid(pid_t, pid_t);
uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);
int system(const char *);
int mkstemp(char *);
mode_t umask(mode_t);
/* Signal sets and masks: accepted, not enforced (signals come from the kernel) */
#include <signal.h>
/* sigset_t even under -std=c11 (no _BSD_SOURCE), as CPython builds */
#define __NEED_sigset_t
#include <bits/alltypes.h>
#ifndef SIG_BLOCK
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#endif
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int sigismember(const sigset_t *, int);
int sigprocmask(int, const sigset_t *, sigset_t *);
struct _IO_FILE;
struct _IO_FILE *popen(const char *, const char *);
int pclose(struct _IO_FILE *);
#ifdef __cplusplus
}
#endif
#endif
