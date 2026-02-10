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
├── mobile-input.ts      # Unified mobile toolbar: virtual keys, copy/paste, voice input
├── remote-panel.ts      # Draggable floating panel UI (used by remote, group)
├── server-window.ts     # macOS-style window wrapper (iframe + terminal modes)
├── window-terminal.ts   # Lightweight xterm.js wrapper for windowed processes
├── process-table.ts     # Global process registry with PID allocation
└── commands/            # One file per command or group of related commands
    ├── index.ts          # Command/CommandContext/TerminalLike interfaces, CommandRegistry class
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
    ├── mcp-client.ts     # MCP Streamable HTTP client (connect to external MCP servers)
    ├── group.ts          # Encrypted group networking (peer discovery via relay)
    ├── seed.ts           # Export state as paste-able snippet (normal or blob)
    ├── hud.ts            # HUD redraw command
    ├── spawn.ts          # Run commands in windowed terminals
    ├── ps.ts             # ps (list processes) and kill (terminate by PID)
    ├── html.ts           # html (render HTML in window) and img (display image)
    └── become.ts         # become/unbecome: full-screen app mode with shareable URLs
└── utils/
    ├── copy-utils.ts     # bufferToString (isWrapped-aware), smartCopyProcess (indent strip)
    ├── tar-utils.ts      # gzip decompression and tar extraction
    └── semver-utils.ts   # semantic versioning and range resolution
server.mjs                   # Unified Node.js server (proxy, signaling, relay, static)
vite-plugin-inline.ts        # Build plugin: inlines JS/CSS/favicon into single HTML
deploy.sh                    # Build + scp + restart on DO droplet
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

Shiro deploys to a **DigitalOcean droplet** at https://shiro.computer (`161.35.13.177`).

A single Node.js server (`server.mjs`) handles everything: static files, API proxy, OAuth callback, WebRTC signaling, and WebSocket relay. Nginx sits in front with SSL (wildcard cert for `*.shiro.computer` via certbot-dns-porkbun).

**Build output is a single self-contained HTML file** — all JS/CSS/favicon inlined by `vite-plugin-inline.ts`. No separate asset files. ~338KB gzipped.

```bash
# Build and deploy to production
npm run deploy    # builds + uploads via scp + restarts server
```

### SSH Setup (required for deploy)

`deploy.sh` uses `~/.ssh/id_ed25519` to SSH/SCP to the droplet. If deploy fails with `Permission denied (publickey)`:

