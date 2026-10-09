/* Fixture for x86-engine.test.ts: prints argv[0] (through a symlink, the link's name, as Linux).
   Built by the test: gcc -static -nostdlib -fno-builtin -Os -fno-pie -no-pie */
static long sys3(long n, long a, long b, long c) {
  long r; __asm__ volatile ("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
  return r;
}
static void put(const char *s) { long n = 0; while (s[n]) n++; sys3(1, 1, (long)s, n); }
__attribute__((noreturn)) void cmain(long *sp) {
  char **argv = (char **)(sp + 1);
  put("argv0="); put(argv[0]); put("\n");
  sys3(60, 0, 0, 0);
  for (;;) {}
}
__asm__(".global _start\n_start:\n mov %rsp, %rdi\n and $-16, %rsp\n call cmain\n");
