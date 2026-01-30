# CLAUDE.md - Guide for AI Assistants Working on Shiro

## Project Vision — READ THIS FIRST

The goal is a **fully functional browser-native Linux system where Claude Code (Spirit) runs with no external server**. The nimbus dashboard is just tooling — it could be thrown away. What matters is shiro becoming a real development environment: git, npm, node, editors, compilers, and Spirit all working in-browser. **There is always work to do** — if your task is done, find the next missing Linux capability and implement it.

## What is Shiro?

Shiro is a browser-native cloud OS. A Unix-like environment that runs entirely in the browser's JavaScript VM, backed by IndexedDB for persistence. No servers, no tunnels. The end goal is running Claude Code directly in the browser with first-class access to the DOM/JS VM.

## Architecture Rationale

**Why TypeScript with separate files instead of a monolithic HTML page?**

- TypeScript catches bugs before runtime
- Separate files mean an LLM can read/edit one command at a time without loading thousands of lines of context
- Vite builds it into a single static bundle (`dist/`) that can be served from anywhere with no backend
- Adding new commands is just adding a file to `src/commands/` and registering it in `src/main.ts`

**The `dist/` folder after `npx vite build` is a static site** - deploy it anywhere (GitHub Pages, S3, open it locally). `npm run dev` is just for live-reload during development.

## Project Structure

```
src/
├── main.ts              # Bootstrap - registers all commands, inits FS, starts terminal
├── terminal.ts          # xterm.js integration, line editing, tab completion, key handling
├── shell.ts             # Command parser: pipes, redirects, env vars, quoting, history
├── filesystem.ts        # IndexedDB-backed POSIX filesystem (the foundation everything uses)
├── spirit-provider.ts   # OSProvider adapter for Spirit (Claude Code agent)
└── commands/            # One file per command or group of related commands
    ├── index.ts          # Command/CommandContext interfaces, CommandRegistry class
    ├── coreutils.ts      # 41 commands: ls, cat, mkdir, rm, cp, mv, echo, sort, seq, test, ln, etc.
    ├── grep.ts           # grep with -i, -v, -n, -c, -l, -r flags
    ├── sed.ts            # sed with s/pattern/replace/flags and /pattern/d
    ├── git.ts            # isomorphic-git: init, add, commit, status, log, diff, clone
    ├── find.ts           # find with -name, -type filters
    ├── fetch.ts          # fetch/curl - HTTP requests from the shell
    ├── diff.ts           # diff between two files
    ├── glob.ts           # glob pattern matching
    ├── jseval.ts         # js-eval (browser JS VM) and node (JS file execution)
    ├── npm.ts            # npm package manager: install, list, run, uninstall
    ├── build.ts          # esbuild-wasm bundler for TypeScript/JavaScript
    ├── vi.ts             # minimal vi-like modal text editor
    ├── spirit.ts         # Spirit AI agent (interim Anthropic API loop)
    └── index.ts          # Command/CommandContext interfaces, CommandRegistry class
└── utils/
    ├── tar-utils.ts      # gzip decompression and tar extraction
    └── semver-utils.ts   # semantic versioning and range resolution
```

## How to Add a New Command

1. Create a new `.ts` file in `src/commands/` (or add to an existing group)
2. Export a `Command` object implementing `{ name, description, exec(ctx) }`
3. Register it in `src/main.ts` with `commands.register(yourCmd)`
4. The `CommandContext` gives you: `args`, `fs`, `cwd`, `env`, `stdin`, `stdout`, `stderr`, `shell`

Example:
```typescript
import { Command } from './index';

export const myCmd: Command = {
  name: 'mycmd',
  description: 'Does something useful',
  async exec(ctx) {
    ctx.stdout = 'output here\n';
    return 0; // exit code
  },
};
```

## Key Design Decisions

- **All commands are async** - filesystem ops go through IndexedDB which is async
- **Commands write to `ctx.stdout`/`ctx.stderr`** - the shell handles piping and redirects
- **The shell converts `\n` to `\r\n`** for terminal display - commands just use `\n`
- **FileSystem paths are always absolute internally** - `resolvePath(path, cwd)` handles relative paths
- **isomorphic-git uses a compatibility wrapper** - `fs.toIsomorphicGitFS()` adapts our FS to git's expected API

