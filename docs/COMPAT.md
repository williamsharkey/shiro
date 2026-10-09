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
| Ruby (ruby, irb, gem, rake, bundle) | 3.4.1 | pkg `ruby` (`ruby.sh`: the official ruby.wasm wasip1 "full" CLI build, repacked; stdlib mounted at its /usr/local prefix) | works | `-e` with json/set/digest/time, `#!/usr/bin/env ruby` scripts with argv/stdin/files, minitest, rake with task dependencies, `gem list`, `gem build` + `gem install --local` + require | no sockets (`gem install` from rubygems.org, net/http connections fail; a `socket.rb` stub lets them load), no threads (minitest runs serially: `MT_CPU=0`), irb needs blocking stdin |
| Perl | 5.40.0 | pkg `perl` (`perl.sh`: static x86-64 glibc build, all core XS linked in, `NO_LOCALE`) run in Blink — new package ABI `x86_64-linux` | works | `-e` with List::Util/Data::Dumper/POSIX, `#!/usr/bin/env perl` scripts with stdin/argv/files/regexes, backticks, `system()`, `open "-\|"`, Test::More (TAP), `prove t`, IPC::Open3, fork without exec (since Blink's real fork) | interpreted: ~1 s start, POSIX loads in seconds; no XS loading, no pods |
| Git | 2.47.1 | pkg `git` (`git.sh`: static x86-64 glibc build, no curl) run in Blink; replaces Shiro's built-in (isomorphic-git) `git` while installed | works for local workflows | init/add/commit with combined flags, branch, merge, rebase, stash, blame, tags/describe, a pre-commit hook, `git clone file://` and `git push` (upload-pack/receive-pack over pipes) | no http(s) remotes (uninstall it for Shiro's built-in GitHub clone/push); `git clone /path` stops at "hardlink different from source" (the kernel's `link()` copies; use `file://` or `--no-hardlinks`) |
| Ninja | 1.12.1 | pkg `ninja` (`ninja.sh`: static x86-64) run in Blink | works | a C program built with clang through rules with depfiles, no-op rebuilds, header changes rebuilding dependents, failed commands reported with clang's diagnostics | — |
| CMake, CTest | 3.31.9 | pkg `cmake` (`x86/cmake.sh`: static x86-64 musl, no OpenSSL) run in Blink | works with the llvm package's clang | a C project with a static library, `check_include_file`, `configure_file`: compiler detection (Clang 21.1.4), build through the Ninja and Makefile generators, `ctest` | configure takes ~10 s (each compiler check is a clang run); no https `file(DOWNLOAD)`; no ccmake/cmake-gui |
| venv | Shiro | `python3 -m venv` | works | `pyvenv.cfg`, `bin/python` symlinks, `bin/pip`, `activate`/`deactivate`; `sys.prefix` is the venv and pip installs into it (vitest and Chromium) | `--copies` ignored (always symlinks) |
| Node.js npm CLIs and libraries | Shiro's node (`node`, `npm`, `npx`) | builtin | works | commander + chalk + dayjs + uuid CLI, mocha 10 (pass and fail exit codes), tsc 5.6 (compile and type errors), prettier 3.3 (files, stdin, `--check "src/**/*.js"`, `--write`), ES modules binding `module`/`require`/`process`; vitest and Chromium | TypeScript 7 (`typescript@7`) is a native Go binary; native addons (`.node`) don't load; axios needs `window.location` (fine in the browser, not under vitest) |
| pnpm | 9.12.3 | npm package under Shiro's node (`npm install pnpm`) | works | `pnpm add` from the registry into the content-addressable store and `node_modules/.pnpm` virtual store (symlinks), `require` through those symlinks (resolving from the real path, as node does), `pnpm install --offline` from the store, `pnpm run` (a `node` script and a shell one), `pnpm exec`, `node_modules/.bin` shims; vitest and Chromium (`add` of 3 packages ≈5 s, `run` ≈2.4 s) | no `pnpm dlx`/`pnpm env` tested; workers run in the same thread (no parallel speed-up) |
| yarn 1 | 1.22.22 | npm package under Shiro's node (`npm install yarn`) | works | `yarn add` from the registry (tarballs through `request` over the fetch-backed http shim, gunzip, tar), `yarn.lock`, `yarn run`, `node_modules/.bin`, `yarn install --offline` from its cache; vitest and Chromium (`add` of 2 packages ≈2 s) | yarn 2+ (berry) not tried |
| Lua (lua, luac) | 5.4.7 | pkg `lua` (`lua.sh`) | works | `#!/usr/bin/env lua` script reading stdin with argv, patterns, coroutines, `table.sort`; `luac -p` syntax errors with locations | no `os.execute`/`io.popen`; the REPL needs blocking stdin |
| SQLite shell | 3.50.4 | pkg `sqlite` (`sqlite.sh`) | works | a database file reused across runs, JSON functions, FTS5, SQL and dot-commands on stdin (`.mode csv`) | single-threaded, no WAL or loadable extensions; interactive mode needs blocking stdin |

Not available (yet), and why:

| Software | Tried | Blocker |
| --- | --- | --- |
| Rust (rustc, cargo) | — | no maintained WASI build of rustc to pin; the Linux toolchain is dynamically linked against librustc_driver and LLVM (~250 MB unpacked) |
| Java (JVM) | — | a JDK image is ~200 MB and HotSpot needs its JIT (mprotect RWX code) for usable speed; Blink would interpret the interpreter |
| Deno, Bun | — | single ~100 MB binaries around V8 / JavaScriptCore JITs; Shiro's own `node` covers the npm use case |
| PHP | — | owned by unix/wasix (WASIX build in `pkg`) |

Shell and platform fixes these needed (all with tests in the same file):

- Node, for pnpm: `require.resolve` (with `paths`), `require.resolve.paths`,
  `require.cache`, `require.main`, `module.createRequire` from a file,
  `Module._nodeModulePaths`/`_resolveFilename`; `MODULE_NOT_FOUND` codes;
  `global` in the entry module; `worker_threads.Worker` runs the worker
  script in the same thread with its own module cache (`workerData`,
  `parentPort`, structured-clone messages); `zlib` is real (pako: gzip,
  deflate, raw, unzip, streams, crc32; it was a pass-through, so gzipped
  tarballs read as tar); `crypto` has real sha384/sha512/md5 and HMAC (sha512
  was faked, so integrity checks failed); `Buffer.from(ArrayBuffer |
  SharedArrayBuffer, offset, length)` is a view, `subarray` stays a Buffer,
  utf16le; `process.emitWarning`; legacy `url.resolve`; `http.Agent` is an
  EventEmitter and responses are Readable streams; more `util.types`.
- Node fs: callbacks run asynchronously, as in node (touch registered its
  listener after starting the call); `fs.write(fd, string, position,
  encoding, cb)` called back (write-file-atomic never finished, leaving
  `package.json` and `.modules.yaml` as empty temp files); `symlink` keeps
  relative targets; `mkdirSync` reaches the filesystem's cache at once (a
  `writeFileSync` right after found no parent and was dropped); renames
  (including directories: pnpm stages a package in `name_tmp_PID`) wait for
  the writes still in flight, which the drain loop had taken out of
  `pendingPromises`; `copyFileSync` copies bytes; `readdir` dirents report
  symlinks (pnpm skipped its symlinked packages when linking `.bin`);
  `realpath` follows symlinks and reports ENOENT; `chmod` is kept.
