/* spawn CMD [ARGS...]: run CMD with WASIX proc_spawn3, its stdout on a
 * pipe from fd_pipe; print each chunk as "child: ..." and finally
 * "status: N" from proc_join. */
#include "rt.h"
typedef struct {
  u8 cmd; u32 fd; u32 src_fd; u32 name; u32 name_len; u32 dirflags; u16 oflags;
  u64 rights_base; u64 rights_inh; u16 fdflags; u16 fdflagsext;
} fd_op; /* 56 bytes, matches wasix ProcSpawnFdOp<Memory32> */
typedef struct { u8 tag; u32 pid; } option_pid;
typedef struct { u8 tag; u16 code; u8 sig; } join_status;

IMPORT("wasix_32v1", "fd_pipe") u16 fd_pipe(int *r, int *w);
IMPORT("wasix_32v1", "proc_spawn3") u16 proc_spawn3(const char *name, size_t name_len,
  char **args, size_t nargs, char **envs, size_t nenvs, const fd_op *ops, size_t nops,
  const void *sig, size_t nsig, u32 search_path, const char *path, size_t path_len, u32 *pid);
IMPORT("wasix_32v1", "proc_join") u16 proc_join(option_pid *pid, u32 flags, join_status *st);

void _start(void) {
  int argc = get_args();
  if (argc < 2) proc_exit(2);
  int r, w;
  if (fd_pipe(&r, &w)) proc_exit(3);
  fd_op ops[3];
  memset(ops, 0, sizeof ops);
  ops[0].cmd = 1; ops[0].fd = 1; ops[0].src_fd = w;   /* dup2(w, 1) */
  ops[1].cmd = 0; ops[1].fd = w;                      /* close(w) */
  ops[2].cmd = 0; ops[2].fd = r;                      /* close(r) */
  u32 pid = 0;
  u16 e = proc_spawn3(argvv[1], slen(argvv[1]), argvv + 1, argc - 1, 0, 0, ops, 3, 0, 0, 1, 0, 0, &pid);
  if (e) { puts_fd(2, "spawn failed: "); put_u(2, e); puts_fd(2, "\n"); proc_exit(4); }
  fd_close(w);
  char buf[1024];
  for (;;) {
    int n = readb(r, buf, sizeof buf);
    if (n <= 0) break;
    puts_fd(1, "child: ");
    writeb(1, buf, n);
  }
  option_pid op = { 1, pid };
  join_status st;
  if (proc_join(&op, 0, &st)) proc_exit(5);
  puts_fd(1, "status: "); put_u(1, st.tag == 1 ? st.code : 128 + st.sig); puts_fd(1, "\n");
  proc_exit(0);
}