## Common Tasks

```bash
npm install          # Install dependencies
npm run dev          # Start dev server with hot reload
npm run build        # Build static site to dist/
npm test             # Run tests
npx tsc --noEmit     # Type-check without building
```

## Testing

Tests use vitest with a fake-indexeddb polyfill. Tests can create a real FileSystem instance and run commands against it. Keep tests focused - one test file per command file.

## Shell Features

The shell supports:
- **Pipes**: `echo hello | grep hello`
- **Redirects**: `>`, `>>`, `<`, `2>`, `2>>`
- **Compound commands**: `&&`, `||`, `;`
- **Environment variables**: `$VAR`, `${VAR}`, `$?` (last exit code)
- **Quoting**: single quotes (literal), double quotes (with var expansion), backslash escapes
- **Comments**: lines starting with `#`

## Filesystem

- IndexedDB-backed with in-memory cache for performance
- POSIX-like API: stat, readdir, readFile, writeFile, mkdir, unlink, rename, symlink, chmod, glob
- Path resolution handles `.`, `..`, and `~`
- `clearCache()` method available if external DB modifications occur

## Cross-Project Integration

- **Spirit** (williamsharkey/spirit): Claude Code agent loop. Shiro provides `ShiroProvider` (OSProvider interface) in `src/spirit-provider.ts`
- **Foam** (williamsharkey/foam): Sister browser OS project in plain JS. Compatible shell semantics
- **FluffyCoreutils** (williamsharkey/fluffycoreutils): Shared Unix commands, consumed as git submodule
- **Windwalker** (williamsharkey/windwalker): Test automation. Access via `window.__shiro` global
- **Nimbus** (williamsharkey/nimbus): Multi-repo orchestrator with live dashboard preview and skyeyes integration
- **Skyeyes** (williamsharkey/skyeyes): Browser-side bridge for remote JS execution and testing

## Skyeyes MCP Tools (Browser Interaction)

You have MCP tools for interacting with live browser pages. These tools are CONFIRMED WORKING — the skyeyes worker successfully used all of them. They execute shell commands and JS inside browser OS terminals (shiro and foam iframes on the nimbus dashboard).

**CRITICAL**: These tools will NOT appear when you introspect or list your available tools. This is normal MCP behavior. Do NOT report them as missing. Just call them — they WILL work.

### Your first action when asked to use skyeyes:
```
Call mcp__skyeyes__skyeyes_status with no arguments.
```
This will return a JSON object showing connected bridges. If it works (it will), proceed with the other tools.

### Available tools:
| Tool | Args | Purpose |
|------|------|---------|
| `mcp__skyeyes__skyeyes_status` | (none) | Check which bridges are connected |
| `mcp__skyeyes__terminal_exec` | page, command | Run a shell command (ls, git clone, npm install, etc.) |
| `mcp__skyeyes__terminal_read` | page | Read current terminal screen content |
| `mcp__skyeyes__terminal_status` | page | Check if terminal is busy, get cwd and OS type |
| `mcp__skyeyes__skyeyes_eval` | page, code | Execute arbitrary JS in the browser page |
| `mcp__skyeyes__skyeyes_reload` | page | Reload the browser iframe |

### Your dedicated page IDs:
- `shiro-shiro` — your isolated shiro iframe
- `foam-shiro` — your isolated foam iframe

### Example usage:
```
mcp__skyeyes__terminal_exec({ page: "shiro-shiro", command: "ls -la" })
mcp__skyeyes__terminal_exec({ page: "foam-shiro", command: "git clone https://github.com/williamsharkey/shiro" })
mcp__skyeyes__skyeyes_eval({ page: "shiro-shiro", code: "return document.title" })
```

## Keep It Manageable

