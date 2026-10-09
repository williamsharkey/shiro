// File identity and exclusive create, as native programs (Claude Code's Bun
// binary, musl's realpath) rely on: st_dev/st_ino agree across stat, lstat,
// fstat on files and dirfds (O_DIRECTORY, O_PATH), statx, newfstatat and
// getdents; survive rename; differ between files. O_CREAT|O_EXCL, O_NOFOLLOW,
// O_TMPFILE, dirfd-relative opens, mkdirat, renameat2(RENAME_NOREPLACE),
// linkat; realpath through /proc/self/fd; owner and mode of a 0700 dir.
// `./prog ids PATH...` prints dev:ino of each path (checked across a reload).
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif
#ifndef O_TMPFILE
#define O_TMPFILE (020000000 | O_DIRECTORY)
#endif

struct linux_dirent64 { unsigned long long d_ino; long long d_off; unsigned short d_reclen; unsigned char d_type; char d_name[]; };

static int fails;
#define CHECK(name, cond) do { if (cond) printf("ok %s\n", name); else { printf("FAIL %s (errno %d %s)\n", name, errno, strerror(errno)); fails++; } } while (0)

static int same(struct stat *a, struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }

static unsigned long long dent_ino(int dirfd, const char *name) {
  char buf[8192];
  lseek(dirfd, 0, SEEK_SET);
  for (;;) {
    long n = syscall(SYS_getdents64, dirfd, buf, sizeof buf);
    if (n <= 0) return 0;
    for (long off = 0; off < n;) {
      struct linux_dirent64 *d = (void *)(buf + off);
      if (!strcmp(d->d_name, name)) return d->d_ino;
      off += d->d_reclen;
    }
  }
}

