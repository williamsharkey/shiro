# Shiro - Browser-Native Cloud OS

A browser-based Unix environment backed by IndexedDB. No servers, no tunnels - everything runs in the browser's JavaScript VM. The end goal is running Claude Code directly in the browser with first-class access to the DOM/JS VM.

## Try It

**Live:** [williamsharkey.github.io/shiro](https://williamsharkey.github.io/shiro)

**Local:**
```bash
npm install && npm run dev
```

## Architecture

```
┌─────────────────────────────────────────┐
│  xterm.js Terminal UI                   │
├─────────────────────────────────────────┤
│  Shell Layer (pipes, redirects, env)    │
├──────────┬──────────┬───────────────────┤
│ Coreutils│ JS-native│ Future WASM       │
│ ls,cat,  │ git,     │ npm, node,        │
│ grep,sed │ fetch    │ tcc, etc.         │
├──────────┴──────────┴───────────────────┤
│  Virtual Filesystem (IndexedDB)         │
├─────────────────────────────────────────┤
│  Browser APIs (DOM, Fetch, Workers)     │
└─────────────────────────────────────────┘
```

## Why This Structure?

- **TypeScript with separate files** - catches bugs before runtime, and lets LLMs (like Claude) read/edit one command at a time without loading thousands of lines of context
- **Vite builds to a static bundle** - `dist/` after `npx vite build` is a plain static site. Deploy it anywhere (GitHub Pages, S3, just open it). No backend needed.
- **Adding a command = one file** - create a `.ts` in `src/commands/`, register it in `main.ts`, done
- **`npm run dev` is just for live-reload** during development, not a runtime dependency

## Available Commands

| Category | Commands |
|----------|---------|
| **Files** | `ls`, `cat`, `head`, `tail`, `touch`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `find` |
| **Text** | `grep`, `sed`, `sort`, `uniq`, `wc`, `tr`, `cut`, `diff`, `tee`, `xargs` |
| **Shell** | `cd`, `pwd`, `echo`, `printf`, `env`, `export`, `clear`, `help` |
| **Network** | `fetch` (curl-like HTTP client) |
| **Git** | `git init/add/commit/status/log/diff/branch/clone` |
| **System** | `date`, `whoami`, `hostname`, `uname`, `true`, `false`, `basename`, `dirname` |

## Project Structure

```
src/
├── main.ts              # Bootstrap & command registration
├── terminal.ts          # xterm.js terminal with line editing & tab completion
├── shell.ts             # Command parser (pipes, redirects, env vars, quoting)
├── filesystem.ts        # IndexedDB-backed POSIX filesystem
└── commands/
    ├── index.ts          # Command interface & registry
    ├── coreutils.ts      # Core Unix utilities
    ├── grep.ts           # Pattern searching
    ├── sed.ts            # Stream editing
    ├── git.ts            # Git via isomorphic-git
    ├── find.ts           # File finding
    ├── fetch.ts          # HTTP client
    └── diff.ts           # File diffing
```

## Development

```bash
npm install              # Install dependencies
npm run dev              # Dev server with hot reload
npm run build            # Build static site to dist/
npm test                 # Run tests
npx tsc --noEmit         # Type-check only
```

## Roadmap

- [x] IndexedDB virtual filesystem with POSIX API
- [x] Shell with pipes, redirects, env vars, quoting
- [x] Core Unix utilities (ls, cat, grep, sed, etc.)
- [x] Git via isomorphic-git
- [x] GitHub Pages deployment
- [x] Automated tests
- [ ] BusyBox WASM for complete coreutils
- [ ] Node.js/npm via WebContainers or WASI
- [ ] TCC (Tiny C Compiler) compiled to WASM
- [ ] Claude Code integration with direct DOM/JS VM access
- [ ] Package manager (brew-like) for pre-compiled WASM binaries

## Inspiration

- [functionserver.com](https://functionserver.com) - but instead of communicating into the browser via WebSockets or a server, Shiro runs directly in the JavaScript VM
- [WebContainers](https://webcontainers.io/) by StackBlitz
- [Browsix](https://browsix.org/) - Unix in the browser tab
- [v86](https://github.com/copy/v86) - x86 emulator in browser
