# x86-64 engines for closed-source Linux ELF

Which engine runs closed-source static amd64 Linux binaries in Shiro, and how
fast. The target that motivated this is Google's `agy` CLI: a ~200 MB static
Go binary that uses threads, futex, epoll, signals and TLS
([UNIX_COMPAT.md](UNIX_COMPAT.md), phase 5). All numbers below were measured
on 2026-10-07/08 in a 4-vCPU cloud container (Node 22.22, Chromium 141
headless via Playwright). They are not from memory or from vendor pages.

**Recommendation: Blink** (jart/blink, ISC) compiled to WebAssembly with
emscripten pthreads, patched for Shiro and wired to the kernel (src/kernel).
It is the only candidate that is user-mode (syscall level, so it can share
Shiro's files, pipes, processes and network), runs amd64, has a permissive
license, and passed every functional test. Its weak point is speed: the wasm
build has no JIT, so CPU-bound code runs about 120x slower than native, and a
large Go binary needs about 20 s to start. See "What agy still needs".

## Candidates

| Engine | amd64 | Kind | License / can Shiro ship it | SAB needed | Go hello | Go cpuloop 50M (native 107 ms) | Go net/http (loopback) |
|---|---|---|---|---|---|---|---|
| **Blink → wasm (this branch)** | yes | user-mode syscalls | ISC, yes (self-hosted, 448 KB wasm) | yes (pthreads) | **0.15–0.16 s** per process | **12.8 s (~120x)** | **works**, 0.32–0.48 s |
| src/x86 (current built-in) | partial | user-mode, TS interpreter | ours | no | fails: `fatal error: float64nan` | fails (same) | fails (same) |
| container2wasm (Bochs, WASI) | yes | full system: Linux 6.1 + runc | Apache-2.0 / LGPL-2.1 / GPL | no (1 vCPU) | 60–85 ms *inside a booted VM* (boot ≈ 3 s) | 9.0 s (~84x) | fails: `lo` down in the container |
| JSLinux x86_64 (Bellard) | yes | full system: Linux 6.19 | **closed source, no license** | no | 0.13 s inside the VM (boot ≈ 14 s) | 7.6 s (~71x) | works, 0.57 s |
| qemu-wasm (TCG→wasm) | yes | full system | GPL-2.0 | yes (2.3 GB) | did not reach a shell | — | — |
| CheerpX 1.4 / WebVM | **no** ("Only 32-bit ELF files are supported", at runtime) | user-mode | proprietary; CDN-only for free tiers, commercial license to self-host or for business use | yes | amd64: fails. 386 build: 0.8–1.2 s | 386 build: 347 ms (1.7x native-386) | 386: bind fails |
| v86 0.5.470 | **no** (no long mode/REX in source) | full system | BSD-2 | no | — | — | — |
| halfix, box64, linux-wasm, qemujs | no | — | — | — | — | — | — |

Notes:
- Full-system engines (container2wasm, JSLinux, qemu-wasm) boot their own
  Linux kernel. Their binaries see that VM's filesystem, network and
  processes, not Shiro's; bridging needs 9p/virtio plumbing. Their per-run
  numbers exclude the VM boot. Blink's include a fresh Worker, wasm
  instantiation and the binary's load from Shiro's filesystem.
- JSLinux and container2wasm interpret faster than Blink-wasm (1.4–1.7x on the
  loop; it was 2.4–2.9x before patch 0010). JSLinux can't be embedded without a license from its author;
  container2wasm needs Docker to build 145 MB+ images per container and runs
  one vCPU with a virtual clock.
- CheerpX has a fast x86→wasm JIT but is 32-bit only, and its license
  forbids self-hosting outside a commercial agreement and use in a competing
  product.

## Blink in detail

### What runs

Measured end to end through Shiro's shell (`./binary`, a kernel process in a
Worker), in Chromium on a cross-origin isolated page, three runs each. The
"before" column is the round-1 build (patches 0001–0005).

| Program | Blink-wasm, Chromium | before | Native | src/x86, Chromium |
|---|---|---|---|---|
| static musl C hello (38 KB) | 80–96 ms (first run 258 ms) | 92–132 ms | 1 ms | 25–88 ms |
| static glibc C hello (785 KB) | 85–115 ms | 123–149 ms | 1 ms | fails: `Unknown two-byte opcode: 0F 62` |
| static Go hello (1.4 MB) | 151–164 ms | 477–620 ms | 2 ms | fails: `float64nan` |
| Go goroutines + net/http server and 4 clients | 317–483 ms | 1.1–1.6 s | 5 ms | fails: `float64nan` |
| Go TLS 1.3 handshake + 3 HTTPS requests over loopback (9.5 MB) | 714–806 ms (setup 116 ms, requests 424 ms) | 1.6–1.8 s (requests 715 ms) | 5 ms | — |
| C loop, 5M iterations (in-process time) | 1.12 s | 1.57–1.70 s | 10 ms | 29.8 s |
| Go loop, 5M iterations (in-process time) | 1.18 s | 1.91–2.04 s | 10 ms | fails |
| Go loop, 50M iterations | 12.8 s | 21.7 s | 107 ms | fails |
| `gh --version`, GitHub CLI 2.62 (59 MB static Go) | 20.3–20.9 s | — | 71–79 ms | — |
| same, Node (vitest host), wall / peak RSS | 22.9 s / 275 MB | 32.7 s / 999 MB | | |

