# tabcomputer

> A computer that lives in your browser tab: a desktop, a real shell with
> processes, pipes and ptys, Debian packages you `apt install`, and Claude Code.
> Your files stay in the tab's storage. Nothing to install.

**Live:** [tabcomputer.com](https://tabcomputer.com)
**Docs:** [tabcomputer.com/docs](https://tabcomputer.com/docs)

## What's in it

- **A desktop** with windows, a dock, a file manager and terminals
  ([docs/DESKTOP.md](docs/DESKTOP.md)). `?ui=terminal` gives the classic full-page terminal.
- **A Unix kernel in the page.** It has processes, fork/exec, signals, ptys, job control, pipes and an
  IndexedDB filesystem that survives reloads ([docs/UNIX_COMPAT.md](docs/UNIX_COMPAT.md),
  [docs/KERNEL_ABI.md](docs/KERNEL_ABI.md)).
- **Real Linux programs.** The Blink x86-64 emulator, compiled to WebAssembly, runs unmodified
  ELF binaries against that kernel ([docs/X86_ENGINES.md](docs/X86_ENGINES.md)).
- **Debian.** `apt install htop vim python3 git …` installs real Debian packages, streamed
  from a Debian mirror ([docs/DEBIAN.md](docs/DEBIAN.md)).
- **The internet.** Guest sockets go out through a TCP relay, so `curl`, `git`, `ssh` and
  `pip` reach real hosts ([docs/NETWORKING.md](docs/NETWORKING.md)).
- **X11 and GUI programs** in desktop windows ([docs/GUI.md](docs/GUI.md)).
- **220+ built-in commands.** They include a bash-compatible shell, coreutils, grep/sed/awk, git, gh, node and npm
  (a Node.js runtime with real npm tarballs), Python, SQLite, tmux, and
  WebAssembly packages ([docs/PACKAGES.md](docs/PACKAGES.md)).
- **Coding agents.** Claude Code is installed in the background on first boot. Other agent CLIs
  are covered in [docs/COMPAT.md](docs/COMPAT.md).

## Try it

```bash
apt install cowsay && cowsay hello from tabcomputer
apt install htop && htop
apt install python3 && python3

git clone https://github.com/williamsharkey/tabcomputer
gh auth login                     # one-time code; private repos work too

claude                            # Claude Code; a sign-in panel opens if needed
doctor                            # one OK/WARN/FAIL line per subsystem, for bug reports
```

## Claude Code

Type `claude`. tabcomputer installs Claude Code in the background on first boot. If you aren't
signed in, a panel opens with a button for the sign-in page and a box for the code it gives
you. Credentials persist in the tab's storage. `claude-window` runs it in a new window, and
`claude login` signs in again.

Plain `claude` runs Anthropic's current native build in the x86-64 engine; `claude install`
downloads it (about 240 MB) and `claude update` fetches a newer one. `claude --npm` (and
`claude install --npm`) runs the pinned pure-JavaScript release, `@anthropic-ai/claude-code@2.1.112`,
on tabcomputer's Node.js runtime instead: no download, and faster to start.

An outer Claude Code can drive a tab over WebRTC: run `remote start` here, then connect with
the `shiro-mcp` package ([shiro-mcp/](shiro-mcp/)).

## Git and GitHub

`git` and a `gh` compatible with the common GitHub CLI commands are built in:

```bash
gh auth login        # shows a one-time code; git name/email are filled in from your account
gh repo clone owner/private-repo
gh repo create my-project --private --source . --push
```

Debian's own `git` and OpenSSH (`apt install git openssh-client`) work too. They use the relay.

## Something wrong?

`doctor` (or `tabinfo`) checks the tab. It prints one line for each of these: the build, cross-origin
isolation, the x86 engine, the internet relay, sign-ins, Debian, storage and the kernel.
It never prints tokens, so you can paste its output into a bug report.

## Development

```bash
npm install
npm run dev                            # dev server at localhost:5173
npm run build                          # build to dist/
PORT=3000 STATIC_DIR=$PWD/dist node server.mjs   # the production server (relay, mirror, isolation)
npm test                               # the vitest suite
```

The page runs as a *profile*, which sets its UI, branding and defaults. tabcomputer is the default
profile. The engine also serves shiro.computer, the terminal-first edition, as the `shiro`
profile ([docs/PROFILES.md](docs/PROFILES.md)). Server options are `TABCOMPUTER_*` environment
variables.

Contributors and coding agents: start with [AGENTS.md](AGENTS.md).

## History

tabcomputer grew out of [Shiro](https://shiro.computer), a browser Unix shell, and keeps its
full history.

## License

MIT

> **Note:** Experimental. Claude Code runs with all tool calls auto-approved. Don't use it with
> sensitive data.
