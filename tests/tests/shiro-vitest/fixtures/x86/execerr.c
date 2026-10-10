/* Fixture for x86-engine.test.ts: execv(argv[1]) and report the errno
 * (ENOENT for a dynamic executable whose loader is missing, as on Linux). */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  execv(argv[1], argv + 1);
  printf("execv: errno %d (%s)\n", errno, errno == ENOENT ? "ENOENT" : strerror(errno));
  return 1;
}