For reference, native Blink on the same machine: Go hello 80 ms, Go loop 50M
737 ms with its x86-64 JIT and about 9.8 s without (`-j`; 983 ms for 5M), `gh --version` 1.3 s
with the JIT and 22 s without. The wasm build is now about as fast as
native Blink's own interpreter on `gh`; the interpreter (~30M guest
instructions/s) is the ceiling.

#### Startup lever: one mapping per file, one CPU, native 64-bit atomics

Snapshotting a Go guest after runtime init was the other candidate. It was
rejected for now: by the time `main` runs, Go has several OS threads (sysmon,
GC workers, netpoller) parked in futex and epoll inside emscripten pthreads, and
a snapshot would have to capture and recreate those threads, their kernel fds
and timers. Profiling `gh --version` showed cheaper wins instead (patch 0010):

| `gh --version`, Node | wall | peak RSS |
|---|---|---|
| round-1 build | 32.7 s | 999 MB |
| one host mapping per file mapping (was 10,474 4 KiB `mmap`s, each zeroed) | 30.3 s | — |
| + `GetCpuCount() = 1` under the GIL (Go sized GOMAXPROCS to the host and its idle Ps fought for the GIL) | 25.3 s | — |
| + lock-free 64-bit atomics (wasm has them; Blink used a mutex) | **22.9 s** | **275 MB** |

The memory drop is the ELF single-copy mapping in effect: Blink's file
mappings are now one block per file that every guest page of it references
(refcounted), not a private copy per page.

The vitest suite (`tests/tests/shiro-vitest/x86-engine.test.ts`) runs the
musl, glibc, Go, Go net/http fixtures, `kernel.spawn` through the loader, a
guest blocking on a kernel pipe for stdin, a Go TCP client through a local
WebSocket relay, Go DNS over the kernel's DoH, a Go program on the pty
(isatty, winsize, raw read, SIGWINCH, Ctrl-C), and Ctrl-C killing a C
program. Go and glibc fixtures are built
in the test when `go`/`gcc` exist.

### How it is wired

- `vendor/blink/`: pinned upstream commit, our patches, `build.sh`
  (emsdk → `public/engines/blink/blink.{mjs,wasm}`, committed so
  `npm run build` needs no emscripten), `shiro-net.js` (sockets), `bench/`.
- `public/engines/blink/host.mjs`: the Worker. It is a kernel guest. The
  guest's own syscalls (patch 0011) arrive as emscripten calls proxied from
  the guest's pthreads to the worker's main thread, which runs each on a
  pool of kernel channels (`POOL_CHANNELS` in `src/x86-engine/blink.ts`,
  1 MiB data areas): it posts `blink-sys`, the page runs the syscall
  (`servePoolChannel`) and answers `blink-done`. A call blocked on one
  channel (a read from the tty, `wait4`) doesn't hold up other threads.
  Blink itself loads programs and ELF interpreters from SHIROFS, a MEMFS
  over the worker's own channel, faulted in with
  `lstat`/`openat`/`read`/`getdents64`.
- `src/x86-engine/`: `chooseX86Engine` (Blink when SharedArrayBuffer is
  usable, else src/x86; `SHIRO_X86_ENGINE=x86` forces the old one),
  `runElfWithBlink` (the shell's `./binary` path) and `registerBlinkLoader`
  (main.ts registers it, so `kernel.spawn()` of an ELF runs in Blink). Blink
  processes appear in `ps` and die on `kill`. `SHIRO_BLINK_DEBUG=1` logs the
  worker's kernel syscalls.
- The shell's ELF path (`src/shell-kernel.ts`) calls `chooseElfRunner`, so a
  `./static-go-binary` at the prompt is a kernel process in the foreground job
  on the pty, like a WASI program.
- Sockets: `vendor/blink/shiro-net.js` replaces emscripten's WebSocket SOCKFS
  with the kernel's socket syscalls (`socket`, `connect`, `accept4`,
  `sendmsg`, ... from src/kernel/net.ts). Kernel sockets are non-blocking;
  blocking guest calls wait on kernel readiness pings, and guest `epoll`/`poll`
  see kernel readiness through emscripten's wait queues. So Go gets loopback
  between guests, real TCP through the unix/net WebSocket relay
  (`SHIRO_TCP_RELAY`), and DNS: `/etc/resolv.conf` points at a nameserver whose
  UDP 53 the kernel answers over DNS-over-HTTPS.
