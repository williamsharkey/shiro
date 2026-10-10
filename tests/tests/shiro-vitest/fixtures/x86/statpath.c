/* Path lookup errors for the stat family, as Linux gives them (LTP lstat02,
 * stat03): EACCES for a directory without search permission, ENOENT for "",
 * ENAMETOOLONG, ENOTDIR through a file, ELOOP past 40 symlinks. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void t(const char *what, const char *p) {
  struct stat st;
  int a = lstat(p, &st), ea = errno;
  int b = stat(p, &st), eb = errno;
  printf("%s lstat %s stat %s\n", what, a ? strerror(ea) : "ok", b ? strerror(eb) : "ok");
}

int main(void) {
  static char lng[PATH_MAX + 2], loop[16 * 45], ok[16 * 45];
  mkdir("sp", 0777);
  if (chdir("sp")) return 1;
  mkdir("dir", 0777);
  close(creat("dir/file", 0777));
  close(creat("file", 0777));
  chmod("dir", 0666);
  mkdir("lp", 0777);
  if (symlink("../lp", "lp/lp")) perror("symlink");
  memset(lng, 'a', PATH_MAX + 1);
  strcpy(loop, ".");
  for (int i = 0; i < 43; i++) strcat(loop, "/lp");
  strcpy(ok, ".");
  for (int i = 0; i < 30; i++) strcat(ok, "/lp");
  t("eacces", "dir/file");
  t("enoent", "");
  t("enametoolong", lng);
  t("enotdir", "file/x");
  t("eloop", loop);
  t("ok-30", ok); /* 30 hops: fine */
  chmod("dir", 0777);
  return 0;
}
