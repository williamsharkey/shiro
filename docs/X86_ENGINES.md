# x86-64 engines for closed-source Linux ELF

Which engine runs closed-source static amd64 Linux binaries in tabcomputer, and how
fast. The target that motivated this is Google's `agy` CLI: a ~200 MB static
Go binary that uses threads, futex, epoll, signals and TLS
([UNIX_COMPAT.md](UNIX_COMPAT.md), phase 5). All numbers below were measured
on 2026-10-07/08 in a 4-vCPU cloud container (Node 22.22, Chromium 141
headless via Playwright). They are not from memory or from vendor pages.

**Recommendation: Blink** (jart/blink, ISC) compiled to WebAssembly with
emscripten pthreads, patched for tabcomputer and wired to the kernel (src/kernel).
It is the only candidate that is user-mode (syscall level, so it can share
tabcomputer's files, pipes, processes and network), runs amd64, has a permissive
license, and passed every functional test. Its weak point is speed: the wasm
build now has its own JIT (patch 0012, x86-64 to WebAssembly): a hot Go loop
runs at about 2–3x native and `gh --version` takes 6.3 s on its first run
in a page and 3.2 s after that, in Chromium (27 s interpreted on the same
machine). See "The wasm JIT" and "What agy still needs".

## Candidates

| Engine | amd64 | Kind | License / can tabcomputer ship it | SAB needed | Go hello | Go cpuloop 50M (native 107 ms) | Go net/http (loopback) |
|---|---|---|---|---|---|---|---|
| **Blink → wasm (this branch)** | yes | user-mode syscalls | ISC, yes (self-hosted, 550 KB wasm) | yes (pthreads) | **0.145 s** per process | **0.25 s wall (2.4x native) with the wasm JIT**; 12.8 s (~120x) interpreted | **works**, 0.34–0.37 s |
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
  processes, not tabcomputer's; bridging needs 9p/virtio plumbing. Their per-run
  numbers exclude the VM boot. Blink's include a fresh Worker, wasm
  instantiation and the binary's load from tabcomputer's filesystem.
- JSLinux and container2wasm interpret faster than Blink-wasm (1.4–1.7x on the
  loop; it was 2.4–2.9x before patch 0010). JSLinux can't be embedded without a license from its author;
  container2wasm needs Docker to build 145 MB+ images per container and runs
  one vCPU with a virtual clock.
- CheerpX has a fast x86→wasm JIT but is 32-bit only, and its license
  forbids self-hosting outside a commercial agreement and use in a competing
  product.

## Blink in detail

### What runs

Measured end to end through tabcomputer's shell (`./binary`, a kernel process in a
Worker), in Chromium on a cross-origin isolated page, three runs each. The
"before" column is the round-1 build (patches 0001–0005). The Blink column's
musl, glibc, Go hello, net/http, Go 5M loop, gh and vim rows were re-measured
on 2026-10-09 with `node bench/run.mjs --suites x86` (medians of 5), after
the page started keeping blink.wasm compiled (docs/BENCHMARKS.md, perf-blink
8). The other rows are older hand measurements.

| Program | Blink-wasm + JIT, Chromium | interpreter only (same machine) | round 1 | Native | src/x86, Chromium |
|---|---|---|---|---|---|
| static musl C hello (38 KB) | 80 ms (first run 192 ms) | 102–107 ms | 92–132 ms | 1 ms | 25–88 ms |
| static glibc C hello (785 KB) | 88 ms (first run 87 ms) | 116 ms | 123–149 ms | 1 ms | fails: `Unknown two-byte opcode: 0F 62` |
| static Go hello (1.4 MB) | 145 ms (first run 134 ms) | 237–245 ms | 477–620 ms | 2 ms | fails: `float64nan` |
| Go goroutines + net/http server and 4 clients | 366 ms (first run 389 ms) | 470–487 ms | 1.1–1.6 s | 5 ms | fails: `float64nan` |
| Go TLS 1.3 handshake + 3 HTTPS requests over loopback (9.5 MB) | 572 ms (first run 791 ms) | 0.96–1.06 s | 1.6–1.8 s | 5 ms | — |
| C loop, 5M iterations (wall at the prompt) | 112 ms | 1.41 s | 1.57–1.70 s | 10 ms | 29.8 s |
| Go loop, 5M iterations (wall at the prompt) | 129 ms | 1.82 s | 1.91–2.04 s | 10 ms | fails |
| Go loop, 50M iterations (wall at the prompt) | 253 ms | 14.4 s | 21.7 s | 107 ms | fails |
| C mul/div/bit-op loop, 10M iterations (`vendor/blink/bench/arith.c`) | 173–190 ms (first run 297 ms; 2.5–2.8 s before the ops were inlined) | 9.7 s | — | 40 ms | — |
| `gh --version`, GitHub CLI 2.62 (59 MB static Go): first run in the page | 3.6 s | 26.7 s | — | 71–79 ms | — |
| same, later runs (V8 reuses the compiled regions) | 3.5 s (2.5 s in an older measurement) | 26.6 s | 20.3–20.9 s | | |
| same, Node (`run.mjs`-style host, no kernel), wall / peak RSS | 3.2–3.6 s / 374 MB | 28.5 s / 278 MB | 32.7 s / 999 MB | | |
| Vim 9.2 (static) opening a C file: `vim --not-a-term -c qa x.c`, later runs (defaults.vim: filetype, syntax) | 2.02 s in the x86 bench (`vim_startup`; 1.51 s in an earlier hand measurement) | ~3.0 s | — | 41 ms | — |

The Vim row is from `bench/ab.mjs` on 2026-10-09 (medians of 15 runs;
the interpreter-only figure is compat-tools' Chromium measurement with
`BLINK_WJIT=0`); the first Vim run after a page load still pays about
1 s more while V8 tiers up the new JIT modules.

