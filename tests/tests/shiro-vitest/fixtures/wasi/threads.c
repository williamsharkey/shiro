/* wasi-threads: spawn NT threads that each add 1 to a shared counter
 * ITER times with atomic RMW, then bump `done` and futex-wake the main
 * thread, which sleeps in memory.atomic.wait32 until all are done. */
#include "rt.h"
IMPORT("wasi", "thread-spawn") int thread_spawn(void *arg);

#define NT 4
#define ITER 10000
#define STACK 16384

static volatile int counter;
static volatile int done;
static u8 stacks[NT][STACK] __attribute__((aligned(16)));
struct start { void *stack_top; int idx; };
static struct start starts[NT];

/* called by wasi_thread_start (thread-start.s) after it set the stack */
void thread_main(int tid, struct start *s) {
  for (int i = 0; i < ITER; i++) __atomic_fetch_add(&counter, 1, __ATOMIC_SEQ_CST);
  __atomic_fetch_add(&done, 1, __ATOMIC_SEQ_CST);
  __builtin_wasm_memory_atomic_notify((int *)&done, 1);
}

void _start(void) {
  for (int i = 0; i < NT; i++) {
    starts[i].stack_top = stacks[i] + STACK;
    starts[i].idx = i;
    int tid = thread_spawn(&starts[i]);
    if (tid <= 0) { puts_fd(2, "thread-spawn failed\n"); proc_exit(1); }
  }
  for (;;) {
    int d = __atomic_load_n(&done, __ATOMIC_SEQ_CST);
    if (d == NT) break;
    __builtin_wasm_memory_atomic_wait32((int *)&done, d, -1);
  }
  puts_fd(1, "counter: "); put_u(1, (u32)counter); puts_fd(1, "\n");
  proc_exit(0);
}
