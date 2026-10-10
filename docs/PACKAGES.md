# Packages (`pkg`, `apt`, `apt-get`)

tabcomputer installs real open-source Unix programs as prebuilt WebAssembly. This is
phase 5 ("Open source") of [UNIX_COMPAT.md](UNIX_COMPAT.md).

```
pkg install sqlite lua jq        # apt install / apt-get install work too
sqlite3 -version; lua -v; which jq
pkg list | available | search <q> | info <name> | files <name> | remove <name>
pkg update; pkg upgrade          # extra index lists from /etc/pkg/sources.list
```

## Layout

| Path | What |
| --- | --- |
| `/usr/lib/pkg/<name>/` | package files (`bin/*.wasm`, data such as `share/fonts`) |
| `/usr/bin/<cmd>` | symlink to the binary, so PATH, `which` and `type` find it |
| `/var/lib/pkg/status.json` | installed packages, with the index entry each came from |
| `/var/lib/pkg/lists/*.json` | lists fetched by `pkg update` |
| `/etc/pkg/sources.list` | one index URL per line (optional) |

The shell runs anything that resolves into `/usr/lib/pkg/` through
`runPackageBinary` (`src/pkg-manager.ts`): argv[0] is the link name (so
multi-call binaries work), the command's recorded arguments are inserted, and
stdin/stdout report `isatty() == false` when piped or redirected.

When the page can block (SharedArrayBuffer, i.e. cross-origin isolated, or
JSPI, which current Chrome has) the program runs as a kernel process through
unix/wasi's `runWasiProgram` (`src/wasi/`): interactive stdin on a terminal,
streamed output, files opened on demand, threads, child processes. The
top-level directories are preopened by name as well as `/`, because some
wasi-libc builds (uutils, figlet) never match a `/` preopen against
`/usr/...`. Otherwise, and always for `wasi_unstable` programs (the kernel
guest implements preview1 only), it uses the older in-page runtime
(`src/wasi-runtime.ts`), which reads the working tree, the package's `preload`
directories and the files named on the command line before the program
starts.

A package command takes precedence over a tabcomputer builtin of the same name
(`jq`, `lua`, `sqlite3`) while it is installed; `builtin jq` still reaches the
builtin. Commands marked `"shadow": false` don't: coreutils applets (so `ls`
stays the builtin), and every WASIX command (`grep`, `sed`, `bash`, `rg`, ...)
until the kernel runs them, so a `--force` install can't break the shell's
own tools. They stay reachable as `/usr/bin/<cmd>`. A missing command that a package provides prints
`it can be installed with: pkg install <name>`.

## Index format

`src/pkg-index.json` is compiled in; `parseIndex()` validates it (and every
list `pkg update` fetches).

```jsonc
{
  "format": 1,
  "packages": [{
    "name": "sqlite", "version": "3.50.4",
    "description": "...", "license": "blessing",
    "source": "https://sqlite.org/2025/sqlite-autoconf-3500400.tar.gz",
    "origin": "shiro", "recipe": "scripts/pkgbuild/sqlite.sh",
    "section": "database",
    "abi": "wasi_snapshot_preview1",          // or wasi_unstable, wasix
    "deps": [],                               // installed first
    "files": [{ "path": "bin/sqlite3.wasm",
                "url": "/pkg/sqlite/3.50.4/sqlite3.wasm",  // or https://
                "sha256": "a602...", "size": 1679802 }],
    "bin": { "sqlite3": { "file": "bin/sqlite3.wasm" } },  // + "args", "shadow", "self"
    "mounts": { "/sysroot": "share/sysroot" }, // guest path → package dir (per process)
    "needs": [],                              // kernel features required at all
    "wants": ["blocking-stdin"],              // features some modes need
    "notes": "Interactive mode needs blocking stdin; ..."
  }]
}
```

