/*
 * agentprobe: what an agent CLI (Claude Code, Codex, ...) needs from the
 * OS, made with raw x86-64 Linux syscalls, as a static native binary makes
 * them. `doctor --agents` runs it under Blink: agentprobe DIR
 *
 * One line per check: "OK name detail" or "FAIL name errno=N NAME detail".
 * Freestanding (no libc): build with scripts/agent-probe/build.sh.
 */
typedef unsigned long u64;
typedef long i64;

static i64 sys(i64 n, i64 a, i64 b, i64 c, i64 d) {
  i64 r;
  register i64 r10 __asm__("r10") = d;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10) : "rcx", "r11", "memory");
  return r;
}
#define SYS_read 0
#define SYS_write 1
#define SYS_open 2
#define SYS_close 3
#define SYS_stat 4
#define SYS_fstat 5
#define SYS_lstat 6
#define SYS_dup2 33
#define SYS_fork 57
#define SYS_execve 59
#define SYS_exit 60
#define SYS_wait4 61
#define SYS_rename 82
#define SYS_mkdir 83
#define SYS_readlink 89
#define SYS_getuid 102
#define O_RDONLY 0
#define O_WRONLY 1
#define O_CREAT 0100
#define O_EXCL 0200
#define O_TRUNC 01000
#define O_DIRECTORY 0200000
#define O_PATH 010000000

struct kstat {
  u64 dev, ino, nlink;
  unsigned mode, uid, gid, pad0;
  u64 rdev; i64 size, blksize, blocks;
  u64 atime, atime_ns, mtime, mtime_ns, ctime, ctime_ns;
  i64 unused[3];
};

static u64 slen(const char *s) { u64 n = 0; while (s[n]) n++; return n; }
static int seq(const char *a, const char *b) { while (*a && *a == *b) a++, b++; return *a == *b; }
static char *scat(char *d, const char *s) { while (*s) *d++ = *s++; *d = 0; return d; }
static void out(const char *s) { sys(SYS_write, 1, (i64)s, slen(s), 0); }
static char *num(char *d, u64 v, int base) {
  char t[24]; int n = 0;
  do { t[n++] = "0123456789abcdef"[v % base]; v /= base; } while (v);
  while (n) *d++ = t[--n];
  *d = 0;
  return d;
}

static const char *ename(i64 e) {
  switch (e) {
    case 1: return "EPERM"; case 2: return "ENOENT"; case 5: return "EIO"; case 9: return "EBADF";
    case 12: return "ENOMEM"; case 13: return "EACCES"; case 14: return "EFAULT"; case 17: return "EEXIST";
    case 18: return "EXDEV"; case 20: return "ENOTDIR"; case 21: return "EISDIR"; case 22: return "EINVAL";
    case 28: return "ENOSPC"; case 30: return "EROFS"; case 36: return "ENAMETOOLONG"; case 38: return "ENOSYS";
    case 39: return "ENOTEMPTY"; case 40: return "ELOOP"; case 95: return "EOPNOTSUPP";
    default: return "E?";
  }
}

static char line[1024];
static void ok(const char *name, const char *detail) {
  char *p = scat(line, "OK "); p = scat(p, name); p = scat(p, " "); p = scat(p, detail); scat(p, "\n");
  out(line);
}
/** r < 0: FAIL with its errno; else FAIL with no errno */
static int fail(const char *name, i64 r, const char *detail) {
  char *p = scat(line, "FAIL "); p = scat(p, name);
  if (r < 0) { p = scat(p, " errno="); p = num(p, -r, 10); p = scat(p, " "); p = scat(p, ename(-r)); }
  p = scat(p, " "); p = scat(p, detail); scat(p, "\n");
  out(line);
  return 1;
}

static char base[512], deep[600], tmp[700], target[700], outf[700], buf[700];

