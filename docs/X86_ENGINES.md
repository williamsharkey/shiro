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
build has no JIT, so CPU-bound code runs about 200x slower than native, and a
large Go binary needs tens of seconds to start. See "What agy still needs".

## Candidates

| Engine | amd64 | Kind | License / can Shiro ship it | SAB needed | Go hello | Go cpuloop 50M (native 107 ms) | Go net/http (loopback) |
|---|---|---|---|---|---|---|---|
| **Blink → wasm (this branch)** | yes | user-mode syscalls | ISC, yes (self-hosted, 448 KB wasm) | yes (pthreads) | **0.48–0.62 s** per process | **21.7 s (~200x)** | **works**, 1.1–1.6 s |
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
- JSLinux and container2wasm interpret faster than Blink-wasm (2.4–2.9x on the
  loop). JSLinux can't be embedded without a license from its author;
  container2wasm needs Docker to build 145 MB+ images per container and runs
  one vCPU with a virtual clock.
- CheerpX has a fast x86→wasm JIT but is 32-bit only, and its license
  forbids self-hosting outside a commercial agreement and use in a competing
  product.

## Blink in detail

### What runs

Measured end to end through Shiro's shell (`./binary`, a kernel process in a
Worker), in Chromium on a cross-origin isolated page, three runs each:

| Program | Blink-wasm, Chromium | Native | src/x86, Chromium |
|---|---|---|---|
| static musl C hello (38 KB) | 92–132 ms | 1 ms | 25–88 ms |
| static glibc C hello (785 KB) | 123–149 ms | 1 ms | fails: `Unknown two-byte opcode: 0F 62` |
| static Go hello (1.4 MB) | 477–620 ms | 2 ms | fails: `float64nan` |
| Go goroutines + net/http server and 4 clients | 1.1–1.6 s | 5 ms | fails: `float64nan` |
| Go TLS 1.3 handshake + 3 HTTPS requests over loopback (9.5 MB) | 1.6–1.8 s (requests: 715 ms) | 5 ms | — |
| C loop, 5M iterations (in-process time) | 1.57–1.70 s | 10 ms | 35.8–36.7 s |
| Go loop, 5M iterations (in-process time) | 1.91–2.04 s | 10 ms | fails |
| `gh --version`, GitHub CLI 2.62 (59 MB static Go), Node | 37 s (29 s with `GOGC=off`) | 79 ms | — |

For reference, native Blink on the same machine: Go hello 80 ms, Go loop 50M
737 ms with its x86-64 JIT and about 9.8 s without (`-j`; 983 ms for 5M), `gh --version` 1.3 s
with the JIT and 22 s without. The wasm build is about 1.7x slower than
native Blink's own interpreter; the interpreter itself (~30M guest
instructions/s natively, ~18M/s in wasm) is the ceiling.

The vitest suite (`tests/tests/shiro-vitest/x86-engine.test.ts`) runs the
musl, glibc, Go, Go net/http fixtures, `kernel.spawn` through the loader, and
a guest blocking on a kernel pipe for stdin. Go and glibc fixtures are built
in the test when `go`/`gcc` exist.

### How it is wired

- `vendor/blink/`: pinned upstream commit, our patches, `build.sh`
  (emsdk → `public/engines/blink/blink.{mjs,wasm}`, committed so
  `npm run build` needs no emscripten), `shiro-net.js` (sockets), `bench/`.
- `public/engines/blink/host.mjs`: the Worker. It is a kernel guest: every
  file and stdio request is a kernel syscall over the SAB channel
  ([KERNEL_ABI.md](KERNEL_ABI.md)). Shiro directories are mounted as SHIROFS,
  a MEMFS faulted in with `lstat`/`openat`/`read`/`getdents64` and written
  back on close. fds 0/1/2 are the process's kernel fds, so pipes and
  redirections stream; stdin reads poll first so a waiting reader doesn't
  stall the other guest threads, and the page pings the worker when fd 0
  becomes readable.
