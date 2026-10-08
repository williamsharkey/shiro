/* kbench: kernel micro-benchmarks run as a WASM process inside Shiro.
 * Freestanding (no libc), so it builds with plain clang --target=wasm32:
 *   sh bench/fixtures/build.sh
 * Every mode prints "key=value" lines; times come from clock_time_get
 * (answered inside the guest, no syscall) in nanoseconds.
 *   kbench nop                 exit at once (spawn latency)
 *   kbench sys N               N fd_fdstat_get(1) calls (one kernel fstat each)
 *   kbench write MB [CHUNK]    write MB MiB to stdout in CHUNK-byte writes (default 65536)
 *   kbench read [CHUNK]        read stdin to EOF
 *   kbench fwrite PATH MB      create PATH and write MB MiB (64 KiB writes)
 *   kbench fread PATH          read PATH to EOF (64 KiB reads)
 *   kbench cpu N               N rounds of an integer hash loop
 */
typedef unsigned int u32;
typedef unsigned long long u64;
typedef unsigned short u16;
typedef unsigned char u8;
typedef unsigned long size_t;
#define IMPORT(name) __attribute__((import_module("wasi_snapshot_preview1"), import_name(name)))
typedef struct { const void *buf; size_t len; } ciovec;
typedef struct { void *buf; size_t len; } iovec;
IMPORT("fd_write") u16 fd_write(int fd, const ciovec *iov, size_t n, size_t *nw);
IMPORT("fd_read") u16 fd_read(int fd, const iovec *iov, size_t n, size_t *nr);
IMPORT("fd_close") u16 fd_close(int fd);
IMPORT("fd_fdstat_get") u16 fd_fdstat_get(int fd, void *buf);
IMPORT("proc_exit") _Noreturn void proc_exit(u32 code);
IMPORT("args_sizes_get") u16 args_sizes_get(size_t *argc, size_t *size);
IMPORT("args_get") u16 args_get(char **argv, char *buf);
IMPORT("clock_time_get") u16 clock_time_get(u32 id, u64 prec, u64 *t);
IMPORT("path_open") u16 path_open(int dirfd, u32 dirflags, const char *path, size_t len,
  u16 oflags, u64 rights, u64 inherit, u16 fdflags, int *fd);
IMPORT("fd_prestat_get") u16 fd_prestat_get(int fd, void *buf);
IMPORT("fd_prestat_dir_name") u16 fd_prestat_dir_name(int fd, char *buf, size_t len);

void *memset(void *d, int c, size_t n) { u8 *p = d; while (n--) *p++ = (u8)c; return d; }
void *memcpy(void *d, const void *s, size_t n) { u8 *p = d; const u8 *q = s; while (n--) *p++ = *q++; return d; }
static size_t slen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
static int writeb(int fd, const void *p, size_t n) { ciovec v = { p, n }; size_t w = 0; return fd_write(fd, &v, 1, &w) ? -1 : (int)w; }
static int readb(int fd, void *p, size_t n) { iovec v = { p, n }; size_t r = 0; u16 e = fd_read(fd, &v, 1, &r); return e ? -(int)e : (int)r; }
static void puts1(const char *s) { writeb(1, s, slen(s)); }
static char *u64toa(u64 v, char *end) { *end = 0; char *p = end; do { *--p = '0' + v % 10; v /= 10; } while (v); return p; }
static void kv(const char *k, u64 v) { char b[32]; puts1(k); puts1("="); puts1(u64toa(v, b + 31)); puts1("\n"); }
static u64 atou(const char *s) { u64 v = 0; while (*s >= '0' && *s <= '9') v = v * 10 + (u64)(*s++ - '0'); return v; }
static int streq(const char *a, const char *b) { while (*a && *a == *b) a++, b++; return *a == *b; }
static u64 now(void) { u64 t = 0; clock_time_get(1, 1, &t); return t; }
static char argbuf[4096];
static char *argvv[16];
static u8 buf[1 << 20];