The JIT column was re-measured on 2026-10-08 after the third JIT round
(mul/div/bit ops inline, a larger decode cache; the previous build, run back
to back with it: Go loop 50M 362 ms, Go loop 5M 205 ms, TLS 678 ms, `gh`
5.2 s first / 2.6 s later, arith 2.5–2.8 s, hellos and net/http the same
within noise). The first two columns were measured back to back on 2026-10-08 in a 4-vCPU
container (`vendor/blink/bench/chromium.mjs`, one Chromium page, runs in the
order listed, so the first run of a binary includes copying it into the page's
filesystem); this machine is slower than the one the round-1 column (and the
older numbers in this file) came from: the interpreter took 26.7 s for `gh`
here against 20.3–20.9 s there. `npm run bench -- --suites x86` agrees:
`gh_version` 31974 → 3231 ms, `go_cpuloop_5m` 2001 → 227 ms
(`bench/results/perf-blink-before-x86.json` → `perf-blink-2-x86.json`; the
suite's median excludes the first run, which was 6.7 s).

First run vs later runs: V8 keeps compiled wasm in a process-wide cache keyed
by the module bytes, so the second `gh` in a page (or a copy of the binary,
or another thread of the same program) gets the regions' Liftoff and
TurboFan code for free. Measured in the first run: compiling and
instantiating ~700 modules is 0.56 s; the rest of the 3 s difference is
V8 compiling region functions on first call and tiering the hot ones up to
TurboFan (a larger `--wasm-tiering-budget`, which a page can't set, brought
the first run from 6.3 to 5.5 s). Smaller regions didn't help (16 blocks:
5.7 s first, 3.8 s later). Short programs that
don't get hot (hello, net/http) are unchanged within noise or a few ms
slower: the module is 90 KB bigger and the interpreter loop does one more
compare per instruction. Node's peak RSS for `gh` grows by the V8 code of
~1,500 compiled regions (Chromium's renderer peak for the same run stayed at
160 MB above idle).

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
  usable, else src/x86; `TABCOMPUTER_X86_ENGINE=x86` forces the old one),
  `runElfWithBlink` (the shell's `./binary` path) and `registerBlinkLoader`
  (main.ts registers it, so `kernel.spawn()` of an ELF runs in Blink). Blink
  processes appear in `ps` and die on `kill`. `TABCOMPUTER_BLINK_DEBUG=1` logs the
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
  (`TABCOMPUTER_TCP_RELAY`), and DNS: `/etc/resolv.conf` points at a nameserver whose
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
- `TABCOMPUTER_BLINK_STRACE=1` adds Blink's own syscall trace.

### The wasm JIT (patch 0012, `blink/wjit.c`)

Blink's own JIT emits x86-64/aarch64 machine code, which a wasm host can't
run, so the wasm build interpreted everything. Patch 0012 adds a translator
from x86-64 to WebAssembly, modeled on what qemu-wasm's TCG backend and v86
do (small modules compiled at run time that share the memory):

- The interpreter loop counts executions of branch targets. At 200 (env
  `BLINK_WJIT_THRESHOLD`), the *region* around the target is compiled: the
  basic blocks reachable from it through direct jumps and conditional
  branches, plus the return points of its calls (up to 64 blocks / 640
  instructions). The region becomes one wasm function, a loop around a
  `br_table`, so its branches never leave wasm; each block also gets a
  two-instruction exported entry, `f_k(m) = body(m, k)`.
- `new WebAssembly.Module` + `Instance`, importing the shared memory and
  the C functions the code calls (not the function table: importing the
  table made every later `table.set` cost O(instances)). The entries go in
  the function table (grown 256 slots at a time), so C calls them like any
  function pointer. Each pthread has its own table, so each thread compiles
  its own regions.
- Guest registers live in wasm locals inside a region; they are written
  back on exit, before calling into C and before a slow-path memory access
  (which may fault and deliver a signal with the right state).
- Inline: mov/movzx/movsx/lea, add/adc/sub/sbb/and/or/xor/cmp/test,
  inc/dec, neg/not, shl/shr/sar, imul (all forms), mul, div/idiv (32 and
  64 bit; a dividend that doesn't fit, a zero divisor or an overflow takes
  Blink's handler from inside the region), bt/bts/btr/btc (register,
  immediate and memory forms, including bit offsets outside the operand),
  bsf/bsr/tzcnt/lzcnt, push/pop, call/ret/jmp/jcc/indirect call and jmp,
  setcc/cmovcc, cqo/cltq, 8/16/32/64-bit forms (16-bit shifts, lea and
  movzx go to Blink), and the SSE moves Go's memmove/memclr use
  (movups/movdqu/movsd, register movaps/movdqa, pxor/xorps). Memory goes through a 256-entry
  per-thread translation cache (`Machine::wjr/wjw`, guest page → host
  page). Each instruction resolves its memory operands before it changes
  anything; a miss calls a helper that refills the cache and never faults,
  and if the access would fault or crosses a page, the region exits
  *before* the instruction and the interpreter runs it, so faults are
  delivered with exact state.
- Blocks are laid out by address: fallthroughs are free and forward
  branches are direct `br`s to the target block; backward branches go
  through the dispatch loop. All exits share one epilogue. Every other instruction calls Blink's own
  op handler with its decoded operands (no decode or dispatch left).
- Flags: liveness over the region, and a flag crawler for code outside it
  (stricter than Blink's: hand-written assembly returns results in flags, so
  `call`/`ret`/syscalls end the crawl as "unknown"); cmp/test+jcc, setcc and
  cmov become one wasm comparison. Such a fused pair leaves the flags in
  wasm locals only, so it isn't fused across an instruction that can leave
  the region part way (a memory operand that faults or crosses a page,
  div's slow path): the interpreter that runs the rest would read stale
  flags. (Until the third round it was, and a `cmp; mov (page-crossing);
  setb` read the wrong carry; `jitfuzz.c`'s `cmpcross` checks it.)
- A call from compiled code to compiled code runs the callee from a C helper
  and resumes the caller's region in wasm when the guest returns to it (up
  to 48 deep), instead of two trips through the interpreter loop.
- Jumps inside a region spend a budget (1024) and check `m->attention`, so
  signals, the GIL and other threads get their turn while a loop spins.
- Safety: code is compiled only from pages that aren't writable. Unmapping
  such a page or changing its protection bumps a global epoch and every
  thread drops all its regions (self-modifying code in RWX pages stays in
  the interpreter, which rechecks instruction bytes). A pending TLB
  invalidation from another thread is honored at region entry.
- `BLINK_WJIT=0` turns it off; `BLINK_WJIT_DEBUG=1` prints statistics
  (regions, compile/instantiate time, the ops still going through Blink);
  `BLINK_WJIT_OFF=<bitmask>`, `BLINK_WJIT_MAX=n` and
  `BLINK_WJIT_BISECT=lo:hi` (guest pc range) bisect a miscompile;
  `BLINK_WJIT_BLOCKS=n` caps region size; under Node,
  `BLINK_WJIT_DUMP=<pc>` writes that region's module to `/tmp`.

Tests: `x86-engine.test.ts` runs `fixtures/x86/jitfuzz.c` (about 170 groups of
instruction forms on edge-case inputs, flags included) with and without the
JIT and requires identical output, and `fixtures/x86/jit.c` for code
rewritten after `mprotect`, in an RWX page and after `munmap`+`mmap`; signal
handlers running while a compiled loop spins; a SIGSEGV in a compiled loop
that the handler repairs; four threads running compiled code.

Where `gh --version` still spends its time (Node profile, ~3.8 s with the
profiler): generated code ≈1.2 s (go-runewidth's `CreateLUT`, which calls
`RuneWidth`'s binary searches for every code point at init, ≈0.3 s;
mallocgc next), interpreting cold code ≈1.1 s (~6.5M instructions run fewer
than 200 times per branch target; lowering the threshold to 25–100 trades
it for compile time and changed nothing), the main thread waiting while
Go's GC workers and sysmon hold the GIL or in blocking syscalls ≈0.6 s,
~480 modules compiled and instantiated ≈0.33 s. Ops still going through
Blink's handlers are down to a few thousand executions per run (they were
~3M: mul/div, 16-bit cmp/mov, bt/btc, bsf, sbb), which didn't move `gh`
much but is 15x on loops built from them. Blink's decoded-instruction cache
had 512 direct-mapped entries, so warm code that isn't compiled yet was
decoded on most visits; 4096 entries (patch 0022, 160 KB per thread) cut
`gh`'s decodes from 3.2M to 1.4M.

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
   tabcomputer the guest's fd, filesystem and process syscalls go to the tabcomputer
   kernel through `shiro_ksys()` (`vendor/blink/shiro-kernel.js`), so guest
   fd N is kernel fd N. `vfork`/`clone(CLONE_VFORK)` run the child on
   the calling thread until it calls `execve` or `_exit` (vfork semantics; the
   kernel creates the child with `SYS_shiro_vfork`). `fork` worked the same
   way until patch 14. `execve` goes through `SYS_shiro_execve`: an ELF is reloaded
   in this Blink, anything else (WASM, scripts, tabcomputer builtins like
   `/bin/sh`) replaces the worker in the same process. `rt_sigaction`
   mirrors the guest's dispositions into the kernel (caught signals are
   forwarded, ignored ones stay ignored across exec). File `mmap` reads the
   file through the kernel into an anonymous mapping (`MAP_SHARED` writable
   ones are written back on `msync`/`munmap`). `statx`, `waitid` (with
   `WNOWAIT`), `eventfd`, `close_range`, `sendfile`, `readv`/`writev` (one
   transfer) and the tty ioctls (`TIOCSCTTY`, `TIOCGPTN`, ...) are covered;
   locks (`fcntl F_SETLK`, `flock`) always succeed.
