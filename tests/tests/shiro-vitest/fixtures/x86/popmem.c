// pop to memory addressed through %rsp: the address is computed after the
// pop moves the stack pointer (V8's builtins: pop 0x88(%rsp))
#include <stdint.h>
#include <stdio.h>

int main(void) {
  uint64_t s[4], r[4];
  // stack: [rsp] = 0x11, [rsp+8] = 0x22, [rsp+16] = 0x33
  __asm__ volatile(
      "mov %%rsp, %%rbx\n\t"
      "lea 32(%1), %%rsp\n\t"  // a private stack in s[] (s[3] is the top)
      "pushq $0x33\n\t"
      "pushq $0x22\n\t"
      "pushq $0x11\n\t"
      "popq 0x8(%%rsp)\n\t"  // writes 0x11 over 0x33 (rsp+8 after the pop)
      "mov %%rsp, %%rax\n\t"
      "mov %%rbx, %%rsp\n\t"
      "sub %1, %%rax\n\t"
      "mov %%rax, %0\n\t"
      : "=r"(r[0]) : "r"(s) : "rax", "rbx", "memory");
  printf("pop 8(%%rsp): rsp at s+%llu, s[1..3] = %#llx %#llx %#llx\n", (unsigned long long)r[0],
         (unsigned long long)s[1], (unsigned long long)s[2], (unsigned long long)s[3]);
  __asm__ volatile(
      "mov %%rsp, %%rbx\n\t"
      "lea 32(%1), %%rsp\n\t"
      "pushq $0x66\n\t"
      "pushq $0x55\n\t"
      "popq (%%rsp)\n\t"  // writes 0x55 over 0x66
      "mov %%rbx, %%rsp\n\t"
      : : "r"(r), "r"(s) : "rbx", "memory");
  printf("pop (%%rsp): s[2..3] = %#llx %#llx\n", (unsigned long long)s[2], (unsigned long long)s[3]);
  uint16_t w[8] = {0};
  __asm__ volatile(
      "mov %%rsp, %%rbx\n\t"
      "lea 16(%0), %%rsp\n\t"
      "pushw $0x7777\n\t"
      "pushw $0x1234\n\t"
      "popw 0x2(%%rsp)\n\t"  // 16-bit: rsp+2 after the pop
      "mov %%rbx, %%rsp\n\t"
      : : "r"(w) : "rbx", "memory");
  printf("popw 2(%%rsp): w[6..7] = %#x %#x\n", w[6], w[7]);
  return 0;
}
