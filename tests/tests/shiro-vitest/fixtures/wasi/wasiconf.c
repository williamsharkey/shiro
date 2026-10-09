/* wasi-conformance.test.ts: preview1 behaviours the wasi-testsuite checks
 * (Wasmtime's), each printed as "name errno-or-value". Run with the "/"
 * preopen either Shiro's root or a directory mounted as "/" ("confined":
 * WASI's capability rules hold, see `confined` in src/wasi/wasi-guest.ts). */
#include "rt.h"

IMPORT("wasi_snapshot_preview1", "fd_fdstat_get") u16 fd_fdstat_get(int fd, void *st);
IMPORT("wasi_snapshot_preview1", "fd_fdstat_set_rights") u16 fd_fdstat_set_rights(int fd, u64 base, u64 inh);
IMPORT("wasi_snapshot_preview1", "fd_seek") u16 fd_seek(int fd, long long off, u32 whence, u64 *pos);
IMPORT("wasi_snapshot_preview1", "fd_allocate") u16 fd_allocate(int fd, u64 off, u64 len);
IMPORT("wasi_snapshot_preview1", "fd_filestat_set_times") u16 fd_filestat_set_times(int fd, u64 atim, u64 mtim, u16 fst);
IMPORT("wasi_snapshot_preview1", "path_filestat_get") u16 path_filestat_get(int fd, u32 flags, const char *p, size_t l, void *buf);
IMPORT("wasi_snapshot_preview1", "path_create_directory") u16 path_create_directory(int fd, const char *p, size_t l);
IMPORT("wasi_snapshot_preview1", "path_symlink") u16 path_symlink(const char *o, size_t ol, int fd, const char *n, size_t nl);
IMPORT("wasi_snapshot_preview1", "path_unlink_file") u16 path_unlink_file(int fd, const char *p, size_t l);
IMPORT("wasi_snapshot_preview1", "path_remove_directory") u16 path_remove_directory(int fd, const char *p, size_t l);
IMPORT("wasi_snapshot_preview1", "path_rename") u16 path_rename(int fd, const char *o, size_t ol, int nfd, const char *n, size_t nl);
IMPORT("wasi_snapshot_preview1", "fd_renumber") u16 fd_renumber(int from, int to);
IMPORT("wasi_snapshot_preview1", "sock_shutdown") u16 sock_shutdown(int fd, u32 how);
IMPORT("wasi_snapshot_preview1", "environ_sizes_get") u16 environ_sizes_get(size_t *n, size_t *size);

#define R_READ (1ull << 1)
#define R_WRITE (1ull << 6)

static void say(const char *k, u32 v) { puts_fd(1, k); puts_fd(1, " "); put_u(1, v); puts_fd(1, "\n"); }
static u16 open_(int d, u32 dirflags, const char *p, u16 oflags, u64 rights, int *fd) {
  return path_open(d, dirflags, p, slen(p), oflags, rights, 0, 0, fd);
}
static u16 mkdir_(int d, const char *p) { return path_create_directory(d, p, slen(p)); }
static u64 mtim(int d, const char *p) {
  u64 st[8];
  path_filestat_get(d, 0, p, slen(p), st);
  return st[6];
}

void _start(void) {
  size_t envc = 0, envsz = 0;
  environ_sizes_get(&envc, &envsz);
  say("environ", (u32)envc);
  int root = root_fd();
  char name[1];
  say("prestat_short", fd_prestat_dir_name(root, name, 0));

  mkdir_(root, "t");
  int d = -1;
  say("open_dir", open_(root, 1, "t", 2 /* DIRECTORY */, 0, &d));
  u64 st[3];
  fd_fdstat_get(d, st);
  say("dir_seek_right", (u32)((st[1] >> 2) & 1));
  say("dir_set_size_right", (u32)((st[1] >> 19) & 1));
  say("dir_readdir_right", (u32)((st[1] >> 14) & 1));
  say("set_rights", fd_fdstat_set_rights(d, st[1], st[2]));
  u64 pos;
  say("seek_dir", fd_seek(d, 0, 1, &pos));

  int f = -1, g = -1;
  say("create", open_(d, 1, "f", 1 | 4 /* CREAT|EXCL */, R_READ | R_WRITE, &f));
  say("create_excl", open_(d, 1, "f", 1 | 4, R_READ | R_WRITE, &g));
  say("allocate", fd_allocate(f, 0, 100));
  u64 fst[8];
  path_filestat_get(d, 0, "f", 1, fst);
  say("size", (u32)fst[4]);
  u64 t = mtim(d, "f") - 100;
  say("set_mtim", fd_filestat_set_times(f, 0, t, 4 /* MTIM */));
  say("mtim_exact", mtim(d, "f") == t);
  say("mtim_and_now", fd_filestat_set_times(f, 0, t, 4 | 8));
  say("dir_rw", open_(d, 1, ".", 2, R_READ | R_WRITE, &g));
  say("file_slash", open_(d, 1, "f/", 0, R_READ, &g));
  open_(d, 1, "f", 0, R_READ, &g);
  fd_fdstat_get(g, st);
  say("ro_write_right", (u32)((st[1] >> 6) & 1));

  say("symlink", path_symlink("f", 1, d, "l", 1));
  say("open_nofollow", open_(d, 0, "l", 0, R_READ, &g));
  say("open_follow", open_(d, 1, "l", 0, R_READ, &g));
  u16 e = path_symlink("/x", 2, d, "abs", 3);
  say("symlink_abs", e);
  if (!e) path_unlink_file(d, "abs", 3);
  say("open_abs", open_(d, 1, "/t/f", 0, R_READ, &g));
  say("open_dotdot", open_(d, 1, "../t/f", 0, R_READ, &g));

  mkdir_(d, "a");
  mkdir_(d, "b");
  open_(d, 1, "b/x", 1, R_WRITE, &g);
  say("rename_nonempty", path_rename(d, "a", 1, d, "b", 1));
  say("rename_file_on_dir", path_rename(d, "f", 1, d, "a", 1));
  say("unlink_dir", path_unlink_file(d, "a", 1));
  say("unlink_file_slash", path_unlink_file(d, "f/", 2));
  say("rmdir_file", path_remove_directory(d, "f", 1));

  say("renumber_closed", fd_renumber(f, 40));
  size_t n;
  say("write_badfd_empty", fd_write(77, 0, 0, &n));
  say("shutdown_stdout", sock_shutdown(1, 3));
  proc_exit(0);
}
