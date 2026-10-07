# Kernel ABI (shared contract for the Unix-compat workstreams)

Several branches build parts of the kernel described in
[UNIX_COMPAT.md](UNIX_COMPAT.md) in parallel. This file is the contract they
share. Change it only in the `unix/kernel` branch, and then tell the other
workstreams. Everything else should compile against these names.

## Layout

```
src/kernel/
  abi.ts        syscall numbers, errno, flags, struct layouts (shared by kernel and guest side)
  kernel.ts     Kernel singleton: process table, scheduler glue, syscall dispatch
  process.ts    Process: pid, ppid, pgid, sid, cwd, env, umask, fd table, signal state
  fd.ts         OpenFile objects + FdTable (dup/dup2/cloexec/refcounts)
  pipe.ts       Pipe (bounded ring buffer, blocking reader/writer wait queues)
  pty.ts        Pty master/slave pair, termios, line discipline   (unix/pty)
  signals.ts    signal numbers, dispositions, delivery, job control (unix/pty)
  net.ts        socket OpenFile backed by the TCP relay            (unix/net)
  channel.ts    SAB syscall channel (worker side + kernel side) and the JSPI fallback
  worker-host.ts  starts a guest Worker and wires it to a Process
```

## Core types (`abi.ts`, `fd.ts`, `process.ts`)

Errors are returned as negative Linux errno numbers (`-ENOENT` = -2), the
same convention `src/x86/syscalls.ts` already uses. WASI shims translate.

```ts
interface OpenFile {                 // one open file description (shared by dup'd fds)
  kind: 'file' | 'dir' | 'pipe' | 'pty' | 'socket' | 'dev';
  flags: number;                     // O_* (O_NONBLOCK, O_APPEND, ...)
  read(buf: Uint8Array): Promise<number>;    // bytes read, 0 = EOF, or -errno; blocks unless O_NONBLOCK (-EAGAIN)
  write(buf: Uint8Array): Promise<number>;
  poll(events: number): number;              // POLLIN/POLLOUT/POLLHUP/POLLERR currently ready
  onReady(cb: () => void): () => void;       // wake-up for poll/epoll waiters; returns unsubscribe
  ioctl?(req: number, arg: Uint8Array): Promise<number>;
  seek?(off: number, whence: number): number;
  stat(): Promise<KStat>;
  close(): Promise<void>;                    // called when the last fd referencing it closes
}
class FdTable { get(fd); alloc(file, minFd = 0, cloexec = false); dup(fd); dup2(a, b); close(fd); fork(); closeOnExec(); }
class Process { pid; ppid; pgid; sid; cwd; env; argv; umask; fds: FdTable; exitStatus?; wait(): Promise<number>; }
```

`kernel.spawn({ path, argv, env, cwd, fds })` creates a process with an
explicit fd map (`fds: { 0: OpenFile, 1: OpenFile, 2: OpenFile, ... }`) and
returns the `Process`. `kernel.waitpid(pid, options)` and
`kernel.kill(pid | -pgid, sig)` complete the lifecycle. Exit status uses
the Linux wait encoding (`code << 8`, or the signal number).

## Syscall channel (`channel.ts`)

Guests run in Workers. Each worker gets one `SharedArrayBuffer`:

```
Int32 [0]  state: 0 idle, 1 request posted, 2 reply ready
Int32 [1]  syscall number (abi.ts SYS_*)
Int32 [2]  reply: result (or -errno)
Int32 [3]  pending-signal flag (kernel sets; guest checks after every reply)
Int32 [4..15] args (int32; 64-bit values use two slots, lo then hi)
bytes [64..]  data area (paths, read/write buffers), size fixed at creation (default 1 MiB)
```

The guest writes args and data, sets state=1, `postMessage('sys')` (or
`Atomics.notify` when the kernel lives in a worker), then
`Atomics.wait(state, 1)`. The kernel performs the async operation, writes
the reply, sets state=2 and notifies. Transfers larger than the data area
are split by the guest-side library, never by the kernel.

When `crossOriginIsolated` is false (no SAB), WASM guests run on the main
thread with JSPI (`WebAssembly.Suspending` / `WebAssembly.promising`) and
call the same kernel functions directly. Same ABI, different transport.
`channel.ts` exports `canBlock(): 'sab' | 'jspi' | 'none'`.

## Integration with the existing shell

Existing builtins stay in-page. Until the shell itself is ported, the
kernel exposes `kernel.runBuiltin(ctx)` adapters: a builtin's
`ctx.stdin`/`ctx.stdout` strings are bridged to fds 0/1/2 of a kernel
process. That way a guest's `posix_spawn("ls")` runs Shiro's `ls`, and
`cat | wasm-program | grep` streams through real pipes.

## Tests

vitest under `tests/tests/shiro-vitest/kernel-*.test.ts`. Node worker
threads provide SAB, so the channel can be tested headless. Each
workstream adds its own `kernel-<area>.test.ts`.