12. The wasm JIT (`blink/wjit.c`), described above.
13. Under tabcomputer a stop signal's default action stops the process.
14. A real `fork()` (and `clone()` without `CLONE_VM`): the process is
   snapshotted (every mapped page, untouched anonymous pages without
   contents and untouched file pages faulted in; the forking thread's
   registers; the signal table; brk/automap; the ELF info), the kernel makes
   the child (`SYS_shiro_vfork`, a copy of the fd table) and host.mjs hands
   the snapshot to the page, which starts a Blink worker for the child that
   rebuilds it and returns 0 from fork. Before, the child ran on the
   parent's thread and memory, so code between fork and exec changed the
   parent and a child that never exec'd broke it (perl's `fork; open
   STDOUT, ">&W"; exec`, IPC::Open3 and `prove` got no output). vfork and
   `CLONE_VFORK` keep running the child on the calling thread. Only the
   calling thread exists in the child. Separate wasm memories can't share
   pages, so a process that has a writable `MAP_SHARED` mapping (anonymous
   or a file) forks the old way instead (patch 23). Tests: `fixtures/x86/fork.c` (fork-musl) and
   `forkcopy.c` in `x86-engine.test.ts`, the perl cases in
   `compat-dev.test.ts`.
15. File mmap of a kernel fd no longer takes `mmap_lock` twice (it
   deadlocked every such mmap).
16. `madvise(MADV_DONTNEED)` zeroes private anonymous pages (jemalloc).
17. `pextrw` zero-extends into the whole destination register.
18. `FUTEX_WAIT_BITSET`/`FUTEX_WAKE_BITSET`; `getrandom(GRND_INSECURE)`.
19. sendmsg/recvmsg pass control data (`SCM_RIGHTS`), `sockaddr_un`
   lengths, `SO_PEERCRED`.
20. `pause()` waits like `sigsuspend` (signals the embedder queues end it);
   tabcomputer `TIOCPKT`/`TIOCGPKT`.
21. Under tabcomputer `CLOCK_BOOTTIME` comes from the kernel (uptime and process
   start times match `/proc`).
22. `lzcnt` returns the leading zero count (it returned `bsr`'s bit index);
   the 32-bit one-operand `imul` zero-extends `%rdx` (it stored the
   sign-extended high half in all 64 bits); a 4096-entry decoded-instruction
   cache (was 512).
23. While a writable `MAP_SHARED` mapping is mapped, fork runs the child on
   the parent's thread and memory until it execs or exits (the pre-14
   behavior), so the memory stays shared: LTP keeps its results and
   checkpoint futexes there and scored 0/320 under the real fork. `munmap`
   of a writable shared kernel-file mapping no longer hangs (its write-back
   took page locks that the `munmap` then waited for). Test:
   `fixtures/x86/forkshared.c`.
24. Blink keeps every resource limit (`setrlimit(RLIMIT_CORE, 0)` succeeds,
   so ssh-agent survives its daemonizing fork; `RLIMIT_STACK` reads 8 MiB).
25. `mlock`/`munlock`/`mlockall`/`munlockall` succeed (wasm memory is never
   paged out; gnupg locks its secure memory).
26. Under tabcomputer `uname` takes the kernel's host and domain names (Blink's
   kernel version and machine otherwise; emscripten's nodename was
   "emscripten", which tmux showed).
27. `mremap` grows (in place, or with `MREMAP_MAYMOVE` by mapping, copying
   and unmapping), shrinks and moves to a fixed place (it always failed
   with ENOMEM; apt's DynamicMMap needs it). Under tabcomputer `getgroups`
   reports the process's gid (it reached emscripten: EINVAL for size 0,
   which broke coreutils `id`). Tests: `fixtures/x86/mremap.c`,
   `getgroups.c`.
28. `brk` fails, like Linux, when the heap would grow over a mapping (Blink
   replaced the mapping), and `mmap(0)` leaves 1 GB above the break: in
   the wasm build the automatic-placement range scales down to the
   program's neighborhood, so apt's 120 MB cache landed at the break and
   malloc's next `brk` overwrote it. Test: `fixtures/x86/brkmap.c`.
29. `cmpps`/`cmppd`/`cmpss`/`cmpsd` write all-ones masks (Blink stored the
   -1 as a float, -1.0), and predicates NLT/NLE are true for NaN. GTK's
   cubic-bezier easing selects with those masks, so l3afpad's main thread
   spun forever in the solve. Test: `fixtures/x86/ssecmp.c`.
30. Under tabcomputer `lchown` and `fchownat(AT_SYMLINK_NOFOLLOW)` don't follow a
   symlink (dpkg lchowns NAME.dpkg-new links before their targets exist),
   and `fchownat` fails for a missing path. Ownership isn't kept; they
   check existence. Test: `fixtures/x86/lchown.c`.
31. Same-instance fork (the default since patch 48; `BLINK_SAME_INSTANCE_FORK=0`
   opts out): the fork child
   is a new System with its own guest thread in the parent's Blink instance
   (same wasm memory). Private pages are copied; pages of writable
   `MAP_SHARED` mappings move onto host pages both processes map
   (refcounted, PTE bit `PAGE_GROW`), so shared memory and its futexes work
   across fork while parent and child run concurrently. The child's kernel
   calls carry its pid; the page routes its signals by pid, turns its
   kernel termination into a SIGKILL of its System, and keeps the worker
   until the last process in it ends (a parent may exit first); its exec
   starts the program in a worker of its own. LTP's fork-sensitive tests
   (the ones the 0023 fallback broke): 22 of 24 pass with the flag, 1 of
   24 without. Limits: a multi-threaded child's other threads aren't
   reaped at its exit. Tests: `x86-engine.test.ts` "same-instance fork".
