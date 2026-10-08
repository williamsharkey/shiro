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
- Builds: the entry chunk was both inlined into index.html and imported
  from its file by lazy chunks, so every module in it existed twice with
  separate state (`pkg install` updated one copy of the package cache, the
  shell read the other). The inline script now only imports the file.

## CLI tools, editors and TUIs (unix/compat-tools)

Smoke tests: `tests/tests/shiro-vitest/compat-tools.test.ts`, one `describe`
per package, run from the shell as kernel processes; the interactive ones
on a terminal pty (raw mode, alternate screen, resize, Ctrl-C/Ctrl-Z).
Packages here are static x86-64 musl builds from `scripts/pkgbuild/x86/`
(pinned upstream source and musl.cc toolchain), installed with `pkg install`
and run in Blink, so they need a cross-origin isolated page
(`"needs": ["x86"]`).

| Software | Version | Route | Status | Tested | Known issues |
| --- | --- | --- | --- | --- | --- |
| less | 710 | pkg (Blink) | works | pages a file on the tty (alternate screen), `/search`, `G`, `q`; `seq \| less` reads the pipe and takes keys from /dev/tty; plain output when piped | |
| nano | 9.2 | pkg (Blink) | works | edit, `^O` save, `^X` quit on the tty; C syntax colours from /usr/share/nano | |
| make | 4.4.1 (GNU) | pkg (Blink) | works | dependency order, recipes through `/bin/sh` and programs on PATH, pattern rules, variables, `-j2`, `make clean`, error exit 2 | |
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

Shiro changes these programs needed (tests in `x86-engine.test.ts`,
`kernel-core.test.ts` and the smoke tests):

- Real `fork()` for Blink guests (patch 0013): a snapshot of the process is
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
  stop signals stop it in the kernel (patch 0012). `x86-engine.test.ts`.
- The filesystem follows symlinks in directory components
  (`/usr/share/vim/vim92/...` through the `/usr/share/vim` link vim's package
  installs).
- `pkg` installs x86-64 packages: gzip-compressed binaries, `.tar.gz` data
  trees, links outside the package root (`"links"`), executable modes.
- `/etc/passwd`, `/etc/group`, `/etc/hosts`, `/etc/hostname` exist; the
  shell exports `LANG=C.UTF-8`.

Building and publishing one of these packages:

```bash
export PKG_WORK=$PWD/.pkgbuild          # downloads, toolchain, build trees
bash scripts/pkgbuild/x86/vim.sh        # -> $PKG_WORK/out/vim/{bin,share}
bash scripts/pkgbuild/x86/publish.sh vim 9.2.0000   # -> public/pkg/vim/9.2.0000/*.gz, prints index entries
```

ncurses-based programs are linked against a static ncurses 6.5 with
`xterm-256color`, `xterm`, `screen*`, `tmux*`, `linux`, `vt100`, `vt220` and
`dumb` compiled in, so they work without a terminfo database.
