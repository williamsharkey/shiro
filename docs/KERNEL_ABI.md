# Kernel ABI (shared contract for the Unix-compat workstreams)

## Changelog

All changes so far are additive; nothing below renames or removes an earlier name.

- **2026-10-07 (unix/kernel, first implementation)**
  - `OpenFile.read/write(buf, signal?)`: optional `AbortSignal`; an abort ends a
    blocked call with `-EINTR`. The kernel passes `proc.syscallSignal`, which
    signal delivery aborts.
  - Optional `OpenFile` members: `readdir()` (dir streams), `truncate(len)`,
    `sync()`, `path`.
  - Reference counting is explicit: `retain(file)` / `release(file)` in
    `fd.ts`. `FdTable` retains every fd it installs; `OpenFile.close()` runs
    once, when the last reference goes. Code that hands an OpenFile to
    `kernel.spawn` gives it to the child: don't call `close()` on it yourself.
  - 64-bit results (lseek): low word in Int32[2], high word in Int32[4]
    (`args[0]`), which the kernel overwrites on every reply.
  - Shiro syscalls: `SYS_spawn = 1000` (posix_spawn, JSON request),
    `SYS_getenv = 1001` (argv/env/cwd/pid as JSON). Argument conventions for
    every syscall are in the table below.
  - Host API: `Runner`, `Loader` (`kernel.addLoader`), `DeviceOpener`
    (`kernel.registerDevice(path, opener)`; pty.ts registers `/dev/ptmx`, net.ts
    can register its own), `Process.signalHook` and `Process.dispositions`
    (signals.ts), `Process.ctty` (pty.ts), `kernel.deliver(proc, sig)`.
  - Worker start message `{ type: 'shiro-start', sab, pid, argv, env, cwd, ...startData }`;
    guests post the string `'sys'` per request.

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

### Syscall arguments

Numbers and errno are Linux x86-64 (`abi.ts`). Pointers become offsets into
the data area: an input string or buffer always starts at data offset 0
(two strings: back to back, lengths in args), and output goes to data
offset 0. Lengths are bytes, without a trailing NUL.

| syscall | args | data in → out | result |
|---|---|---|---|
| read | fd, len | → bytes | n, 0 = EOF |
| write | fd, len | bytes → | n |
| open | pathLen, flags, mode | path | fd |
| openat | dirfd, pathLen, flags, mode | path | fd |
| close / dup / fsync | fd | | 0 / fd |
| dup2 / dup3 | old, new (, flags) | | new |
| stat / lstat | pathLen | path → struct stat (144 B, x86-64 layout) | 0 |
| fstat | fd | → struct stat | 0 |
| lseek | fd, offLo, offHi, whence | | offset (64-bit, see above) |
| ftruncate | fd, lenLo, lenHi | | 0 |
| ioctl | fd, req, argLen | arg ↔ arg | per req |
| pipe / pipe2 | (flags) | → int32 rfd, wfd | 0 |
| poll | nfds, timeoutMs (-1 = forever) | struct pollfd[] ↔ revents | ready count |
| fcntl | fd, cmd, arg | | per cmd (DUPFD, GETFD/SETFD, GETFL/SETFL) |
| nanosleep | sec, nsec | | 0 / -EINTR |
| wait4 | pid, options | → int32 status | pid, 0 (WNOHANG) |
| kill | pid, sig | | 0 |
| getpid/getppid/getpgrp/getuid/getgid/setsid | | | id |
| getpgid / getsid | pid (0 = self) | | id |
| setpgid | pid, pgid | | 0 |
| exit / exit_group | code | | does not return |
| getcwd | size | → cwd + NUL | length incl. NUL |
| chdir / mkdir / rmdir / unlink | pathLen (, mode) | path | 0 |
| rename | oldLen, newLen | old, new | 0 |
| readlink | pathLen, bufsiz | path → target | length |
| umask | mask | | old mask |
| getdents64 | fd, count | → linux_dirent64 records | bytes, 0 = end |
| spawn (1000) | jsonLen | `{path, argv, env?, cwd?, fds?: [[child, parent]…], pgid?, setsid?}` | pid, -ENOENT if nothing can run `path` |
| getenv (1001) | | → `{argv, env, cwd, pid}` JSON | length |

`GuestSys` in `channel.ts` wraps all of these for JS guests.

## Host API (page side)

```ts
const k = getKernel();                    // main.ts attaches fs + shell at boot
const p = k.spawn({ path: 'ls', argv: ['ls', '-l'], fds: { 0: r, 1: w, 2: err } });
await p.wait();                           // wait status; or k.waitpid(p.pid)
k.addLoader((path, proc, k) => isWasm(path) ? wasiRunner : null);
startWorker(k, proc => webWorker(new Worker(url)), { path, argv, fds });
k.syscall(proc, SYS_read, [fd, n], dataView);   // same dispatcher for every transport
```

Programs resolve through loaders (newest first). The last loader is the
builtin loader: a registered Shiro command (bare name, or under `/bin`,
`/usr/bin`, ...) runs through `runBuiltin`; any other executable the shell
can find (scripts, node programs) runs through a forked shell. Nothing found:
the child writes `NAME: command not found` and exits 127 (`SYS_spawn`
checks first and returns -ENOENT).

Kernel processes take pids from `processTable` and appear in its `list()`,
so `ps`, `kill`, `pgrep` and `top` see them. A child of init (pid 1, the page)
that nobody waits for is reaped 30 s after it exits.

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
