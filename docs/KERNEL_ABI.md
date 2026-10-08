# Kernel ABI (shared contract for the Unix-compat workstreams)

## Changelog

All changes so far are additive; nothing below renames or removes an earlier name.

- **2026-10-08 (unix/wasix)** (additive)
  - **Fix:** renaming or unlinking a file that is still open. Open
    descriptions share an `Inode` that writes back to its path; after a
    rename it wrote to the old path (recreating the temp file and leaving the
    new one short: clang's object files came out empty), and after an unlink
    it brought the file back. `fd.ts` exports `renameInodes(fs, from, to)`
    (flush, then re-key) and `unlinkInode(fs, path)`; kernel.ts's
    rename/unlink call them. Code that renames through the FileSystem API
    directly should do the same.
  - `netStackOf(kernel)` (net.ts): the NetStack `installNet` gave a kernel.
  - Shiro syscalls 1101–1104 (`src/wasi/abi.ts`, registered by `host.ts`):
    `SYS_wasix_fork`, `SYS_wasix_exec`, `SYS_wasix_signal`,
    `SYS_wasix_resolve`. A stat/access of a missing `/bin`, `/usr/bin`,
    `/usr/local/bin`... entry named after a Shiro command reports an
    executable file (`binCommandStat`).
  - `FileSystem.writeFile` stores a compact copy of a typed-array view
    (IndexedDB cloned the whole underlying buffer).

- **2026-10-08 (unix/compat-tools)**
  - **New syscalls:** `SYS_shiro_vfork` (1010) creates a child process with
    nothing running in it (fd table forked, signal state copied); the
    caller's engine then issues the child's syscalls on its behalf (Blink's
    pool channels name it with `as`) until `SYS_shiro_execve` (1011) or
    `exit_group` for it. `SYS_shiro_execve` takes JSON `{path, argv, env:
    ["K=V"], inproc?}`: it does the exec bookkeeping (close-on-exec fds,
    argv/env, caught signals reset), then starts the program in a vfork
    child, returns the resolved path of an ELF for `inproc` engines, or
    stops the caller's runner and runs the new program in the same process
    (`Process.stopRunner()`, `proc.data.execRunner`). `/bin/NAME` paths of
    Shiro commands exec even though no file exists.
  - Also: `eventfd`/`eventfd2` (`EventFile` in fd.ts), `close_range`,
    `geteuid`/`getegid`, and `WNOWAIT` for `wait4` (report without reaping).

- **2026-10-08 (unix/kernel, round 2)**
  - **Fix:** `Kernel.syscall` (and the guest library) decoded paths and
    spawn JSON with `TextDecoder` straight from the SharedArrayBuffer data
    area. Browsers throw on that (Node doesn't), so every path syscall from a
    Worker failed with EIO in a real browser. Both sides now decode copies.
    **Rule:** a buffer handed to a syscall handler or to `OpenFile.read/
    write/ioctl` may be a view of shared memory, valid only during the call:
    copy what you keep (`buf.slice()`), and decode with `decodeText()` from
    `abi.ts`, never `TextDecoder.decode(view)`. `kernel-core.test.ts` makes
    `TextDecoder` throw on shared input, on the kernel side and in the guest
    worker, to hold every path to this. (unix/wasi can drop
    `CopyingKernelChannel`.)
  - **Syscall registry:** `kernel.registerSyscalls(nrs | {lo, hi}, handler)`.
    Handlers run before the kernel's own (newest first); returning
    `undefined` passes the call on. net.ts registers `SOCKET_SYSCALLS`:
    `kernel.registerSyscalls(SOCKET_SYSCALLS, (p, nr, a, d, k) => netSyscall(p, nr, a, d, () => k.deliver(p, SIGPIPE)))`.
    pty/signals.ts can override the kernel's signal syscalls the same way.
  - **New syscalls:** pread64/pwrite64, access/faccessat, mkdirat, unlinkat,
    renameat/renameat2 (RENAME_NOREPLACE), newfstatat (AT_EMPTY_PATH,
    AT_SYMLINK_NOFOLLOW), readlinkat, symlink/symlinkat, link/linkat (a copy:
    the filesystem has no hard links), utimensat, chmod/fchmod/fchmodat,
    truncate, fchdir, getrandom, sched_yield, gettid, tkill/tgkill,
    rt_sigaction, rt_sigprocmask, rt_sigreturn, rt_sigpending,
    rt_sigsuspend, sigaltstack (recorded only), select/pselect6,
    epoll_create/epoll_create1/epoll_ctl/epoll_wait/epoll_pwait. ioctl
    FIONBIO/FIOCLEX/FIONCLEX are handled by the kernel.
  - **Guest signal handlers:** `rt_sigaction` stores the handler number in
    `proc.dispositions` and flags/mask/restorer in `proc.sigactions`. When a
    channel flags a caught signal (`kernel.takeSignal`) the kernel pushes the
    current mask on `proc.signalFrames` and blocks sa_mask plus the signal
    (unless SA_NODEFER; SA_RESETHAND resets). The guest runs the handler
    after the reply that carried the signal word, then sends
    `rt_sigreturn`, which restores the mask. `GuestChannel.call` does the
    sigreturn itself after `onSignal`. Blocked signals wait in
    `proc.deferredSignals` and are delivered when unblocked (`kernel.setSigmask`).
    SA_RESTART is not honored (blocked calls return -EINTR).
  - **Threads:** `attachThread(kernel, proc, createWorker)` (worker-host.ts)
    runs another Worker as a thread of `proc`: own channel and tid
    (`kernel.allocTid`, `proc.tids`, `kernel.processOfTid`), shared fds and
    signal state. `SYS_exit` from a thread ends that thread; `exit_group`
    ends the process. The start message carries `tid`. Channels subscribe
    with `proc.addSignalListener` instead of overwriting `proc.data.onSignal`
    (which now fans out to every listener; call it, don't replace it). Each
    signal goes to exactly one thread.
  - **Spawn fd inheritance:** without `fds`, a child inherits every
    non-cloexec fd (posix_spawn), with /dev/null filling a missing 0-2.
    `inheritFds: true` (SYS_spawn JSON `inherit: true`) installs `fds` on top
    of the inherited set. `FdTable.inherit(overrides)`. Guest spawns
    (SYS_spawn) also inherit ignored signals and the signal mask, as exec
    does (caught ones reset), minus a `sigdefault` list; host
    `kernel.spawn` does that only with `inheritSignals: true`.
  - **Hooks for pty/signals.ts:** `kernel.onSpawn(cb)` (synchronous, before
    the program starts; replaces wrapping `kernel.spawn`), public
    `kernel.notify()` (wakes waitpid after outside state changes),
    `OpenFile.ioctl(req, arg, caller?)` gets the caller's syscall
    AbortSignal like read/write, and `Process.fromSyscallSignal(signal)`
    maps it back without scanning. The process table reports `'stopped'`
    (`ShiroProcess.status` gained it).
  - **Optional OpenFile members:** `pread(buf, off)`, `pwrite(buf, off)`;
    kind `'epoll'`.
  - **abi.ts additions:** the syscall numbers above and socket ones
    (`SYS_socket`… `SYS_accept4`, `SOCKET_SYSCALLS`), errno 71/75 and 88–115,
    AF_/SOCK_/SOL_/SO_/IPPROTO_/TCP_/MSG_/SHUT_ constants, `SOCKADDR_ROOM`,
    POLLRDHUP and friends, EPOLL*, SIG_DFL/SIG_IGN/SIG_BLOCK…/SA_*/SS_*,
    struct sizes (`SIGACTION_SIZE`, `STACK_T_SIZE`, `EPOLL_EVENT_SIZE`),
    `sigsetToWords`/`sigsetFromWords`, `decodeText`, AT_EMPTY_PATH,
    R_OK/W_OK/X_OK, UTIME_NOW/UTIME_OMIT, FIONBIO/FIOCLEX/FIONCLEX. Values
    match net.ts's, so it can re-export them.
  - **GuestSys:** wrappers for all of the above (`openat`, `fstatat`,
    `mkdirat`, `unlinkat`, `renameat`, `symlinkat`, `linkat`, `readlinkat`,
    `utimensat`, `pread`, `pwrite`, `sigaction`, `sigprocmask`,
    `sigpending`, `sigsuspend`, `gettid`, `tgkill`, `exitThread`, `select`,
    `epollCreate`/`epollCtl`/`epollWait`, and sockets: `socket`,
    `socketpair`, `connect`, `bind`, `listen`, `accept`, `send`/`sendto`,
    `recv`/`recvfrom`, `shutdown`, `setsockopt`, `getsockopt`,
    `getsockname`, `getpeername`).
  - `FileSystem.utimes(path, atimeMs, mtimeMs)` (src/filesystem.ts).

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
  ioctl?(req: number, arg: Uint8Array, caller?: AbortSignal): Promise<number>;
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
| pread64 / pwrite64 | fd, len, offLo, offHi | → bytes / bytes → | n |
| access / faccessat | (dirfd,) pathLen, mode | path | 0 |
| newfstatat | dirfd, pathLen (0 + AT_EMPTY_PATH = the fd), flags | path → struct stat | 0 |
| mkdirat | dirfd, pathLen, mode | path | 0 |
| unlinkat | dirfd, pathLen, flags (AT_REMOVEDIR) | path | 0 |
| renameat / renameat2 | olddirfd, oldLen, newdirfd, newLen (, flags) | old, new | 0 |
| symlink / symlinkat | targetLen, (dirfd,) linkLen | target, linkpath | 0 |
| link / linkat | (olddirfd,) oldLen, (newdirfd,) newLen (, flags) | old, new | 0 (copies) |
| readlinkat | dirfd, pathLen, bufsiz | path → target | length |
| utimensat | dirfd, pathLen (0 = the fd), flags, hasTimes | path, then 2 struct timespec (32 B) at offset pathLen | 0 |
| chmod / fchmod / fchmodat | pathLen or fd or (dirfd, pathLen), mode | path | 0 |
| truncate | pathLen, lenLo, lenHi | path | 0 |
| fchdir | fd | | 0 |
| getrandom | len, flags | → bytes | n |
| gettid | | | tid (pid for the main thread) |
| tkill / tgkill | (tgid,) tid, sig | | 0 |
| rt_sigaction | sig, hasNew, hasOld | new struct kernel_sigaction (32 B) at 0 → old at 32 | 0 |
| rt_sigprocmask | how, hasSet, hasOld | sigset (8 B) at 0 → old at 8 | 0 |
| rt_sigreturn | | | 0 (restores the mask saved when the handler started) |
| rt_sigpending | | → sigset (8 B) | 0 |
| rt_sigsuspend | | sigset (8 B) | -EINTR |
| sigaltstack | hasNew, hasOld | new stack_t (24 B) at 0 → old at 24 | 0 |
| select | nfds, present (1 r, 2 w, 4 x), tvSec (-1 = forever), tvUsec | 3 fd_set bitmaps, each ceil(nfds/64)*8 B, back to back ↔ | ready count |
| pselect6 | nfds, present, tvSec, tvNsec, maskLo, maskHi, hasMask | as select | ready count |
| epoll_create1 / epoll_create | flags (EPOLL_CLOEXEC) / size | | epfd |
| epoll_ctl | epfd, op, fd, events, dataLo, dataHi | | 0 |
| epoll_wait | epfd, maxevents, timeoutMs | → packed epoll_event[] (12 B: u32 events, u64 data) | count |
| epoll_pwait | epfd, maxevents, timeoutMs, hasMask, maskLo, maskHi | as epoll_wait | count |
| sockets (41–55, 288) | see docs/NETWORKING.md (net.ts) | recvfrom/accept put the sockaddr `SOCKADDR_ROOM` bytes after the payload | |
| spawn (1000) | jsonLen | `{path, argv, env?, cwd?, fds?: [[child, parent]…], inherit?, pgid?, setsid?, sigdefault?}` | pid, -ENOENT if nothing can run `path` |
| getenv (1001) | | → `{argv, env, cwd, pid}` JSON | length |

`GuestSys` in `channel.ts` wraps all of these for JS guests.

## Host API (page side)

```ts
const k = getKernel();                    // main.ts attaches fs + shell at boot
const p = k.spawn({ path: 'ls', argv: ['ls', '-l'], fds: { 0: r, 1: w, 2: err } });
await p.wait();                           // wait status; or k.waitpid(p.pid)
k.addLoader((path, proc, k) => isWasm(path) ? wasiRunner : null);
k.registerSyscalls(SOCKET_SYSCALLS, netHandler);   // net.ts; return undefined to pass on
k.onSpawn(proc => adopt(proc));                   // signals.ts
attachThread(k, proc, (p, tid) => webWorker(new Worker(url)));
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
