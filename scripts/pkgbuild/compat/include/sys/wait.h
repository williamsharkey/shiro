/* waitpid and the W* macros for wasi-sdk programs in Shiro (wasi-proc.c). */
#ifndef _SHIRO_SYS_WAIT_H
#define _SHIRO_SYS_WAIT_H
#include <sys/types.h>
#include <sys/resource.h>
#ifdef __cplusplus
extern "C" {
#endif
#define WNOHANG 1
#define WUNTRACED 2
#define WCONTINUED 8
#define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
#define WTERMSIG(s) ((s) & 0x7f)
#define WSTOPSIG(s) WEXITSTATUS(s)
#define WIFEXITED(s) (!WTERMSIG(s))
#define WIFSTOPPED(s) ((short)((((s) & 0xffff) * 0x10001U) >> 8) > 0x7f00)
#define WIFSIGNALED(s) (((s) & 0xffff) - 1U < 0xffu)
#define WIFCONTINUED(s) ((s) == 0xffff)
#define WCOREDUMP(s) ((s) & 0x80)
pid_t wait(int *);
pid_t waitpid(pid_t, int *, int);
pid_t wait3(int *, int, struct rusage *);
pid_t wait4(pid_t, int *, int, struct rusage *);
#ifdef __cplusplus
}
#endif
#endif
