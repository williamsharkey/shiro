# Compatibility scoreboard

What popular Unix software runs in Shiro, by which route, and how it was
checked. Each row has an automated smoke test; sections are owned by the
workstream named in their heading, so append rows to your own section.

Routes: **pkg** = `pkg install` of a WASM build (recipe under
`scripts/pkgbuild/`, sha256-pinned), run as a kernel process; **builtin** =
implemented in Shiro (TypeScript); **Blink** = static x86-64 Linux ELF in the
Blink engine.

## Languages and toolchains (unix/compat-dev)

Smoke tests: `tests/tests/shiro-vitest/compat-dev.test.ts` (kernel processes
in Node worker threads). Browser checks: `scripts/browser-check.mjs` against a
built app in headless Chromium, cross-origin isolated.

| Software | Version | Route | Status | Tested | Known issues |
| --- | --- | --- | --- | --- | --- |
| python3 (CPython) | 3.13.7 | pkg `python3` (`python3.sh`: upstream WASI port + zlib + sqlite3; stdlib as a 4.3 MB zip of .pyc) | works | `-c`, `--version`, zlib/sqlite3/json/hashlib/decimal, `#!/usr/bin/env python3` scripts with argv/stdin/files, a package + `python -m unittest -v`; in Chromium: start-up ≈0.25 s | no subprocess, sockets, ssl, ctypes, threads (WASI preview1); REPL needs blocking stdin |
| pip | Shiro (pip-compatible CLI) | builtin `pip`/`pip3`/`python3 -m pip` | works for pure-Python wheels | resolver with PEP 440/508 (specifiers, markers, extras, pre-releases), console scripts, `-r`, `--target`, `-U`, uninstall/list/freeze/show/download, sha256 check; fake index in vitest, real PyPI in Chromium (`six`, `attrs`, `requests` + deps) | no sdists (needs a build backend run), no native wheels, no `-e` |
| GNU make | 4.4.1 | pkg `make` (`make.sh` + the process shim `compat/wasi-proc.c`) | works | shell recipes, `$(shell)`, `$(wildcard)`, pattern rules, `-C`, up-to-date checks after `touch`, recipes running clang and llvm-ar; zlib's Makefile | no jobserver (`-j` runs jobs one at a time), no `-O` output sync, no load average |
| clang / clang++ / wasm-ld / llvm-ar, nm, objdump... | LLVM 21.1.4 | pkg `llvm`: YoWASP's LLVM for WASI (npm `@yowasp/clang`, preview1 multi-call binary + wasi-libc sysroot, taken from the tarball by sha256) and a driver built here (`compat/clang-driver.c`) | works, targets wasm32-wasip1 | compile + link + run C; `cc -c`, static libraries, `-L/-l`, compile errors with locations; **zlib 1.3.1 built with its own Makefile passes its test suite** (vitest and Chromium: 13 s for the library, `example` and `minigzip`) | each driver step is a separate kernel process (the 72 MB module is compiled once and cached); no native target, no C++ exceptions/threads |
| Go (go, gofmt, compile, link, asm, vet) | 1.24.7 | pkg `go` (`go.sh`: upstream source + `go/wasip1-processes.patch`, cross-built to wasip1; GOROOT with std sources and a prebuilt std build cache, 44 MB) | works, builds GOOS=wasip1 | `go version/env`, `gofmt`, `go build` of a two-package module, `go vet`, `go run`, `go test`; the built program spawns commands with `os/exec`; Chromium: install 8.7 s, first build of a small program seconds (std from the shipped cache), net/http-sized programs ~2 min the first time | no network for the go command (`GOPROXY=off`: vendor modules or use `replace`); std packages outside the shipped cache compile on first use |
| venv | Shiro | `python3 -m venv` | works | `pyvenv.cfg`, `bin/python` symlinks, `bin/pip`, `activate`/`deactivate`; `sys.prefix` is the venv and pip installs into it (vitest and Chromium) | `--copies` ignored (always symlinks) |

Shell and platform fixes these needed (all with tests in the same file):

- Shebangs: `#!/usr/bin/env NAME` (with `-S` and `VAR=value`) and absolute
  interpreters run any builtin, installed package or script on PATH; an
  interpreter missing on disk falls back to the command of that name; a
  missing one is `bad interpreter`, exit 126.
- Sourced files and scripts group multi-line `name() { … }` bodies and
  `{ … }` groups; a sourced file starting with a comment ran nothing.
- `${1:-x}` (positional parameters with operators), `[ ! a = b ]` inside
  `if`, and `awk -f progfile`.
- Packages can ask for argv[0] to be the absolute path they were found at
  (`"argv0": "path"`), which CPython needs to find a venv.
- Kernel files: an open file renamed (temp file + rename, as clang writes
  objects) or unlinked lost later writes or came back; inodes now follow
  renames and detach on unlink. Kernel-spawned WASM gets the top-level
  preopens the prompt gives (some wasi-libc builds can't use "/"), and the
  kernel's builtin loader honours packages that replace builtins (`cc`).
- `pkg`: files can come out of (gzipped) tarballs and tar archives can be
  unpacked (`"tar": {"member", "unpack"}`), for npm-hosted builds; storing
  a view of a larger buffer in IndexedDB stored the whole buffer (every
  WebC font and tar member), now copied first.
- `sed` scripts with newlines; `wc` prints a bare number for one count of
  one input, like GNU.
- Go on wasip1 (in the shipped patch): `syscall.StartProcess/Wait4/Pipe`,
  `os.Pipe` and `exec.LookPath` on the kernel's WASIX calls; `Wait` polls
  so goroutines keep running; a spawned child gets exactly `attr.Files`
  (new guest action: close of fd 0xffffffff, since wasip1 has no
  close-on-exec); cmd/go's file locks are no-ops; and the runtime's
  `notetsleepg` (os/signal's loop) polls the network instead of spinning,
  which had starved every goroutine waiting on a pipe (`go test` hung).
- Builds: the entry chunk was both inlined into index.html and imported
  from its file by lazy chunks, so every module in it existed twice with
  separate state (`pkg install` updated one copy of the package cache, the
  shell read the other). The inline script now only imports the file.

Known issues found along the way (not fixed here):

- WASIX programs (bash, dash from unix/wasix) pass `exec` arguments as one
  newline-separated string (`proc_exec3`), so an argument containing a
  newline arrives split. Autoconf-style `configure` scripts that hand sed a
  multi-line script break that way; Shiro's own shell can't run them either.