32. `alarm` and `setitimer(ITIMER_REAL)` are per process in the kernel (Blink
   used the host's one timer, shared by every process in an instance), so
   a child's alarm is its own and SIGALRM interrupts blocking calls like
   any signal. Test: `fixtures/x86/alarmfork.c`.
33. `prctl` `PR_SET_NAME`/`PR_GET_NAME` (per thread; perl's `$0 = ...` died
   with EINVAL) and `PR_CAPBSET_READ`; under tabcomputer `capget` reports every
   capability for uid 0 and none otherwise (Linux's version handshake), and
   `capset` accepts (libcap's `cap_get_proc` failed with ENOSYS). Test:
   `fixtures/x86/prctlcap.c`.
34. Futexes are keyed by host address, so a same-instance fork child and
   its parent meet on a `MAP_SHARED` futex; a same-instance child's extra
   threads end with it (`exit_group`, a kill); under tabcomputer `stat` and
   friends with a NULL buffer are EFAULT once the file is found (LTP
   fstat03). Tests: `fixtures/x86/shfutex.c`, `mtchild.c`, `statnull.c`.
35. `FUTEX_WAKE` wakes at most `count` waiters and returns how many (it
   woke every waiter and returned the waiter count; LTP futex_wake02), and
   a timed futex wait ends by the guest's clock, the absolute timeout's
   own clock for `FUTEX_WAIT_BITSET`, not by the condition variable's
   coarser realtime ticks (LTP futex_wait_bitset01 saw it end early).
   Test: `fixtures/x86/futexwake.c`.
36. Under tabcomputer a futex wait in a process's main thread shows the process
   sleeping (S in `/proc/PID/stat`) after its first polling tick, through
   `SYS_shiro_sleeping` (LTP waits for S before signalling a child:
   futex_wait03, futex_wait07); `FUTEX_WAKE` on an unmapped address is
   EFAULT; the main thread's tid is the kernel's pid, in a vfork-style
   child too (it was Blink's own). Kernel side: a syscall shows S once it
   has lasted 2 ms (a quick `sigaction` is R, as on Linux) and a fork child
   counts as running from the start. Test: `fixtures/x86/futexintr.c`.
37. More `prctl`: `PR_SET/GET_KEEPCAPS` (iputils' ping died with EINVAL),
   `PDEATHSIG`, `DUMPABLE`, `CHILD_SUBREAPER`, `NO_NEW_PRIVS` and
   `CAP_AMBIENT` are recorded and reported back, not enforced;
   `PR_CAPBSET_DROP` is accepted under emscripten. Test:
   `fixtures/x86/prctlcap.c`.
38. Under tabcomputer `mknod`/`mknodat` go to the kernel's `mknodat`, which
   makes FIFOs (and regular files) and refuses devices; with a kernel
   that has no `mknodat` they stay EPERM. Test: `fixtures/x86/mkfifo.c`
   (runs once the kernel defines `SYS_mknodat`).
39. `bsf`/`bsr` with a zero source leave the destination unchanged, all 64
   bits at every operand size, as hardware does (Blink wrote 0); LLVM's
   `ctlz`/`cttz` rely on it (`mov $127,%r8; bsr %rax,%r8; xor $63,%r8`),
   so Rust's `0u64.leading_zeros()` was 63 and xAI's grok CLI panicked.
   Interpreter, Blink's path JIT and the wasm JIT. Test:
   `fixtures/x86/bitscan.c` (native output).
40. SSE4.1 and SSE4.2 (legacy encodings, `blink/sse4.c`): blendv*,
   ptest, pmovsx/zx, pmuldq, pcmpeqq/gtq, packusdw, pmin/pmax*,
   phminposuw, round*, blend*, pinsr*/pextr*, insertps/extractps,
   dpps/dppd, mpsadbw, pcmpestri/estrm/istri/istrm, and crc32's r/m16
   form; CPUID advertises SSE4.1/4.2 (x86-64-v2 with popcnt and cx16).
   Bun (Claude Code's native build, opencode) and `GOAMD64=v2` Go need
   them. They run in the interpreter (the wasm JIT calls them). Tests:
   `fixtures/x86/sse4.c` (random operands, every immediate; hashes equal
   to native), a `GOAMD64=v2` Go program.
41. The wasm JIT compiles instructions that straddle a 4 KB page when
   both pages are read-only code (it ended the region before one and the
   interpreter ran up to the next taken branch, every time: 218k times in
   one Vim function); `rep movs`/`rep stos` of words, dwords and qwords
   (musl's memcpy and memset) go a page at a time going up. Test:
   `fixtures/x86/strops.c` (native output).
42. Under tabcomputer `sendfile` with a NULL offset reads at the input's file
   position (it read `*NULL`: EFAULT); systemd-sysusers' backup of
   `/etc/group` failed with it, and with that the postinst of systemd,
   cron, udev and logrotate. Test: `fixtures/x86/sendfile.c`.
43. Under tabcomputer `sendmmsg`/`recvmmsg` go to the kernel as one
   `sendmsg`/`recvmsg` per message (Blink's own failed with EBADF on kernel
   sockets, and glibc's resolver, which sends its A and AAAA queries with
   `sendmmsg`, gave up: pip couldn't resolve PyPI). Test:
   `fixtures/x86/mmsg.c` (two DNS queries over the kernel's DoH).
44. Under tabcomputer `/proc/self/maps` (and `/proc/thread-self/maps`, and the
   process's own `/proc/<pid>/maps`) come from the guest page table and
   Blink's file maps, in Linux's format, through a kernel pipe (up to 64
   KB): glibc's `pthread_getattr_np` finds the main stack there, and glibc
   builds of Bun (Claude Code, opencode) aborted without it. Test:
   `fixtures/x86/maps.c`.
45. `timerfd_create`/`timerfd_settime`/`timerfd_gettime` (they were ENOSYS;
   uSockets' timers in glibc Bun builds such as opencode) go to a kernel
   timerfd (`TimerFile` in `src/kernel/fd.ts`): readable through
   read/poll/epoll when it expires, counting interval expirations. Blink
   passes milliseconds and its own realtime/monotonic "now", so absolute
   times are read on the timer's clock. Test: `fixtures/x86/timerfd.c`.
46. Debugging aid: with `SHIRO_BLINK_CRASH=1` in a guest's environment a
   fatal signal is reported on its stderr through the kernel (signal, rip,
   fault address, the mapping rip is in, the code there, the words before
   the return address, registers, Blink's backtrace); `=2` also keeps the
   interpreter's last 1024 instructions (snapshot at the first fault or
   signal) and the signal deliveries, and `SHIRO_BLINK_PROBE=addr,...`
   logs registers and stack words at those addresses. Run with
   `BLINK_WJIT=0` to see every instruction. Test: `fixtures/x86/segv.c`.
47. `pop` to memory addressed through `%rsp` (`pop 0x88(%rsp)` in V8's
   builtins) computes the address after the pop moves the stack pointer;
   Blink computed it before (two arguments of one call, in an order up to
   the compiler) and wrote 8 bytes low, over a return address: Debian's
   `nodejs` crashed on any script (found with patch 46). Test:
   `fixtures/x86/popmem.c` (native output).
48. Same-instance fork is on by default (`BLINK_SAME_INSTANCE_FORK=0` gives
   the old fork: a new worker from a snapshot, or a vfork-style child on
   the parent's thread while writable `MAP_SHARED` memory is mapped).
   LTP's syscalls with it on: 197/320 against 155/320 (unix/conformance's
   A/B, no new failures or hangs).
49. `CLOCK_REALTIME` and `gettimeofday` have sub-ms resolution
   (`performance.now()` anchored to `Date.now()`, per thread). emscripten
   reads them from `Date.now()`, whole ms, so two reads microseconds apart
   could differ by 1 ms. vim's typeahead check (`inchar_loop` with
   `wtime` 0) then computes its wait as `0 - elapsed = -1`, which blocks
   until the next key with the typed one not yet shown: the vim stall
   (4/30 runs of shell-stdio's `vim-keys.mjs`, 2/60 after this patch; the
   rest are real ≥1 ms pauses between the two reads, which only a fix in
   vim avoids). `SHIRO_BLINK_PROBE` prints all 16 registers. Test:
   `fixtures/x86/realtime.c`.
50. `nanosleep`, `clock_nanosleep` and `pause`/`sigsuspend` (which Blink
   sleeps itself) show the process sleeping in `/proc/PID/stat`, as futex
   waits do (patch 36): LTP waits for `S` before signalling a child
   (pause01, signal01). Test: `fixtures/x86/sleepstate.c`.
51. A `FUTEX_WAKE` grant goes only to a waiter that was waiting at the
   wake. A thread or process that woke its peer and then waited on the same
   word at once (LTP checkpoints: the value never changes) could take its
   own grant and return, leaving the peer to time out (fork04, waitpid13).
   Test: `fixtures/x86/futexpingpong.c`.
52. `getsockname`/`getpeername` take the kernel's address length, so an
   abstract `AF_UNIX` name keeps its trailing NULs (LTP bind04/05);
   `AF_NETLINK` addresses are 12 bytes (nft's libmnl, glibc's
   `getifaddrs`, which looped forever); `readlink("/proc/self/exe")` asks
   the kernel, which resolves symlinks (ld.so's `$ORIGIN`: uv's Python
   venvs, aider); `fallocate` is `EOPNOTSUPP` (Go's linker falls back).
   Test: `fixtures/x86/sockaddrs.c`.
53. Exit: the guest's other threads end before the kernel hears
   `exit_group` (killed, futex waiters woken, kernel calls in flight
   answered `EINTR` by host.mjs's `shiroDying`, up to 0.5 s), and the
   exiting thread goes back to its event loop rather than proxy
   emscripten's exit to a main thread that never answers. A Worker with a
   thread parked in a wait takes Chromium 2 s to terminate: memory after
   `gh --version` comes back in ~0.1 s instead of ~2.1 s. `nanosleep`,
   `clock_nanosleep` and `pause` sleep in slices and end on a handled
   signal (with the time left: LTP nanosleep02). Test:
   `fixtures/x86/sleepintr.c`.
54. Sleeps keep time on `CLOCK_MONOTONIC` (emscripten's `CLOCK_REALTIME`
   counts whole ms, and glibc's `nanosleep` is
   `clock_nanosleep(CLOCK_REALTIME)`; an absolute realtime deadline is
   converted), and patch 50's sleeping mark is only taken for sleeps over
   5 ms, with its kernel round trips inside the sleep (off 3 ms before the
   deadline). LTP nanosleep01 and clock_nanosleep02 pass all rows again
   (they slept 0.4-1.3 ms too long).
55. A same-instance fork child's fatal signal gets the crash report too
   (`SHIRO_BLINK_CRASH=1`).
56. `clock_gettime`'s fast path in `OpSyscall` leaves `CLOCK_REALTIME`
   and `CLOCK_BOOTTIME` to the Shiro code: patch 49's sub-ms realtime
   only reached `gettimeofday` before (musl's `gettimeofday`, which
   Shiro's static vim uses, is `clock_gettime`). `SHIRO_BLINK_MMLOG=1`
   logs the guest's mmap/mprotect/munmap/mremap/madvise calls to its
   stderr; `=2` keeps the last 256 for the crash report (debugging aid).
57. Instructions that cross into the next code page go to the interpreter
   again, as before patch 41 (`BLINK_WJIT_STRADDLE=1` turns 41's decoding
   back on). With it, a forked child decoding `.xz` with liblzma's
   threaded decoder crashed in glibc's `_int_free` or reported corrupt
   data (Debian mode's dpkg-deb), in one binary layout of two. Bisecting
   by code address and by straddle site needs lzma_decode's three
   straddling instructions together; each runs right on its own. Not yet
   understood. No measurable cost on the x86 suite (vim_startup -3.5%,
   gh_version +0.1%, both "same").
58. `clock_nanosleep` (and so glibc's `nanosleep`) returns `EINVAL` for a
   negative or out-of-range timespec before sleeping, as Linux's
   `timespec64_valid` (LTP nanosleep04, broken by patch 54's path). Test:
   `fixtures/x86/sleepintr.c`.
59. `uname` takes the Shiro kernel's `release` and `version` too
   (`6.1.0-<hostname>`, `#1 SMP ...`; Node's `os.release()` said
   `4.5.0-blink-1.1.0`), keeping Blink's `sysname` and `machine`. Test:
   `fixtures/x86/uname.c`.
60. `syslog(2)` (klogctl) goes to the kernel's log, `SYS_syslog`: the read
   actions copy its text out (util-linux `dmesg -S`). From the unix/kernel
   session (their 0055, 9c3f7a1). Test: `debian.test.ts` dmesg.
61. `epoll_wait` takes any `maxevents` > 0 (at most 4096 events per call;
   Redis 8 passes maxclients + 128 and aborted on `EINVAL`), and the CPU
   clock ids from `clock_getcpuclockid`/`pthread_getcpuclockid` work, as
   the time since the first CPU-clock read (emscripten has no CPU clocks;
   GHC's `getCurrentThreadCPUTime` failed). Test: `fixtures/x86/cpuclock.c`.
62. `getpriority`/`setpriority` keep a nice value per process (0 to start,
   inherited on fork; raw `getpriority` is 20 − nice; only root lowers
   it, `EACCES` otherwise). emscripten's stubs said `-ENODEV`/`EPERM`, so
   pam_limits failed every `su`/`runuser` session. Test: `fixtures/x86/nice.c`.
63. uids and gids are the kernel's: `set*id`, `setgroups`, `setfs*id`,
   `getresuid/gid`, `getgroups`, `geteuid/getegid` go to it (real,
   effective and saved ids and groups per process) instead of Blink
   answering success with real = effective; a kernel without them
   (`ENOSYS`) gets the old answers, and root checks use the effective uid.
   `signalfd`/`signalfd4` go to the kernel, which now learns the process's
   signal mask (the main thread's: before a kernel call when it changed,
   right after `rt_sigprocmask`/`rt_sigreturn`/`rt_sigsuspend`, and around
   sigsuspend's wait), so a blocked signal is held for signalfd instead of
   being delivered, dropped or fatal. For PostgreSQL (initdb, its latch).
   Tests: `fixtures/x86/ids.c` (needs the kernel's `SYS_setresuid`),
   `fixtures/x86/signalfd.c`.
64. `SHIRO_BLINK_PROFILE=<file>` writes where a guest's time goes: the wall
   time, the JIT's compile time and count, and per syscall number its
   count, total and longest time (with its kernel call and waits), every
   5 s and at the first read of stdin (a TUI's prompt is up). Debugging
   aid, for profiling programs where they run.
65. Direct channels (opt-in, `TABCOMPUTER_BLINK_DIRECT=1`): host.mjs puts
   four kernel channels in Blink's own wasm memory, and the page serves
   them by watching their state words
   (`KernelChannel.watch`, the way WASI guests' channels are served).
   A guest thread's own calls go straight to the kernel with no message
   through host.mjs either way: getppid's round trip in Node falls from
   ~110 µs to ~10 µs. Calls for a vfork child (`as` ≠ 0), and calls made
   while all four channels are busy, still go through the pool. A thread
   waiting on a direct channel while Blink holds a signal for it asks the
   page (`blink-kick`) to interrupt the process's blocking calls: the
   signal can reach the kernel just before the call does, with nothing in
   progress for it to interrupt (cmake hung in `epoll_wait` that way).
   Off by default: the page then holds the worker's wasm memory, so (we
   think) a finished process gives it back only at the page's next GC. In Chromium
   that is +10–17 MiB peak RSS for vim and Go's net/http, against 11–17%
   less time (docs/BENCHMARKS.md, perf-blink 7).
66. `SHIRO_BLINK_PROFILE` also writes:
   - per thread: time holding the GIL (running), time waiting for it, time
     in syscalls and in futex, compiled blocks entered and instructions
     interpreted;
   - a 1-ms sample of where the GIL holder is (a compiled block's entry or
     an interpreted instruction);
   - the most interpreted addresses and opcodes.
   The prompt label also fires on TCSETS of fd 0 and on `epoll_ctl(ADD, 0)`.
67. `getcpu(2)` reports CPU 0, node 0. An instruction fetch from the unmapped
   legacy vsyscall page (`0xffffffffff600000`) reads stubs that make the
   gettimeofday, time and getcpu syscalls, as Linux emulates them (HotSpot
   calls the page's getcpu when `sched_getcpu` fails). CPUID leaf 1 reports
   family 6, model 0x5e (OpenCV reads the family before the feature bits).
   An ELF whose name ends in `.bin` loads as an ELF, not a flat binary
   (LibreOffice's `soffice.bin`).
68. The host pages several processes map (MAP_SHARED across a same-instance
   fork) are counted in a hash table, not an array searched end to end:
   forking a process with 128 MiB of shared memory went from 1.3 s per fork
   to ~13 ms.
69. System V shared memory: shmget and shmctl go to the kernel, which keeps
   the segments (ids, permissions, attach counts, 1013/1014). shmat maps one
   set of host pages per shmid, shared by every attacher in the instance, so
   a same-instance fork child inherits the attachment and its bytes. shmdt
   unmaps, and exec and exit drop a process's attachments. A segment's pages
   go once the kernel has destroyed it. Processes in other Blink instances
   (a separate worker) can't share a segment. Test: fixtures/x86/sysvshm.c
   (with POSIX shm across fork).
70. `sysinfo(2)` is the kernel's: uptime, loads, and the same memory totals
   `free` and /proc/meminfo report. A kernel without it gets Blink's own
   answer. SHIRO_BLINK_PROFILE's address table has 2^17 slots, and addresses
   that find none are counted apart; they used to be lumped into slot 0,
   which made one address look like 95% of the time. An engine abort's
   report (the guest's stderr and dmesg, "blink: aborted …") ends with the
   last lines of Blink's own stderr, so an assertion names its file and line.
   `vendor/blink/blink.symbols` (wasm function index → name, from
   `--emit-symbol-map`) comes with each build, for naming `wasm-function[N]`
   frames in a stack.
71. SHIRO_BLINK_PROFILE says why instructions ran interpreted: not at a branch
   target, first visit, below the compile threshold (200), or a failed
   compile. In gh --version, 6.8 M of 7.9 M interpreted instructions are
   warm-up: a block's entry below the threshold, then the instructions after
   it up to the next branch.
72. After an instruction compiled code stopped at (one straddling a page since
   patch 0057, an unsupported op), the next instruction is tried as an entry,
   instead of interpreting everything up to the next taken branch. Neutral on
   the x86 suite (A/B, all "same").
73. `sqrtpd` computes in double precision: it read and wrote each double as
   32 bits. The float → int conversions (`cvt(t)sd2si`, `cvt(t)ss2si`, the
   packed ones) give x86's integer indefinite (the most negative value) for
   NaN and out-of-range input, instead of C's undefined result (wasm
   saturates). Rust's `as` casts test for that value, and librsvg drew every
   gradient transparent. Test: fixtures/x86/sse2d.c, compared with native
   output, JIT on and off.
74. SHIRO_BLINK_PROFILE times each compiled-code entry, giving a per-thread
   "in compiled code ms" (the JIT's compiles included; see the header line),
   and splits the 1-ms samples by kind. In gh --version, the main thread runs
   4.8 s, of which 3.0 s is compiled code (0.67 s of it compiling) and ~1.8 s
   is the interpreter, at ~290 ns per instruction with the profile's own
   overhead.
75. A woken futex waiter stops counting as a waiter as soon as it takes its
   wake. It used to stay counted until SysFutexWait ended, after letting go
   of the lock and making a kernel round trip, so a FUTEX_WAKE in between
   counted it twice. A waker that counts its wakes, like LTP's checkpoints,
   then stopped early and the last waiter timed out: waitpid08/10, 3 to 5
   rounds in 10 of fixtures/x86/futexckpt.c. LTP waitpid went from 4/11 to
   8/11.
76. ppoll, pselect6 and epoll_pwait(2) apply their signal-mask argument; they
   used to ignore it. A signal the call lets through is delivered with the
   caller's mask saved in its frame, as after sigsuspend; otherwise the
   caller's mask is restored when the call returns. An interruptible kernel
   call also takes a signal that the mask it just sent released (LTP ppoll01).
77. System V semaphores are forwarded to the kernel's (unix/perf-kernel):
   `semget`, `semop` and `semtimedop`, which block in the kernel, and
   `semctl`, with its SETVAL int, the GETALL/SETALL arrays (sized by an
   IPC_STAT) and the semid_ds/seminfo structs. SEM_UNDO is applied by the
   kernel at process exit. Test: fixtures/x86/sysvsem.c, identical to native
   output (Audacity's single-instance lock).
78. A failed assertion's text goes to host.mjs through a synchronous call to
   the main runtime thread (`Module.shiroNote`) before the abort. A guest
   thread's stderr never reached host.mjs, so "blink: aborted" had arrived
   without the file:line.
79. System V message queues are forwarded to the kernel's: `msgget`,
   `msgsnd`/`msgrcv` (mtype plus text; they block in the kernel) and
   `msgctl`. Test: fixtures/x86/sysvmsg.c, identical to native output.
80–82. unix/conformance's patches, folded into this series:
   - LTP errnos: clock ids, getrlimit, iov lengths, waitid options, fchown
     on O_PATH, personality, CLONE_PARENT, sigpending;
   - record locks, pipe sizes and RLIMIT_NOFILE handled by the kernel;
     EFAULT for read-only output buffers; fd checks;
   - /proc/self/maps as a kernel memfd; nanosleep's rem written before the
     signal frame.
85. From one compiled block straight to the next: after a block, WjExecute
   runs the next one directly when it has code (an indirect jmp's target, a
   block cut at its length). It does up to 64 blocks before going back
   through Actor's loop, and stops for signals, a JIT epoch change, or
   another thread wanting the GIL. A computed-goto bytecode loop, one block
   per op like JSC's LLInt, went from 131 to 92 ns per op (2 ns native, 660
   ns interpreted). The x86 suite A/B is unchanged ("same" everywhere).
83–84. unix/conformance's: raise(SIGKILL)/raise(SIGSTOP) and
   rt_sigqueueinfo/rt_tgsigqueueinfo go to the kernel (as kill).
86. unix/conformance's: POSIX message queues go to the kernel
   (mq_open … mq_getsetattr).
87. rt_sigtimedwait (sigwait, sigwaitinfo, sigtimedwait) goes to the kernel's
   new call 128. It takes the lowest pending signal of the set that the
   process blocked, without running a handler. Blink first takes one sent to
   this thread (pthread_kill), and waits in the kernel in slices of at most
   50 ms so it sees those too. It returns EAGAIN at the timeout and EINTR
   for a signal let through. VLC's main thread sigwaits and quit at once on
   ENOSYS. Test: fixtures/x86/sigwait.c, identical to native output.
88. SHIRO_BLINK_PROFILE samples its timing. 1 in SHIRO_BLINK_PROFILE_EVERY
   (default 64) compiled entries is timed, with any compile left out. 1 in N
   interpreted instructions goes in the address and opcode tables. Both are
   scaled by N. Timing every entry slowed native Claude's startup by 55%
   and inflated its "in compiled code" share. After 0085, "blocks run"
   counts entries, each running up to 65 blocks.
89. unix/conformance's: POSIX timers go to the kernel; sched_* answers as
   Linux's (sched_getparam wrote 8 bytes into the 4-byte struct).
90. FUTEX_REQUEUE and FUTEX_CMP_REQUEUE (they were EINVAL). Up to `val`
   waiters are woken, and up to `val2` more move to uaddr2. The moved ones
   count at uaddr2 at once, so a wake there right after finds them. Each
   steps over when it next looks, keeping its timeout. A waiter that leaves
   (timeout, signal) while a move is meant for it steps over and leaves from
   there, so the counts stay right. LTP futex_cmp_requeue02/03 pass.
   futex_cmp_requeue01 passes its 10- and 100-waiter cases, but 1000 forked
   waiters don't fit its 30 s. Test: fixtures/x86/futexrequeue.c, identical
   to native output.
91. A thread running a vfork child takes no signals until the child execs
   or exits, as on Linux, where the parent sleeps in vfork. Before, Go's
   SIGURG (sysmon preemption) for the forking thread was delivered to the
   child with the parent's handlers. Go's runtime threw "signal received
   during fork" and the parent wedged with unreaped children (toolchains'
   `go run` hang). perf-kernel's gowait stress (60 rounds of 8 parallel
   os/exec children, BLINK_FORK_STRESS=1) failed before; it passed 3 of 3
   runs after.
92. Same-instance fork keeps page lock counts. Fork turns the parent's
   MAP_SHARED pages into shared host pages. It moved each onto a fresh page
   with a plain PTE store, dropping the lock count of a thread blocked in
   the kernel on that page (a futex waiter in sem_wait). Its release then
   failed `entry & PAGE_LOCKS` in memory.c (Open POSIX fork_21-1,
   pthread_attr_destroy_1-1, about 1 run in 3). A page of its own is now
   shared in place, with no copy and no free under a user. Block and
   reserved pages still move, with a CAS that keeps the count. The child's
   copies of the PTEs start with no locks; it inherited the parent's and
   waited on them as it exited. fork_21-1 passes 12/12 and
   pthread_attr_destroy_1-1 6/6.
93. unix/conformance's: rt_sigqueueinfo hands its siginfo to the kernel; sched_*
   take a thread's tid as the caller's own.
94. FUTEX_WAKE_OP and the priority-inheritance futex ops (LOCK_PI,
   LOCK_PI2, TRYLOCK_PI, UNLOCK_PI) were EINVAL. glibc aborts on that ("The
   futex facility returned an unexpected error code") for
   PTHREAD_PRIO_INHERIT mutexes, which TBB, OpenEXR and Blender use. The
   word holds the owner's tid; a contended locker sets FUTEX_WAITERS and
   waits on the word. It takes it with FUTEX_WAITERS when it had to wait,
   so its unlock comes back to wake the rest. EDEADLK for the owner, EPERM
   for an unlock by a non-owner, timeouts absolute as on Linux; priority
   inheritance itself is a no-op. Test: fixtures/x86/futexpi.c (raw ops, 4
   threads on a PI mutex, a timed lock), identical to native output.
95. Signals carry their siginfo. A signal from the kernel arrives as a
   number on a reply. Blink asks the kernel's call 1030 for its siginfo
   (si_code, sender pid/uid, sigqueue's value, a timer's overrun) before
   rt_sigreturn: in C for direct channels, in host.mjs for the pool and
   the loader's channel. It keeps each one until the signal is delivered,
   when it goes into the SA_SIGINFO frame. Each queued instance of a
   real-time signal stays pending until all are delivered, in order.
   Found on the way: EnqueueSignal used `1ul << (sig - 1)`, and long is
   32 bits in wasm32, so signal 34 (SIGRTMIN) became bit 1, SIGINT. Every
   real-time signal killed the process with status 130 (the Open POSIX
   sigqueue tests' 130/160 exits). Test: fixtures/x86/siginfo.c,
   identical to native output. An older kernel without 1030 gets the
   number-only frames as before.
100. Instructions that cross into the next code page are compiled again
   (patch 41's decoding, which 57 had turned off), when that page can't
   change either. 57's failure, liblzma's threaded decoder crashing in a
   forked child in one binary layout, no longer reproduces: 20 of 20 runs
   decode right. Left to the interpreter, a straddler inside a hot loop
   made every pass leave compiled code for one instruction and come back.
   agent-clis' sampled profile of native Claude's startup shows such loops
   (0x434cffe: 461 k interpreted passes). BLINK_WJIT_STRADDLE=0 gives 57's
   behaviour. The x86 suite A/B is unchanged ("same" everywhere).
101. SHIRO_BLINK_MMLOG=3 logs, besides the mappings, each write, pwrite
   and pwritev to a file (fd > 2): source address, length, offset and the
   first 16 bytes as Blink gathered them. It shows whether data a file
   lost (PostgreSQL's zeroed WAL page) left Blink intact.
102. MAP_HUGETLB is ENOMEM, as on Linux with no huge pages reserved.
   PostgreSQL's huge_pages=try then maps ordinary pages; Blink used to
   accept the flag silently. Test: fixtures/x86/hugetlb.c.
103. SHIRO_BLINK_PROFILE also lists compiled code's calls to Blink's
   handlers (the instructions not inlined), by count.
104. rol/ror by a constant are inline: 8-, 32- and 64-bit, registers and
   memory, with CF/OF as alu.c's Rol/Ror. 16-bit and by-%cl rotates still
   call.
105. Hint nops (0F 18–1E, including endbr64 at every function of a CET
   build) and prefetch are inline as nothing.
106. SSE2/SSSE3 integer ops with a 66 prefix are inline as wasm SIMD:
   padd/psub b/w/d/q, pand/pandn/por/pxor, pcmpeq/pcmpgt b/w/d,
   pminub/pmaxub, punpck{l,h}{bw,wd,dq,qdq}, pshufd, pshufb (selector
   bytes with the top bit set give 0), palignr up to 16, psrl/psra/psll
   w/d/q and psrldq/pslldq by immediates (counts past the lane width as
   on x86), pmovmskb. Memory operands must be 16-byte aligned: otherwise
   the interpreter runs the instruction and raises the #GP.
107. movaps/movapd/movdqa with a memory operand are inline, with the same
   alignment check. OpenSSL's SSSE3 SHA-1 runs 5x faster (3300 → 650 ms
   for 16 MB); see BENCHMARKS.md "unix/perf-blink 11". Tests:
   fixtures/x86/rotates.c and ssei.c, identical to native.
108. comisd/ucomisd/comiss/ucomiss clear AF along with OF and SF, as x86
   does (Blink left AF alone). Found by fixtures/x86/ssefloat.c: scalar
   double ops (arithmetic, min/max, the eight cmpsd predicates, sqrt,
   cvt* to 32/64-bit, roundsd in all modes, movmskpd) over NaN, ±inf, ±0,
   denormals and integer limits. Now identical to native in the
   interpreter and in compiled code.
109. Same-instance fork shares private pages copy-on-write. A writable
   page of its own becomes a refcounted shared host page (PAGE_GROW), read
   only, with PAGE_COW and PAGE_COWRW (the mapping's write intent); parent
   and child map the same page. Pages a thread holds locked in a system
   call are still copied. Blink writes through a resolved pointer on many
   paths without checking PAGE_RW. So any address it resolves in a COW
   page (LookupAddress2: interpreter, system calls, string ops, stack)
   gives the process its own copy first, or the page itself once nobody
   else maps it. It copies before dropping the reference and swaps the PTE
   with a CAS. Only compiled code's inline reads keep sharing: its writes
   miss its write cache and come back through the interpreter.
   - mprotect keeps COW pages read-only and records write intent in
     COWRW.
   - madvise(DONTNEED) breaks COW first, then zeros.
   - mremap, /proc/self/maps and IsValidMemory count COWRW as writable.
   - The JIT doesn't treat a COW page as fixed code.
   - Blink's own writes (futex words, clear-tid, robust lists, CopyToUser)
     resolve with LookupAddressWrite.
   - BLINK_FORK_COW=0 gives the copying fork.
96–98. unix/conformance's:
   - 0096: a blocked real-time raise() queues in the kernel;
     sigprocmask leaves SIGKILL/SIGSTOP out; sigaltstack modes as on
     Linux.
   - 0097: mprotect(PROT_WRITE) keeps the page readable.
   - 0098: writable shared mappings of kernel files are written back
     before a new mapping reads the file, and at exit.
110. A same-instance child's signals carry their siginfo too: host.mjs
   makes call 1030 as the child, and blink_shiro_signal_pid_info queues it
   on the child's System. Open POSIX sigqueue_1-1 (the child's handler
   checks si_value) passes. Test: fixtures/x86/siginfochild.c.
111. memfd_create goes to the kernel's (Blink answered ENOSYS): Firefox's
   shared memory, Mesa, Wayland and PulseAudio make their buffers with
   it. Test: fixtures/x86/memfd.c. (Another process mapping the same
   memfd afresh doesn't see its writes yet; 0112 fixes that.)
112. Objects shared with other Blink instances (shmobj, the Blink half of
   docs/research/SHARED_MAPPINGS.md). A MAP_SHARED mapping of a /dev/shm
   file or a memfd asks the kernel for a shared object (call 1020, kind
   0x100: remote from the first mapper, so nobody has to publish). Its
   bytes live in the kernel's SharedArrayBuffer, which the instance's
   host.mjs thread holds.
   - Blink maps shadow pages marked PAGE_REMOTE (bit 48). No TLB caches
     them, the JIT's included: compiled code leaves the instruction to the
     interpreter. Every access comes through LookupAddress2.
   - An instruction locks the object (a control word after its bytes) and
     copies the page in, in one call to the host thread. The thread keeps
     the lock and the page for the next instructions, a lease of at most
     0.5 ms, released before any system call or GIL hand-off. Then it
     writes the pages back and unlocks. Lock-prefixed instructions are
     atomic across instances. A thread waiting for the lock sleeps on a
     wake from the host thread (Atomics.waitAsync), and newcomers let
     waiters go first.
   - A system call may block, so it locks only around its copies. It
     writes back what it changed, diffed against what it read.
   - FUTEX_WAIT/WAKE on a remote word wait and wake on the buffer itself,
     so a wake crosses instances.
   - munmap, exit and same-instance fork keep the kernel's mapping counts.
   - BLINK_SHMOBJ=0 maps such files as private copies, as before.

   Tests:
   - fixtures/x86/psem.c: sem_open, with an exec'd process posting (was
     it.fails).
   - fixtures/x86/shmobj.c: a memfd mapped again by an exec'd process,
     2×2000 lock xadds plus a PROCESS_SHARED mutex, and 50 semaphore
     ping-pongs. Counts exact with and without the JIT, 0.8 s for the
     whole program. The first version, a call per access and no lease,
     took 24 s.
   - shmobj.test.ts: the kernel side of kind 0x100, memfd keys and the
     control page.

   Costs and gaps:
   - A cross-instance semaphore round trip is ~6 ms (native: 0.08 ms).
   - read()/write() on a memfd go through the buffer while it's remote
     (perf-kernel's side). A /dev/shm file's don't yet.
   - SysV shm between instances still uses a copy per instance.
0500. unix/conformance's mlock/munlock/mlockall and mmap argument errors
   (Open POSIX mlock_8-1, munlock_10-1, mlockall_13-1, mmap_21-1, 23-1,
   24-2). Numbered from 0500 so the two branches never renumber each
   other.

   fork+exit+wait with 16 MiB of dirty heap went from 30 to 7.5 ms, and
   with 64 MiB from 104 to 12 ms (native: 3.1 ms). Test:
   fixtures/x86/cowfork.c covers:
   - heap, brk, .data, mmap and stack views on both sides after either
     writes;
   - a signal frame in the child;
   - mprotect, madvise and mremap after fork;
   - a grandchild, 8 children, and exec.

   It matches native, and the gowait stress, the xz threaded decode, Open
   POSIX fork_21-1 and the LTP fork/mm subset are unchanged.

The page compiles blink.wasm once and gives the `WebAssembly.Module` to every
Blink worker (src/x86-engine/blink.ts `blinkWasmModule`, host.mjs
`instantiateWasm`). V8 keeps a module's optimized code only while something
holds the module. Once finished workers ended promptly (patch 0053), the next
process compiled blink.wasm again and ran on Liftoff code: go_hello +62%.
`TABCOMPUTER_BLINK_SHARED_MODULE=0` makes each worker fetch and compile it
itself.

The guest's kernel calls go over a pool of channels (`src/x86-engine/blink.ts`
→ `public/engines/blink/host.mjs`). It starts at 6, and host.mjs asks the
page for another (up to 64) while all are busy. Before, more threads or
same-instance fork children blocked in the kernel than channels held up
every other call of the instance (epoll_wait15/16). Test:
`fixtures/x86/blockedkids.c`.

Patches 13, 15–21 and 24–26 come from unix/compat-tools (15 also from
unix/conformance); this branch is where the series is kept now.

Native Blink's own exit path (`KillOtherThreads`) still hangs after
multi-threaded Go programs; the wasm build doesn't use it.

### Limits today

- Needs `crossOriginIsolated` (pthreads and the kernel channel use
  SharedArrayBuffer). tabcomputer.com is isolated (`server.mjs` sends
  COOP/COEP); on a page that isn't, `./binary` uses src/x86.
- The JIT compiles per thread and per run (nothing is cached across
  processes yet), and cold code still runs in the interpreter; most
  SSE/x87, string ops, xadd/cmpxchg and 16-bit shifts still call Blink's
  handlers.
- Memory: wasm32, 4 GB max. File mappings are now one copy inside Blink, but
  the binary is still copied on its way in (tabcomputer's FS, the kernel read,
  MEMFS).
- Non-loopback TCP needs the relay (`TABCOMPUTER_TCP_RELAY`); without it `connect`
  fails like an offline host.
- Signals sent before the guest has loaded are dropped. SIGTSTP is the
  kernel's default stop; a guest can't catch it.
- The worker doesn't use the kernel's new `symlink`/`chmod` yet.
- One guest thread runs at a time (GIL).

## What agy still needs

Honest estimate for a ~200 MB static Go CLI that talks TLS to Google APIs:

1. **Cross-origin isolation in production.** Done: tabcomputer.com is
   isolated. Without it the engine doesn't start.
2. **A TCP relay deployed.** Done: tabcomputer.com runs it (Go's own DNS and
   TLS run over the kernel's sockets). Since Blink patch 0040, `agy --version`
   runs (11 s); a request needs a Google sign-in and is untested
   ([COMPAT.md](COMPAT.md#agent-clis-unixagent-clis)).
3. Interactive use works today (tty, raw mode, SIGWINCH, Ctrl-C).
4. **Speed**: with the wasm JIT, `gh` (59 MB) prints its version in 5.0 s
   (first run) / 2.5 s (later runs) in Chromium on a machine where the
   interpreter took 27 s (20 s on the faster machine of earlier rounds).
   Startup scales with the code that runs at init rather than with the file
   size. If agy's init runs 2–3x as much code as gh's, expect roughly
   10–15 s for its first run in a page and 5–8 s for later runs (an
   estimate from gh, not measured), and hot CPU-bound code at 2–5x native
   instead of ~120x (Go loop 50M: 253 ms vs 107 ms native; mul/div loop
   4–5x).
   Since then (Blink patches 0085–0111): compiled blocks chain without
   leaving the JIT, SSE2/SSSE3 integer code, rotates and hint nops are
   compiled (SHA-1 5 → 25 MB/s), and fork is copy-on-write (64 MiB parent:
   104 → 12 ms). From before the JIT to now, the x86 suite reads go_cpuloop
   2282 → 246 ms and Go/glibc peak RSS −50–94% (BENCHMARKS.md, perf-blink
   13). A larger data point: Claude's native ~200 MB single-file binary
   (a JavaScript runtime plus its bundle) starts in ~48 s, 87% of it in
   compiled code. That is far more init code than a Go CLI, so it bounds
   agy from above rather than replacing the estimate: still 10–15 s first
   run, 5–8 s later, unmeasured.
   Next levers: the interpreter for cold code (≈1.1 s of `gh`'s 3.3 s in
   Node: Blink's per-instruction dispatch and memory helpers), keeping
   compiled regions across page loads (V8 already reuses them within one
   page), smaller wasm per guest instruction (≈80 bytes now; Liftoff
   compile time and first-run speed follow it), and snapshotting a guest
   after runtime init.
5. Memory: the wasm heap peaks at 117 MB for `gh` (the mapped 50 MB binary
   plus Go's heap; the file's bytes otherwise live in JS memory, outside the
   4 GB wasm32 limit), so a 200 MB binary with a few hundred MB of Go heap
   fits with room to spare. The JIT adds no wasm heap; V8's code for the
   compiled regions is outside it (Node's process peak for `gh` went from
   278 to 426 MB).

Blink makes agy *possible* in tabcomputer; with the wasm JIT its start should be measured in seconds rather than a minute.

## Reproducing

```bash
EMSDK=/path/to/emsdk vendor/blink/build.sh          # rebuild public/engines/blink
cd tests && npx vitest run --config vitest.config.ts tests/shiro-vitest/x86-engine.test.ts
# Chromium numbers: serve the app with COOP same-origin + COEP credentialless,
# build the vendor/blink/bench programs (CGO_ENABLED=0 go build / musl-gcc -static)
# into $BENCH_DIR, then:
BENCH_DIR=... node vendor/blink/bench/chromium.mjs http://localhost:5199/ "./hello-go;./cpuloop 5000000"
```
