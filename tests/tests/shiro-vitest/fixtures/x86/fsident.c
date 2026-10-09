// What Claude Code's atomic writes and task-output checks need from the
// filesystem: O_CREAT|O_EXCL temp files, mkdir -p then openat(dirfd), the
// same st_dev/st_ino from stat, lstat and fstat (files and directories), a
// 0700 directory owned by the caller, and /proc/self/fd/N naming the path.
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/syscall.h>
#include <unistd.h>

// statx by syscall, as Bun calls it (musl 1.2.4 has no wrapper)
struct kstatx {
  unsigned stx_mask, stx_blksize; unsigned long long stx_attributes;
  unsigned stx_nlink, stx_uid, stx_gid; unsigned short stx_mode, pad0; unsigned long long stx_ino, stx_size, stx_blocks, stx_attributes_mask;
  struct { long long tv_sec; unsigned tv_nsec; int pad; } stx_atime, stx_btime, stx_ctime, stx_mtime;
  unsigned stx_rdev_major, stx_rdev_minor, stx_dev_major, stx_dev_minor; unsigned long long spare[14];
};
static int kstatx(int dfd, const char *path, int flags, struct kstatx *sx) { return syscall(SYS_statx, dfd, path, flags, 0x7ffu, sx); }
#include <unistd.h>

static int fails = 0;
#define CHECK(cond, ...) do { if (!(cond)) { fails++; printf("FAIL " __VA_ARGS__); printf(" (errno %d %s)\n", errno, strerror(errno)); } } while (0)

static void same(const char *what, const char *path, int fd) {
  struct stat a, b, c;
  CHECK(stat(path, &a) == 0, "%s: stat %s", what, path);
  CHECK(lstat(path, &b) == 0, "%s: lstat %s", what, path);
  CHECK(fstat(fd, &c) == 0, "%s: fstat", what);
  CHECK(a.st_dev == b.st_dev && a.st_ino == b.st_ino, "%s: stat %lu:%lu lstat %lu:%lu", what,
        (unsigned long)a.st_dev, (unsigned long)a.st_ino, (unsigned long)b.st_dev, (unsigned long)b.st_ino);
  CHECK(a.st_dev == c.st_dev && a.st_ino == c.st_ino, "%s: stat %lu:%lu fstat %lu:%lu", what,
        (unsigned long)a.st_dev, (unsigned long)a.st_ino, (unsigned long)c.st_dev, (unsigned long)c.st_ino);
  struct stat d;
  CHECK(stat(path, &d) == 0 && d.st_ino == a.st_ino && d.st_dev == a.st_dev, "%s: stat twice differs", what);
  char link[64], got[512];
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, got, sizeof got - 1);
  if (n >= 0) got[n] = 0;
  char *real = realpath(path, 0);
  CHECK(n > 0 && real && strcmp(got, real) == 0, "%s: %s -> %s, realpath %s", what, link, n > 0 ? got : "?", real ? real : "?");
  free(real);
}

static int run(int argc, char **argv);
struct args { int argc; char **argv; int ret; };
static void *on_thread(void *p) { struct args *a = p; a->ret = run(a->argc, a->argv); return 0; }

// --thread BASE: the same checks from a second thread (Bun's threadpool does async fs)
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--thread") == 0) {
    struct args a = { argc - 1, argv + 1, 1 };
    pthread_t t;
    pthread_create(&t, 0, on_thread, &a);
    pthread_join(t, 0);
    return a.ret;
  }
  return run(argc, argv);
}

