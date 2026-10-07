/* Fixture for x86-engine.test.ts. Build: musl-gcc -static -Os -s -o hello-musl hello.c */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  printf("hello from c\n");
  for (int i = 1; i < argc; i++) printf("arg%d=%s\n", i, argv[i]);
  const char *v = getenv("FIXTURE_VAR");
  printf("env=%s\n", v ? v : "(unset)");
  FILE *f = fopen("input.txt", "r");
  if (f) { char buf[128] = {0}; fgets(buf, sizeof buf, f); fclose(f); printf("read=%s", buf); }
  f = fopen("out-c.txt", "w");
  if (f) { fputs("written by c\n", f); fclose(f); }
  char line[128];
  if (fgets(line, sizeof line, stdin)) printf("stdin=%s", line);
  fprintf(stderr, "to stderr\n");
  return argc > 1 && !strcmp(argv[1], "fail") ? 7 : 0;
}
