# Toward full Unix compatibility

Goal: anything that runs on Linux/macOS/WSL installs and runs in Shiro. This
note records where Shiro stands, what blocks that goal, and the order to fix it.
Written 2026-10-07, after the `port-agy` attempt to run Google's `agy` CLI.

## What the `port-agy` attempt found

- `agy` is a closed-source, ~200 MB statically linked amd64 Go binary. There is
  no source to compile to WASM. `williamsharkey/Panopticon` is not its source:
  it is a separate Go TUI (two deps, ~30k lines) that only stores Antigravity
  session links.
- The first PoC (Pyodide in a Worker; `subprocess.run` sent to the main-thread
  shell over `SharedArrayBuffer` + `Atomics.wait`) targeted the wrong
  language, so it was reverted. It passed in vitest only because Node worker
  threads have SAB. On shiro.computer the page is not cross-origin isolated (no
  COOP/COEP headers), so `SharedArrayBuffer` is undefined and it exits at once.
  It also copied the whole filesystem into the worker on every run, joined
  argv into a shell string without quoting, capped output at 1 MB, and
  stubbed `Popen` to `None`.
- The idea worth keeping is the **pattern**: a worker that blocks on a
  syscall while the main thread services it. That is the core of the process
  model below.

## x86 emulator status (measured)

A static Go 1.24 hello-world (`CGO_ENABLED=0`, 2.2 MB) loads and enters the Go
runtime, then dies in `runtime.check()` with `fatal error: float64nan`.
`UCOMISD`/`UCOMISS` are stubs that always report "equal", and there are no
scalar SSE arithmetic ops (`ADDSD`, `MULSD`, `CVTSI2SD`, …). A static glibc
hello-world stops at the unimplemented opcode `0F 62`.

A Go program past that point needs `clone` threads, real `futex`, `epoll`,
signals with `sigaltstack` (Go aborts when it fails; it returns `EACCES`
today), and `SIGURG` preemption. The emulator interprets with BigInt registers
on the main thread. Fixing opcodes one at a time will not reach "runs agy"
in reasonable time or at usable speed.

## The structural gaps

1. **No real processes.** Every command, node script, WASI module and x86
   binary runs as an async function on the page's main thread. No
   preemption, no isolated memory, and a CPU-bound program freezes the UI.
2. **No blocking syscalls.** WASI preloads files and treats stdin/poll as
   non-blocking. x86 `read` on an empty pipe returns 0. Real programs need
   `read()` to block until data arrives.
3. **No threads.** `clone`/`futex` are stubs, and nothing gives a guest more
   than one execution context.
4. **No sockets.** The browser has no TCP. `connect` is a fetch shim, and
   there is no `bind`/`listen`/`accept` and no TCP relay in `server.mjs` (its
   WebSocket server only relays peer channels).
5. **Native binaries.** Closed-source ELF (like `agy`) needs a complete,
   fast x86-64 Linux; open-source code can instead target WASM.

## Roadmap

### 1. Cross-origin isolation (prerequisite)
Serve `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless` from `server.mjs` (and the
nginx config), so that `crossOriginIsolated` is true and SAB/`Atomics.wait`
work. First audit what this breaks: CDN imports (Pyodide, esm), `seed blob`
cross-origin embedding, server windows, OAuth popups (COOP severs
`window.opener`). Behind a flag until the audit is green. When the page is
not isolated, fall back to JSPI (`WebAssembly.Suspending`) for WASM guests.

### 2. A kernel and worker processes
A main-thread (or dedicated-worker) kernel owns the filesystem, the fd tables,
pipes, ptys, the process table and signals. Each WASI, x86 or Python process
runs in its own Worker and makes syscalls through one shared ABI: write the
request into a SAB ring, `Atomics.wait`, and let the kernel `Atomics.notify`
when done. A blocking `read` simply doesn't get a reply until data exists.
Existing JS builtins stay in-page, as kernel-side programs that share the
same fd and pipe objects. This replaces the per-runtime ad hoc I/O in
`wasi-runtime.ts` and `x86/syscalls.ts`. Also gives `kill`/Ctrl-C real
teeth: `worker.terminate()`.

### 3. POSIX surface on that ABI
fork/exec/wait (spawn semantics; real `fork` only where the guest runtime can
snapshot memory), pipes, `poll`/`select`/`epoll`, a pty with termios
(raw/cooked, SIGWINCH, job control), signals, `/proc` basics, symlinks and
permissions in the FS. Threads for WASM guests through wasi-threads and a
shared `WebAssembly.Memory`.

### 4. Networking
A WebSocket-to-TCP relay endpoint in `server.mjs` (authenticated,
rate-limited, egress-restricted) behind kernel sockets. `connect`/`send`/
`recv` become real streams, so guest TLS works end to end. Listening sockets
map onto the existing virtual-server and `serve` machinery.

### 5. Binaries
- **Open source:** build to WASM (wasip1/wasip2, emscripten, Go
  `GOOS=wasip1` or `GOOS=js`) and run on the kernel ABI. A package
  repository of prebuilt WASM CLIs is the fastest route to "apt install
  works".
- **Closed-source amd64 ELF:** adopt a mature engine rather than grow
  `src/x86`. Candidates to evaluate: Blink compiled to WASM (user-mode
  x86-64 Linux; its syscalls could map onto the kernel ABI), CheerpX/WebVM
  (x86→WASM JIT with a full Linux userland; commercial license), v86
  (full-system, 32-bit only). Measure startup and throughput on a static Go
  binary first, then on `agy`. Keep `src/x86` for small static tools until
  then.

## Running `agy` specifically
Phases 1, 2, 4 and an engine from phase 5 that handles Go threads and
signals. Its network calls go to Google APIs over TLS, so they need the TCP
relay. Until then, `agy` can't run in Shiro by any route; there is no source
for the WASM option.