- tty: fds 0–2 forward `TCGETS`/`TCSETS*`/`TIOCGWINSZ` to the kernel pty
  (unix/pty), so `isatty`, raw mode and the window size work. The worker
  installs kernel handlers for SIGHUP/INT/QUIT/USR1/USR2/TERM/WINCH; a
  delivered signal is raised in the guest (`blink_shiro_signal`) and the
  worker answers with `rt_sigreturn`. Ctrl-C reaches a Go program as SIGINT,
  a resize as SIGWINCH; a guest that doesn't catch a signal dies of it with
  the kernel's status (130 for Ctrl-C). Ctrl-Z stops the process through the
  kernel's default action and `fg` resumes it.
- `$(./binary)` at the prompt captures the program's stdout (src/shell.ts);
  before, any kernel program inside `$(...)` wrote to the tty.
- `SHIRO_BLINK_STRACE=1` adds Blink's own syscall trace.

### Patches to upstream Blink (vendor/blink/patches)

1. `%rdx` is zero at `_start` for non-Cosmopolitan ELF. Blink passed the
   program path there, and static glibc registers `%rdx` with `atexit` as
   `rtld_fini`, so every static glibc program crashed in `exit()`.
2. `eventfd`/`eventfd2`, emulated on a pipe. Go 1.24's netpoll requires it.
   Also fixes the `epoll_pwait` configure probe on new glibc.
3. emscripten: exit reaches JavaScript (`emscripten_force_exit`, and
   `Module.shiroExit` first), `emscripten_sleep()` isn't used in pthread
   builds (it needs ASYNCIFY and aborts), and `exit_group` doesn't wait for
   threads parked in proxied syscalls.
4. Guest-thread races (also reproducible in native Blink with `-m`, its
   software-MMU mode, which is the mode wasm uses):
   - freed pages and page tables went on a LIFO free list and were reused at
     once while other threads could still walk or cache them; they now cool
     off in a FIFO, and page tables are unlinked before being freed;
   - the TLB and icache invalidation flags were cleared after flushing,
     losing invalidations posted in between;
   - a global interpreter lock (`blink/gil.c`) runs one guest thread at a
     time, released around blocking syscalls and every 4096 instructions.
     Before it, Go net/http faulted or corrupted Blink's heap in about 1 of 3
     wasm runs; after, 0 in 70 (native `-m` and wasm). The cost is no guest
     parallelism, which the interpreter-bound wasm build barely had.

5. `blink_shiro_signal()`: the worker raises a kernel-delivered signal in
   the guest.
6. `epoll_pwait` waits in 50 ms slices and `read` returns EINTR, so a
   signal queued while a guest thread blocks is delivered.
7. The GIL is restored to its entry state across syscalls, and recursive
   signal delivery holds it (a handler's `rt_sigreturn` used to deadlock).
8. A fatal signal ends the process through `Module.shiroKill`, so the
   kernel sees the right status.
9. Startup and memory (see above): `GetCpuCount()` is 1 under the GIL; on
   emscripten a file mapping is one host block shared by its pages
   (`MugBlock`, refcounted); 64-bit atomics are native when the target has
   them (`CAN_ATOMIC64`).

11. Kernel passthrough (`blink/shiro.inc`, included by `syscall.c`): under
   Shiro the guest's fd, filesystem and process syscalls go to the Shiro
   kernel through `shiro_ksys()` (`vendor/blink/shiro-kernel.js`), so guest
   fd N is kernel fd N. `fork`/`vfork`/`clone(CLONE_VFORK)` run the child on
   the calling thread until it calls `execve` or `_exit` (vfork semantics; the
   kernel creates the child with `SYS_shiro_vfork`, and `fork` also saves and
   restores the parent's live stack, which the child's return through libc
   overwrites). `execve` goes through `SYS_shiro_execve`: an ELF is reloaded
   in this Blink, anything else (WASM, scripts, Shiro builtins like
   `/bin/sh`) replaces the worker in the same process. `rt_sigaction`
   mirrors the guest's dispositions into the kernel (caught signals are
   forwarded, ignored ones stay ignored across exec). File `mmap` reads the
   file through the kernel into an anonymous mapping (`MAP_SHARED` writable
   ones are written back on `msync`/`munmap`). `statx`, `waitid` (with
   `WNOWAIT`), `eventfd`, `close_range`, `sendfile`, `readv`/`writev` (one
   transfer) and the tty ioctls (`TIOCSCTTY`, `TIOCGPTN`, ...) are covered;
   locks (`fcntl F_SETLK`, `flock`) always succeed.

