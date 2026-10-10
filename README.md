# tabcomputer

tabcomputer is a computer that lives in your browser tab: a desktop with windows and a dock,
a Unix kernel written for the page, and real Linux programs. Debian's x86-64 binaries run in
the Blink emulator compiled to WebAssembly, and a TCP relay connects them to the internet.

**Live:** [tabcomputer.com](https://tabcomputer.com). Nothing to install. Your files stay in
this browser's storage for this site.

## Try it

Open the Terminal window and install real Debian:

```bash
debian install                                   # Debian 13 "trixie" amd64; the file tree appears at once
sudo apt update                                  # fetch the package lists
sudo apt install -y jq                           # Debian's own .deb, unpacked by Debian's dpkg
echo '{"a":[1,2,3]}' | jq '.a | add'
sudo apt install -y python3
python3 -c 'import sys; print(sys.version)'
sudo apt install -y ripgrep
sudo apt install -y sqlite3
sudo apt install -y git
sudo apt install -y htop vim nano
gui xeyes                                        # an X11 app in a desktop window
```

These are Debian's unmodified x86-64 binaries running in the Blink emulator, so expect
minutes, not seconds, for an install. Measured in headless Chromium on a 4-vCPU cloud container
against a local server (the "parallel" rows ran with three other tabs doing the same):

| Step | Time |
| --- | --- |
| `debian install` | 0.4–0.9 s (contents stream in on first use) |
| `sudo apt update` | 47 s |
| `sudo apt install -y jq` | 44 s; each `jq` run about 1 s |
| `sudo apt install -y python3` | 4.5 min; each `python3` start about 3 s |
| `sudo apt install -y ripgrep` / `sqlite3` | about 1 min each (parallel) |
| `sudo apt install -y git` | 3.4 min (parallel) |
| `sudo apt install -y htop vim nano` | 2.5 min (parallel) |
| `gui xeyes` | 2 s to install, about 1 s to the window ([docs/GUI.md](docs/GUI.md)) |

The benchmark suite's numbers for the same paths are in [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
("Real workloads"). 496 of popcon's 500 most-installed Debian packages install and pass a
smoke test ([docs/DEBIAN_SCORE.md](docs/DEBIAN_SCORE.md)). Some work but are too slow to enjoy:
Debian's `nodejs` takes 26 s for `node -e`. Use tabcomputer's built-in `node` instead.

### Whole toolchains in seconds

`toolchain install` puts a whole Debian toolchain in place without running apt: the same Debian
packages, prebuilt as layers on the server, recorded in dpkg's database so `apt` keeps working
on top. Each program's files download the first time it runs.

```bash
toolchain list                   # the sets, their size, which are installed
toolchain install c              # build-essential (gcc, g++, make), gdb, cmake, pkg-config
printf '#include <stdio.h>\nint main(void){puts("hi");}\n' > hi.c && gcc hi.c && ./a.out
toolchain install python         # also: go, tex, classic (Fortran, COBOL, Pascal, Ada), node, java
```

From a fresh tab to the first working program: `c` 8.9 s (`gcc hi.c && ./a.out`), `python` 6.6 s,
`tex` 7.0 s (`pdflatex`), `classic` 10.5 s, `node` 24.3 s. The same python3 set through apt took
17.8 minutes, and the `c` set through apt didn't finish in an hour (docs/BENCHMARKS.md
"Toolchain layers", from the unix/toolchains branch; [docs/DEBIAN.md](docs/DEBIAN.md) "Toolchain
layers"). `java` works but is slow: `javac Hello.java && java Hello` took about 2 minutes in a
test shell (Node, under load), and each JVM start prints a harmless CDS warning. Settings →
Toolchains lists the same sets with Install buttons. Until the server has built a set's layer,
`toolchain install` falls back to apt and says so.

### tabcomputer's prebuilt packages

Before `debian install`, `apt` and `pkg` install from tabcomputer's own index instead: 72
packages built for the page ([the full list](#appendix-prebuilt-packages)). They come in two kinds:

- **WebAssembly** (32 packages: WASI and WASIX builds such as jq, python3, sqlite, ripgrep,
  lua, ruby, php, clang, make). They run directly in the browser's WebAssembly engine, with no
  x86 emulation. A `jq` run takes 70–90 ms (Debian's: about 1 s), a `python3 -c 'print(1)'`
  0.1–0.5 s (Debian's: about 3 s).
- **Static x86-64** (40 packages: vim, git, htop, curl, openssh, tmux, gawk, perl and more).
  They still run in Blink, but each is a single static musl binary with no shared libraries,
  dynamic loader or dpkg step to emulate. `git --version` takes 0.2–0.4 s.

Installing one is a sha256-checked download from tabcomputer's own server, with no package
lists to fetch: `apt install jq` took 0.2 s and `pkg install python3` (12.6 MB) 0.5 s, where
Debian's `apt update` alone takes 47 s. The trade-offs: the set is fixed at 72, versions are
pinned, and WASM builds carry WASI's limits (the WASI python3 has no sockets or subprocesses).
Debian has everything else, including libraries, gcc and exact Debian behavior.

Prebuilt wins for the tools it has and for a quick start. Debian wins for everything else.
They mix: after `debian install`, `apt` is Debian's and `pkg install NAME` still gets the
prebuilt build ([how they coexist](#how-prebuilt-debian-and-built-in-commands-coexist)).

## What's real and what's emulated

Real:

- **The kernel.** Processes, fork/exec, file descriptors, pipes, ptys, signals, job control,
  sockets, `/proc`, and System V shared memory, semaphores and message queues (`ipcs`, `ipcrm`),
  written in TypeScript for the page ([docs/KERNEL_ABI.md](docs/KERNEL_ABI.md),
  [docs/UNIX_COMPAT.md](docs/UNIX_COMPAT.md)).
- **The programs.** WebAssembly (WASI/WASIX) builds, and unmodified x86-64 Linux ELF
  binaries, including Debian's own glibc, apt and dpkg.
- **The network.** Guest TCP sockets reach real hosts through a WebSocket-to-TCP relay on the
  server ([docs/NETWORKING.md](docs/NETWORKING.md)).

Emulated:

- **The CPU.** x86-64 runs in Blink compiled to WebAssembly, with a JIT from x86-64 to wasm
  ([docs/X86_ENGINES.md](docs/X86_ENGINES.md)).
- **The disk.** Files live in IndexedDB and survive reloads.
- **The screen.** X11 programs draw through an X server written in TypeScript
  ([docs/GUI.md](docs/GUI.md)).

Not here: hardware devices, kernel modules, and any access to your own machine.

## What's in it

- **Desktop.** Menu bar, dock, windows with snapping, Terminal with tabs, Files, Settings,
  Activity, About, search (Ctrl+Space), light and dark themes, a phone layout with an
  extra-keys bar. `?ui=terminal` gives the full-page terminal ([docs/DESKTOP.md](docs/DESKTOP.md)).
- **Shell and commands.** A bash-compatible shell and built-in commands
  (coreutils, grep/sed/awk, git, gh, node and npm, jq, rg, tmux, vi, nano). `help` lists the
  common ones, `help --all` all of them.
- **Debian.** `debian install` streams in Debian 13 "trixie" amd64; then `sudo apt install` is
  Debian's apt against a Debian mirror. 496 of popcon's top 500 packages install and pass a
  smoke test ([docs/DEBIAN_SCORE.md](docs/DEBIAN_SCORE.md), [docs/DEBIAN.md](docs/DEBIAN.md)).
  Heavier tools work too, slowly: `tesseract` (OCR; 4 min to install, 7.5 s for a line of text)
  and LibreOffice headless (`libreoffice-writer-nogui`: 10 min to install, then
  `soffice --headless --convert-to pdf note.txt` in 37 s; measured in headless Chromium with
  two installs running). calibre doesn't work yet: its install fails or hangs
  ([docs/research/OPPORTUNITIES.md](docs/research/OPPORTUNITIES.md)).
- **Prebuilt packages.** 72 programs built for the page, WebAssembly or static x86-64, that
  install in about a second ([above](#tabcomputers-prebuilt-packages), [docs/PACKAGES.md](docs/PACKAGES.md)).
- **Conformance.** LTP syscall tests under Blink pass 240/322 (272 with engine patches waiting for the next Blink build); the busybox testsuite
  625/635; the oils shell spec tests 1413/1567 ([docs/CONFORMANCE.md](docs/CONFORMANCE.md)).
- **GUI apps.** `gui` lists Debian X11 apps (xterm, GTK and Qt editors and viewers, GIMP,
  Inkscape, Krita, VLC, NetSurf). They open as desktop windows. Of the 29 in the scoreboard,
  all install, 24 open a window and 18 take keyboard input; GTK 2/3 text can render as real
  DOM text ([docs/GUI_SCORE.md](docs/GUI_SCORE.md), [docs/GUI.md](docs/GUI.md),
  [docs/DOM-RENDERING.md](docs/DOM-RENDERING.md)).
- **Browser app (research spike).** Tabs showing real sites on per-site origins, with TLS done
  in the page over the relay ([docs/BROWSER.md](docs/BROWSER.md), [docs/WEB_SCORE.md](docs/WEB_SCORE.md)).
- **Languages.** Node.js (tabcomputer's runtime with real npm tarballs; `node` alone is a
  REPL), Python, Ruby (`irb` works), Go, clang, and whatever Debian packages
  ([docs/COMPAT.md](docs/COMPAT.md)).
- **Web development.** `npm create vite@latest app -- --template react`, `npm i`,
  `npm run dev`, then `serve open 5173`: the app renders in a preview window and an edit to
  `src/App.jsx` arrives by hot reload (about 15 s from nothing to running; COMPAT.md "vite 8").
  Node's `fs.watch` sees every write, so nodemon, jest --watch and chokidar work too.
- **Web servers in the tab.** `serve DIR` serves a folder in a preview window; programs that
  `listen()` are reachable the same way; `page :PORT click #id` drives the page.
- **Media.** `ffmpeg` is ffmpeg.wasm, served by tabcomputer itself; its ~31 MB core loads the first time it runs.

## Claude Code and other agents

Claude Code comes in two builds:

- **Native** (the default on tabcomputer). `claude install` downloads Anthropic's
  linux-x64-musl binary (about 240 MB) and plain `claude` runs it in the x86-64 engine.
  `claude update` fetches a newer one. It is slow: one `claude -p` request took 85–105 s to
  reach the API in the measurements in [docs/COMPAT.md](docs/COMPAT.md).
- **npm** (`claude --npm`). The pinned pure-JavaScript release, `@anthropic-ai/claude-code@2.1.112`,
  on tabcomputer's Node.js runtime. It is installed in the background at first boot and starts
  quickly. `claude-window` runs it in a new window.

Both builds sign themselves in. Signed out, Claude Code opens the sign-in page in a new browser
tab; paste the code it shows at the "Paste code here" prompt. `claude login` signs in again.

Codex, Grok Build, Gemini CLI and aider also reach their APIs from tabcomputer; opencode does
not start yet. The table with versions, timings and blockers is in
[docs/COMPAT.md](docs/COMPAT.md#agent-clis-unixagent-clis).

An agent outside the tab can drive it: run `remote start` here, then connect with the
`shiro-mcp` package ([shiro-mcp/](shiro-mcp/)).

## Git and GitHub

`git` and a `gh` covering the common GitHub CLI commands are built in:

```bash
gh auth login        # shows a one-time code; fills in git user.name/email from your account
gh repo clone owner/private-repo
gh repo create my-project --private --source . --push
gh issue create --title T --body-file notes.md
gh pr list --json number,title --jq '.[].title'
```

Debian's `git` and OpenSSH (`apt install git openssh-client` in Debian mode) work too, over
the relay.

## Limits

- **Speed.** Hot loops in the x86-64 engine run at about 2–5x native, but starting a big
  program is slow: `gh --version` takes 5.0 s on its first run in a page (75 ms native), and
  most GTK and Qt apps take 4–24 s to their first window (Inkscape 38 s) ([docs/X86_ENGINES.md](docs/X86_ENGINES.md),
  [docs/GUI_SCORE.md](docs/GUI_SCORE.md)).
- **Network.** TCP to ports 22, 80, 443 and 9418 only, through the relay. UDP to the internet
  is DNS only (answered over DNS-over-HTTPS). No listening on the internet.
- **Not yet working.** inotify for Linux programs (Node's `fs.watch` works); a D-Bus session bus
  (some GUI apps wait on it or quit); opencode. Each scoreboard lists its failures
  and why.
- **dpkg under Blink.** dpkg-deb's `.xz` decompression occasionally crashes or reports corrupt
  data (an open Blink issue, [docs/X86_ENGINES.md](docs/X86_ENGINES.md) item 57). It hit 2 of about 15
  `apt install` runs while this README was checked (python3 once, gcc once). When `apt` stops
  with a dpkg error, run the install again; apt suggests `sudo apt --fix-broken install`.
- **Storage.** Everything lives in this browser's site storage. Clearing site data erases the
  machine. `doctor` and Settings → Storage show usage.
- **Isolation.** Blocking syscalls and threads need a cross-origin isolated page (SharedArrayBuffer).
  tabcomputer.com is isolated; a page embedded elsewhere may not be.

## Something wrong?

Run `doctor` (also `tabinfo`). It prints one line each for the build, cross-origin isolation,
the x86 engine, the internet relay, sign-ins, Debian, storage and the kernel, and warns when
the tab is older than the server's deploy. `dmesg` shows the kernel log, including why the
relay refused a connection. `doctor` never prints tokens, so you can paste its output
into an issue at [github.com/williamsharkey/tabcomputer/issues](https://github.com/williamsharkey/tabcomputer/issues).

`doctor --agents` tests what agent CLIs (Claude Code, Codex) need, in a scratch
directory under `/tmp/doctor-UID`: `mkdir -p` with mode 0700, an `O_EXCL` temp
file renamed over a target, `stat`/`lstat`/`fstat` agreeing, `realpath`, and a
child `sh -c 'echo hi'` writing to a file. Each step is OK or FAIL with the errno.
It runs them twice, as a static x86-64 binary under Blink
(`scripts/agent-probe/agentprobe.c`, the syscalls the native Claude binary makes)
and through the Node runtime (what the npm build uses), so you can see which layer
breaks. It also runs the native `claude --version` if that is installed. Plain
`doctor` shows a one-line summary.

## Development

```bash
npm install
npm run dev                                      # dev server at localhost:5173
npm run build                                    # build to dist/
PORT=3000 STATIC_DIR=$PWD/dist node server.mjs   # the production server: relay, Debian mirror, isolation headers
npm test                                         # the vitest suite (runs from tests/)
npx tsc --noEmit -p .                            # typecheck
```

The same engine can run as another product through a *profile* (`profiles/<id>/`): UI mode,
branding and defaults. tabcomputer is the default profile ([docs/PROFILES.md](docs/PROFILES.md)).
Server options are `TABCOMPUTER_*` environment variables.

Production is one droplet set up by [deploy/tabcomputer/](deploy/tabcomputer/README.md); a push
to the `deploy` branch ships.

Coding agents and contributors: start with [AGENTS.md](AGENTS.md). All docs: [docs/README.md](docs/README.md).

## History

tabcomputer grew out of [Shiro](https://shiro.computer), a browser Unix shell, and keeps its
history. The engine still runs shiro.computer as the terminal-first `shiro` profile.

## Appendix: prebuilt packages

`src/pkg-index.json`, as `pkg available` lists it. "Download" is what `pkg install` fetches.
WASI and WASIX builds run as WebAssembly; "old WASI" builds use the older `wasi_unstable` ABI and
run in the page's simpler runtime. x86-64 builds are static musl binaries run in Blink.
Recipes are in `scripts/pkgbuild/`. Details: [docs/PACKAGES.md](docs/PACKAGES.md).

| Package | Version | Kind | Download | Commands |
| --- | --- | --- | --- | --- |
| coreutils | 0.12.0 | WASM (WASI) | 7.7 MB | coreutils, arch, base32, base64, basename, … |
| lua | 5.4.7 | WASM (WASI) | 519 kB | lua, luac |
| python3 | 3.13.7 | WASM (WASI) | 12.6 MB | python3, python |
| make | 4.4.1 | WASM (WASI) | 259 kB | make, gmake |
| llvm | 21.1.4 | WASM (WASI) | 52.8 MB | clang, clang++, cc, c++, wasm-ld, … |
| go | 1.24.7 | WASM (WASI) | 308.2 MB | go, gofmt |
| sqlite | 3.50.4 | WASM (WASI) | 1.7 MB | sqlite3 |
| jq | 1.8.1 | WASM (WASI) | 1.1 MB | jq |
| cowsay | 0.3.0 | WASM (WASI) | 776 kB | cowsay, cowthink |
| figlet | 0.0.1 | WASM (WASI) | 2.3 MB | figlet, chkfont |
| uuid | 0.3.0 | WASM (WASI) | 2.4 MB | uuid |
| wabt | 1.0.37 | WASM (WASI) | 20.5 MB | wat2wasm, wasm2wat, wasm-validate, wasm-strip, wasm-interp, … |
| ruby | 3.4.1 | WASM (WASI) | 30.8 MB | ruby, gem, irb, rake, bundle, … |
| perl | 5.40.0 | x86-64 static (Blink) | 21.8 MB | perl, prove, shasum, json_pp, ptar, … |
| ninja | 1.12.1 | x86-64 static (Blink) | 897 kB | ninja |
| cmake | 3.31.9 | x86-64 static (Blink) | 31.3 MB | cmake, ctest |
| fortune | 0.2.0 | WASM (old WASI) | 2.4 MB | fortune |
| lolcat | 0.2.0 | WASM (old WASI) | 2.1 MB | lolcat |
| brotli | 0.0.1 | WASM (old WASI) | 707 kB | brotli |
| openssl-wasm | 0.2.0 | WASM (old WASI) | 1.6 MB | openssl |
| qr2text | 0.0.1 | WASM (old WASI) | 499 kB | qr2text |
| viu | 0.2.3 | WASM (old WASI) | 3.1 MB | viu |
| quickjs | 0.0.3 | WASM (old WASI) | 2.6 MB | quickjs, qjs |
| util-linux | 0.0.1 | WASM (old WASI) | 543 kB | cal |
| bash | 1.0.25 | WASM (WASIX) | 1.9 MB | bash |
| dash | 1.0.19 | WASM (WASIX) | 335 kB | dash |
| grep-wasix | 3.12.0 | WASM (WASIX) | 365 kB | grep |
| sed-wasix | 4.9.0 | WASM (WASIX) | 263 kB | sed |
| less-wasix | 685.0.1 | WASM (WASIX) | 467 kB | less |
| ripgrep | 15.2.1 | WASM (WASIX) | 3.4 MB | rg |
| curl-wasix | 8.4.0 | WASM (WASIX) | 9.0 MB | curl |
| quickjs-ng | 0.15.1 | WASM (WASIX) | 2.1 MB | qjs-ng |
| php | 8.3.403 | WASM (WASIX) | 85.7 MB | php |
| python | 3.13.20 | WASM (WASIX) | 308.7 MB | python3.13 |
| clang | 16.0.0 | WASM (WASIX) | 775.0 MB | clang-16, clang, wasm-ld, lld, llvm-ar, … |
| less | 710 | x86-64 static (Blink) | 230 kB | less, lessecho |
| vim | 9.2.0000-1 | x86-64 static (Blink) | 8.7 MB | vim, vi, view, vimdiff, ex |
| neovim | 0.12.5 | x86-64 static (Blink) | 9.1 MB | nvim |
| emacs | 31.1 | x86-64 static (Blink) | 26.1 MB | emacs, emacsclient, etags, ebrowse |
| nano | 9.2 | x86-64 static (Blink) | 322 kB | nano |
| diffutils | 3.12 | x86-64 static (Blink) | 244 kB | diff, cmp, diff3, sdiff |
| patch | 2.8 | x86-64 static (Blink) | 100 kB | patch |
| gawk | 5.4.1 | x86-64 static (Blink) | 374 kB | gawk, awk |
| sed | 4.10 | x86-64 static (Blink) | 106 kB | sed |
| grep | 3.12 | x86-64 static (Blink) | 127 kB | grep, egrep, fgrep |
| findutils | 4.11.0 | x86-64 static (Blink) | 242 kB | find, xargs |
| bc | 1.08.2 | x86-64 static (Blink) | 106 kB | bc, dc |
| tar | 1.35 | x86-64 static (Blink) | 384 kB | tar |
| gzip | 1.15 | x86-64 static (Blink) | 78 kB | gzip, gunzip, zcat |
| tree | 2.2.1 | x86-64 static (Blink) | 64 kB | tree |
| file | 5.46 | x86-64 static (Blink) | 595 kB | file |
| xz | 5.8.1 | x86-64 static (Blink) | 153 kB | xz, unxz, xzcat, lzma |
| zstd | 1.5.7 | x86-64 static (Blink) | 301 kB | zstd, unzstd, zstdcat |
| zip | 3.0 | x86-64 static (Blink) | 138 kB | zip |
| unzip | 6.0 | x86-64 static (Blink) | 109 kB | unzip, zipinfo |
| ca-certificates | 2026-09-25 | x86-64 static (Blink) | 108 kB | (certificates) |
| openssl | 3.5.9 | x86-64 static (Blink) | 2.2 MB | openssl |
| curl | 8.22.0 | x86-64 static (Blink) | 2.2 MB | curl |
| git | 2.56.0-1 | x86-64 static (Blink) | 5.8 MB | git, git-upload-pack, git-receive-pack, git-upload-archive |
| fd | 10.3.0 | x86-64 static (Blink) | 1.7 MB | fd |
| bat | 0.26.1 | x86-64 static (Blink) | 3.5 MB | bat |
| fzf | 0.74.0 | x86-64 static (Blink) | 2.0 MB | fzf |
| yq | 4.52.1 | x86-64 static (Blink) | 5.4 MB | yq |
| tmux | 3.8 | x86-64 static (Blink) | 671 kB | tmux |
| screen | 5.0.2 | x86-64 static (Blink) | 319 kB | screen |
| htop | 3.5.3 | x86-64 static (Blink) | 266 kB | htop |
| procps | 4.0.7 | x86-64 static (Blink) | 881 kB | top, ps, free, uptime, pgrep, … |
| wget | 1.25.0 | x86-64 static (Blink) | 2.2 MB | wget |
| rsync | 3.5.1 | x86-64 static (Blink) | 529 kB | rsync |
| mandoc | 1.14.6 | x86-64 static (Blink) | 344 kB | man, mandoc, apropos, whatis, makewhatis |
| openssh | 10.6p1 | x86-64 static (Blink) | 8.9 MB | ssh, scp, sftp, ssh-keygen, ssh-agent, … |
| gnupg | 2.5.24 | x86-64 static (Blink) | 9.3 MB | gpg, gpgv, gpg-agent, gpgconf, gpg-connect-agent, … |

### How prebuilt, Debian and built-in commands coexist

A command name can come from three places: a tabcomputer builtin (TypeScript, in the page), a
prebuilt package (files in `/usr/lib/pkg/NAME/`, linked as `/usr/bin/CMD`), or a Debian package
(its own file in `/usr/bin`).

- **Prebuilt over builtin.** An installed prebuilt command replaces the builtin of the same name
  (`jq`, `sqlite3`, `lua`). Commands marked `"shadow": false` in the index don't: coreutils'
  applets and every WASIX package's commands (`bash`, `grep`, `sed`, `less`, `rg`, `curl`, `php`, ...). They stay reachable as
  `/usr/bin/CMD`. `builtin NAME` always reaches the builtin.
- **`apt` before and after Debian mode.** Before `debian install`, `apt`, `apt-get` and `pkg`
  are all tabcomputer's package manager. After it, `apt` and `apt-get` are Debian's
  (`/usr/bin/apt`), and `pkg` is the prebuilt one. Prebuilt packages installed earlier keep working.
- **Prebuilt vs Debian.** `/usr/bin/CMD` holds one of them. Installing the Debian package
  replaces a prebuilt link. `pkg install` won't replace a Debian file: it warns
  `not replacing /usr/bin/jq (a regular file)`. To switch, for example with jq:

  ```bash
  sudo apt install -y jq                            # Debian's jq (1.7)
  sudo apt remove -y jq && pkg install --reinstall jq  # back to the prebuilt jq (1.8.1)
  /usr/lib/pkg/jq/bin/jq.wasm --version              # the prebuilt one by path, whichever owns /usr/bin/jq
  ```

- **Builtins vs Debian (the overlay).** In Debian mode a Debian program file replaces the
  builtin of the same name, except for the programs in
  [`src/debian/overlay-policy.json`](src/debian/overlay-policy.json). There, tabcomputer's
  builtin passes the same tests as Debian's and runs without emulation, so it stays the default:
  `base64 basename cut diff dirname expr find grep head ls md5sum od paste sed seq sha256sum sort
  tail tee uniq xargs`, plus apt's `http` and `store` methods and `dpkg-preconfigure`. The choice is
  recorded as a dpkg diversion (Debian's file moves to `PATH.debian`), so `dpkg-divert --list`
  shows it. To switch:

  ```bash
  tabcomputer-alternatives --list                  # every overlaid program and who runs it
  tabcomputer-alternatives --display grep          # who runs it, why, and the dpkg diversion
  tabcomputer-alternatives --set grep debian       # Debian's grep (GNU grep 3.11)
  tabcomputer-alternatives --auto grep             # back to the default (tabcomputer's)
  ```

  Details: [docs/DEBIAN.md](docs/DEBIAN.md) ("Hybrid overlay").

## License

MIT

> **Note:** Experimental. Claude Code here runs with tool calls auto-approved. Don't use it
> with sensitive data.
