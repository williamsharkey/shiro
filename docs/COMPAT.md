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
| vim | 9.2.0000 | x86 | works | edit + `:wq`; syntax colours from the runtime; `:help`; resize (SIGWINCH) updates `&columns`/`&lines`; Ctrl-Z stops it, `fg` resumes; `vim -es` scripting | Startup with `filetype`/`syntax` is slow (seconds): Blink interprets x86 at ~1/120 native speed. No POSIX timers (`timer_create`), so no `'redrawtime'` timeout |

## What made them work

Changes in Shiro that these programs needed, with tests elsewhere:

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