12. A stop signal's default action (SIGTSTP/SIGTTIN/SIGTTOU/SIGSTOP) stops
   the process in the kernel instead of terminating it.
13. Real `fork()`: `fork` and `clone` without `CLONE_VFORK` snapshot the
   process (every mapped page, the forking thread's registers, the signal
   table, brk, ELF info); the kernel creates the child (`SYS_shiro_vfork`),
   the page starts a new Blink worker that rebuilds the snapshot
   (`blinkRunner(path, restore)`), and `fork` returns 0 there. Programs that
   fork without exec (GNU tar's compressor helper, servers) work; `vfork`
   and `posix_spawn` keep the cheaper emulation of patch 11.
14. `mmap` of a kernel fd no longer takes `mmap_lock` around
   `ShiroMmapFile`, which takes it itself (a deadlock in `file`).
15. `madvise(MADV_DONTNEED)` zeroes touched anonymous pages, as Linux does
   (jemalloc in Rust programs such as fd checks it and warns otherwise).
16. `pextrw` zero-extends into the whole destination register (upstream
   wrote only the low 16 bits; Rust's miniz_oxide inflate built with LTO
   uses it, so bat's compressed themes failed to load).
17. `futex` `FUTEX_WAIT_BITSET` (absolute timeout) and `FUTEX_WAKE_BITSET`,
   `getrandom(GRND_INSECURE)`: Rust's std uses both.

Native Blink's own exit path (`KillOtherThreads`) still hangs after
multi-threaded Go programs; the wasm build doesn't use it.

### Limits today

- Needs `crossOriginIsolated` (pthreads and the kernel channel use
  SharedArrayBuffer). On shiro.computer that depends on the unix/isolation
  branch; until then `./binary` uses src/x86.
- No JIT: ~120x native on CPU-bound code. Startup of large Go binaries is
  dominated by runtime and package init running in the interpreter.
- Memory: wasm32, 4 GB max. File mappings are now one copy inside Blink, but
  the binary is still copied on its way in (Shiro's FS, the kernel read,
  MEMFS).
- Non-loopback TCP needs the relay (`SHIRO_TCP_RELAY`); without it `connect`
  fails like an offline host. `socketpair` is ENOSYS.
- Signals sent before the guest has loaded are dropped. SIGTSTP is the
  kernel's default stop; a guest can't catch it.
- The worker doesn't use the kernel's new `symlink`/`chmod` yet.
- One guest thread runs at a time (GIL).

## What agy still needs

Honest estimate for a ~200 MB static Go CLI that talks TLS to Google APIs:

1. **Cross-origin isolation in production** (unix/isolation). Without it the
   engine doesn't start.
2. **A TCP relay deployed** for shiro.computer. The wiring is done (Go's own
   DNS and TLS run over the kernel's sockets, tested against a local relay);
   the relay itself has to run somewhere.
3. Interactive use works today (tty, raw mode, SIGWINCH, Ctrl-C).
4. **Speed** is the remaining problem. `gh` (59 MB) now takes 20–21 s to
   print its version in Chromium (it was 30–37 s). agy is 3–4x larger, so
   expect about a minute of startup, and ~120x native for anything
   CPU-heavy (a TLS handshake plus three HTTPS requests takes 0.4 s).
   Options, roughly in order of payoff:
   - a wasm code generator for Blink's JIT (emitting small wasm modules per
     hot path, as qemu-wasm does for TCG, is the 10x+ lever; weeks of work);
   - snapshotting a guest after runtime init (needs Go's threads, futexes
     and kernel fds recreated; see above);
   - more interpreter profiling (software page-table walks dominate now).
5. Memory headroom: about 300 MB peak for `gh`, so a 200 MB binary plus Go
   heap should fit inside 4 GB.

Blink makes agy *possible* in Shiro, with a minute-long start.

## Reproducing

```bash
EMSDK=/path/to/emsdk vendor/blink/build.sh          # rebuild public/engines/blink
cd tests && npx vitest run --config vitest.config.ts tests/shiro-vitest/x86-engine.test.ts
# Chromium numbers: serve the app with COOP same-origin + COEP credentialless,
# build the vendor/blink/bench programs (CGO_ENABLED=0 go build / musl-gcc -static)
# into $BENCH_DIR, then:
BENCH_DIR=... node vendor/blink/bench/chromium.mjs http://localhost:5199/ "./hello-go;./cpuloop 5000000"
```
