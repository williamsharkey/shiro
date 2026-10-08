/*
 * Processes for wasi-sdk (preview1) programs running in Shiro.
 *
 * wasi-libc has no fork/exec/pipe/dup. Shiro's kernel guest implements a
 * subset of WASIX (src/wasi/wasi-guest.ts): proc_spawn3, proc_join, fd_pipe,
 * fd_dup. This file builds posix_spawn, waitpid, pipe, dup/dup2, exec*
 * (spawn + wait + exit), system and popen on them, so ordinary C programs
 * (make, ninja, ...) can run commands. Children start in the libc's current
 * directory (wasi-libc's chdir is userland), and inherit non-cloexec fds.
 */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wasi/api.h>
#include "include/shiro-proc.h"

#define WASIX(name) __attribute__((import_module("wasix_32v1"), import_name(#name)))

WASIX(proc_spawn3)
int32_t __shiro_proc_spawn3(const char *name, uint32_t name_len, char *const *argv, uint32_t argc,
                            char *const *envp, uint32_t envc, const void *fdops, uint32_t fdops_len,
                            const void *signals, uint32_t signals_len, uint8_t search_path,
                            const char *path, uint32_t path_len, uint32_t *ret_pid);
WASIX(proc_join)
int32_t __shiro_proc_join(void *pid, uint32_t flags, void *status);
WASIX(fd_pipe)
int32_t __shiro_fd_pipe(uint32_t *r, uint32_t *w);
WASIX(fd_dup)
int32_t __shiro_fd_dup(uint32_t fd, uint32_t *ret);
WASIX(getcwd)
int32_t __shiro_getcwd(char *buf, uint32_t *len);

extern char **environ;

/* WASIX ProcSpawnFdOp (56 bytes) */
struct fdop {
  uint8_t cmd; uint8_t _p0[3];
  uint32_t fd, src_fd, name, name_len, dirflags;
  uint16_t oflags; uint8_t _p1[6];
  uint64_t rights_base, rights_inh;
  uint16_t fdflags; uint8_t _p2[6];
};
_Static_assert(sizeof(struct fdop) == 56, "ProcSpawnFdOp layout");

struct __shiro_fa { int op, fd, src, flags; mode_t mode; char *path; };

static int set_errno(int e) { errno = e; return -1; }

/* wasi-libc keeps the cwd itself and starts it at "/" (resolving relative
   paths in the "." preopen). Start it at the kernel's cwd instead, so
   getcwd(), $PWD-less programs and spawned children all agree. */
__attribute__((constructor)) static void sync_cwd(void) {
  char buf[PATH_MAX], cur[8];
  uint32_t len = sizeof buf - 1;
  if (!getcwd(cur, sizeof cur) || strcmp(cur, "/") != 0) return;
  if (__shiro_getcwd(buf, &len) != 0 || len >= sizeof buf) return;
  buf[len] = 0;
  if (buf[0] == '/' && buf[1]) chdir(buf);
}

/* ── pipes and fds ─────────────────────────────────────────────────── */

int pipe(int fds[2]) {
  uint32_t r, w;
  int e = __shiro_fd_pipe(&r, &w);
  if (e) return set_errno(e);
  fds[0] = (int)r; fds[1] = (int)w;
  return 0;
}

int pipe2(int fds[2], int flags) {
  if (pipe(fds) < 0) return -1;
  if (flags & O_NONBLOCK) { fcntl(fds[0], F_SETFL, O_NONBLOCK); fcntl(fds[1], F_SETFL, O_NONBLOCK); }
  if (flags & O_CLOEXEC) { fcntl(fds[0], F_SETFD, FD_CLOEXEC); fcntl(fds[1], F_SETFD, FD_CLOEXEC); }
  return 0;
}

int dup(int fd) {
  uint32_t n;
  int e = __shiro_fd_dup((uint32_t)fd, &n);
  return e ? set_errno(e) : (int)n;
}

int dup2(int old, int nfd) {
  if (old == nfd) return fcntl(old, F_GETFD) < 0 ? -1 : nfd;
  int t = dup(old);
  if (t < 0) return -1;
  int e = __wasi_fd_renumber((__wasi_fd_t)t, (__wasi_fd_t)nfd);
  if (e) { close(t); return set_errno(e); }
  return nfd;
}

int dup3(int old, int nfd, int flags) {
  if (old == nfd) return set_errno(EINVAL);
  if (dup2(old, nfd) < 0) return -1;
  if (flags & O_CLOEXEC) fcntl(nfd, F_SETFD, FD_CLOEXEC);
  return nfd;
}

/* ── posix_spawn ───────────────────────────────────────────────────── */

