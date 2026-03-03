# Shiro

> A standalone Unix environment that runs in a browser tab — shell, git, npm, node, vi, C compiler, SQLite, Python, and Claude Code. One HTML file. No server.

**Live:** [shiro.computer](https://shiro.computer)
**Docs:** [shiro.computer/docs](https://shiro.computer/docs)
**About:** [shiro.computer/about](https://shiro.computer/about)
**Examples:** [examples/](examples/)

## What's in it

- **220+ commands** — ls, grep, awk, sed, find, curl, diff, xargs, tar, wc, sort, uniq, factor, base32, numfmt, dos2unix...
- **Persistent filesystem** — IndexedDB-backed. Files survive reloads.
- **Git** — isomorphic-git: init, add, commit, diff, log, clone, push
- **npm** — Real tarballs from registry.npmjs.org. require() resolves node_modules.
- **Node.js runtime** — Run .js files. CommonJS and ES module transforms.
- **C compiler** — xcc compiles C to WebAssembly, runs via WASI
- **SQLite** — sql.js WASM. Persistent databases in IndexedDB.
- **Python** — Pyodide WASM. pip installs packages.
- **Lua, jq, esbuild** — Lazy-loaded WASM runtimes, cached on first use
- **x86-64 emulator** — Runs real Linux ELF binaries (musl-static) via instruction-level emulation. ~135 instructions, ~60 syscalls, SSE2, JIT block cache.
- **tmux** — Terminal multiplexer with split panes, sessions, detach/attach
- **SSH/SCP over WebRTC** — Peer-to-peer shell sessions and file transfer between browser tabs
- **Compression** — bzip2, xz, zstd with full tar integration (-j/-J/--zstd)
- **Init system** — systemctl services, cron scheduling, journalctl logs
- **Claude Code** — The real @anthropic-ai/claude-code CLI runs inside the browser
- **Virtual servers** — `serve` hosts apps, `page` interacts with them
- **Windowed terminals** — `spawn` opens commands in their own window with interactive REPL
- **Template palette** — 9 educational lessons (HTML, React, Node, Python, TypeScript, C, SQLite, Shell) launch in windowed terminals with split view
- **One HTML file** — ~420 KB gzipped. Deploy anywhere. Works offline.

## vs WebContainers

| | Shiro | WebContainers |
|---|---|---|
| Deployment | Single HTML file | SDK integration |
| Server needed | No | Yes (proxy) |
| Persistence | IndexedDB | Memory only |
| Claude Code | Built-in | No |
| C/Python/Lua/SQL | WASM runtimes | Node.js only |
| Size | ~420 KB | ~30 MB |

## Examples

```bash
# Shell basics
echo "hello" | sed 's/hello/world/' | wc -c
mkdir -p src && echo 'console.log("hi")' > src/app.js
find . -name "*.js" | grep -l "console"

# Git (isomorphic-git)
git init && git add . && git commit -m "initial"
git log --oneline

# npm (real tarballs from registry.npmjs.org)
npm install lodash prettier
node -e "console.log(require('lodash').uniq([1,1,2]))"

# C compiler → WebAssembly
echo '#include <stdio.h>\nint main(){printf("hello\\n");}' > hi.c
cc hi.c -o hi && ./hi

# SQLite
sqlite3 app.db "CREATE TABLE users(name TEXT); INSERT INTO users VALUES('alice');"
sqlite3 app.db "SELECT * FROM users;"

# x86-64 emulator (runs real Linux binaries)
./hello              # Auto-detect ELF binary, run in emulator
x86 run ./hello      # Explicit execution
x86 debug ./hello    # Step-through with register dumps

# Serve and interact with web apps
serve /tmp/myapp 3000
page :3000 click "#button"
page :3000 text "body"

# Heredocs
cat > /tmp/hello.html << 'EOF'
<h1>Hello World</h1>
EOF
serve /tmp 3000

# Windowed terminals
spawn                    # Open a blank interactive terminal window
spawn node server.js     # Run command in a window, then drop to REPL
title "My App"           # Set the window title

# Claude Code (runs inside the browser)
claude -p "create a todo app with localStorage"
```

## Claude Code Integration

The real `@anthropic-ai/claude-code` CLI runs inside Shiro's Node.js runtime shim. The tools Claude Code relies on — file reads, edits, grep, glob, bash — are shimmed to use the virtual filesystem. Both print mode (`claude -p "..."`) and interactive mode (`claude`) work. API calls route through a CORS proxy to Anthropic's API.

An outer Claude Code instance can also control Shiro remotely via MCP tools over WebRTC. Run `remote start` in Shiro, then connect with the `shiro-mcp` package.

## Node.js Compatibility

~50 shimmed Node.js modules. Core modules (fs, path, buffer, events, process, crypto, os, url, util, child_process) are fully functional. See the [full compatibility table](https://shiro.computer/docs#node-compat).

## Development

```bash
npm install
npm run dev          # Dev server at localhost:5173
npm run build        # Build to dist/
npm run deploy       # Build + deploy to shiro.computer
```

## License

MIT

> **Note:** Experimental. Claude Code runs with `--dangerously-skip-permissions` (all tool calls auto-approved). API requests transit a CORS proxy. Don't use with sensitive data.
