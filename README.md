# tabcomputer

tabcomputer is a computer that lives in your browser tab: a desktop with windows and a dock,
a Unix kernel written for the page, and real Linux programs. Debian's x86-64 binaries run in
the Blink emulator compiled to WebAssembly, and a TCP relay connects them to the internet.

**Live:** [tabcomputer.com](https://tabcomputer.com). Nothing to install. Your files stay in
this browser's storage for this site.

## Try it

Type these in the Terminal window:

```bash
apt install cowsay && cowsay hello      # tabcomputer's own package index (prebuilt programs)
apt install htop && htop
doctor                                  # one OK/WARN/FAIL line per subsystem

debian install                          # stream in a Debian 13 root filesystem
sudo apt update && sudo apt install -y jq && jq --version   # now Debian's own apt

gh auth login                           # sign in to GitHub with a one-time code
git clone https://github.com/williamsharkey/tabcomputer

gui xeyes                               # an X11 app in a desktop window
claude --npm                            # Claude Code, the pinned JavaScript build
```

## What's real and what's emulated

Real:

- **The kernel.** Processes, fork/exec, file descriptors, pipes, ptys, signals, job control,
  sockets and `/proc`, written in TypeScript for the page ([docs/KERNEL_ABI.md](docs/KERNEL_ABI.md),
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
- **Packages.** Before Debian mode, `apt`/`pkg` install from tabcomputer's own index of
  prebuilt programs: 72 entries, WASM builds and static x86-64 builds such as vim, htop,
  git, python3 and curl ([docs/PACKAGES.md](docs/PACKAGES.md)).
- **Debian.** `debian install` streams in Debian 13 "trixie" amd64. After that,
  `sudo apt install` is Debian's apt against a Debian mirror. Of popcon's top 300 packages,
  298 install and pass a smoke test ([docs/DEBIAN_SCORE.md](docs/DEBIAN_SCORE.md),
  [docs/DEBIAN.md](docs/DEBIAN.md)).
- **Conformance.** LTP syscall tests under Blink pass 237/320; the busybox testsuite
  625/635; the oils shell spec tests 1413/1567 ([docs/CONFORMANCE.md](docs/CONFORMANCE.md)).
- **GUI apps.** `gui` lists Debian X11 apps (xeyes, xterm, GTK and Qt editors and viewers,
  GIMP, Inkscape, NetSurf). They open as desktop windows. GTK 2/3 text can render as real
  DOM text ([docs/GUI.md](docs/GUI.md), [docs/DOM-RENDERING.md](docs/DOM-RENDERING.md)).
- **Browser app (research spike).** Tabs showing real sites on per-site origins, with TLS done
  in the page over the relay ([docs/BROWSER.md](docs/BROWSER.md), [docs/WEB_SCORE.md](docs/WEB_SCORE.md)).
- **Languages.** Node.js (tabcomputer's runtime with real npm tarballs), Python, Go, clang,
  and whatever Debian packages ([docs/COMPAT.md](docs/COMPAT.md)).
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
  on tabcomputer's Node.js runtime. It is installed in the background at first boot, starts
  quickly, and opens a sign-in panel if you aren't signed in. `claude-window` runs it in a new
  window.

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
```

Debian's `git` and OpenSSH (`apt install git openssh-client` in Debian mode) work too, over
the relay.

## Limits

- **Speed.** Hot loops in the x86-64 engine run at about 2–5x native, but starting a big
  program is slow: `gh --version` takes 5.0 s on its first run in a page (75 ms native), and
  GTK and Qt apps take 7–32 s to their first frame (GIMP longer) ([docs/X86_ENGINES.md](docs/X86_ENGINES.md),
  [docs/GUI.md](docs/GUI.md)).
- **Network.** TCP to ports 22, 80, 443 and 9418 only, through the relay. UDP to the internet
  is DNS only (answered over DNS-over-HTTPS). No listening on the internet.
- **Not yet working.** `fs.watch` and inotify (file watchers, hot reload); a D-Bus session bus
  (some GUI apps wait on it or quit); hard links; opencode. Each scoreboard lists its failures
  and why.
- **Storage.** Everything lives in this browser's site storage. Clearing site data erases the
  machine. `doctor` and Settings → Storage show usage.
- **Isolation.** Blocking syscalls and threads need a cross-origin isolated page (SharedArrayBuffer).
  tabcomputer.com is isolated; a page embedded elsewhere may not be.

## Something wrong?

Run `doctor` (also `tabinfo`). It prints one line each for the build, cross-origin isolation,
the x86 engine, the internet relay, sign-ins, Debian, storage and the kernel, and warns when
the tab is older than the server's deploy. It never prints tokens, so you can paste its output
into an issue at [github.com/williamsharkey/tabcomputer/issues](https://github.com/williamsharkey/tabcomputer/issues).

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

## License

MIT

> **Note:** Experimental. Claude Code here runs with tool calls auto-approved. Don't use it
> with sensitive data.