int posix_spawnattr_init(posix_spawnattr_t *a) { memset(a, 0, sizeof *a); return 0; }
int posix_spawnattr_destroy(posix_spawnattr_t *a) { (void)a; return 0; }
int posix_spawnattr_setflags(posix_spawnattr_t *a, short f) { a->flags = f; return 0; }
int posix_spawnattr_getflags(const posix_spawnattr_t *a, short *f) { *f = (short)a->flags; return 0; }
int posix_spawnattr_setpgroup(posix_spawnattr_t *a, pid_t g) { a->pgroup = g; return 0; }
int posix_spawnattr_setsigmask(posix_spawnattr_t *a, const sigset_t *m) { (void)a; (void)m; return 0; }
int posix_spawnattr_setsigdefault(posix_spawnattr_t *a, const sigset_t *m) { (void)a; (void)m; return 0; }

int posix_spawn_file_actions_init(posix_spawn_file_actions_t *fa) { memset(fa, 0, sizeof *fa); return 0; }

int posix_spawn_file_actions_destroy(posix_spawn_file_actions_t *fa) {
  for (int i = 0; i < fa->n; i++) free(fa->acts[i].path);
  free(fa->acts);
  memset(fa, 0, sizeof *fa);
  return 0;
}

static struct __shiro_fa *fa_push(posix_spawn_file_actions_t *fa) {
  if (fa->n == fa->cap) {
    int cap = fa->cap ? fa->cap * 2 : 8;
    struct __shiro_fa *a = realloc(fa->acts, cap * sizeof *a);
    if (!a) return NULL;
    fa->acts = a; fa->cap = cap;
  }
  struct __shiro_fa *a = &fa->acts[fa->n++];
  memset(a, 0, sizeof *a);
  return a;
}

int posix_spawn_file_actions_addopen(posix_spawn_file_actions_t *fa, int fd, const char *path, int flags, mode_t mode) {
  struct __shiro_fa *a = fa_push(fa);
  if (!a) return ENOMEM;
  a->op = 2; a->fd = fd; a->flags = flags; a->mode = mode; a->path = strdup(path);
  return 0;
}
int posix_spawn_file_actions_addclose(posix_spawn_file_actions_t *fa, int fd) {
  struct __shiro_fa *a = fa_push(fa);
  if (!a) return ENOMEM;
  a->op = 0; a->fd = fd;
  return 0;
}
int posix_spawn_file_actions_adddup2(posix_spawn_file_actions_t *fa, int src, int fd) {
  struct __shiro_fa *a = fa_push(fa);
  if (!a) return ENOMEM;
  a->op = 1; a->fd = fd; a->src = src;
  return 0;
}
int posix_spawn_file_actions_addchdir_np(posix_spawn_file_actions_t *fa, const char *path) {
  struct __shiro_fa *a = fa_push(fa);
  if (!a) return ENOMEM;
  a->op = 3; a->path = strdup(path);
  return 0;
}
int posix_spawn_file_actions_addfchdir_np(posix_spawn_file_actions_t *fa, int fd) {
  struct __shiro_fa *a = fa_push(fa);
  if (!a) return ENOMEM;
  a->op = 4; a->src = fd;
  return 0;
}

#define RIGHT_FD_READ (1ull << 1)
#define RIGHT_FD_WRITE (1ull << 6)

static int count(char *const *v) { int n = 0; while (v && v[n]) n++; return n; }