static int root_fd(void) {
  for (int fd = 3; fd < 32; fd++) {
    u32 st[2]; char name[8];
    if (fd_prestat_get(fd, st)) return -1;
    if (st[1] == 1 && !fd_prestat_dir_name(fd, name, 1) && name[0] == '/') return fd;
  }
  return -1;
}
static int open_path(const char *path, int create) {
  int root = root_fd(), fd = -1;
  if (root < 0) return -1;
  while (*path == '/') path++;
  /* oflags: CREAT=1 TRUNC=8; rights: all */
  if (path_open(root, 1, path, slen(path), create ? 9 : 0, ~0ull, ~0ull, 0, &fd)) return -1;
  return fd;
}

void _start(void) {
  size_t argc = 0, sz = 0;
  args_sizes_get(&argc, &sz);
  if (argc > 16 || sz > sizeof argbuf) proc_exit(2);
  args_get(argvv, argbuf);
  const char *mode = argc > 1 ? argvv[1] : "nop";
  if (streq(mode, "nop")) proc_exit(0);
  if (streq(mode, "sys")) {
    u64 n = argc > 2 ? atou(argvv[2]) : 1000;
    u8 st[24];
    u64 t0 = now();
    for (u64 i = 0; i < n; i++) fd_fdstat_get(1, st);
    u64 dt = now() - t0;
    kv("calls", n); kv("ns", dt);
    proc_exit(0);
  }
  if (streq(mode, "write")) {
    u64 mb = argc > 2 ? atou(argvv[2]) : 16, chunk = argc > 3 ? atou(argvv[3]) : 65536;
    if (chunk > sizeof buf) chunk = sizeof buf;
    for (u64 i = 0; i < chunk; i++) buf[i] = (u8)('a' + i % 26);
    u64 total = mb << 20, done = 0, t0 = now();
    while (done < total) {
      u64 n = total - done < chunk ? total - done : chunk;
      int w = writeb(1, buf, (size_t)n);
      if (w <= 0) proc_exit(1);
      done += (u64)w;
    }
    kv("bytes", done); kv("ns", now() - t0);
    proc_exit(0);
  }
  if (streq(mode, "read")) {
    u64 chunk = argc > 2 ? atou(argvv[2]) : 65536, total = 0, t0 = 0;
    if (chunk > sizeof buf) chunk = sizeof buf;
    for (;;) {
      int r = readb(0, buf, (size_t)chunk);
      if (r <= 0) break;
      if (!t0) t0 = now();
      total += (u64)r;
    }
    kv("bytes", total); kv("ns", t0 ? now() - t0 : 0);
    proc_exit(0);
  }
  if (streq(mode, "fwrite") && argc > 2) {
    u64 mb = argc > 3 ? atou(argvv[3]) : 4, total = mb << 20, done = 0;
    for (u64 i = 0; i < 65536; i++) buf[i] = (u8)i;
    u64 t0 = now();
    int fd = open_path(argvv[2], 1);
    if (fd < 0) { puts1("error=open\n"); proc_exit(1); }
    while (done < total) { int w = writeb(fd, buf, 65536); if (w <= 0) proc_exit(1); done += (u64)w; }
    fd_close(fd);
    kv("bytes", done); kv("ns", now() - t0);
    proc_exit(0);
  }
  if (streq(mode, "fread") && argc > 2) {
    u64 total = 0, t0 = now();
    int fd = open_path(argvv[2], 0);
    if (fd < 0) { puts1("error=open\n"); proc_exit(1); }
    for (;;) { int r = readb(fd, buf, 65536); if (r <= 0) break; total += (u64)r; }
    fd_close(fd);
    kv("bytes", total); kv("ns", now() - t0);
    proc_exit(0);
  }
  if (streq(mode, "cpu")) {
    u64 n = argc > 2 ? atou(argvv[2]) : 100000000ull;
    u64 t0 = now();
    u32 h = 2166136261u;
    for (u64 i = 0; i < n; i++) { h ^= (u32)i; h *= 16777619u; h ^= h >> 13; }
    u64 dt = now() - t0;
    kv("hash", h); kv("ns", dt);
    proc_exit(0);
  }
  puts1("usage: kbench nop|sys N|write MB|read|fwrite PATH MB|fread PATH|cpu N\n");
  proc_exit(2);
}
