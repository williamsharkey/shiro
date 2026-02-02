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
    ├── remote.ts         # WebRTC remote connection for Claude Code MCP
    ├── seed.ts           # Export state as paste-able snippet (normal or blob)
    └── hud.ts            # HUD redraw command
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

## Deployment

Shiro deploys to **Cloudflare Pages** at https://shiro.computer

```bash
# Build and deploy to production
npm run build
npx wrangler pages deploy dist --project-name=shiro
```

The `wrangler.toml` configures the Cloudflare Pages project. Deployment takes ~3 seconds.

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

## Remote Connection (shiro-mcp)

Shiro can be controlled remotely from Claude Code via WebRTC peer-to-peer connection.

**In Shiro browser:**
```bash
remote start    # Generate connection code, copy to clipboard
remote stop     # End remote session
remote status   # Check connection status
```

**In Claude Code:** Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "shiro": {
      "command": "shiro-mcp"
    }
  }
}
```

Then use tools: `shiro:connect`, `shiro:exec`, `shiro:read`, `shiro:write`, `shiro:list`, `shiro:eval`

**Architecture:**
- Signaling server at `remote.shiro.computer` (Cloudflare Worker + KV)
- WebRTC DataChannel for direct P2P after signaling
- Connection codes have ~46 bits entropy, expire in 5 minutes

**Key files:**
- `src/commands/remote.ts` — remote command, WebRTC setup, message handlers
- `remote-worker/` — Cloudflare Worker signaling server
- `shirocode/shiro-mcp/` — MCP server package for Claude Code

## Seed Command

Export Shiro state as a paste-able snippet:
```bash
seed            # Normal seed (iframe loads from shiro.computer)
seed blob       # Self-contained blob URL (works on CSP-restricted sites like X)
seed yolo       # Target yolo.shiro.computer subdomain
```

The blob mode inlines all JS/CSS, gzips (~70% reduction), and creates a blob URL at runtime.

## Skyeyes MCP Tools

You have skyeyes MCP tools for browser interaction (see `~/.claude/CLAUDE.md` for full tool list). Your dedicated page IDs:
- `shiro-shiro` — your shiro iframe
- `foam-shiro` — your foam iframe

## Keep It Manageable

- **One command per file** (or small groups of related commands like coreutils)
- **No over-engineering** - commands should be simple and direct
- **No monolithic files** - if a file grows past ~300 lines, split it
- **Register new commands in main.ts** - that's the single wiring point