static int check_mkdir(void) {
  /* mkdir -p BASE/a/b/c, 0700 each */
  char *p = scat(deep, base); scat(p, "/a/b/c");
  for (char *q = deep + 1; ; q++) {
    if (*q == '/' || *q == 0) {
      char c = *q; *q = 0;
      i64 r = sys(SYS_mkdir, (i64)deep, 0700, 0, 0);
      *q = c;
      if (r < 0 && r != -17) { *q = 0; fail("mkdir", r, deep); return 2; }
      if (!c) break;
    }
  }
  struct kstat st;
  i64 r = sys(SYS_stat, (i64)deep, (i64)&st, 0, 0);
  if (r < 0) { fail("mkdir", r, "stat of the new directory"); return 2; }
  i64 uid = sys(SYS_getuid, 0, 0, 0, 0);
  char *d = scat(buf, "mode "); d = num(d, st.mode & 07777, 8); d = scat(d, " uid "); d = num(d, st.uid, 10);
  d = scat(d, " (getuid "); d = num(d, uid, 10); scat(d, ")");
  if ((st.mode & 0170000) != 0040000 || (st.mode & 0777) != 0700 || st.uid != (u64)uid) return fail("mkdir", 0, buf);
  ok("mkdir", buf);
  return 0;
}

static int check_atomic_write(void) {
  char *p = scat(tmp, deep); scat(p, "/.target.tmp");
  p = scat(target, deep); scat(p, "/target");
  i64 fd = sys(SYS_open, (i64)tmp, O_WRONLY | O_CREAT | O_EXCL, 0600, 0);
  if (fd < 0) return fail("atomic-write", fd, "open(O_CREAT|O_EXCL)");
  if (sys(SYS_write, fd, (i64)"data\n", 5, 0) != 5) return fail("atomic-write", 0, "write");
  sys(SYS_close, fd, 0, 0, 0);
  i64 again = sys(SYS_open, (i64)tmp, O_WRONLY | O_CREAT | O_EXCL, 0600, 0);
  if (again >= 0) { sys(SYS_close, again, 0, 0, 0); return fail("atomic-write", 0, "a second O_EXCL open succeeded"); }
  if (again != -17) return fail("atomic-write", again, "a second O_EXCL open (expected EEXIST)");
  i64 r = sys(SYS_rename, (i64)tmp, (i64)target, 0, 0);
  if (r < 0) return fail("atomic-write", r, "rename over the target");
  struct kstat st;
  if (sys(SYS_stat, (i64)tmp, (i64)&st, 0, 0) != -2) return fail("atomic-write", 0, "the temp file still exists after rename");
  fd = sys(SYS_open, (i64)target, O_RDONLY, 0, 0);
  if (fd < 0) return fail("atomic-write", fd, "open the target");
  char b[16];
  i64 n = sys(SYS_read, fd, (i64)b, sizeof b, 0);
  sys(SYS_close, fd, 0, 0, 0);
  if (n != 5 || b[0] != 'd' || b[4] != '\n') return fail("atomic-write", n < 0 ? n : 0, "the target's contents");
  ok("atomic-write", "O_CREAT|O_EXCL, EEXIST again, rename over the target");
  return 0;
}

static int check_stat(void) {
  struct kstat a, b, c;
  i64 r = sys(SYS_stat, (i64)target, (i64)&a, 0, 0);
  if (r < 0) return fail("stat", r, "stat");
  r = sys(SYS_lstat, (i64)target, (i64)&b, 0, 0);
  if (r < 0) return fail("stat", r, "lstat");
  i64 fd = sys(SYS_open, (i64)target, O_RDONLY, 0, 0);
  if (fd < 0) return fail("stat", fd, "open");
  r = sys(SYS_fstat, fd, (i64)&c, 0, 0);
  sys(SYS_close, fd, 0, 0, 0);
  if (r < 0) return fail("stat", r, "fstat");
  char *d = scat(buf, "dev:ino ");
  d = num(d, a.dev, 10); d = scat(d, ":"); d = num(d, a.ino, 10);
  if (a.dev != b.dev || a.ino != b.ino || a.dev != c.dev || a.ino != c.ino) {
    d = scat(d, " lstat "); d = num(d, b.dev, 10); d = scat(d, ":"); d = num(d, b.ino, 10);
    d = scat(d, " fstat "); d = num(d, c.dev, 10); d = scat(d, ":"); num(d, c.ino, 10);
    return fail("stat", 0, buf);
  }
  scat(d, " (stat, lstat, fstat agree)");
  ok("stat", buf);
  return 0;
}

