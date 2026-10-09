/* Fixture for x86-engine.test.ts: lchown and fchownat(AT_SYMLINK_NOFOLLOW)
   act on a symlink itself (dpkg lchowns NAME.dpkg-new links before their
   targets exist). Build: gcc -static -O1 -o lchown lchown.c */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
static void show(const char *what, int r) { printf("%s=%d %s\n", what, r, r ? strerror(errno) : ""); }
int main(void) {
  unlink("/tmp/dangling");
  (void)!symlink("/nonexistent-target", "/tmp/dangling");
  show("lchown(dangling)", lchown("/tmp/dangling", 0, 0));
  show("fchownat(dangling, NOFOLLOW)", fchownat(AT_FDCWD, "/tmp/dangling", 0, 0, AT_SYMLINK_NOFOLLOW));
  show("chown(dangling)", chown("/tmp/dangling", 0, 0));
  show("fchownat(dangling)", fchownat(AT_FDCWD, "/tmp/dangling", 0, 0, 0));
  show("lchown(missing)", lchown("/tmp/missing-entirely", 0, 0));
  show("fchownat(missing)", fchownat(AT_FDCWD, "/tmp/missing-entirely", 0, 0, 0));
  int fd = open("/tmp", O_RDONLY | O_DIRECTORY);
  show("fchownat(dirfd, dangling, NOFOLLOW)", fchownat(fd, "dangling", 0, 0, AT_SYMLINK_NOFOLLOW));
  show("fchownat(fd, \"\", EMPTY_PATH)", fchownat(fd, "", 0, 0, AT_EMPTY_PATH));
  unlink("/tmp/dangling");
  return 0;
}
