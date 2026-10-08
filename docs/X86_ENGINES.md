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
build now has its own JIT (patch 0012, x86-64 to WebAssembly): a hot Go loop
runs at about 2–3x native and `gh --version` takes 6.3 s on its first run
in a page and 3.2 s after that, in Chromium (27 s interpreted on the same
machine). See "The wasm JIT" and "What agy still needs".

## Candidates

| Engine | amd64 | Kind | License / can Shiro ship it | SAB needed | Go hello | Go cpuloop 50M (native 107 ms) | Go net/http (loopback) |
|---|---|---|---|---|---|---|---|
| **Blink → wasm (this branch)** | yes | user-mode syscalls | ISC, yes (self-hosted, 550 KB wasm) | yes (pthreads) | **0.17 s** per process | **0.25 s wall (2.4x native) with the wasm JIT**; 12.8 s (~120x) interpreted | **works**, 0.34–0.37 s |
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

| Program | Blink-wasm + JIT, Chromium | interpreter only (same machine) | round 1 | Native | src/x86, Chromium |
|---|---|---|---|---|---|
| static musl C hello (38 KB) | 77–96 ms (first run 158 ms) | 102–107 ms | 92–132 ms | 1 ms | 25–88 ms |
| static glibc C hello (785 KB) | 94–104 ms (first run 133 ms) | 116 ms | 123–149 ms | 1 ms | fails: `Unknown two-byte opcode: 0F 62` |
| static Go hello (1.4 MB) | 171–173 ms (first run 202 ms) | 237–245 ms | 477–620 ms | 2 ms | fails: `float64nan` |
| Go goroutines + net/http server and 4 clients | 343–371 ms (first run 531 ms) | 470–487 ms | 1.1–1.6 s | 5 ms | fails: `float64nan` |
| Go TLS 1.3 handshake + 3 HTTPS requests over loopback (9.5 MB) | 572 ms (first run 791 ms) | 0.96–1.06 s | 1.6–1.8 s | 5 ms | — |
| C loop, 5M iterations (wall at the prompt) | 112 ms | 1.41 s | 1.57–1.70 s | 10 ms | 29.8 s |
| Go loop, 5M iterations (wall at the prompt) | 175 ms | 1.82 s | 1.91–2.04 s | 10 ms | fails |
| Go loop, 50M iterations (wall at the prompt) | 253 ms | 14.4 s | 21.7 s | 107 ms | fails |
| C mul/div/bit-op loop, 10M iterations (`vendor/blink/bench/arith.c`) | 173–190 ms (first run 297 ms; 2.5–2.8 s before the ops were inlined) | 9.7 s | — | 40 ms | — |
| `gh --version`, GitHub CLI 2.62 (59 MB static Go): first run in the page | 5.0 s | 26.7 s | — | 71–79 ms | — |
| same, later runs (V8 reuses the compiled regions) | 2.5 s | 26.6 s | 20.3–20.9 s | | |
| same, Node (`run.mjs`-style host, no kernel), wall / peak RSS | 3.2–3.6 s / 374 MB | 28.5 s / 278 MB | 32.7 s / 999 MB | | |

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
decoded on most visits; 4096 entries (patch 0020, 160 KB per thread) cut
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
   Shiro the guest's fd, filesystem and process syscalls go to the Shiro
   kernel through `shiro_ksys()` (`vendor/blink/shiro-kernel.js`), so guest
   fd N is kernel fd N. `vfork`/`clone(CLONE_VFORK)` run the child on
   the calling thread until it calls `execve` or `_exit` (vfork semantics; the
   kernel creates the child with `SYS_shiro_vfork`). `fork` worked the same
   way until patch 14. `execve` goes through `SYS_shiro_execve`: an ELF is reloaded
   in this Blink, anything else (WASM, scripts, Shiro builtins like
   `/bin/sh`) replaces the worker in the same process. `rt_sigaction`
   mirrors the guest's dispositions into the kernel (caught signals are
   forwarded, ignored ones stay ignored across exec). File `mmap` reads the
   file through the kernel into an anonymous mapping (`MAP_SHARED` writable
   ones are written back on `msync`/`munmap`). `statx`, `waitid` (with
   `WNOWAIT`), `eventfd`, `close_range`, `sendfile`, `readv`/`writev` (one
   transfer) and the tty ioctls (`TIOCSCTTY`, `TIOCGPTN`, ...) are covered;
   locks (`fcntl F_SETLK`, `flock`) always succeed.
12. The wasm JIT (`blink/wjit.c`), described above.
13. Under Shiro a stop signal's default action stops the process.
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
   calling thread exists in the child; a `MAP_SHARED` file mapping becomes
   a private copy. Tests: `fixtures/x86/fork.c` (fork-musl) and
   `forkcopy.c` in `x86-engine.test.ts`, the perl cases in
   `compat-dev.test.ts`.
15. File mmap of a kernel fd no longer takes `mmap_lock` twice (it
   deadlocked every such mmap).
16. `madvise(MADV_DONTNEED)` zeroes private anonymous pages (jemalloc).
17. `pextrw` zero-extends into the whole destination register.
18. `FUTEX_WAIT_BITSET`/`FUTEX_WAKE_BITSET`; `getrandom(GRND_INSECURE)`.
19. sendmsg/recvmsg pass control data (`SCM_RIGHTS`), `sockaddr_un`
   lengths, `SO_PEERCRED`.
20. `lzcnt` returns the leading zero count (it returned `bsr`'s bit index);
   the 32-bit one-operand `imul` zero-extends `%rdx` (it stored the
   sign-extended high half in all 64 bits); a 4096-entry decoded-instruction
   cache (was 512).

Patches 13 and 15–19 come from unix/compat-tools (15 also from
unix/conformance); this branch is where the series is kept now.

Native Blink's own exit path (`KillOtherThreads`) still hangs after
multi-threaded Go programs; the wasm build doesn't use it.

### Limits today

- Needs `crossOriginIsolated` (pthreads and the kernel channel use
  SharedArrayBuffer). On shiro.computer that depends on the unix/isolation
  branch; until then `./binary` uses src/x86.
- The JIT compiles per thread and per run (nothing is cached across
  processes yet), and cold code still runs in the interpreter; most
  SSE/x87, string ops, xadd/cmpxchg and 16-bit shifts still call Blink's
  handlers.
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
4. **Speed**: with the wasm JIT, `gh` (59 MB) prints its version in 5.0 s
   (first run) / 2.5 s (later runs) in Chromium on a machine where the
   interpreter took 27 s (20 s on the faster machine of earlier rounds).
   Startup scales with the code that runs at init rather than with the file
   size. If agy's init runs 2–3x as much code as gh's, expect roughly
   10–15 s for its first run in a page and 5–8 s for later runs (an
   estimate from gh, not measured), and hot CPU-bound code at 2–5x native
   instead of ~120x (Go loop 50M: 253 ms vs 107 ms native; mul/div loop
   4–5x).
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

Blink makes agy *possible* in Shiro; with the wasm JIT its start should be measured in seconds rather than a minute.

## Reproducing

```bash
EMSDK=/path/to/emsdk vendor/blink/build.sh          # rebuild public/engines/blink
cd tests && npx vitest run --config vitest.config.ts tests/shiro-vitest/x86-engine.test.ts
# Chromium numbers: serve the app with COOP same-origin + COEP credentialless,
# build the vendor/blink/bench programs (CGO_ENABLED=0 go build / musl-gcc -static)
# into $BENCH_DIR, then:
BENCH_DIR=... node vendor/blink/bench/chromium.mjs http://localhost:5199/ "./hello-go;./cpuloop 5000000"
```