static int statx_same(const char *path, struct stat *st) {
  struct { unsigned int mask, blksize; unsigned long long attributes; unsigned int nlink, uid, gid; unsigned short mode, pad; unsigned long long ino, size, blocks, amask;
    struct { long long s; unsigned int ns; int r; } at, bt, ct, mt; unsigned int rdev_major, rdev_minor, dev_major, dev_minor; unsigned long long spare[14]; } sx;
  if (syscall(SYS_statx, AT_FDCWD, path, AT_SYMLINK_NOFOLLOW, 0x7ff, &sx) != 0) return 0;
  return sx.ino == st->st_ino && makedev(sx.dev_major, sx.dev_minor) == st->st_dev;
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "ids")) {
    for (int i = 2; i < argc; i++) {
      struct stat st;
      if (lstat(argv[i], &st)) printf("%s missing\n", argv[i]);
      else printf("%s %llu:%llu\n", argv[i], (unsigned long long)st.st_dev, (unsigned long long)st.st_ino);
    }
    return 0;
  }
  if (argc > 1 && !strcmp(argv[1], "cwd")) {
    // getcwd and realpath(".") through /proc/self/fd must both be the physical directory
    char cw[PATH_MAX], rl[PATH_MAX], ln[64];
    if (!getcwd(cw, sizeof cw)) return 2;
    int h = open(".", O_PATH);
    snprintf(ln, sizeof ln, "/proc/self/fd/%d", h);
    ssize_t k = readlink(ln, rl, sizeof rl - 1);
    if (k < 0) return 3;
    rl[k] = 0;
    struct stat x, y, z;
    lstat(cw, &x); fstat(h, &y); stat(".", &z);
    printf("getcwd %s\nfd %s\nsame %d\n", cw, rl, !strcmp(cw, rl) && S_ISDIR(x.st_mode) && same(&x, &y) && same(&y, &z));
    return 0;
  }
  struct stat a, b, c;
  // 4. ownership and mode of a private dir (Claude Code's /tmp/claude-<uid>)
  char priv[64];
  snprintf(priv, sizeof priv, "/tmp/claude-%d", (int)getuid());
  CHECK("mkdir 0700", mkdir(priv, 0700) == 0 || errno == EEXIST);
  CHECK("private dir owner and mode", stat(priv, &a) == 0 && a.st_uid == getuid() && (a.st_mode & 07777) == 0700 && S_ISDIR(a.st_mode));
  CHECK("lstat agrees (not a symlink)", lstat(priv, &b) == 0 && same(&a, &b) && S_ISDIR(b.st_mode));

  // 1. identity of a directory through every stat path
  CHECK("mkdir d", mkdir("d", 0755) == 0);
  CHECK("stat d", stat("d", &a) == 0);
  int dfd = open("d", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  CHECK("fstat O_DIRECTORY fd", dfd >= 0 && fstat(dfd, &b) == 0 && same(&a, &b));
  int pfd = open("d", O_PATH | O_CLOEXEC);
  CHECK("fstat O_PATH fd", pfd >= 0 && fstat(pfd, &b) == 0 && same(&a, &b));
  CHECK("fstatat AT_EMPTY_PATH", fstatat(pfd, "", &b, AT_EMPTY_PATH) == 0 && same(&a, &b));
  CHECK("newfstatat", fstatat(AT_FDCWD, "d", &b, 0) == 0 && same(&a, &b));
  CHECK("statx dir", statx_same("d", &a));
  int cwd = open(".", O_RDONLY | O_DIRECTORY);
  CHECK("getdents d_ino of dir", cwd >= 0 && dent_ino(cwd, "d") == a.st_ino);
  CHECK("getdents . is the dir", dent_ino(dfd, ".") == a.st_ino);

  // 2. exclusive create, relative to a dirfd
  int fd = openat(dfd, "f", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  CHECK("openat O_CREAT|O_EXCL", fd >= 0);
  CHECK("O_EXCL on existing is EEXIST", openat(dfd, "f", O_CREAT | O_EXCL | O_WRONLY, 0600) < 0 && errno == EEXIST);
  CHECK("write", write(fd, "data", 4) == 4);
  CHECK("fstat file", fstat(fd, &a) == 0 && S_ISREG(a.st_mode) && (a.st_mode & 0777) == 0600 && a.st_uid == getuid());
  CHECK("stat file agrees with fstat", stat("d/f", &b) == 0 && same(&a, &b));
  CHECK("fstatat dirfd agrees", fstatat(dfd, "f", &b, AT_SYMLINK_NOFOLLOW) == 0 && same(&a, &b));
  CHECK("statx file", statx_same("d/f", &a));
  CHECK("getdents d_ino of file", dent_ino(dfd, "f") == a.st_ino);
  close(fd);
  CHECK("stat after close agrees", stat("d/f", &b) == 0 && same(&a, &b));

  // two files never share an inode; a dir and a file neither
  int fd2 = openat(dfd, "f2", O_CREAT | O_EXCL | O_WRONLY, 0644);
  CHECK("second file", fd2 >= 0 && fstat(fd2, &c) == 0 && c.st_ino != a.st_ino);
  if (fd2 >= 0) close(fd2);
  struct stat ds; stat("d", &ds);
  CHECK("file and dir differ", ds.st_ino != a.st_ino && ds.st_ino != c.st_ino);

  // rename keeps the inode; RENAME_NOREPLACE refuses an existing target
  CHECK("renameat d/f -> d/g", renameat(dfd, "f", dfd, "g") == 0);
  CHECK("inode follows rename", stat("d/g", &b) == 0 && same(&a, &b));
  CHECK("renameat2 NOREPLACE on existing is EEXIST", syscall(SYS_renameat2, dfd, "g", dfd, "f2", RENAME_NOREPLACE) < 0 && errno == EEXIST);
  CHECK("renameat2 NOREPLACE to a new name", syscall(SYS_renameat2, dfd, "g", dfd, "h", RENAME_NOREPLACE) == 0 && stat("d/h", &b) == 0 && same(&a, &b));
  CHECK("rename over a file keeps the source inode", rename("d/h", "d/f2") == 0 && stat("d/f2", &b) == 0 && same(&a, &b));
  CHECK("rename a dir keeps its inode", rename("d", "d2") == 0 && stat("d2", &b) == 0 && b.st_ino == ds.st_ino && rename("d2", "d") == 0);
  CHECK("an open dirfd follows its renamed dir", fstat(dfd, &b) == 0 && b.st_ino == ds.st_ino);

  // linkat: same inode, two links
  CHECK("linkat", linkat(dfd, "f2", dfd, "l", 0) == 0 && stat("d/l", &b) == 0 && same(&a, &b) && b.st_nlink == 2);
  CHECK("unlink one link leaves the other", unlink("d/l") == 0 && stat("d/f2", &b) == 0 && same(&a, &b) && b.st_nlink == 1);

  // mkdirat; O_NOFOLLOW; O_TMPFILE
  CHECK("mkdirat", mkdirat(dfd, "sub", 0700) == 0 && fstatat(dfd, "sub", &b, 0) == 0 && S_ISDIR(b.st_mode) && (b.st_mode & 07777) == 0700);
  CHECK("mkdirat on existing is EEXIST", mkdirat(dfd, "sub", 0700) < 0 && errno == EEXIST);
  CHECK("symlinkat", symlinkat("f2", dfd, "ln") == 0);
  CHECK("O_NOFOLLOW on a symlink is ELOOP", openat(dfd, "ln", O_RDONLY | O_NOFOLLOW) < 0 && errno == ELOOP);
  CHECK("O_CREAT|O_EXCL on a dangling symlink is EEXIST", symlinkat("nowhere", dfd, "dangle") == 0 && openat(dfd, "dangle", O_CREAT | O_EXCL | O_WRONLY, 0600) < 0 && errno == EEXIST);
  int t = open("d", O_TMPFILE | O_RDWR, 0600);
  CHECK("O_TMPFILE works or is unsupported", t >= 0 || errno == EOPNOTSUPP || errno == EISDIR || errno == ENOTSUP);
  if (t >= 0) close(t);

  // 3. realpath as musl does it, and getcwd
  char cwdbuf[PATH_MAX], link[64], real[PATH_MAX];
  CHECK("getcwd", getcwd(cwdbuf, sizeof cwdbuf) != NULL);
  int here = open(".", O_PATH | O_CLOEXEC);
  snprintf(link, sizeof link, "/proc/self/fd/%d", here);
  ssize_t n = readlink(link, real, sizeof real - 1);
  if (n >= 0) real[n] = 0;
  CHECK("readlink /proc/self/fd of O_PATH . is getcwd", n > 0 && !strcmp(real, cwdbuf));
  snprintf(link, sizeof link, "/proc/self/fd/%d", dfd);
  n = readlink(link, real, sizeof real - 1);
  if (n >= 0) real[n] = 0;
  char want[PATH_MAX + 16]; snprintf(want, sizeof want, "%s/d", cwdbuf);
  CHECK("readlink /proc/self/fd of a dirfd", n > 0 && !strcmp(real, want));
  char *rp = realpath("d/../d/f2", NULL);
  snprintf(want, sizeof want, "%s/d/f2", cwdbuf);
  CHECK("realpath", rp && !strcmp(rp, want));
  const char *dirs[] = { "/", "/home", "/home/user", "/tmp", priv, cwdbuf };
  for (int i = 0; i < 6; i++) {
    char name[PATH_MAX + 32]; snprintf(name, sizeof name, "%s is a real directory", dirs[i]);
    CHECK(name, lstat(dirs[i], &b) == 0 && S_ISDIR(b.st_mode));
  }
  // *at() relative to an O_PATH dirfd (Bun opens the parent O_PATH, then creates the temp file in it)
  int opd = open(cwdbuf, O_PATH | O_DIRECTORY | O_CLOEXEC);
  int tf = openat(opd, "atomic.tmp.1", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0644);
  CHECK("openat O_PATH dirfd O_CREAT|O_EXCL", tf >= 0 && write(tf, "x", 1) == 1 && close(tf) == 0);
  CHECK("renameat O_PATH dirfds (atomic replace)", renameat(opd, "atomic.tmp.1", opd, "atomic.txt") == 0 && fstatat(opd, "atomic.txt", &b, 0) == 0 && b.st_size == 1);
  CHECK("mkdirat O_PATH dirfd", mkdirat(opd, "pdir", 0700) == 0);
  CHECK("faccessat O_PATH dirfd", faccessat(opd, "atomic.txt", W_OK, 0) == 0);
  CHECK("fchmodat O_PATH dirfd", fchmodat(opd, "atomic.txt", 0600, 0) == 0 && stat("atomic.txt", &b) == 0 && (b.st_mode & 0777) == 0600);
  CHECK("utimensat O_PATH dirfd", utimensat(opd, "atomic.txt", NULL, 0) == 0);
  CHECK("unlinkat O_PATH dirfd", unlinkat(opd, "atomic.txt", 0) == 0 && unlinkat(opd, "pdir", AT_REMOVEDIR) == 0);
  CHECK("read through an O_PATH fd is EBADF", read(opd, real, 1) < 0 && errno == EBADF);

  // through a symlinked directory: the fd is the directory it resolves to
  CHECK("symlink to dir", symlink("d", "dl") == 0);
  struct stat dst; stat("d", &dst);
  int lfd = open("dl", O_RDONLY | O_DIRECTORY);
  CHECK("fstat of a dir opened through a symlink", lfd >= 0 && fstat(lfd, &b) == 0 && same(&b, &dst));
  int lpfd = open("dl", O_PATH);
  CHECK("fstat O_PATH through a symlink", lpfd >= 0 && fstat(lpfd, &b) == 0 && same(&b, &dst));
  snprintf(link, sizeof link, "/proc/self/fd/%d", lpfd);
  n = readlink(link, real, sizeof real - 1);
  if (n >= 0) real[n] = 0;
  snprintf(want, sizeof want, "%s/d", cwdbuf);
  CHECK("readlink /proc/self/fd of a dir opened through a symlink is the real path", n > 0 && !strcmp(real, want));
  CHECK("stat through a symlinked dir", stat("dl/f2", &b) == 0 && stat("d/f2", &c) == 0 && same(&b, &c));
  int lf = open("dl/f2", O_RDONLY);
  CHECK("fstat of a file opened through a symlinked dir", lf >= 0 && fstat(lf, &b) == 0 && same(&b, &c));
  CHECK("getdents through a symlinked dir", lfd >= 0 && dent_ino(lfd, "f2") == c.st_ino);
  CHECK("O_CREAT through a symlinked dir", openat(lfd, "viadl", O_CREAT | O_EXCL | O_WRONLY, 0600) >= 0 && stat("d/viadl", &b) == 0);
  printf("%d failed\n", fails);
  return fails ? 1 : 0;
}