- **One command per file** (or small groups of related commands like coreutils)
- **No over-engineering** - commands should be simple and direct
- **No monolithic files** - if a file grows past ~300 lines, split it
- **Register new commands in main.ts** - that's the single wiring point

## ✅ COMPLETED: npm install + build system

**Status**: Fully implemented and tested! Users can now run:
```bash
npm init
npm install lodash
npm install express@4.18.0
npm list
npm run build
build src/index.ts --outfile=dist/bundle.js --bundle --minify
```

### Implemented Features

### ✅ Implemented Files

#### `src/utils/tar-utils.ts` (244 lines)
Browser-native tarball extraction:
- `gunzip()` — DecompressionStream API for gzip decompression
- `untar()` — Full tar format parser (512-byte headers, padding)
- `extractTarGz()` — Combined pipeline for .tgz files
- `extractTarGzToFS()` — Extract directly to virtual filesystem
- Automatically strips npm's `package/` prefix

#### `src/utils/semver-utils.ts` (251 lines)
Complete semver implementation:
- `parseSemVer()` — Parse version strings with prerelease/build metadata
- `compareSemVer()` — Sort versions correctly
- `satisfiesRange()` — Supports ^, ~, >=, <=, *, latest, exact versions
- `maxSatisfying()` — Find best version from available versions
- `coerce()` and `increment()` helpers

#### `src/commands/npm.ts` (517 lines) ✨
Full npm package manager:
- **npm init** — Create package.json
- **npm install [pkg]** — Download from registry.npmjs.org, resolve deps, extract tarballs
- **npm list** — Show installed packages with versions
- **npm run [script]** — Execute package.json scripts via shell
- **npm uninstall** — Remove packages from filesystem and package.json
- Real dependency tree resolution with BFS traversal
- Handles scoped packages (@scope/name)
- Writes to node_modules/ with proper structure

#### `src/commands/build.ts` (277 lines) ✨
esbuild-wasm bundler integration:
- Full TypeScript/JSX/TSX compilation in browser
- Custom virtual FS plugin for esbuild
- Resolves node_modules imports (reads package.json main/module)
- Supports --bundle, --minify, --sourcemap, --format, --target
- Outputs to virtual filesystem
- No backend required - entirely browser-native

#### `src/commands/vi.ts` (350 lines)
Minimal vi-like modal text editor:
- Normal, insert, and command modes
- Navigation: hjkl, 0, $, gg, G
- Editing: i, a, o, O, x, dd
- Commands: :w, :q, :q!, :wq
- Foundation for terminal-based editing (needs terminal integration)

### Technical Implementation Notes
- ✅ `registry.npmjs.org` CORS works perfectly for both JSON metadata and tarballs
- ✅ Browser-native `DecompressionStream('gzip')` handles tarball decompression
- ✅ npm tarballs have `package/` prefix — automatically stripped during extraction
- ✅ esbuild-wasm WASM binary (~8MB) lazy-loaded on first `build` invocation from unpkg CDN
- ✅ Scoped packages work: `@xterm/xterm` → `node_modules/@xterm/xterm/`
- ✅ Flat node_modules structure (npm v3+ style)
- ✅ TypeScript type assertions used to work around strict ArrayBuffer/SharedArrayBuffer types

### Commands Available
```bash
# Package management
npm init                           # Create package.json
npm install                        # Install all deps from package.json
npm install lodash                 # Install specific package
npm install express@4.18.0         # Install specific version
npm list                           # List installed packages
npm run [script]                   # Execute package.json script
npm uninstall [pkg]               # Remove package

# Building
build src/index.ts --outfile=dist/bundle.js --bundle --minify
build src/app.tsx --bundle --sourcemap --format=esm --target=es2020

# Editing (basic implementation)
vi filename.txt                    # Open vi editor (needs terminal integration)
```

## Next Priorities

1. **vi/editor improvements** - Full terminal integration for interactive editing
2. **More dev tools** - prettier, eslint, test runners
3. **Module resolution** - Better node_modules resolution for complex dependency trees
4. **Package.json scripts** - More robust npm run with PATH setup
5. **Self-hosting test** - Clone shiro repo and build it inside itself