static int do_spawn(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa,
                    char *const argv[], char *const envp[], int search) {
  int n = fa ? fa->n : 0;
  struct fdop *ops = calloc((size_t)n + 1, sizeof *ops);
  if (!ops) return ENOMEM;
  /* The child starts where this process is (see sync_cwd) */
  char cwd[PATH_MAX];
  int k = 0;
  if (getcwd(cwd, sizeof cwd)) {
    ops[k].cmd = 3; ops[k].name = (uint32_t)(uintptr_t)cwd; ops[k].name_len = (uint32_t)strlen(cwd);
    k++;
  }
  for (int i = 0; i < n; i++, k++) {
    const struct __shiro_fa *a = &fa->acts[i];
    struct fdop *o = &ops[k];
    o->fd = (uint32_t)a->fd;
    o->src_fd = (uint32_t)a->src;
    switch (a->op) {
      case 0: o->cmd = 0; break;
      case 1: o->cmd = 1; break;
      case 2: {
        o->cmd = 2;
        o->name = (uint32_t)(uintptr_t)a->path; o->name_len = (uint32_t)strlen(a->path);
        int acc = a->flags & O_ACCMODE;
        o->rights_base = (acc == O_RDONLY || acc == O_RDWR ? RIGHT_FD_READ : 0) |
                         (acc == O_WRONLY || acc == O_RDWR ? RIGHT_FD_WRITE : 0);
        o->oflags = (uint16_t)(((a->flags & O_CREAT) ? 1 : 0) | ((a->flags & O_DIRECTORY) ? 2 : 0) |
                               ((a->flags & O_EXCL) ? 4 : 0) | ((a->flags & O_TRUNC) ? 8 : 0));
        o->fdflags = (uint16_t)((a->flags & O_APPEND) ? 1 : 0);
        break;
      }
      case 3: o->cmd = 3; o->name = (uint32_t)(uintptr_t)a->path; o->name_len = (uint32_t)strlen(a->path); break;
      case 4: o->cmd = 4; break;
    }
  }
  char *const *env = envp ? envp : environ;
  const char *path = search ? getenv("PATH") : NULL;
  if (search && !path) path = "/usr/local/bin:/usr/bin:/bin";
  uint32_t child = 0;
  int e = __shiro_proc_spawn3(file, (uint32_t)strlen(file), argv, (uint32_t)count(argv), env, (uint32_t)count(env),
                              ops, (uint32_t)k, NULL, 0, search ? 1 : 0, path, path ? (uint32_t)strlen(path) : 0, &child);
  free(ops);
  if (e) return e;
  if (pid) *pid = (pid_t)child;
  return 0;
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *fa,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  (void)attr;
  return do_spawn(pid, path, fa, argv, envp, 0);
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  (void)attr;
  return do_spawn(pid, file, fa, argv, envp, strchr(file, '/') == NULL);
}

/* ── wait ──────────────────────────────────────────────────────────── */

struct option_pid { uint8_t tag; uint8_t _p[3]; uint32_t pid; };
struct join_status { uint8_t tag; uint8_t _p; uint16_t code; uint8_t sig; uint8_t _q[3]; };

pid_t wait4(pid_t pid, int *status, int options, struct rusage *ru) {
  struct option_pid p = { .tag = pid > 0 ? 1 : 0, .pid = pid > 0 ? (uint32_t)pid : 0 };
  struct join_status s;
  memset(&s, 0, sizeof s);
  if (ru) memset(ru, 0, sizeof *ru);
  int e = __shiro_proc_join(&p, (options & WNOHANG) ? 1 : 0, &s);
  if (e) return set_errno(e);
  if (p.tag == 0) return 0; /* WNOHANG, nothing yet */
  if (status) *status = s.tag == 1 ? (s.code & 0xff) << 8 : (s.sig & 0x7f);
  return (pid_t)p.pid;
}

pid_t waitpid(pid_t pid, int *status, int options) { return wait4(pid, status, options, NULL); }
pid_t wait(int *status) { return wait4(-1, status, 0, NULL); }
pid_t wait3(int *status, int options, struct rusage *ru) { return wait4(-1, status, options, ru); }

/* ── exec: spawn, wait, exit with the child's status ───────────────── */

static int exec_common(const char *file, char *const argv[], char *const envp[], int search) {
  pid_t pid;
  int e = do_spawn(&pid, file, NULL, argv, envp, search && !strchr(file, '/'));
  if (e) return set_errno(e);
  int st = 0;
  while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {}
  fflush(NULL);
  _Exit(WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st));
}

int execve(const char *p, char *const a[], char *const e[]) { return exec_common(p, a, e, 0); }
int execv(const char *p, char *const a[]) { return exec_common(p, a, NULL, 0); }
int execvp(const char *f, char *const a[]) { return exec_common(f, a, NULL, 1); }
int execvpe(const char *f, char *const a[], char *const e[]) { return exec_common(f, a, e, 1); }

static char **va_argv(const char *first, va_list ap) {
  int n = 1;
  va_list c;
  va_copy(c, ap);
  while (va_arg(c, const char *)) n++;
  va_end(c);
  char **v = malloc((size_t)(n + 1) * sizeof *v);
  if (!v) return NULL;
  v[0] = (char *)first;
  for (int i = 1; i < n; i++) v[i] = va_arg(ap, char *);
  v[n] = NULL;
  return v;
}
int execl(const char *p, const char *a0, ...) {
  va_list ap; va_start(ap, a0); char **v = va_argv(a0, ap); va_end(ap);
  return v ? exec_common(p, v, NULL, 0) : -1;
}
int execlp(const char *f, const char *a0, ...) {
  va_list ap; va_start(ap, a0); char **v = va_argv(a0, ap); va_end(ap);
  return v ? exec_common(f, v, NULL, 1) : -1;
}

/* ── system / popen ────────────────────────────────────────────────── */

