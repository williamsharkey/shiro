/**
 * AGENTS.md / CLAUDE.md content seeded into /home/user so a coding agent
 * running inside tabcomputer gets one instruction file plus a compatibility shim.
 * Keep it true to what works today (README.md, docs/).
 */
export const AGENTS_MD = `# AGENTS.md: you are running inside tabcomputer

tabcomputer is a computer that lives in a browser tab. You are a coding agent
inside it. \`/home/user/NEO.md\` describes this boot (standalone, or
injected into another page); read it first.

## The machine

- A Unix kernel written in TypeScript runs in the page: processes, fork/exec,
  pipes, ptys, signals, job control, sockets, \`/proc\`. \`ps\` lists kernel
  processes.
- The shell is tabcomputer's own bash-compatible shell, with many builtins
  (coreutils, grep/sed/awk, rg, jq, git, gh, node, npm, vi, nano, tmux).
- Files live in the browser's IndexedDB and survive reloads. Home is
  \`/home/user\`. You run as uid 1000; \`sudo\` gives root.
- x86-64 Linux programs run in the Blink emulator (compiled to WebAssembly).
  WASM programs run directly. Big x86 programs start slowly: seconds, not
  milliseconds.
- TCP to the internet goes through a relay on ports 22, 80, 443 and 9418
  only. UDP is DNS only.

## Installing software

- \`apt install NAME\` (also \`pkg\`) installs from tabcomputer's own index of
  prebuilt programs: vim, htop, git, python3, curl, make, llvm, go and more.
  \`pkg available\` lists them.
- \`debian install\` streams in Debian 13; after that, \`sudo apt install NAME\`
  is Debian's apt. Most of Debian's popular packages work, slowly.
- \`npm install\` and \`pip install\` work (pure-Python wheels for pip).
- \`gui\` lists X11 desktop apps; \`gui NAME\` opens one in a window.

## Useful here

- \`doctor\`: one OK/WARN/FAIL line per subsystem (build, isolation, x86
  engine, relay, sign-ins, Debian, storage, kernel). Run it first when
  something fails. It never prints secrets.
- \`serve DIR\` serves a folder in a preview window; a program that
  \`listen()\`s on a port is served the same way.
- \`page :PORT text|click|input|eval ...\` drives that page, so you can test
  a UI without a browser automation tool.
- \`gh auth login\` signs in to GitHub; git and gh then use the token.

## What doesn't work (yet)

- File watching: \`fs.watch\` never fires and inotify is ENOSYS, so watch
  modes and hot reload don't react to edits. Re-run commands instead.
- \`time\` reports no user/sys CPU time.
- No D-Bus session bus; no hardware, kernel modules or host access.
- Background-task-heavy or highly concurrent agent work can stall the page.
  Prefer working serially.
- Under \`pkg\`'s WASI python, tracebacks can show paths relative to \`/\`
  instead of the working directory.

## tabcomputer's source

The source is not on this machine. It is at
https://github.com/williamsharkey/tabcomputer (\`git clone --depth 1\` it
if you need it). Its docs/ folder has the details and scoreboards.

## Reporting a bug

Run \`doctor\`, then open an issue at
https://github.com/williamsharkey/tabcomputer/issues (\`gh issue create\`
works here) with the command, what happened, what you expected, and the
\`doctor\` output. Never paste tokens or credentials: the ones in this
environment (\`~/.claude/.credentials.json\`, the GitHub token) stay private.
`;

export const CLAUDE_MD = `# CLAUDE.md

Deprecated. Read \`/home/user/AGENTS.md\`, then \`/home/user/NEO.md\`.

This file remains only for clients that still auto-load \`CLAUDE.md\`.
`;
