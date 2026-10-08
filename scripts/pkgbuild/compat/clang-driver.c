/*
 * clang / clang++ / cc / c++ for Shiro's llvm package.
 *
 * LLVM built for WASI (llvm.wasm, a multi-call binary) can't start
 * processes, so its clang driver can only print what it would run. This
 * wrapper asks it (`clang -### ...`), then runs each step (cc1, wasm-ld)
 * as its own kernel process through posix_spawn (compat/wasi-proc.c), the
 * way YoWASP's JavaScript wrapper does in one process. It also points the
 * driver at the package's sysroot and resource directory.
 */
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define ROOT "/usr/lib/pkg/llvm"
#define SYSROOT ROOT "/sysroot"

extern char **environ;

static const char *llvm_path(void) {
  const char *p = getenv("SHIRO_LLVM_WASM");
  return p && *p ? p : ROOT "/bin/llvm.wasm";
}

static int run(char **argv, int capture_fd, char **out, size_t *outlen) {
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  int fds[2] = { -1, -1 };
  if (capture_fd >= 0) {
    if (pipe(fds) < 0) { perror("clang: pipe"); return 127; }
    posix_spawn_file_actions_adddup2(&fa, fds[1], capture_fd);
    posix_spawn_file_actions_addclose(&fa, fds[0]);
  }
  pid_t pid;
  int e = posix_spawn(&pid, llvm_path(), &fa, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&fa);
  if (capture_fd >= 0) close(fds[1]);
  if (e) {
    fprintf(stderr, "clang: cannot run %s: %s\n", llvm_path(), strerror(e));
    if (capture_fd >= 0) close(fds[0]);
    return 127;
  }
  if (capture_fd >= 0) {
    size_t cap = 4096, n = 0;
    char *buf = malloc(cap);
    for (;;) {
      if (n + 1024 > cap) buf = realloc(buf, cap *= 2);
      ssize_t r = read(fds[0], buf + n, cap - n - 1);
      if (r < 0 && errno == EINTR) continue;
      if (r <= 0) break;
      n += (size_t)r;
    }
    buf[n] = 0;
    close(fds[0]);
    *out = buf; *outlen = n;
  }
  int st = 0;
  while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {}
  return WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
}

/* One ` "arg" "arg"...` line of -### output -> argv (NULL-terminated), with
   a free slot before it for the multi-call name. */
static char **parse_line(const char *line) {
  size_t cap = 16, n = 1;
  char **v = malloc(cap * sizeof *v);
  const char *p = line;
  while (*p) {
    while (*p == ' ') p++;
    if (!*p) break;
    char *a = malloc(strlen(p) + 1), *q = a;
    if (*p == '"') {
      p++;
      while (*p && *p != '"') {
        if (*p == '\\' && (p[1] == '"' || p[1] == '\\' || p[1] == '$')) p++;
        *q++ = *p++;
      }
      if (*p == '"') p++;
    } else {
      while (*p && *p != ' ') *q++ = *p++;
    }
    *q = 0;
    if (n + 2 > cap) v = realloc(v, (cap *= 2) * sizeof *v);
    v[n++] = a;
  }
  v[n] = NULL;
  return v + 1;
}

static int has(int argc, char **argv, const char *s) {
  for (int i = 1; i < argc; i++) if (strcmp(argv[i], s) == 0) return 1;
  return 0;
}

static int has_prefix(int argc, char **argv, const char *s) {
  for (int i = 1; i < argc; i++) if (strncmp(argv[i], s, strlen(s)) == 0) return 1;
  return 0;
}

int main(int argc, char **argv) {
  const char *base = strrchr(argv[0], '/') ? strrchr(argv[0], '/') + 1 : argv[0];
  const char *tool = strstr(base, "++") ? "clang++" : "clang";

  /* clang <our flags> <the user's> */
  char **args = calloc((size_t)argc + 8, sizeof *args);
  int n = 0;
  args[n++] = (char *)tool;
  if (!has_prefix(argc, argv, "--sysroot")) args[n++] = "--sysroot=" SYSROOT;
  if (!has_prefix(argc, argv, "-resource-dir")) args[n++] = "-resource-dir=" SYSROOT;
  int first_user = n;
  for (int i = 1; i < argc; i++) args[n++] = argv[i];
  args[n] = NULL;

  /* Things the driver does itself, without running steps */
  if (argc == 1 || has(argc, argv, "-###") || has(argc, argv, "--version") || has(argc, argv, "-dumpmachine") ||
      has(argc, argv, "-dumpversion") || has(argc, argv, "--help") || has(argc, argv, "-help") ||
      has_prefix(argc, argv, "-print-") || has_prefix(argc, argv, "--print-")) {
    char *dummy; size_t dl;
    (void)dummy; (void)dl;
    return run(args, -1, NULL, NULL);
  }

  /* clang -### ... : the steps, on stderr */
  char **hash = calloc((size_t)n + 2, sizeof *hash);
  for (int i = 0, j = 0; i < n; i++) {
    hash[j++] = args[i];
    if (i == first_user - 1) hash[j++] = "-###";
  }
  char *out = NULL;
  size_t outlen = 0;
  int code = run(hash, 2, &out, &outlen);
  if (code != 0 || !out) {
    if (out) fwrite(out, 1, outlen, stderr);
    return code ? code : 1;
  }

  /* Header lines (clang version, Target, ...), then one quoted line per
     step (" (in-process)" marks cc1 run in-process), then the end. */
  char **steps[64];
  int nsteps = 0, state = 0;
  char *save = NULL;
  for (char *line = strtok_r(out, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
    if (state == 0 && !(strncmp(line, "clang", 5) == 0 || strncmp(line, "Target:", 7) == 0 ||
                        strncmp(line, "Thread model:", 13) == 0 || strncmp(line, "InstalledDir:", 13) == 0 ||
                        strncmp(line, "Build config:", 13) == 0))
      state = 1;
    if (state == 1) {
      if (strcmp(line, " (in-process)") == 0) continue;
      if (strncmp(line, " \"", 2) == 0 && nsteps < 64) { steps[nsteps++] = parse_line(line); continue; }
      state = 2;
      fprintf(stderr, "%s\n", line); /* a warning or error from the driver */
    }
  }
  if (has(argc, argv, "-v")) {
    /* -v: show the steps like clang does */
    for (int i = 0; i < nsteps; i++) {
      for (char **a = steps[i]; *a; a++) fprintf(stderr, "%s\"%s\"", a == steps[i] ? " " : " ", *a);
      fputc('\n', stderr);
    }
  }
  for (int i = 0; i < nsteps; i++) {
    /* Multi-call style, as `yowasp-llvm TOOL args...` (YoWASP's argv[0]): "" "clang" "-cc1" ... is the
       driver re-running itself as cc1, "wasm-ld" ... the linker */
    char **a = steps[i];
    /* the executable ("" or a path) before "clang" "-cc1" */
    if (a[0] && a[1] && a[2] && strncmp(a[2], "-cc1", 4) == 0) a++;
    else if (a[0] && a[0][0] == 0) a++;
    if (!a[0]) continue;
    const char *t = strrchr(a[0], '/') ? strrchr(a[0], '/') + 1 : a[0];
    a[0] = (char *)t;
    a--;
    a[0] = "yowasp-llvm";
    int c = run(a, -1, NULL, NULL);
    if (c != 0) return c;
  }
  return 0;
}