int system(const char *cmd) {
  if (!cmd) return 1;
  char *argv[] = { "sh", "-c", (char *)cmd, NULL };
  pid_t pid;
  int e = do_spawn(&pid, "/bin/sh", NULL, argv, NULL, 0);
  if (e) { errno = e; return -1; }
  int st = 0;
  while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {}
  return st;
}

static struct popen_ent { FILE *f; pid_t pid; struct popen_ent *next; } *popen_list;

FILE *popen(const char *cmd, const char *mode) {
  int fds[2];
  int reading = mode[0] == 'r';
  if ((mode[0] != 'r' && mode[0] != 'w') || pipe(fds) < 0) { errno = EINVAL; return NULL; }
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, reading ? fds[1] : fds[0], reading ? 1 : 0);
  posix_spawn_file_actions_addclose(&fa, reading ? fds[0] : fds[1]);
  char *argv[] = { "sh", "-c", (char *)cmd, NULL };
  pid_t pid;
  int e = do_spawn(&pid, "/bin/sh", &fa, argv, NULL, 0);
  posix_spawn_file_actions_destroy(&fa);
  close(reading ? fds[1] : fds[0]);
  if (e) { close(reading ? fds[0] : fds[1]); errno = e; return NULL; }
  FILE *f = fdopen(reading ? fds[0] : fds[1], reading ? "r" : "w");
  struct popen_ent *p = malloc(sizeof *p);
  if (!f || !p) { free(p); return NULL; }
  p->f = f; p->pid = pid; p->next = popen_list; popen_list = p;
  return f;
}

int pclose(FILE *f) {
  struct popen_ent **pp = &popen_list, *p;
  while ((p = *pp) && p->f != f) pp = &p->next;
  if (!p) { errno = ECHILD; return -1; }
  *pp = p->next;
  fclose(f);
  int st = 0;
  pid_t pid = p->pid;
  free(p);
  while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {}
  return st;
}

/* ── identity and signals (single user, no signal delivery to others) ── */

int kill(pid_t pid, int sig) { (void)pid; (void)sig; return set_errno(ENOSYS); }
int killpg(pid_t pg, int sig) { (void)pg; (void)sig; return set_errno(ENOSYS); }
pid_t getppid(void) { return 1; }
pid_t getpgrp(void) { return getpid(); }
pid_t setsid(void) { return getpid(); }
int setpgid(pid_t p, pid_t g) { (void)p; (void)g; return 0; }
uid_t getuid(void) { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void) { return 0; }
gid_t getegid(void) { return 0; }

/* ── the one user ──────────────────────────────────────────────────── */

#include <pwd.h>

static struct passwd *the_user(void) {
  static struct passwd pw;
  const char *name = getenv("USER"), *home = getenv("HOME");
  pw.pw_name = (char *)(name && *name ? name : "user");
  pw.pw_passwd = "x";
  pw.pw_uid = 0; pw.pw_gid = 0;
  pw.pw_gecos = pw.pw_name;
  pw.pw_dir = (char *)(home && *home ? home : "/home/user");
  pw.pw_shell = "/bin/sh";
  return &pw;
}
struct passwd *getpwuid(uid_t uid) { (void)uid; return the_user(); }
struct passwd *getpwnam(const char *name) {
  struct passwd *pw = the_user();
  return name && strcmp(name, pw->pw_name) == 0 ? pw : NULL;
}
static int pwent_done;
void setpwent(void) { pwent_done = 0; }
void endpwent(void) { pwent_done = 0; }
struct passwd *getpwent(void) { if (pwent_done) return NULL; pwent_done = 1; return the_user(); }

/* File mode creation mask: kept, not applied (files get the kernel's default modes) */
static mode_t cur_umask = 022;
mode_t umask(mode_t m) { mode_t o = cur_umask; cur_umask = m & 0777; return o; }

/* ── signal sets (wasi-libc's sigset_t is one byte; masks are not enforced) ── */
int sigemptyset(sigset_t *s) { *s = 0; return 0; }
int sigfillset(sigset_t *s) { *s = (sigset_t)~0; return 0; }
int sigaddset(sigset_t *s, int n) { *s |= (sigset_t)(1u << (n & 7)); return 0; }
int sigdelset(sigset_t *s, int n) { *s &= (sigset_t)~(1u << (n & 7)); return 0; }
int sigismember(const sigset_t *s, int n) { return (*s >> (n & 7)) & 1; }
static sigset_t cur_mask;
int sigprocmask(int how, const sigset_t *set, sigset_t *old) {
  if (old) *old = cur_mask;
  if (set) cur_mask = how == SIG_BLOCK ? (cur_mask | *set) : how == SIG_UNBLOCK ? (cur_mask & ~*set) : *set;
  return 0;
}
char *getlogin(void) { return the_user()->pw_name; }
