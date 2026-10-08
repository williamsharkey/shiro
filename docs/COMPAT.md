# Popular Unix software in Shiro

Scoreboard for real upstream programs running in Shiro, installed with
`pkg install <name>` and started from the prompt as kernel processes. Each
row has an automated smoke test in
`tests/tests/shiro-vitest/compat-tools.test.ts` (the `describe` named after
the package); "tested" says what it checks. Interactive programs are tested
on a terminal pty (raw mode, alternate screen, resize, Ctrl-C/Ctrl-Z).

Routes:

- **x86** — a static x86-64 musl build from a recipe in
  `scripts/pkgbuild/x86/` (pinned upstream release + the pinned musl.cc
  toolchain), run in Blink ([X86_ENGINES.md](X86_ENGINES.md)). Needs a
  cross-origin isolated page (SharedArrayBuffer). Packages carry
  `"needs": ["x86"]`.
- **wasm** — a WASI/WASIX build ([PACKAGES.md](PACKAGES.md)).

| Software | Version | Route | Status | Tested | Known issues |
| --- | --- | --- | --- | --- | --- |
| less | 710 | x86 | works | pages a file on the tty (alternate screen), `/search`, `G`, `q`; `seq \| less` reads the pipe and takes keys from /dev/tty; plain output when piped | |
| nano | 9.2 | x86 | works | edit, `^O` save, `^X` quit on the tty; C syntax colours from /usr/share/nano | |
| make | 4.4.1 (GNU) | x86 | works | dependency order, recipes through `/bin/sh` and programs on PATH, pattern rules, variables, `-j2`, `make clean`, error exit 2 | |
| diff, cmp, diff3, sdiff | 3.12 (GNU diffutils) | x86 | works | `diff -u` exit codes, `cmp` | |
| patch | 2.8 (GNU) | x86 | works | applies a unified diff | |
| awk (gawk) | 5.4.1 | x86 | works | fields, arrays, `asorti`, `gensub`, printf | no extensions, no MPFR |
| sed | 4.10 (GNU) | x86 | works | `s///g`, `-n p`, `-E`, `-i` | |
| grep | 3.12 (GNU) | x86 | works | `-r` over directories, `-n -c -i -v -o`, `egrep`, exit 1 on no match | no PCRE (`-P`) |
| find, xargs | 4.11.0 (GNU findutils) | x86 | works | `-name -type -exec {} \;`, `-print0 \| xargs -0` | |
| bc, dc | 1.08.2 (GNU) | x86 | works | `bc -l` 20 digits of π, bignums, `dc` | |
| tar | 1.35 (GNU) | x86 | works | `czf` (gzip run as a child through `/bin/sh`), `tzf`, `xzf -C` | |
| gzip, gunzip, zcat | 1.15 (GNU) | x86 | works | `-k`, `-c`, `-d`, `-t`, binary output redirected to a file | |
| vim | 9.2.0000 | x86 | works | edit + `:wq`; syntax colours from the runtime; `:help`; resize (SIGWINCH) updates `&columns`/`&lines`; Ctrl-Z stops it, `fg` resumes; `vim -es` scripting | Startup with `filetype`/`syntax` is slow (seconds): Blink interprets x86 at ~1/120 native speed. No POSIX timers (`timer_create`), so no `'redrawtime'` timeout |

## What made them work

Changes in Shiro that these programs needed, with tests elsewhere:

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

## Building and publishing an x86 package

```bash
export PKG_WORK=$PWD/.pkgbuild          # downloads, toolchain, build trees
bash scripts/pkgbuild/x86/vim.sh        # -> $PKG_WORK/out/vim/{bin,share}
bash scripts/pkgbuild/x86/publish.sh vim 9.2.0000   # -> public/pkg/vim/9.2.0000/*.gz, prints index entries
```

ncurses-based programs are linked against a static ncurses 6.5 with
`xterm-256color`, `xterm`, `screen*`, `tmux*`, `linux`, `vt100`, `vt220` and
`dumb` compiled in, so they work without a terminfo database.
