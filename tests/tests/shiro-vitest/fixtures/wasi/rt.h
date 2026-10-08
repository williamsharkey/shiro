/* Minimal freestanding runtime for the kernel-wasi test programs.
 * No libc: these call wasi_snapshot_preview1 / wasix_32v1 / wasi imports
 * directly, so they build with plain clang --target=wasm32 (see build.sh). */
typedef unsigned int u32;
typedef unsigned long long u64;
typedef unsigned short u16;
typedef unsigned char u8;
typedef unsigned long size_t;

#define IMPORT(mod, name) __attribute__((import_module(mod), import_name(name)))
typedef struct { const void *buf; size_t len; } ciovec;
typedef struct { void *buf; size_t len; } iovec;

IMPORT("wasi_snapshot_preview1", "fd_write") u16 fd_write(int fd, const ciovec *iov, size_t n, size_t *nw);
IMPORT("wasi_snapshot_preview1", "fd_read") u16 fd_read(int fd, const iovec *iov, size_t n, size_t *nr);
IMPORT("wasi_snapshot_preview1", "fd_close") u16 fd_close(int fd);
IMPORT("wasi_snapshot_preview1", "proc_exit") _Noreturn void proc_exit(u32 code);
IMPORT("wasi_snapshot_preview1", "args_sizes_get") u16 args_sizes_get(size_t *argc, size_t *size);
IMPORT("wasi_snapshot_preview1", "args_get") u16 args_get(char **argv, char *buf);
IMPORT("wasi_snapshot_preview1", "path_open") u16 path_open(int dirfd, u32 dirflags, const char *path, size_t len,
  u16 oflags, u64 rights, u64 inherit, u16 fdflags, int *fd);
IMPORT("wasi_snapshot_preview1", "fd_prestat_get") u16 fd_prestat_get(int fd, void *buf);
IMPORT("wasi_snapshot_preview1", "fd_prestat_dir_name") u16 fd_prestat_dir_name(int fd, char *buf, size_t len);

static size_t slen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
static int writeb(int fd, const void *p, size_t n) {
  ciovec v = { p, n }; size_t w = 0;
  return fd_write(fd, &v, 1, &w) ? -1 : (int)w;
}
static int puts_fd(int fd, const char *s) { return writeb(fd, s, slen(s)); }
static int readb(int fd, void *p, size_t n) {
  iovec v = { p, n }; size_t r = 0;
  u16 e = fd_read(fd, &v, 1, &r);
  return e ? -(int)e : (int)r;
}
static char *utoa(u32 v, char *end) { /* writes digits ending at end, returns start */
  *end = 0; char *p = end;
  do { *--p = '0' + v % 10; v /= 10; } while (v);
  return p;
}
static int put_u(int fd, u32 v) { char b[16]; return puts_fd(fd, utoa(v, b + 15)); }

static char argbuf[4096];
static char *argvv[64];
static int get_args(void) {
  size_t argc = 0, sz = 0;
  args_sizes_get(&argc, &sz);
  if (argc > 64 || sz > sizeof argbuf) return 0;
  args_get(argvv, argbuf);
  return (int)argc;
}
static int atoi_(const char *s) { int v = 0; while (*s >= '0' && *s <= '9') v = v * 10 + (*s++ - '0'); return v; }

/* first preopen named "/" */
static int root_fd(void) {
  for (int fd = 3; fd < 32; fd++) {
    u32 st[2];
    if (fd_prestat_get(fd, st)) return -1;
    char name[8];
    if (st[1] == 1 && !fd_prestat_dir_name(fd, name, 1) && name[0] == '/') return fd;
  }
  return -1;
}

void *memset(void *d, int c, size_t n) { u8 *p = d; while (n--) *p++ = (u8)c; return d; }
void *memcpy(void *d, const void *s, size_t n) { u8 *p = d; const u8 *q = s; while (n--) *p++ = *q++; return d; }
