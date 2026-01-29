# CLAUDE.md - Guide for AI Assistants Working on Shiro

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
    └── spirit.ts         # Spirit AI agent (interim Anthropic API loop)
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

## Next Task: npm install + build system for self-hosting

### Goal
Inside Shiro's browser terminal, run:
```
git clone https://github.com/williamsharkey/shiro
cd shiro
npm install
npm run build
```

### New Files to Create (4)

#### 1. `src/commands/tar-utils.ts` (~80 lines)
Utility module for npm install. No command export.
- `decompressGzip(data: Uint8Array): Promise<Uint8Array>` — uses browser-native `DecompressionStream('gzip')`
- `extractTar(data: Uint8Array): TarEntry[]` — parses POSIX tar format (512-byte headers), strips npm's `package/` prefix
- TarEntry: `{ path: string, type: 'file' | 'dir', content: Uint8Array, mode: number }`

#### 2. `src/commands/semver-utils.ts` (~60 lines)
Minimal semver resolver for `^x.y.z` ranges (all Shiro deps use this).
- `parseSemver(v)` — parse "1.27.1" → { major, minor, patch }
- `satisfies(version, range)` — check if version matches `^x.y.z`
- `maxSatisfying(versions[], range)` — pick highest matching version

#### 3. `src/commands/npm.ts` (~250 lines)
Main npm command. Exports `npmCmd: Command`.

**`npm install` flow:**
1. Read `package.json` from cwd, merge dependencies + devDependencies
2. BFS resolve dependency tree: fetch `https://registry.npmjs.org/{pkg}` (CORS-enabled), pick version with `maxSatisfying()`, read transitive deps
3. Download tarballs: `https://registry.npmjs.org/{pkg}/-/{name}-{version}.tgz`
4. Decompress + extract each tarball into `node_modules/{pkg}/`
5. Scoped packages (e.g. `@xterm/xterm`): URL-encode scope, directory is `node_modules/@xterm/xterm/`
6. Flat node_modules (npm v3+ style), first version wins on conflicts

**`npm run <script>` flow:**
1. Read `package.json` scripts
2. Execute script string via `ctx.shell.execute(script, ...)`

#### 4. `src/commands/build.ts` (~150 lines)
esbuild-wasm integration. Exports `buildCmd`, `tscCmd`, `viteCmd`.

**`build` command:**
- Initialize esbuild-wasm (lazy, on first use)
- Custom esbuild plugin `shiro-virtual-fs`:
  - `onResolve`: resolve relative imports against virtual FS, bare specifiers against `node_modules/` (read package.json main/module field)
  - `onLoad`: read file contents from virtual FS, pick loader by extension (.ts → 'ts', .css → 'css', .js → 'js')
  - Extension resolution: try exact, .ts, .tsx, .js, /index.ts, /index.js
- Call `esbuild.build()` with `write: false`, then write outputFiles to virtual FS `dist/`

**`tsc` stub:** Returns 0 with "Type checking skipped (browser environment)" — Shiro's tsconfig has `noEmit: true` so tsc only type-checks, which we skip for MVP

**`vite` stub:** `vite build` delegates to `buildCmd.exec()`. Other subcommands return error.

### Files to Modify (2)

**`src/main.ts`** — Add imports and register: `npmCmd`, `buildCmd`, `tscCmd`, `viteCmd`

**`package.json`** — Add `esbuild-wasm` to dependencies, then `npm install` on host

### Implementation Order
1. `tar-utils.ts` — standalone, no deps on new code
2. `semver-utils.ts` — standalone, no deps on new code
3. `npm.ts` — depends on tar-utils and semver-utils
4. `build.ts` — depends on esbuild-wasm package
5. Register in `main.ts`, add esbuild-wasm to `package.json`
6. Run tests, type-check, push

### Technical Notes
- `registry.npmjs.org` supports CORS for both JSON metadata and tarballs
- Browser-native `DecompressionStream('gzip')` handles tarball decompression (all modern browsers)
- npm tarballs wrap files under a `package/` directory prefix — must strip it during extraction
- esbuild-wasm WASM binary is ~8MB, lazy-loaded on first `build` invocation
- Vite's `?url` import suffix provides the URL to bundled WASM files
- For scoped packages (`@scope/name`), the registry URL is `https://registry.npmjs.org/@scope%2Fname`

### Verification
1. `npx tsc --noEmit` — types pass
2. `npx vitest run` — existing 78 tests still pass
3. Deploy to GitHub Pages, open browser, run: `git clone ... && cd shiro && npm install && npm run build && ls dist/`
