/* Prints its argv: stands in for the native claude binary, which runs as
 * ugrep/bfs/rg when started with that argv[0] (exec -a). For agent-shell.test.ts. */
#include <stdio.h>
int main(int argc, char **argv) {
  printf("argv0=%s", argv[0]);
  for (int i = 1; i < argc; i++) printf(" [%s]", argv[i]);
  printf("\n");
  return 0;
}