static int check_realpath(void) {
  /* what musl's and glibc's realpath() do: O_PATH, then /proc/self/fd/N */
  i64 fd = sys(SYS_open, (i64)deep, O_PATH | O_DIRECTORY, 0, 0);
  if (fd < 0) return fail("realpath", fd, "open(O_PATH)");
  char link[32]; char *p = scat(link, "/proc/self/fd/"); num(p, fd, 10);
  char got[600];
  i64 n = sys(SYS_readlink, (i64)link, (i64)got, sizeof got - 1, 0);
  sys(SYS_close, fd, 0, 0, 0);
  if (n < 0) return fail("realpath", n, "readlink /proc/self/fd/N");
  got[n] = 0;
  if (!seq(got, deep)) { char *d = scat(buf, got); d = scat(d, " != "); scat(d, deep); return fail("realpath", 0, buf); }
  ok("realpath", deep);
  return 0;
}

static int check_child(char **envp) {
  char *p = scat(outf, deep); scat(p, "/child.out");
  i64 pid = sys(SYS_fork, 0, 0, 0, 0);
  if (pid < 0) return fail("child", pid, "fork");
  if (pid == 0) {
    i64 fd = sys(SYS_open, (i64)outf, O_WRONLY | O_CREAT | O_TRUNC, 0600, 0);
    if (fd < 0) sys(SYS_exit, 120, 0, 0, 0);
    sys(SYS_dup2, fd, 1, 0, 0);
    char *argv[] = { "sh", "-c", "echo hi", 0 };
    i64 r = sys(SYS_execve, (i64)"/bin/sh", (i64)argv, (i64)envp, 0);
    sys(SYS_exit, r == -2 ? 127 : 126, 0, 0, 0);
  }
  int status = 0;
  i64 r = sys(SYS_wait4, pid, (i64)&status, 0, 0);
  if (r < 0) return fail("child", r, "wait4");
  if ((status & 0x7f) != 0 || ((status >> 8) & 0xff) != 0) {
    char *d = scat(buf, "sh -c 'echo hi' exited, wait status 0x"); num(d, status, 16);
    return fail("child", 0, buf);
  }
  i64 fd = sys(SYS_open, (i64)outf, O_RDONLY, 0, 0);
  if (fd < 0) return fail("child", fd, "open the output file");
  char b[16];
  i64 n = sys(SYS_read, fd, (i64)b, sizeof b, 0);
  sys(SYS_close, fd, 0, 0, 0);
  if (n != 3 || b[0] != 'h' || b[1] != 'i' || b[2] != '\n') return fail("child", n < 0 ? n : 0, "the output file doesn't hold \"hi\"");
  ok("child", "fork, execve /bin/sh -c 'echo hi' > file, wait4");
  return 0;
}

int main(int argc, char **argv, char **envp) {
  if (argc < 2 || argv[1][0] != '/') { out("usage: agentprobe /ABSOLUTE/SCRATCH/DIR\n"); return 2; }
  scat(base, argv[1]);
  int bad = check_mkdir();
  if (bad == 2) return 1; /* the rest need the directory (a wrong mode or owner doesn't stop them) */
  int aw = check_atomic_write();
  bad += aw;
  bad += aw ? 0 : check_stat();
  bad += check_realpath();
  bad += check_child(envp);
  return bad ? 1 : 0;
}

__attribute__((naked, noreturn)) void _start(void) {
  __asm__ volatile(
    "xor %rbp, %rbp\n"
    "mov (%rsp), %rdi\n"        /* argc */
    "lea 8(%rsp), %rsi\n"       /* argv */
    "lea 16(%rsp,%rdi,8), %rdx\n" /* envp */
    "and $-16, %rsp\n"
    "call main\n"
    "mov %eax, %edi\n"
    "mov $60, %eax\n"
    "syscall\n");
}