- Node: the preloader reads pnpm's `.pnpm/*/node_modules` packages, and
  `require` resolves a package behind a symlink from its real directory.
- Node: `child_process.spawn` with inherited stdio (`'inherit'`, `[0,1,2]`)
  writes the child's output to the parent's and has `stdout === null`.
- Node, for yarn: `fs.open` of a missing file to read is ENOENT (yarn took
  a tarball cache it never wrote for a hit and fetched nothing),
  `fs.copyFile` copies what the script sees, as bytes (copies out of its
  cache came out empty), `Buffer.from(s, 'base64')` is lenient like node's
  (integrity strings), `os.networkInterfaces()` has an external interface
  (none read as offline), and an http body still arriving counts as the
  script's activity (downloads ended with the script).
- Shell: a script run by path (`./x.sh`, yarn's `sh` launcher) wrote
  straight to the terminal, ignoring its redirects and pipes
  (`./x.sh > /dev/null`, `./x.sh | tr`); its output now goes through them
  like a builtin's. (This showed `base64 -d` adding a newline of its own;
  it no longer does.)
- Node: idle-exit activity is counted per script. It was page-wide, so a
  parent waiting on a child `node` (pnpm run → node app.js) kept the child
  from ever looking idle, and each waited on the other for the 10-minute
  cap. The cap on a script's async phase is 10 minutes (was 10 s, which
  killed pnpm during its retry back-off).


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
- Packages: script launchers inside a package (ruby's gem/rake) run through
  their shebang; `pkg install` creates a package's mount points on disk.
- Blink: the kernel no longer replies to an execve of a non-ELF program
  that replaced the caller (the reply raced the engine's termination and
  perl's exec of `#!` scripts failed), and Blink's kernel gets the shell,
  so guests can exec builtins (`/bin/sh`, PATH shims).
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

- Node: module bodies get their own function scope, so a top-level
  `const process`/`module`/`require` shadows the wrapper's parameters, and
  the ESM transform's own require/exports use internal names; `import()` of
  computed specifiers (and prettier's `new Function("m", "return import(m)")`)
  resolves relative to the module and gives a namespace with `default`;
  package `exports` prefer `require` to `import` (commander's `import` entry
  is an ESM wrapper), after `browser` as before (axios's browser build uses
  fetch). `stream` was stubs (`push`/`write` did nothing;
  fast-glob hung) and is now a working Readable/Writable/Duplex/Transform with
  pipe/pipeline/finished/async iteration; `path` follows Node's algorithms
  (`dirname("a")` was `/`); `events` works with `EventEmitter.call(this)`
  and subclasses that never call it; `fs.promises` has all of `fs/promises`,
  empty directories are directories, fd writes land in order (tsc's output
  was empty); `'exit'` listeners run at a natural end (mocha's exit code);
  `process.stdin` is async-iterable; `console.log` formats `%s %d %j`; npx
  passes stdin and quotes arguments verbatim (a quoted glob stayed a glob).
  For yarn: timers are Node `Timeout` objects (`unref()`; unref'd timeouts
  don't keep a script alive), `process.binding('natives'|'constants')`, the
  std streams have every EventEmitter method, https responses carry an
  authorized `socket`, output after `process.exit()` is dropped (a CLI's
  catch-all printed `Error: process.exit(0)`), and `fs.createReadStream` /
  `createWriteStream` are real streams over bytes (binary was decoded as
  text).

- `sh -c 'prog args'` naming a program (not a builtin) runs the program in
  that process, as a real shell execs its last command: builtins see stdin
  only at EOF and write their output when they return, so a program talking
  to its parent over pipes couldn't run through `sh -c` (git clone and
  `git-upload-pack`).
- (unix/shell-stdio) Any `sh -c SCRIPT` run as a kernel process now uses its
  fds as its stdio (`src/shell-stdio.ts`): kernel programs in the script get
  the pipes, `read` takes one line at a time, other builtins read stdin only
  if they need it, output goes out as each command finishes. `git clone
  --upload-pack='true; git-upload-pack'` works; builtins as kernel processes
  no longer swallow stdin they don't read.

- WASM programs started by a forked x86 program (cmake, ninja) inherit its
  fds, so fd 3 can be a pipe; wasi-libc finds its preopens by scanning from
  fd 3 to the first EBADF, found none, and every absolute path failed (clang
  under cmake: "no such file or directory"). Fds below the last preopen now
  answer as non-directory preopens. (The crash cmake hit earlier was the
  kernel's FIONBIO on /dev/null, fixed on unix/perf-blink.)

Known issues found along the way (not fixed here):

- WASIX programs (bash, dash from unix/wasix) pass `exec` arguments as one
  newline-separated string (`proc_exec3`), so an argument containing a
  newline arrives split. Autoconf-style `configure` scripts that hand sed a
  multi-line script break that way; Shiro's own shell can't run them either.
- A static glibc CMake faults in its malloc start-up in Blink (upstream too);
  the package is built against musl.


## CLI tools, editors and TUIs (unix/compat-tools)

Smoke tests: `tests/tests/shiro-vitest/compat-tools.test.ts`, one `describe`
per package, run from the shell as kernel processes; the interactive ones
on a terminal pty (raw mode, alternate screen, resize, Ctrl-C/Ctrl-Z).
Most packages here are static x86-64 builds, from `scripts/pkgbuild/x86/`
(pinned upstream source and musl.cc toolchain) or upstream's own static
releases (pinned sha256), installed with `pkg install` and run in Blink, so
they need a cross-origin isolated page (`"needs": ["x86"]`). Rows marked
WASI/WASIX are WASM packages run as kernel processes in workers.

Browser checks: `scripts/browser-tui.mjs` drives the built app in headless
Chromium (cross-origin isolated) through xterm.js's own keyboard input and
reads the rendered screen. Verified there on 2026-10-09: vim (insert, `:wq`,
type-ahead), nano (`^O`, `^X`), less (paging, `/` search, type-ahead), htop,
top, tmux (split, detach, `ls`), screen (detach), fzf (filter, pick), nvim
(edit, `:help`), emacs -nw (edit, C-x C-s), man (through less), gpg
(pinentry-curses dialog). Two bugs only the browser showed are fixed: keys
typed while a command started were dropped, and AF_UNIX connect failed with
EIO (the browser's `TextDecoder` refuses the shared syscall buffer).

| Software | Version | Route | Status | Tested | Known issues |
| --- | --- | --- | --- | --- | --- |
| less | 710 | pkg (Blink) | works | pages a file on the tty (alternate screen), `/search`, `G`, `q`; `seq \| less` reads the pipe and takes keys from /dev/tty; plain output when piped | |
| nano | 9.2 | pkg (Blink) | works | edit, `^O` save, `^X` quit on the tty; C syntax colours from /usr/share/nano | |
| diff, cmp, diff3, sdiff | 3.12 (GNU diffutils) | pkg (Blink) | works | `diff -u` exit codes, `cmp` | |
| patch | 2.8 (GNU) | pkg (Blink) | works | applies a unified diff | |
| awk (gawk) | 5.4.1 | pkg (Blink) | works | fields, arrays, `asorti`, `gensub`, printf | no extensions, no MPFR |
| sed | 4.10 (GNU) | pkg (Blink) | works | `s///g`, `-n p`, `-E`, `-i` | |
| grep | 3.12 (GNU) | pkg (Blink) | works | `-r` over directories, `-n -c -i -v -o`, `egrep`, exit 1 on no match | no PCRE (`-P`) |
| find, xargs | 4.11.0 (GNU findutils) | pkg (Blink) | works | `-name -type -exec {} \;`, `-print0 \| xargs -0` | |
| bc, dc | 1.08.2 (GNU) | pkg (Blink) | works | `bc -l` 20 digits of π, bignums, `dc` | |
| tar | 1.35 (GNU) | pkg (Blink) | works | `czf` (gzip run as a child through `/bin/sh`), `tzf`, `xzf -C` | |
| gzip, gunzip, zcat | 1.15 (GNU) | pkg (Blink) | works | `-k`, `-c`, `-d`, `-t`, binary output redirected to a file | |
| vim | 9.2.0000 | pkg (Blink) | works | edit + `:wq`; syntax colours from the runtime; `:help`; resize (SIGWINCH) updates `&columns`/`&lines`; Ctrl-Z stops it, `fg` resumes; `vim -es` scripting | Startup with `filetype`/`syntax` is slow (seconds): Blink interprets x86 at ~1/120 native speed. No POSIX timers (`timer_create`), so no `'redrawtime'` timeout |
| nvim (Neovim) | 0.12.5 (PUC Lua 5.1) | pkg (Blink) | works | headless `:s` + `:wq`, Lua (`vim.inspect`), treesitter parsing and `:help` highlighting, editing on the tty, a shell in `:terminal` (pty) | built with PUC Lua instead of LuaJIT (its JIT would be translated twice); the bundled parsers (c, lua, vim, vimdoc, query, markdown) are linked into the static binary, so `parser/*.so` from plugins can't load; no translations |
| emacs (-nw), emacsclient, etags | 31.1 (GNU) | pkg (Blink; ncurses 6.5) | works | batch Lisp, the portable dump, `org`; editing and C-x C-s on the tty, `M-x shell` (pty) | terminal only: no GUI, TLS (`--with-gnutls=no`), images, native compilation or tree-sitter; byte-compiled Lisp without sources (`find-function` shows no source); no Japanese input-method dictionary |
| tmux | 3.8 | pkg (Blink; libevent 2.1, ncurses 6.5) | works | `new-session` on the tty: status line, a shell in the pane, `C-b %` split, `C-b d` detach; `list-panes`, `send-keys` into a detached session; re-attach on a bigger terminal (the status line comes back without a key press); `#{host}` is the kernel hostname; `kill-session`; in Chromium too | Slow to draw (emulated). Built with a 2 s format-expansion budget (upstream 100 ms cut the status line short when emulation was slow). The `tmux` builtin is replaced while the package is installed |
| screen | 5.0.2 (GNU) | pkg (Blink; ncurses 6.5) | works | session on the tty: shell window, `C-a c` new window, `C-a d` detach; `-ls`, `-X stuff` into a detached session, `-r` re-attach, `-X quit` | no PAM/utmp; sockets in `~/.screen` (no setuid socket directory). The builtin `screen`, if any, is replaced while the package is installed |
| htop | 3.5.3 | pkg (Blink; ncurses 6.5) | works | CPU, memory, load and uptime meters; the process list from the kernel `/proc`; `q` quits | CPU% is an estimate (wall time minus time in syscalls); memory per process reads 0; one CPU meter per `navigator.hardwareConcurrency` |
| top, ps, free, uptime, vmstat, pgrep, pkill, pidof, watch, w | 4.0.7 (procps-ng) | pkg (Blink; ncurses 6.5) | works | `ps -ef`/`-o`, `free -m`, `uptime`, `vmstat`, `top -b` over two refreshes, `pgrep`/`pkill` of a running program | `w` lists no users (no utmp); no `kill` (the shell's builtin) |
| tree | 2.2.1 | pkg (Blink) | works | tree drawing and counts, `-d --noreport` | |
| file | 5.46 | pkg (Blink) | works | shell script, JSON, PNG, gzip, ELF; `--mime-type` (magic database mapped with `mmap`) | |
| xz, xzcat, unxz | 5.8.1 | pkg (Blink) | works | `-k`, `-l`, `xzcat`; `tar -J` | single-threaded |
| zstd, zstdcat, unzstd | 1.5.7 | pkg (Blink) | works | `-19`, `zstdcat`; `tar --zstd` | |
| zip | 3.0 (Info-ZIP) | pkg (Blink) | works | `zip -qr` | no bzip2 method |
| unzip, zipinfo | 6.0 (Info-ZIP, Debian patches) | pkg (Blink) | works | `-l`, `-t`, `-d`, `zipinfo -1` | no bzip2 method |
| git | 2.56.0 | pkg (Blink) | works | init, add, commit, log, diff, branch, checkout, merge, stash, tag, describe, status; `git clone` of a local repository | Perl/Python/Tcl parts left out (`git add -i` is the C version; no `git svn`, `gitk`, `send-email`). Remote clones need https through the network relay (curl is linked in) — not in the automated test. Slow on big repositories |
| openssl | 3.5.9 | pkg (Blink) | works | `dgst -sha256`, `enc -aes-256-cbc -pbkdf2`, `rand`, Ed25519 `genpkey`, self-signed `req -x509`, `x509 -subject` | no engines/providers beyond the default |
| curl | 8.22.0 (OpenSSL 3.5.9, zlib) | pkg (Blink) | works | HTTP GET with headers against a loopback server on kernel sockets; connection refused is exit 7 | Remote hosts go through the server's WebSocket-to-TCP relay and DNS-over-HTTPS (not in the automated test). No HTTP/2, HTTP/3, IDN, libssh2 |
| ca-certificates | 2026-09-25 (Mozilla, via curl.se) | pkg | works | `/etc/ssl/certs/ca-certificates.crt`, `/etc/ssl/cert.pem`; openssl and curl depend on it | |
| wget | 1.25.0 (GNU; OpenSSL 3.5.9, zlib) | pkg (Blink) | works | download to a file and `-O-` from a loopback HTTP server; exit 4 on a network failure | remote hosts through the TCP relay (as curl); no IRI/IDN, PSL, metalink |
| rsync | 3.5.1 | pkg (Blink) | works | `-a` copy, `-i` itemized delta with `--delete`, `-n` dry run finds nothing after a sync | remote copies need `-e ssh` and a reachable server; no xxhash/zstd/lz4, ACLs or xattrs |
| ssh, scp, sftp, ssh-keygen, ssh-agent, ssh-add | 10.6p1 (OpenSSH portable; OpenSSL 3.5.9, zlib) | pkg (Blink) | works (client) | `ssh-keygen` Ed25519 key (0600, `-l`, `-y`), `ssh-agent -s` + `ssh-add`/`-l` on an AF_UNIX socket, `ssh -G` config, identification exchange with a server on a kernel socket, connection refused | no sshd, so a full login isn't covered by the automated test; remote hosts go through the TCP relay as curl does. `rsync -e ssh` needs a reachable server |
| gpg, gpgv, gpg-agent, gpgsm, gpgtar, gpgconf, gpg-connect-agent, pinentry | 2.5.24 (GnuPG; libgcrypt 1.12.4) | pkg (Blink) | works | Ed25519/Cv25519 key generation, detached and clear signatures, `gpgv`, a bad signature fails, public-key and symmetric encryption, the agent over its AF_UNIX socket, `gpg-connect-agent`, passphrase entry in pinentry-curses on the tty | no dirmngr (keyserver and WKD lookups), keyboxd, scdaemon (smartcards) or TOFU; `pinentry` is pinentry-curses (pinentry-tty also installed) |
| man, apropos, whatis, makewhatis | 1.14.6 (mandoc) | pkg (Blink) | works | `man -w`, formatting `man(1)`/`mandoc(1)`, `makewhatis` then `whatis`/`apropos`; pages from other packages (`xz`, alias `xzcat` via `.so`, procps' `vmstat(8)`) | pages come with the packages here (recipes' `install_man`; publish.sh links them into /usr/share/man), except git, openssl, curl, gnupg and fzf, whose pages are generated with tools the builds leave out; pager is `less` (`pkg install less`) |
| jq | 1.8.1 | pkg (WASI) | works | filters, `-r`, `-s`, `gsub` (oniguruma), `-e` exit status | |
| ripgrep | 15.2.0 | pkg (WASIX) | works as `/usr/bin/rg` | `.gitignore`, `-t`, `-g`, `-c`, `-l`, exit 1 on no match | plain `rg` is Shiro's builtin (the package doesn't take the name); no PCRE2; one search thread |
| sqlite3 | 3.50.4 | pkg (WASI) | works | database file, queries, SQL on stdin, `-json` | interactive shell wants blocking stdin |
| coreutils (uutils) | 0.12.0 | pkg (WASI) | works | `coreutils sha256sum`, `/usr/bin/factor`, `sort -n`, `tr`, `numfmt`, `seq` | builtins keep the plain names; use `/usr/bin/NAME` or `coreutils NAME` |
| fd | 10.3.0 | pkg (Blink; upstream static musl release) | works | `-e`, `-t d`, `.gitignore` respected, `-u` | |
| bat | 0.26.1 | pkg (Blink; upstream static musl release) | works | highlighting with the built-in themes (default and `--theme`), `-n`, plain output when piped, `--list-languages` | needed Blink patches 0017 (`pextrw`) and 0018 (`FUTEX_WAIT_BITSET`, `GRND_INSECURE`) and kernel `FIONBIO` on pipes |
| fzf | 0.74.0 | pkg (Blink; upstream static Go release) | works | `-f` filter; the TUI with `--height` on the tty (cursor position report, typing narrows the list, Enter prints the pick) | Go runtime in Blink: start-up takes about a second |
| yq | 4.52.1 (mikefarah) | pkg (Blink; upstream static Go release) | works | path query, `-o json`, `-i` in-place edit | |

Shiro changes these programs needed (tests in `x86-engine.test.ts`,
`kernel-core.test.ts` and the smoke tests):

- Real `fork()` for Blink guests (patch 0014): a snapshot of the process is
  rebuilt in a new worker, so a child can run alongside its parent without
  exec (GNU tar's compressor helper). `x86-engine.test.ts`.
- `/bin/sh` as a kernel process (`system()`, `popen()`, `sh -c`, tar's
  `-z`): the forked Shiro shell is that process, and programs it starts get
  its real fds and process group (`Shell.kernelHost`), so binary data and the
  tty pass through.
- `prog > file`, `>> file`, `2> file`, `2>&1` on kernel programs: the kernel
  opens the file and the program writes it directly (binary-safe, streamed).
- Builtins run as programs: PATH shims for more of them
  (`src/path-shims.ts`, also used at boot), `/bin/echo`-style paths of shell
  builtins, and an installed package's program wins over a filter builtin
  in pipelines too (`gzip`, `sort`, ...). `sort -z`.
- Blink guests use the kernel's fds and processes (Blink patch 0011): the
  terminal is the real pty (`/dev/tty`, termios, `TIOCGWINSZ`), pipes are
  kernel pipes, `fork`/`vfork`/`posix_spawn` + `execve` + `wait4` work
  (vfork semantics), signals a program catches are delivered to it and
  stop signals stop it in the kernel (patch 0013). `x86-engine.test.ts`.
- The filesystem follows symlinks in directory components
  (`/usr/share/vim/vim92/...` through the `/usr/share/vim` link vim's package
  installs).
- `pkg` installs x86-64 packages: gzip-compressed binaries, `.tar.gz` data
  trees, links outside the package root (`"links"`), executable modes.
- `/etc/passwd`, `/etc/group`, `/etc/hosts`, `/etc/hostname` exist; the
  shell exports `LANG=C.UTF-8`.
- `mmap` of a kernel file in a Blink guest (patch 0015 fixes a deadlock it
  hit; `file` maps its magic database).
- Blink: `pextrw` zero-extends its result (patch 0017; Rust's inflate built
  with LTO, so every compressed asset in bat failed to load), futex
  `FUTEX_WAIT_BITSET`/`FUTEX_WAKE_BITSET` and `getrandom(GRND_INSECURE)`
  (patch 0018; Rust's std), `MADV_DONTNEED` (patch 0016). `x86-engine.test.ts`.
- AF_UNIX path sockets, `sendmsg`/`recvmsg` with `SCM_RIGHTS` and
  `SO_PEERCRED` in the kernel (Blink patch 0019): the tmux client and server
  talk over `/tmp/tmux-1000/default` and the client hands over its tty.
  `kernel-net.test.ts`, `x86-engine.test.ts`.
- `sh` run as a program on a terminal with no script (a tmux pane, or `-i`)
  is interactive: a `PS1` prompt (default `\u@\h:\w\$ `), a line read from
  the tty in canonical mode, Ctrl-C/Ctrl-Z/Ctrl-\ left to its foreground
  children, `exit` or EOF to end. It does job control on its pty
  (`ProcessTty` in `src/kernel/pty.ts`): each job gets a process group and
  the terminal (tcsetpgrp) while it runs, Ctrl-Z stops it and gives the
  terminal and the shell's tty modes back, and `jobs`/`fg`/`bg`/`kill %N`/
  `wait` (128+signal for a stopped job) work on it: vim and htop under Ctrl-Z
  and `fg` in a screen window (`tests/browser/job-control.mjs`).
  `$$`/`$PPID`/`$0` are the process's. In a kernel sh script, `prog &` is a
  kernel process (`$!` its pid, stdin `/dev/null`); with `set -m` it gets its
  own process group, so `kill -STOP`, `jobs` and `bg` act on it. In-page
  builtins and functions in the background stay promises: they can be
  aborted, not stopped.
- A kernel `/proc` (`src/kernel/procfs.ts`): `/proc/self`, `/proc/PID/`
  (`stat`, `status`, `cmdline`, `comm`, `environ`, `cwd`, `exe`, `fd/N`,
  `task`), and `/proc/stat`, `/proc/loadavg`, `/proc/uptime` from the process
  table; musl's `ttyname()` (screen's "Must be connected to a terminal")
  reads `/proc/self/fd/0`. CPU time is estimated (wall time minus time in
  syscalls); memory sizes read 0. `kernel-core.test.ts`.
- `/proc` files regenerate when rewound (procps keeps `/proc/stat` open),
  counters in `/proc/stat` never go backwards, `/proc/vmstat` exists, and
  `CLOCK_BOOTTIME` comes from the kernel (Blink patch 0021; kernel
  `clock_gettime`), so uptime and process start times agree with `/proc`.
- ptys: `TIOCPKT` packet mode on the master; `stat()` of a tty no longer
  makes it the caller's controlling terminal or leaves a slave open (screen's
  windows got `fgtty: Not a tty`). Blink's `pause()` now sees signals (patch 0020)
  (screen's attacher waits in it). `kernel-pty.test.ts`.
- `ioctl(FIONBIO)` works on every file, pipes included (Rust's
  `Command::output()`). `kernel-core.test.ts`.
- Blink keeps its own log in its in-memory root (`-L /blink.log`), not in
  the program's working directory.
- `rename` keeps a file's modification time (it set it to now): `rsync -a`
  sets times on a temp file and renames it. `filesystem.test.ts`.
- `link(2)` still copies (the filesystem has no hard links) but the copy
  reports the source's inode number, which git's local clone checks, and
  both names report a link count of 2 (shadow's lock files: `groupadd`,
  `useradd` in openssh-client's and other postinsts). `kernel-core.test.ts`.
- Files keep no owner, so `stat` reports them as the caller's (root's in a
  root shell): git refused root's own repositories ("dubious ownership").
- Shiro's commands look like files only where exec runs them (`/bin`,
  `/usr/bin` and the sbin ones, when no real file has that name): GNU make
  took `/usr/local/bin/echo` from its own PATH search and failed with
  "echo: No such file or directory". `debian.test.ts`.
- `systemctl` accepts what Debian's maintainer scripts run (`--root=/
  preset`, `daemon-reload`, `is-enabled`, ...).

### Popular CLI tools from Debian (apt)

Debian mode (`debian install`, a root shell) with
`apt-get install -y --no-install-recommends PKG`, then a non-interactive
smoke test, on 2026-10-09 (vitest, the mirror cache served by `server.mjs`).
The install column is the whole `apt-get install` (download, unpack,
maintainer scripts, triggers) in Blink: about a minute even for jq, most
of it apt's dependency resolution and dpkg-preconfigure (perf-fs-shell's
profile: 14 s and 20 s for `hello`), which unix/perf-fs-shell is cutting.
Debian's builds of the TUIs (tmux, nano, htop, ncdu, fzf, emacs -nw) have
only had these non-interactive checks; Shiro's own `pkg` builds of them,
in the table above, are the ones verified on the pty in Chromium.

| Tool (package) | Version | Status | Install | Smoke test | Notes |
| --- | --- | --- | --- | --- | --- |
| jq | 1.7.1 | works | 69 s | `jq -c '.a\|add'` | |
| ripgrep (`rg`) | 14.1 | works | 61 s | `rg -n` | |
| fd (`fd-find`, `fdfind`) | 10.2 | works | 61 s | `fdfind -e txt` | Debian names it `fdfind` |
| bat (`batcat`) | 0.25 | works | 109 s | `batcat --paging=never -p` | Debian names it `batcat` |
| fzf | 0.60 | works | 61 s | `fzf -f` filter | |
| tmux | 3.5a | works | 80 s | `tmux -V` | |
| less | 668 | works | 63 s | `less -F` | |
| man (`man-db`) | 2.13 | broken (fix in progress) | 138 s | `man -P cat 7 man`: "No manual entry" | the rootfs excluded `/usr/share/man` (dpkg `path-exclude`, as Docker's slim images do), so no package had pages; unix/debian is dropping the exclusion for packages installed from now on |
| curl | 8.14.1 | works (local) | 113 s | `curl --version`, `file://` | network through Shiro's relay not tried here |
| wget | 1.25 | works (local) | 59 s | `--version` | network not tried |
| ssh, ssh-keygen (`openssh-client`) | 10.0p1 | works | 90 s | `ssh -V`, `ssh-keygen -t ed25519` | its postinst failed (`groupadd _ssh`: link count), fixed |
| rsync | 3.5.0 | works | 93 s | `rsync -a` | |
| zip, unzip | 3.0, 6.0 | works | 71 s | zip + `unzip -l` | |
| make | 4.4.1 | works | 69 s | a Makefile | recipes failed ("echo: No such file"), fixed |
| gcc (+ `libc6-dev`) | 14.2 | works, slow | 357 s | compile + run hello.c | |
| strace | 6.13 | broken | 85 s | — | Blink has no `ptrace` |
| file | 5.46 | works | 87 s | `file` on text and ELF | |
| tree | 2.2 | works | 75 s | `tree -L 1` | |
| ncdu | 1.22 | works | 84 s | `ncdu -o` export | |
| nano | 8.4 | works | 82 s | `--version` | |
| emacs (`emacs-nox`) | 30.1 | works, slow | 399 s | `emacs --batch --eval` | |
| htop | 3.4.1 | works | 76 s | `--version` | |
| git | 2.47.3 | works | 280 s | init + commit + log as root | "dubious ownership" as root, fixed |
| sqlite3 | 3.46 | works | 102 s | `select 6*7` | |
| bc | 1.07.1 | works | 76 s | `2^20` | |
| gawk | 5.2.1 | works | 97 s | `BEGIN{print 6*7}` | |
| xz, zstd (`xz-utils`, `zstd`) | 5.8.1, 1.5.7 | works | 106 s | compress + decompress through pipes | |
| lsof | 4.99.4 | works | 135 s | `lsof -p` lists cwd, root, fds | |
| nc (`netcat-openbsd`) | 1.229 | works (local) | 83 s | `nc -h` | connections not tried |
| ps, pstree, free (`procps`, `psmisc`) | 4.0.4, 23.7 | works | 121 s | `ps -e`, `pstree`, `free -m` | memory figures are nominal |
| python3 (`python3-minimal`) | 3.13.5 | works | 219 s | `python3 -c` | Debian's CPython in Blink (Shiro's own `python3` package is WASI) |

Building and publishing one of these packages:

```bash
export PKG_WORK=$PWD/.pkgbuild          # downloads, toolchain, build trees
bash scripts/pkgbuild/x86/vim.sh        # -> $PKG_WORK/out/vim/{bin,share}
bash scripts/pkgbuild/x86/publish.sh vim 9.2.0000   # -> public/pkg/vim/9.2.0000/*.gz, prints index entries
```

ncurses-based programs are linked against a static ncurses 6.5 with
`xterm-256color`, `xterm`, `screen*`, `tmux*`, `linux`, `vt100`, `vt220` and
`dumb` compiled in, so they work without a terminfo database.

## Claude Code native binary (unix/perf-kernel)

Status (2026-10-09, unix/agent-clis, see "Agent CLIs" below): with Blink's
SSE4.1/4.2 (patch 0040) the **musl build runs**: `--version` in 2.1 s and
`-p` reaches the Anthropic API. The glibc build still crashes in Bun's
startup. Before patch 0040 both died of SIGILL on `pinsrq`.

Experimental opt-in (plain `claude` still runs the pinned npm build):

- `claude install --native [VERSION]` (`src/commands/claude-native.ts`)
  downloads from inside the guest with the `curl` package (x86-64, its own
  TLS over the kernel's TCP relay, so CORS doesn't apply and nothing goes
  through a Shiro proxy route): the linux-x64-musl build, checked against
  the release manifest's sha256, to `$CLAUDE_NATIVE_PATH` (default
  `~/.local/bin/claude`), and musl's loader from Debian's `musl` package
  (pinned sha256; snapshot.debian.org fallback) as
  `/lib/ld-musl-x86_64.so.1`. In Chromium: 170 s for 238 MB.
- `claude --native ARGS` (or `CLAUDE_NATIVE=1 claude ARGS`) runs it through
  the shell's ELF path (Blink, with the terminal's pty). In Chromium:
  `--version` 2.7 s; `-p "say hi"` to the API's answer 139 s, 105 s with
  `BUN_JSC_useJIT=0`.

What the official native installer (`claude.ai/install.sh`) installs, as of
2.1.295 (`downloads.claude.ai/claude-code-releases/<version>/<platform>/claude`,
sha256-checked against `manifest.json`):

- A **Bun single-file executable**: Bun's runtime (`.text` 60 MB, JSC
  included) plus the app in a `.bun` section (160 MB). linux-x64 is
  256 MB, linux-x64-musl 250 MB; both are **dynamically linked** (glibc
  2.26+: `libc`, `libm`, `libpthread`, `libdl`, `librt` and
  `/lib64/ld-linux-x86-64.so.2`; or musl's `/lib/ld-musl-x86_64.so.1`).
- Mapped image: R 23 MB + RX 60 MB + RW 161 MB, a 12.5 MB main stack
  (`PT_GNU_STACK`), TLS 22 KB. That is ~250 MB of guest memory before JSC
  starts, inside Blink's 4 GB wasm memory.
- Imports that matter for Blink and the kernel: raw `syscall()` (Bun's
  io_uring/futex/memfd/statx calls go through it, so the set is only
  visible at run time), `epoll_create1`/`epoll_pwait`, `eventfd`,
  `signalfd`, `inotify_init1`, `splice`, `sendfile`, `prctl`,
  `sched_getaffinity`, `posix_spawn*` (with `addchdir`), `mmap`/
  `mprotect`/`madvise` (JSC's JIT and its large virtual reservations).

Where Shiro intercepts it today (so `claude` at the prompt never reaches a
native binary):

- `src/commands/claude.ts`: the `claude` builtin runs the pinned npm build
  (`CLAUDE_CODE_VERSION`, pure JS) through Shiro's `node`, and answers
  `claude install|update|upgrade` with a "pinned" message. Builtins win over
  PATH lookup, so a binary at `~/.local/bin/claude` is not reached by name.
- `src/commands/fetch.ts`: `curl`/`fetch` of `claude.ai/install.sh` returns
  a stand-in script that runs `npm install -g` of that package instead of
  the real installer.
- To run the native ELF deliberately today, invoke it by absolute or
  relative path (`/home/user/.local/bin/claude`, `./claude`): a path that
  is not under `/bin`, `/usr/bin` or `/usr/local/bin` goes to the ELF loader
  (Blink), not to the builtin. Proposed opt-in: `claude --native` or
  `CLAUDE_NATIVE=1` making the builtin exec the native binary when one is
  installed, and `CLAUDE_NATIVE=1` letting `install.sh` through.

To try it (once allowed): put the binary and the five glibc libraries plus
the loader in the VFS (Blink loads the ELF interpreter from SHIROFS), then
run `claude --version` and `claude -p "say hi"` with a dummy key, with and
without `BUN_JSC_useJIT=0`.

## Agent CLIs (unix/agent-clis)

Popular AI coding-agent CLIs, run as Shiro would run them: native x86-64
ELF builds in Blink as kernel processes, Node builds on Shiro's `node`. Run
2026-10-09 with dummy API keys for the other vendors (a 401/400 from the
vendor's API proves the network path).

| Tool | Version | Kind | Install | `--version` | Network | Timings | Blockers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code (native) | 2.1.295 | ELF, Bun 1.4.3 single-file exe; glibc (256 MB) and musl (250 MB) builds, dynamic | `claude.ai/install.sh` (Shiro substitutes the npm install; fetch the binary from `downloads.claude.ai/claude-code-releases/<v>/linux-x64-musl/claude`, plus `/lib/ld-musl-x86_64.so.1`) | **yes**: musl 2.1 s, glibc 2.2 s (since Blink 0044) | **musl: yes**: `-p "say hi"` reaches the Anthropic API through the kernel relay ("Invalid API key" for a dummy key) | musl `-p` to the API error: 118 s with the JIT, 108 s with `BUN_JSC_useJIT=0` (Node probe) | glibc build: works since Blink patch 0044 (`--version` 2.2 s): glibc's `pthread_getattr_np` finds the main stack through `/proc/self/maps`, which Blink now answers from the guest's page table. `claude install --native` still installs the musl build (smaller, no glibc in the VFS needed). Live-token test not run: `CLAUDE_CODE_OAUTH_TOKEN` is not in this container's environment. |
| OpenAI Codex | 0.162.0 | ELF, Rust, static-pie musl (294 MB) | GitHub release `codex-x86_64-unknown-linux-musl.tar.gz` (`npm i -g @openai/codex` wraps the same binary) | **yes** | **yes**: `codex exec` reaches `wss://api.openai.com/v1/responses` and `https://…/responses` through the kernel's TCP relay, 401 | Chromium: `--version` 4.8 s, `exec` until the 401s end 59 s (it retries), renderer peak ~2.0 GB; Node probe: 7.9 s / 69 s | none for the request path. It warns about missing bubblewrap (its Linux sandbox) and `/proc/self/exe`; use `--sandbox danger-full-access` for tool calls in Shiro. |
| Grok Build (xAI) | 1.0.50 | ELF, Rust, static-pie (183 MB) | `x.ai/cli/install.sh` → `x.ai/cli/grok-<v>-linux-x86_64` | **yes** | **yes** (Blink patch 0039): `grok -p` reaches `api.x.ai`, 400 for a bad key | Chromium: `--version` 1.8 s; Node probe: `--version` 5.1 s, `-p` to the API error 148 s | Before patch 0039 Blink's BSF/BSR wrote 0 to the destination for a zero source and `-p` panicked ("Span not found"). |
| Antigravity CLI (`agy`, Google) | 1.3.2 | ELF, Go (`GOAMD64` v2, boringcrypto) + cgo/Rust, glibc dynamic (211 MB) | `antigravity.google/cli/install.sh` → manifest → `cli_linux_x64.tar.gz` (sha512) | **yes** (Blink patch 0040), 11 s | not tried (needs a Google sign-in) | — | Before patch 0040 it exited with "compiled with sse4.1 enabled, but this feature is not available". |
| opencode | 1.18.35 | ELF, Bun 1.3.14 (baseline build), glibc dynamic (185 MB); a musl build needs libstdc++/libgcc_s | `npm i -g opencode-ai` (picks `opencode-linux-x64[-baseline\|-musl]`) | **no** | not reached | — | Past `/proc/self/maps` (patch 0044) and timerfd (0045) it still dies of SIGTRAP (WebKit `CRASH()`, an `int3`) in wasm Blink right after installing its signal-30 handler; native Blink `-j` gets further. Sent to perf-blink. |
| Gemini CLI | 0.63.0 | Node (esbuild code-split ESM chunks with top-level await) | `npm i -g @google/gemini-cli` (1.5–2.6 s) | **yes** | **yes**: `gemini --skip-trust -p` reaches `generativelanguage.googleapis.com` through `/api/gemini/`, 400 "API key not valid" | `--version` 9.9 s, `-p` to the error 24 s (Chromium) | Fixed here (below). Left: a "Failed to release project registry lock" warning from proper-lockfile (harmless). |
| Grok CLI (community, `@vibe-kit/grok-cli`) | 0.0.34 | Node | `npm i -g @vibe-kit/grok-cli` | not run | — | — | Superseded by xAI's own Grok Build (above); not tested. |
| aider | 0.86.2 | Python | `pip install aider-chat` | not run | — | — | Pins ~80 packages, many native (numpy, scipy, pydantic-core, tiktoken, orjson, aiohttp, tree-sitter): out of reach of the WASI CPython's pure-Python `pip`. The plausible route is Debian mode (glibc CPython and manylinux wheels in Blink), not tried. |

What was fixed in Shiro for these (tests: `agent-clis.test.ts`):

- **Top-level await across modules**: an ES module whose body awaits runs
  as an async function, so `require()` handed importers its exports before
  its `export { … }` ran (`gemini` failed with `getScriptArgs is not a
  function`). Static imports in async modules and `import()` now wait for
  the imported module's body (`requireModule.ready`, `compileAsyncModule` in
  `src/node-compat/require.ts`), skipping a wait that would close a cycle.
- **Live bindings for esbuild chunks** (`src/commands/jseval/esm-live.ts`):
  esbuild's split chunks export variables that lazy `__esm` initializers
  assign later; importers read them through the exporter's namespace
  (`ValueType` → `__shiro_live3.ValueType`) and exports are getters. Only
  for modules that import esbuild's runtime helpers from a sibling chunk.
- `node:dns/promises`; `fs.utimes`/`utimesSync`/`promises.utimes` set the
  mtime (they were no-ops), and `stat` keeps the mtime it reports for a
  path it hadn't seen written (it was `Date.now()` on every call, which
  proper-lockfile took as a compromised lock).
- `child_process.spawn(…, { env })` passes `env` to the child.
- Gemini CLI relaunches itself under a child `node` only to raise V8's heap
  limit; Shiro sets `GEMINI_CLI_NO_RELAUNCH=true` for it (export it empty
  to override).
- The node runner's 15 s/60 s script timeout and the 10 s wait after the
  entry returns now end only an idle script (no fetch, fs work, timers or
  new output); Gemini's entry awaits the whole run, and a model request
  outlasted them (exit 124).
- `server.mjs` proxies `/api/gemini/` to `generativelanguage.googleapis.com`
  (its preflights reject Gemini CLI's headers); its Clearcut telemetry
  (`play.googleapis.com/log`) is dropped like Claude's.
- `curl -o FILE` (and the new `-O`, `--output`, `-fsSLo`) writes the
  response bytes unchanged; it used to decode them as text and append a
  newline, so a downloaded binary came out 58% larger and corrupt.

How to reproduce the native runs: `tests/tests/shiro-vitest/agent-cli-probe.test.ts`
(skipped unless `AGENT_PROBE_ROOT` is set) loads host directories into the
test FS (the binary under `/opt/…`, plus `/lib64/ld-linux-x86-64.so.2`,
`libc`, `libm`, `libpthread`, `libdl`, `librt`, `libresolv` and a CA
bundle), runs one command line in Blink as a kernel process and prints wall
time, peak RSS of the Node process (it includes the in-memory FS holding the
binary, so ~1.5–3.8 GB here), failing kernel syscalls and the output.
`AGENT_PROBE_RELAY_PORTS` starts `server.mjs`'s TCP relay in a child process
so the guest can reach an HTTPS proxy (`HTTPS_PROXY=http://127.0.0.1:PORT`).
Failing syscalls seen were all expected ones (ENOENT from `openat`/
`newfstatat`, EINVAL from `readlink`, EEXIST from `mkdir`, EINPROGRESS from
`connect`, EAGAIN, ENOTTY); Blink itself reports `rseq` (334) missing, which
glibc tolerates.

## Linux GUI apps (unix/gui)

Unmodified Debian bookworm amd64 programs in Blink, drawing through Xshiro,
the X11 server in the page, into desktop windows ([GUI.md](GUI.md)). Route
**gui** = `gui APP` / the dock: the app's Debian packages are fetched on first
use (sha256-checked, cached by hash), then the ELF runs as a kernel process
with `DISPLAY=:0`. Smoke tests: `x11.test.ts` (protocol, and a raw-protocol
x86-64 client over the kernel's AF_UNIX socket), `gui-apps.test.ts`
(install + launch); browser runs with `scripts/gui/shoot.mjs` (headless
Chromium, screenshots in `docs/screenshots/gui-*.png`). Times: first launch
of an installed app → first frame, in Chromium.

| Software | Version | Route | Status | Tested | Known issues |
| --- | --- | --- | --- | --- | --- |
| xeyes | x11-apps 7.7+9 | gui (7.5 MB) | works | shaped window, pupils follow the pointer; first frame 0.9–1.3 s, warm 0.5 s | — |
| xeyes (Debian mode) | trixie x11-apps | `debian install`, then `gui xeyes` = real `apt-get install` in Blink | works | apt update + install 384 s; window 1.0 s after launch | apt is slow (interpreted/JIT x86) |
| xclock | x11-apps 7.7+9 | gui (8.9 MB) | works | analog clock with RENDER antialiasing; 2.6–2.8 s | — |
| xcalc, xedit | x11-apps 7.7+9 | gui | not checked | — | — |
| xterm | 379 | gui (9.3 MB) | works | Shiro's shell in xterm's pty, typing, output, core fonts; 2.5–2.7 s | no XKB (core keymap), UTF-8 locale falls back to C (Xlib has no C.UTF-8 entry) |
| FeatherPad | 1.3.5 (Qt 5.15.8) | gui (35 MB of an 84 MB closure) | works | menus, toolbar icons, typing text; 10.5–16 s | Qt warns about missing XKB; no GLX (Mesa never downloaded) |
| GPicView | 0.2.5 (GTK 2.24.33) | gui (26.8 MB) | works | opens a PNG at 512×512; 6.9–9.7 s | some stock toolbar icons missing |
| L3afpad | 0.8.18.1.11 (GTK 3.24.38) | gui (33.1 MB of a 51 MB closure) | works | Adwaita theme, menus, typing text; 12.9 s | needed Blink patch 0029 (SSE compares) |
| Mousepad | 0.5.10 (GTK 3, Xfce) | gui (44.6 MB) | works | editor window and menus; 32 s | slow start: waits on D-Bus / xfconf, which aren't there |
| Ristretto | 0.12.4 (GTK 3, Xfce) | gui (35.1 MB) | works | opens a PNG; 14–15.5 s | no thumbnails (tumbler over D-Bus) |
| LXImage-Qt | 1.2.0 (Qt 5) | gui (36.8 MB) | exits | — | without a D-Bus session bus its single-instance check fails and it quits (status 0) |
| GIMP | 2.10.34 (GTK 2) | gui (53.2 MB of a 141 MB closure) | works (slow) | main window, menus; first start 290 s, later starts 84 s | first start queries ~100 plug-ins one Blink process each; 22 plug-ins whose libraries are left out (PDF, HEIF, help browser...) are removed; no MIDI/ALSA, no D-Bus |
| Inkscape | 1.2 (GTK 3) | — | not packaged | — | 94 MB closure; next to try |