static int run(int argc, char **argv) {
  // --ino PATH...: print each path's dev:ino (compared across processes)
  if (argc > 2 && strcmp(argv[1], "--ino") == 0) {
    for (int i = 2; i < argc; i++) {
      struct stat st;
      if (stat(argv[i], &st) == 0) printf("%lu:%lu\n", (unsigned long)st.st_dev, (unsigned long)st.st_ino);
      else printf("%s: %s\n", argv[i], strerror(errno));
    }
    return 0;
  }
  const char *base = argc > 1 ? argv[1] : "/tmp/fsident";
  char p[512];
  uid_t uid = geteuid();

  // mkdir -p of a deep path, 0700, owned by us
  snprintf(p, sizeof p, "%s/a/b/tasks", base);
  for (char *s = p + 1;; s++) {
    if (*s == '/' || !*s) {
      char c = *s;
      *s = 0;
      CHECK(mkdir(p, 0700) == 0 || errno == EEXIST, "mkdir %s", p);
      *s = c;
      if (!c) break;
    }
  }
  struct stat st;
  CHECK(stat(base, &st) == 0, "stat %s", base);
  CHECK(st.st_uid == uid, "owner of %s is %u, euid %u", base, (unsigned)st.st_uid, (unsigned)uid);
  CHECK((st.st_mode & 0777) == 0700, "mode of %s is %o", base, (unsigned)(st.st_mode & 0777));
  CHECK(S_ISDIR(st.st_mode), "%s not a dir", base);

  // the directory: open it O_DIRECTORY|O_NOFOLLOW, same identity every way
  snprintf(p, sizeof p, "%s/a/b/tasks", base);
  int dfd = open(p, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  CHECK(dfd >= 0, "open dir %s", p);
  if (dfd >= 0) same("dir", p, dfd);

  // openat(dirfd) a new file, O_CREAT|O_EXCL; again it's EEXIST
  int fd = openat(dfd, "x.output", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  CHECK(fd >= 0, "openat O_CREAT|O_EXCL x.output");
  if (fd >= 0) {
    CHECK(write(fd, "hi\n", 3) == 3, "write");
    snprintf(p, sizeof p, "%s/a/b/tasks/x.output", base);
    same("file", p, fd);
    close(fd);
  }
  errno = 0;
  CHECK(openat(dfd, "x.output", O_WRONLY | O_CREAT | O_EXCL, 0600) < 0 && errno == EEXIST, "second O_EXCL not EEXIST");

  // atomic write: temp file O_CREAT|O_EXCL beside the target, then rename
  const char *home = getenv("HOME") ? getenv("HOME") : "/home/user";
  char tmp[512], dst[512];
  snprintf(tmp, sizeof tmp, "%s/probe.txt.tmp.%d.a0876c", home, getpid());
  snprintf(dst, sizeof dst, "%s/probe.txt", home);
  fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
  CHECK(fd >= 0, "open O_CREAT|O_EXCL %s", tmp);
  if (fd >= 0) {
    CHECK(write(fd, "probe\n", 6) == 6, "write tmp");
    CHECK(fsync(fd) == 0, "fsync tmp");
    close(fd);
    CHECK(rename(tmp, dst) == 0, "rename %s", tmp);
    CHECK(stat(dst, &st) == 0 && st.st_size == 6, "stat %s after rename", dst);
  }

  // a new directory, then a file in it, by path
  snprintf(p, sizeof p, "%s/.probe-dir", home);
  CHECK(mkdir(p, 0755) == 0 || errno == EEXIST, "mkdir %s", p);
  snprintf(p, sizeof p, "%s/.probe-dir/probe.txt", home);
  fd = open(p, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  CHECK(fd >= 0, "open %s", p);
  if (fd >= 0) { same("new-dir file", p, fd); close(fd); }

  // Bun's way: O_PATH directory fds as openat() bases, realpath through
  // /proc/self/fd, statx and fstatat(AT_EMPTY_PATH) for identities
  snprintf(p, sizeof p, "%s/a/b", base);
  int pfd = open(p, O_PATH | O_DIRECTORY | O_CLOEXEC);
  CHECK(pfd >= 0, "open O_PATH|O_DIRECTORY %s", p);
  if (pfd >= 0) {
    same("O_PATH dir", p, pfd);
    struct stat e;
    CHECK(fstatat(pfd, "", &e, AT_EMPTY_PATH) == 0, "fstatat(O_PATH fd, \"\", AT_EMPTY_PATH)");
    struct stat a2;
    stat(p, &a2);
    CHECK(e.st_ino == a2.st_ino && e.st_dev == a2.st_dev, "AT_EMPTY_PATH ino %lu vs stat %lu", (unsigned long)e.st_ino, (unsigned long)a2.st_ino);
    int f2 = openat(pfd, "y.tmp.106.a0876c", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    CHECK(f2 >= 0, "openat(O_PATH dirfd, new, O_CREAT|O_EXCL)");
    if (f2 >= 0) {
      close(f2);
      CHECK(renameat(pfd, "y.tmp.106.a0876c", pfd, "y.txt") == 0, "renameat in O_PATH dir");
      CHECK(fstatat(pfd, "y.txt", &e, AT_SYMLINK_NOFOLLOW) == 0, "fstatat y.txt AT_SYMLINK_NOFOLLOW");
    }
    struct kstatx sx;
    CHECK(kstatx(AT_FDCWD, p, AT_SYMLINK_NOFOLLOW, &sx) == 0, "statx %s", p);
    CHECK(sx.stx_ino == a2.st_ino && makedev(sx.stx_dev_major, sx.stx_dev_minor) == a2.st_dev,
          "statx %u:%u:%llu vs stat %lu:%lu", sx.stx_dev_major, sx.stx_dev_minor, (unsigned long long)sx.stx_ino,
          (unsigned long)a2.st_dev, (unsigned long)a2.st_ino);
    CHECK(kstatx(pfd, "", AT_EMPTY_PATH, &sx) == 0 && sx.stx_ino == a2.st_ino, "statx(O_PATH fd, AT_EMPTY_PATH)");
    CHECK(sx.stx_uid == uid, "statx uid %u", sx.stx_uid);
    close(pfd);
  }

  // Claude Code's write pinning: the parent as an O_PATH fd, everything
  // below it through /proc/self/fd/N/NAME (mkdir, open, O_EXCL, rename),
  // and readlink(/proc/self/fd/N) to check where the fd points
  snprintf(p, sizeof p, "%s/pin", base);
  CHECK(mkdir(p, 0700) == 0 || errno == EEXIST, "mkdir %s", p);
  int pin = open(p, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  CHECK(pin >= 0, "open O_PATH %s", p);
  if (pin >= 0) {
    char via[128], got[512], q[256];
    snprintf(via, sizeof via, "/proc/self/fd/%d", pin);
    ssize_t n = readlink(via, got, sizeof got - 1);
    if (n >= 0) got[n] = 0;
    CHECK(n > 0 && strcmp(got, p) == 0, "readlink %s = %s, want %s", via, n > 0 ? got : "?", p);
    snprintf(q, sizeof q, "%s/sub", via);
    CHECK(mkdir(q, 0700) == 0 || errno == EEXIST, "mkdir %s", q);
    int sub = open(q, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    CHECK(sub >= 0, "open O_PATH %s", q);
    if (sub >= 0) {
      char via2[128], t1[256], t2[256];
      snprintf(via2, sizeof via2, "/proc/self/fd/%d", sub);
      n = readlink(via2, got, sizeof got - 1);
      if (n >= 0) got[n] = 0;
      snprintf(q, sizeof q, "%s/sub", p);
      CHECK(n > 0 && strcmp(got, q) == 0, "readlink %s = %s, want %s", via2, n > 0 ? got : "?", q);
      snprintf(t1, sizeof t1, "%s/out.tmp.106.a0876c", via2);
      snprintf(t2, sizeof t2, "%s/out.txt", via2);
      int f = open(t1, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
      CHECK(f >= 0, "open O_CREAT|O_EXCL %s", t1);
      if (f >= 0) {
        CHECK(write(f, "pinned\n", 7) == 7, "write %s", t1);
        close(f);
        CHECK(rename(t1, t2) == 0, "rename %s", t1);
        snprintf(q, sizeof q, "%s/sub/out.txt", p);
        CHECK(stat(q, &st) == 0 && st.st_size == 7, "stat %s", q);
        CHECK(stat(t2, &st) == 0 && st.st_size == 7, "stat %s", t2);
      }
      close(sub);
    }
    close(pin);
  }

  printf(fails ? "fsident: %d failed\n" : "fsident: ok\n", fails);
  return fails ? 1 : 0;
}
