# Shiro - Browser-Native Cloud OS

## Goal
A browser-based Unix environment backed by IndexedDB/OPFS that can eventually run Claude Code natively with direct DOM/JS VM access. No servers, no tunnels - everything runs in the browser's JavaScript VM.

## Architecture

```
┌─────────────────────────────────────────┐
│  xterm.js Terminal UI                   │
├─────────────────────────────────────────┤
│  Shell Layer (command dispatch)         │
├──────────┬──────────┬───────────────────┤
│ BusyBox  │ JS-native│ Future WASM       │
│ WASM     │ tools    │ tools             │
│ (core    │ (git,    │ (npm, node,       │
│  utils)  │  fetch)  │  tcc, etc.)       │
├──────────┴──────────┴───────────────────┤
│  Virtual Filesystem (OPFS + IndexedDB)  │
├─────────────────────────────────────────┤
│  Browser APIs (DOM, Fetch, Workers)     │
└─────────────────────────────────────────┘
```

## Phase 1: Repo Init + Minimal Shell

### Step 1: Create GitHub repo
- `gh repo create williamsharkey/shiro --public --clone`
- Initialize with package.json, tsconfig, basic structure

### Step 2: Project scaffold
```
shiro/
├── package.json
├── tsconfig.json
├── index.html           # Entry point
├── src/
│   ├── main.ts          # Bootstrap
│   ├── terminal.ts      # xterm.js integration
│   ├── shell.ts         # Command parser & dispatcher
│   ├── filesystem.ts    # IndexedDB-backed virtual FS
│   ├── process.ts       # Process abstraction (Web Workers)
│   └── commands/        # Built-in commands
│       ├── index.ts
│       ├── coreutils.ts # ls, cat, echo, mkdir, rm, cp, mv, pwd, cd
│       ├── grep.ts      # grep implementation
│       ├── sed.ts       # sed (basic)
│       └── git.ts       # isomorphic-git wrapper
├── wasm/                # WASM binaries (busybox, etc.)
│   └── README.md
└── vite.config.ts       # Vite bundler config
```

### Step 3: Implement core filesystem
- IndexedDB-backed filesystem with POSIX-like API
- Directory tree structure stored in IndexedDB
- Support: stat, readdir, readFile, writeFile, mkdir, unlink, rename
- Path resolution with `.` and `..`

### Step 4: Implement shell + terminal
- xterm.js for terminal rendering
- Line editor with history (up/down arrows)
- Command parsing (pipes `|`, redirects `>` `>>`, env vars `$`)
- Built-in commands: cd, pwd, echo, env, export, clear, help

### Step 5: Implement JS-native coreutils
- `ls` (with -l, -a flags)
- `cat`, `head`, `tail`
- `mkdir`, `rmdir`, `rm` (-r)
- `cp`, `mv`, `touch`
- `grep` (basic regex)
- `wc`, `sort`, `uniq`
- `echo`, `printf`

### Step 6: Git via isomorphic-git
- `git init`, `git add`, `git commit`, `git status`, `git log`, `git diff`
- Clone from CORS-enabled repos
- All backed by the virtual filesystem

### Step 7: Dev server + build
- Vite for dev server and bundling
- Deploy to GitHub Pages or similar

## Future Phases
- **Phase 2**: BusyBox WASM compilation for complete coreutils
- **Phase 3**: Node.js/npm via WebContainers or custom WASI runtime
- **Phase 4**: TCC (Tiny C Compiler) compiled to WASM
- **Phase 5**: Claude Code integration - tool implementations that operate on virtual FS and have DOM access
- **Phase 6**: Package manager (brew-like) that fetches pre-compiled WASM binaries

## Key Dependencies
- `xterm.js` + `@xterm/addon-fit` - Terminal emulator
- `isomorphic-git` - Git in JS
- `vite` - Build tool
- `typescript` - Type safety
- `idb` - IndexedDB wrapper (or raw IndexedDB)

## Verification
1. `npm install && npm run dev` starts local dev server
2. Terminal renders and accepts input
3. Can run: `ls`, `mkdir test`, `cd test`, `echo "hello" > file.txt`, `cat file.txt`
4. Files persist across page reloads (IndexedDB)
5. `git init && git add . && git commit -m "init"` works
6. `grep` finds patterns in files

## Inspiration
- [functionserver.com](https://functionserver.com) - but instead of communicating into the browser via WebSockets or a server on Digital Ocean, Shiro runs directly in the JavaScript VM
- [WebContainers](https://webcontainers.io/) by StackBlitz
- [Browsix](https://browsix.org/) - Unix in the browser tab
- [v86](https://github.com/copy/v86) - x86 emulator in browser