- `src/x86-engine/`: `chooseX86Engine` (Blink when SharedArrayBuffer is
  usable, else src/x86; `SHIRO_X86_ENGINE=x86` forces the old one),
  `runElfWithBlink` (the shell's `./binary` path) and `registerBlinkLoader`
  (main.ts registers it, so `kernel.spawn()` of an ELF runs in Blink). Blink
  processes appear in `ps` and die on `kill`. `SHIRO_BLINK_DEBUG=1` logs the
  worker's kernel syscalls.
- Sockets: `vendor/blink/shiro-net.js` replaces emscripten's WebSocket SOCKFS
  with in-process stream sockets (AF_INET/AF_INET6 loopback, AF_UNIX) that
  feed emscripten's epoll. Other destinations go to `Module.shiroNet.connect`
  (the hook for the unix/net TCP relay, not wired yet) or fail with
  ENETUNREACH.

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

Native Blink's own exit path (`KillOtherThreads`) still hangs after
multi-threaded Go programs; the wasm build doesn't use it.

### Limits today

- Needs `crossOriginIsolated` (pthreads and the kernel channel use
  SharedArrayBuffer). On shiro.computer that depends on the unix/isolation
  branch; until then `./binary` uses src/x86.
- No JIT: ~200x native on CPU-bound code. Startup of large Go binaries is
  dominated by runtime and package init running in the interpreter.
- Memory: wasm32, 4 GB max. A binary is held in memory several times on its
  way in (Shiro's FS, the kernel read, MEMFS, Blink's mapping).
- Only loopback networking. TCGETS/TIOCGWINSZ on stdio aren't forwarded to
  the kernel yet, so guests never see a tty (no raw mode, no colors from
  isatty). Kernel signals (Ctrl-C as SIGINT) aren't forwarded into the guest;
  `kill -9` works. No `symlink(2)`/`chmod(2)` through the kernel ABI yet.
- One guest thread runs at a time (GIL).

## What agy still needs

Honest estimate for a ~200 MB static Go CLI that talks TLS to Google APIs:

1. **Cross-origin isolation in production** (unix/isolation). Without it the
   engine doesn't start.
2. **Real network**: route `Module.shiroNet.connect` (and DNS: Go reads
   `/etc/resolv.conf` and sends UDP) to the unix/net TCP relay. Go does its
   own TLS, so a plain TCP relay is enough. A day or two once unix/net is in
   unix/kernel.
3. **A tty**: forward termios/winsize ioctls and SIGINT/SIGWINCH between the
   kernel pty (unix/pty) and Blink's signal delivery. Without it agy runs
   only non-interactively.
4. **Speed** is the real problem. `gh` (59 MB) takes 30–37 s just to print
   its version; agy is 3–4x larger, so expect around a minute or more of
   startup and ~200x native for anything CPU-heavy (a TLS handshake plus
   three HTTPS requests took 0.7 s). Options, roughly in order of payoff:
   - a wasm code generator for Blink's JIT (Blink already builds and caches
     native code paths; emitting small wasm modules per hot path, as
     qemu-wasm does for TCG, is the 10x+ lever; weeks of work);
   - snapshotting a guest after runtime init (Go's init is deterministic for
     a given binary and env) to skip it on later runs;
   - profiling the interpreter in wasm (memory access goes through
     software page tables; a bigger TLB and fewer atomics may give 1.5–2x).
5. **Memory headroom** for 200 MB + Go heap inside 4 GB wasm32: map the ELF
   from one copy instead of three.

Until 4 is addressed, Blink makes agy *possible* in Shiro, not pleasant.

## Reproducing

```bash
EMSDK=/path/to/emsdk vendor/blink/build.sh          # rebuild public/engines/blink
cd tests && npx vitest run --config vitest.config.ts tests/shiro-vitest/x86-engine.test.ts
# Chromium numbers: serve the app with COOP same-origin + COEP credentialless,
# build the vendor/blink/bench programs (CGO_ENABLED=0 go build / musl-gcc -static)
# into $BENCH_DIR, then:
BENCH_DIR=... node vendor/blink/bench/chromium.mjs http://localhost:5199/ "./hello-go;./cpuloop 5000000"
```