A file can come out of a tarball (gzipped or not, e.g. an npm package):
`"tar": { "member": "package/gen/llvm.core.wasm" }` takes one file, and
`"unpack": true` extracts the (member's) tar archive into the directory
`path` (optionally only entries under `"dir"`). The tarball is downloaded
and checked once per install. A file can also come out of a Wasmer WebC container instead of being the download
itself: `"webc": { "atom": "figlet" }` takes one atom, `"webc": { "volume":
"atom", "dir": "/fonts" }` copies a volume subtree. Each container is
downloaded once per install and checked against its sha256 (Wasmer's CDN is
content-addressed: the file name is the sha256). `src/webc.ts` reads WebC v2
and v3.

URLs starting with `/` are served by the tabcomputer origin (`public/pkg/` in this
repo, copied to `dist/` by vite); outside a tabcomputer page they resolve against
`https://tabcomputer.com` (`DEFAULT_MIRROR`; shiro.computer no longer serves `/pkg/`), or
`$TABCOMPUTER_PKG_MIRROR`.

## Kernel features and gating

`needs` / `wants` use: `wasix`, `processes`, `threads`, `sockets`,
`blocking-stdin`, `tty`, `sync-fs`, `wasix-stack`, `dynamic-linking`,
`mounts`. A package whose `needs` the kernel lacks is
listed as `[needs kernel]`, `pkg install` refuses it without `--force`, and
running it exits 126 unless `TABCOMPUTER_PKG_FORCE=1`.

What the kernel provides follows the WASM process mode (`wasmProcessMode()`
in `src/wasi/host.ts`): `sab` gives blocking-stdin, tty, processes, threads,
sync-fs, wasix (the guest's WASIX subset), wasix-stack (fork, setjmp and
exec through asyncify stack capture) and sockets; `jspi` the same without
threads and wasix-stack;
`none` nothing. Other kernel parts
can add features with:

```js
globalThis.__tabcomputerKernel = { features: ['sockets'] };
```

## Packages

Status as of 2026-10-08 (unix/wasix), run through the shell in vitest
(`pkg.test.ts`, and `kernel-wasix.test.ts` for bash, dash, php, python,
clang and curl), in both the in-page runtime and as kernel processes; the
WASIX ones also at the prompt in Chromium on a cross-origin isolated page. "partial" means batch use
works everywhere and the interactive mode needs a page that can block.

| Package | Version | Source | ABI | Status |
| --- | --- | --- | --- | --- |
| coreutils (uutils, 78 applets) | 0.12.0 | built here, `coreutils.sh` | preview1 | ok |
| lua, luac | 5.4.7 | built here, `lua.sh` | preview1 | ok; the REPL reads the tty as a kernel process (checked on the pty) |
| python3 (CPython) | 3.13.7-1 | built here, `python3.sh` | preview1 + WASIX sockets/proc | ok; the default `python3`/`python` (installed on first use; Pyodide is `pyodide`). subprocess (posix_spawn), sockets, ssl (OpenSSL 3.5) and urllib http/https through the relay; `pip` installs pure-Python wheels, `python3 -m venv` works; no preexec_fn, no native extensions |
| make (GNU) | 4.4.1 | built here, `make.sh` | preview1 + process shim | ok; no jobserver |
| llvm (clang, wasm-ld, llvm-ar, ...) | 21.1.4 | npm `@yowasp/clang` tarball + driver built here, `llvm.sh` | preview1 + process shim | ok; targets wasm32-wasip1 |
| go (go, gofmt + tools) | 1.24.7 | built here, `go.sh` + patch | preview1 + WASIX processes | ok; builds wasip1 programs; no module downloads |
| perl | 5.40.0 | built here (static x86-64), `perl.sh` | x86_64-linux (Blink) | ok; fork, `prove`, IPC::Open3 |
| git | 2.47.1 | built here (static x86-64), `git.sh` | x86_64-linux (Blink) | ok; replaces the built-in git; local and `file://` remotes, no http(s) |
| ninja | 1.12.1 | built here (static x86-64), `ninja.sh` | x86_64-linux (Blink) | ok; runs clang from the llvm package |
| cmake, ctest | 3.31.9 | built here (static x86-64 musl), `x86/cmake.sh` | x86_64-linux (Blink) | ok; Ninja and Makefile generators with clang |
| sqlite3 | 3.50.4 | built here, `sqlite.sh` | preview1 | ok; the interactive shell reads the tty as a kernel process (checked on the pty) |
| jq | 1.8.1 | built here, `jq.sh` | preview1 | ok |
| cowsay, cowthink | 0.3.0 | Wasmer | preview1 | ok |
| figlet, chkfont (+57 fonts) | 0.0.1 (FIGlet 2.2.5) | Wasmer | preview1 | ok |
| uuid | 0.3.0 | Wasmer | preview1 | ok |
| wabt (wat2wasm, wasm2wat, ...) | 1.0.37 | Wasmer | preview1 | ok |
| ruby (ruby, irb, gem, rake, bundle) | 3.4.1 | ruby.wasm release, repacked, `ruby.sh` | preview1 + mounts | ok; no sockets or threads (stubs); irb reads the cooked tty (io/console stub) |
| fortune, lolcat, brotli, qr2text, viu | | Wasmer | wasi_unstable | ok |
| openssl-wasm (openssl) | 0.2.0 (OpenSSL 1.1) | Wasmer | wasi_unstable | ok (no s_client: sockets). The `openssl` package is now OpenSSL 3.5 as an x86-64 build ([COMPAT.md](COMPAT.md)) |
| quickjs (qjs) | 0.0.3 | Wasmer | wasi_unstable | partial: REPL |
| util-linux (cal only) | 0.0.1 | Wasmer | wasi_unstable | ok; exits 1 after correct output |
| grep-wasix, sed-wasix (GNU grep 3.12, sed 4.9) | | Wasmer | WASIX | ok as kernel processes, as `/usr/bin/grep` and `/usr/bin/sed`; `grep -r` fails with ENOSYS. The `grep` and `sed` packages are now x86-64 builds ([COMPAT.md](COMPAT.md)) |
| ripgrep (rg) | 15.2.1 | Wasmer | WASIX | ok as kernel processes, as `/usr/bin/rg` |
| quickjs-ng (qjs-ng) | 0.15.1 | Wasmer | WASIX | ok as kernel processes |
| less-wasix (less) | 685 | Wasmer | WASIX | runs as kernel processes; passthrough checked, interactive paging not yet. The `less` package is now the x86-64 build ([COMPAT.md](COMPAT.md)) |
| bash | 1.0.25 | Wasmer | WASIX | ok as kernel processes: scripts, `-c`, interactive on the pty (readline editing, ^C), fork/exec/pipelines/`$(...)`, `wait` |
| dash | 1.0.19 | Wasmer | WASIX | ok as kernel processes, as bash; this early build's exec passes no environment, so exported variables don't reach children |
| php | 8.3 | Wasmer | WASIX | ok as kernel processes (`php -r`, exceptions, fatal errors through zend_bailout's longjmp); 86 MB |
| python3.13 | 3.13 | Wasmer | WASIX | ok as kernel processes: `-c`, stdlib imports (json, zoneinfo, ...) with its volumes mounted at their `/nix/store` paths; no side modules (dlopen) (62 MB) |
| clang 16, lld, llvm-ar/nm | 16 | Wasmer | WASIX | ok as kernel processes: `clang hello.c -o hello.wasm` compiles and links (the driver runs `clang-16 -cc1` and `wasm-ld` as child processes, sysroot mounted at `/sysroot`, headers at `/lib`), and the output runs (111 MB) |
| curl-wasix (curl) | 8.4.0 | Wasmer | WASIX | The `curl` package is now curl 8.22 as an x86-64 build ([COMPAT.md](COMPAT.md)). ok as kernel processes: HTTP and HTTPS (OpenSSL in the guest, CA certificates mounted at `/openssl`) through the kernel sockets and the TCP relay; `/usr/bin/curl` (the builtin keeps the name) |

"Ok as kernel processes" means installable and working where WASM processes
can use threads (`sab` mode: a cross-origin isolated page). Without that, WASIX
packages stay gated on `threads`, because every one imports a shared
`env.memory`. WASIX commands never shadow builtins (`shadow: false`), so
`grep` stays tabcomputer's and GNU grep is `/usr/bin/grep`.

What the WASIX packages needed from the kernel guest (`src/wasi/wasi-guest.ts`):
`proc_signals_sizes_get`/`proc_signals_get` and `proc_exit2` (WASIX libc
startup exits 71 through them, and then trapped), `path_open2` and
`fd_fdflags_get/set` (GNU tools open files with them), and preview1 calls
imported under `wasix_32v1` (early builds such as dash). The four features
that kept the rest gated, now provided in `sab` mode:

- `wasix-stack` (done): WASIX builds are asyncified, so the guest captures
  and rewinds the stack itself (`src/wasi/asyncify.ts`): setjmp/longjmp,
  fork (a new kernel process with a copy of the memory, fds and signal
  state) and a real exec. See AGENTS.md "WASM Processes".
- `dynamic-linking` (done, sab mode): python is a position-independent
  module; `src/wasi/dylink.ts` lays it out and `src/wasi/dyncall.ts` serves
  the WASIX dynamic calls its trampolines use. Loading side modules (dlopen)
  is not implemented: programs see dlopen fail (ENOSYS).
- `mounts` (done): an entry's `mounts` map guest paths to package
  directories, applied per process as WASI preopens named after the guest
  path (also for package programs another program starts by path).
- `sockets` (done): the guest implements the WASIX socket calls and
  `resolve` over the kernel sockets (src/kernel/net.ts), so sab and jspi
  mode provide it.

Known gaps: dash's early WASIX libc execs without an environment (exported
variables don't reach its children; bash is fine); dlopen of WASM side
modules; `jspi` mode (no SharedArrayBuffer) has neither threads nor stack
capture, so WASIX packages need a cross-origin isolated page.

Not available as WASM anywhere checked: busybox, vim,
git, make (no WASI builds; busybox and make also need processes).

Dropped from the old list: Wasmer's `lua` 0.1.4 and `optipng` are emscripten
builds (`env`/`asm2wasm` imports), not WASI; `sqlite` 0.2.2 is replaced by the
3.50.4 build.

## x86-64 packages (`"abi": "x86_64-linux"`)

Static x86-64 musl builds of popular tools (less, vim, ...) run in Blink as
kernel processes; [COMPAT.md](COMPAT.md) has the scoreboard. Index
additions they use:

- `"needs": ["x86"]`: the `x86` feature is present when Blink can run
  (SharedArrayBuffer).
- File `"unpack": "gzip"` (one compressed file) or `"tar.gz"` (a tree
  unpacked into the directory `path`); sha256/size are the download's.
  Programs under `bin/`, `sbin/` and `libexec/` are installed executable.
- `"links": { "/usr/share/vim": "share/vim" }`: symlinks outside the package
  root, made at install and removed with the package.

Recipes are in `scripts/pkgbuild/x86/` (musl.cc toolchain and sources pinned
by sha256, or by commit for git sources); `scripts/pkgbuild/x86/publish.sh
NAME VERSION` writes the compressed files to `public/pkg/` and prints index
entries.

## Building packages (`scripts/pkgbuild/`)

Recipes are plain bash, no Docker: each downloads a pinned upstream release
(sha256), builds it with wasi-sdk 25 (also pinned and downloaded when
`$WASI_SDK` is unset), and writes `$PKG_OUT/<name>/bin/*.wasm`.

```bash
bash scripts/pkgbuild/sqlite.sh                 # PKG_WORK=./.pkgbuild by default
bash scripts/pkgbuild/publish.sh sqlite 3.50.4  # copy to public/pkg, print index entries
```

`common.sh` holds the toolchain setup (setjmp/longjmp through wasm exception
handling, the wasi-libc emulation libraries) and `compat/wasi-compat.c`
supplies `mkstemp`/`tmpfile`, which wasi-libc declares but doesn't define.
`coreutils.sh` uses cargo's `wasm32-wasip1` target with upstream's `feat_wasm`
feature set and `release-small` profile.

Built binaries are committed under `public/pkg/` (about 11 MB). They could move
to release assets later; only the index URLs would change.

## WASI runtime notes

Changes made for these packages in `src/wasi-runtime.ts`:
`wasi_unstable` is adapted onto preview1 (`src/wasi-preview0.ts`: fd_seek
whence order, 56-byte filestat, 56-byte clock subscriptions); `fd_renumber`;
preopens carry all rights (old wasi-libc returns ENOTCAPABLE otherwise);
`stdinIsTTY`/`stdoutIsTTY`; a file written through one fd is visible to a later
open and to `path_filestat_get` (sqlite reopens its database).

Snapshot-0 (2019) wasi-libc corrupts its heap with more than a couple of
preopens, while some preview1 builds don't match a `/` preopen against
`/usr/...`, so `runPackageBinary` preopens `/` and `.` for `wasi_unstable`
programs and adds the touched top-level directories for the rest.