1. **Generate a key** (if you don't have one): `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`
2. **Add your public key to the droplet** — you need an existing authorized machine or the DO web console (cloud.digitalocean.com → Droplets → shiro → Console):
   ```bash
   # On the droplet:
   echo 'YOUR_PUBLIC_KEY_HERE' >> /root/.ssh/authorized_keys
   ```
3. **Test**: `ssh root@161.35.13.177 "echo connected"`
4. **Save credentials to Claude memory** — store the droplet IP, root password, and SSH key path in your auto memory directory (`~/.claude/projects/<project>/memory/MEMORY.md`) so future sessions can deploy without re-setup.

**Droplet credentials**: Root password and droplet ID are stored in Claude's auto memory file, not in the repo. If you're a new Claude instance, ask the user or check `~/.claude/projects/*/memory/MEMORY.md` for credentials. The DigitalOcean CLI (`doctl`) is also authenticated and can reset the root password if needed: `doctl compute droplet-action password-reset 550124232`.

## Testing

Tests live in the **windwalker** repo (`../windwalker/tests/shiro-vitest/`).
Windwalker uses linkedom + fake-indexeddb for proper DOM polyfills in Node.js.

```bash
cd ../windwalker
npm install
npm run test:shiro        # vitest unit/integration tests
npm run test:skyeyes:shiro # browser tests via skyeyes
```

Running `npm test` in shiro will print these instructions as a reminder.

## Shell Features

The shell supports:
- **Pipes**: `echo hello | grep hello`
- **Redirects**: `>`, `>>`, `<`, `2>`, `2>>`
- **Compound commands**: `&&`, `||`, `;`
- **Environment variables**: `$VAR`, `${VAR}`, `$?` (last exit code)
- **Positional parameters**: `$@`, `$*`, `$#`, `$0`-`$9`
- **Quoting**: single quotes (literal), double quotes (with var expansion), backslash escapes
- **Comments**: lines starting with `#`

## Filesystem

- IndexedDB-backed with in-memory cache for performance
- POSIX-like API: stat, readdir, readFile, writeFile, mkdir, unlink, rename, symlink, chmod, glob
- Path resolution handles `.`, `..`, and `~`
- `clearCache()` method available if external DB modifications occur

## Mobile Input

On touch devices (`pointer: coarse`), a unified 2-row toolbar appears at the bottom of the screen. Implemented in `src/mobile-input.ts`, styled in `index.html`.

**Layout:**
```
Row 1: [Esc] [Tab] [Ctrl] [[] []] [{] [}]  ···spacer···  [Paste] [Mic]      [ ↑ ]
Row 2: [ - ] [ | ] [ / ]  [~] [`] [$] [&]  ···spacer···  [ Copy] [ ; ]   [←] [↓] [→]
```

- **Arrows**: Inverted-T layout — `↑` centered above `↓`, `←` and `→` flanking
- **Ctrl**: Sticky toggle (turns blue when active, next key sends Ctrl+key)
- **Paste/Copy**: Clipboard API with prompt() fallback; Copy grabs selection or last command output
- **Mic**: Voice dictation via Web Speech API; says "send"/"enter" to submit. Button changes to "Stop" while recording
- **z-index**: `2147483647` — stays above spawned windows and remote panels
- **Keyboard repositioning**: Uses `visualViewport` API to sit above the iOS keyboard

## Monorepo Subdirectories

These were merged from separate repos with full commit history preserved (`git log -- subdir/` works):

- **`fluffycoreutils/`**: Shared Unix commands library (ls, cat, grep, sed, etc.) — ES module consumed by Shiro and Foam
- **`spirit/`**: Claude Code agent loop with multi-LLM support — Shiro provides `ShiroProvider` (OSProvider interface)
- **`windwalker/`**: Test automation suite — vitest unit tests + skyeyes browser tests. Run: `cd windwalker && npm run test:shiro`
- **`hypercompact/`**: HTML compression utilities for compact DOM representations

## Related Projects (separate repos)

- **Foam** (williamsharkey/foam): Sister browser OS in plain JS. Compatible shell semantics
- **Nimbus** (williamsharkey/nimbus): Multi-repo orchestrator with live dashboard preview
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
- Signaling handled by `server.mjs` on the DigitalOcean droplet
- WebRTC DataChannel for direct P2P after signaling
- Connection codes have ~46 bits entropy, expire in 5 minutes

**Key files:**
- `src/commands/remote.ts` — remote command, WebRTC setup, message handlers
- `shirocode/shiro-mcp/` — MCP server package for Claude Code

## MCP Client

Shiro can connect to external MCP servers as a client using the Streamable HTTP protocol:
```bash
mcp connect <url>        # Initialize session, list available tools
mcp disconnect [url]     # Close session (or all sessions)
mcp tools [url]          # List tools
mcp call <tool> [json]   # Call a tool with JSON arguments
mcp status               # Show active connections
```

Same-origin MCP servers work without CORS issues. External servers need CORS headers.

## Group Networking

Encrypted peer discovery via WebSocket relay. Multiple Shiro instances can find each other:
```bash
group join <name> <password>   # Join an encrypted group
group leave                    # Leave current group
group peers                    # List discovered peers
group status                   # Show group info
```

Uses PBKDF2 key derivation + AES-GCM encryption. The WebSocket relay (built into `server.mjs`) never sees plaintext — it only forwards encrypted blobs.

**Key files:**
- `src/commands/mcp-client.ts` — MCP client command
- `src/commands/group.ts` — Group networking command
- `server.mjs` — Server with built-in WebSocket relay at `/channel/:id`

## Seed Command

Export Shiro state as a paste-able snippet:
```bash
seed            # Normal seed (iframe loads from shiro.computer)
seed blob       # Self-contained blob URL (works on CSP-restricted sites like X)
seed yolo       # Target yolo.shiro.computer subdomain
```

The blob mode inlines all JS/CSS, gzips (~70% reduction), and creates a blob URL at runtime.

## Become (App Mode)

Make Shiro "become" a served app — full-screen with no terminal, accessible via path-based URLs like `shiro.computer/myapp`:
```bash
serve /tmp/myapp 3000       # Start serving an app
become 3000 myapp           # Full-screen app mode, URL → /myapp
become                      # Auto-detect if only one server running
unbecome                    # Return to terminal (also: __shiro.unbecome() in console)
```

**How it works:**
- `become` saves config to `localStorage['shiro-become']` (synchronous — no flash on reload)
- Hides terminal via `.become-active` CSS class, creates a full-screen iframe with app content
- On page reload, `main.ts` detects become config, starts the server, and re-enters app mode
- `server.mjs` SPA fallback means `shiro.computer/myapp` loads index.html which boots into become mode
- Server windows have a purple "Become" button (4th traffic light) for one-click activation
- `unbecome` clears config, removes iframe, shows terminal, resets URL to `/`

**Key files:** `src/commands/become.ts`, boot logic in `src/main.ts`, button in `src/server-window.ts`

## Claude Code (Inner Claude)

The real `@anthropic-ai/claude-code` CLI (v2.1.37, 11MB bundled ESM) runs inside Shiro's Node.js runtime (`jseval.ts`). Both print mode (`claude -p "..."`) and interactive mode (`claude`) work.

**How it works:**
- Shell finds `claude` → bin stub at `/usr/local/bin/claude` → follows to `cli.js`
- `jseval.ts` transforms the ESM bundle, wraps in AsyncFunction, provides ~50 Node.js module shims
- API calls go through CORS proxy: `globalThis.fetch` → rewrite URLs → `/api/anthropic/*` → `api.anthropic.com`
- OAuth tokens auto-refresh before CLI runs (pre-flight check in jseval.ts)

**Key details:**
- OAuth credentials: `/home/user/.claude/.credentials.json` (persisted in IndexedDB)
- Token refresh: `POST /api/platform/v1/oauth/token` with `grant_type=refresh_token`
- Telemetry blocked: datadoghq.com, sentry.io, event_logging → fake 200 responses
- Stdin piping works: `echo "text" | claude -p "analyze this"`
- Interactive mode uses ink (React for terminal) with stdin passthrough bridging
- Tree-sitter WASM gracefully degraded (syntax highlighting disabled; browser can't compile the emscripten binary)
- Vendored ripgrep (ELF binary) shimmed to `find`/`grep` builtins
- `fileCache` keeps sync/async fs operations coherent — FileHandle and `fs.promises` both update it
- Binary files (ELF, Mach-O) rejected at shell level with "cannot execute binary file"

## Skyeyes MCP Tools

You have skyeyes MCP tools for browser interaction (see `~/.claude/CLAUDE.md` for full tool list). Your dedicated page IDs:
- `shiro-shiro` — your shiro iframe
- `foam-shiro` — your foam iframe

## Keep It Manageable

- **One command per file** (or small groups of related commands like coreutils)
- **No over-engineering** - commands should be simple and direct
- **No monolithic files** - if a file grows past ~300 lines, split it
- **Register new commands in main.ts** - that's the single wiring point

