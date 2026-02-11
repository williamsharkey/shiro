/**
 * CLAUDE.md content seeded into /home/user/CLAUDE.md
 * so that Claude Code running inside Shiro knows its environment.
 */
export const CLAUDE_MD = `# CLAUDE.md — You are running inside Shiro Browser OS

## What is Shiro?

Shiro is a browser-native Unix environment. Everything runs in the browser — filesystem is IndexedDB, commands are JavaScript, there is no real Linux kernel. You ARE Claude Code running inside this browser OS.

## Key Facts

- **Filesystem**: IndexedDB-backed, persistent across page reloads. POSIX-like (stat, readdir, readFile, writeFile, mkdir, symlink, chmod, glob).
- **Shell**: Supports pipes (\`|\`), redirects (\`>\`, \`>>\`, \`<\`), \`&&\`, \`||\`, \`;\`, env vars (\`$VAR\`), quoting, glob expansion (\`*.ts\`, \`src/**\`), comments.
- **Home directory**: \`/home/user\`
- **No real Linux**: Commands like \`apt\`, \`docker\`, \`python\`, \`cargo\`, \`go\` do not exist. Don't try to install system packages.

## Available Tools

| Tool | Status | Notes |
|------|--------|-------|
| **git** | Working | isomorphic-git — clone, add, commit, push, pull, diff, log, branch, checkout, merge |
| **node** | Working | Runs JS files via browser VM. Supports require(), many Node.js builtins shimmed |
| **npm** | Working | Browser-native — install, list, run, uninstall. Packages from npm registry via CDN |
| **cat/ls/mkdir/rm/cp/mv/echo/grep/sed/find** | Working | JavaScript implementations of Unix coreutils |
| **rg** | Working | Ripgrep-compatible search — recursive by default, supports --type, --glob, -A/-B/-C context |
| **test / [** | Working | POSIX conditional expressions: -f, -d, -e, -z, -n, string/numeric comparisons |
| **vi** | Working | Minimal vi-like editor |
| **curl/fetch** | Working | HTTP requests via browser fetch API |
| **esbuild** | Working | TypeScript/JavaScript bundler (esbuild-wasm) |

## Git Usage

\`\`\`bash
git clone https://github.com/williamsharkey/shiro
git clone https://github.com/williamsharkey/fluffycoreutils
git add . && git commit -m "message"
git push origin main
\`\`\`

Git clone uses a CORS proxy built into the server. **\`GITHUB_TOKEN\` is already set in your environment** — git push/pull/fetch will use it automatically. Do NOT echo, export, or print the token.

## npm Usage

\`\`\`bash
npm install <package>         # Install from npm registry
npm list                      # Show installed packages
npm run <script>              # Run package.json scripts
\`\`\`

Packages are fetched via CDN (esm.sh/unpkg) and stored in the virtual filesystem.

## Node.js Runtime

The \`node\` command runs JavaScript in a sandboxed async VM with shimmed Node.js APIs:
- \`fs\`, \`path\`, \`os\`, \`crypto\`, \`child_process\`, \`http\`, \`https\`, \`url\`, \`events\`, \`stream\`, \`buffer\`, \`util\`, etc.
- \`process.env\`, \`process.argv\`, \`process.cwd()\`, \`process.exit()\` all work
- \`require()\` and ES module \`import\` both supported
- Binary data via Buffer shim

## Self-Modification

You CAN modify Shiro itself! The full source is at https://github.com/williamsharkey/shiro

### Relevant Repositories

| Repo | Description | URL |
|------|-------------|-----|
| **shiro** | This browser OS (TypeScript/Vite) | https://github.com/williamsharkey/shiro |
| **fluffycoreutils** | Shared Unix commands (submodule) | https://github.com/williamsharkey/fluffycoreutils |
| **spirit** | Claude Code agent loop library | https://github.com/williamsharkey/spirit |
| **nimbus** | Monorepo orchestrator | https://github.com/williamsharkey/nimbus-land |
| **skyeyes** | Browser bridge for testing | https://github.com/williamsharkey/skyeyes |
| **tests** | Test suite (in shiro monorepo) | https://github.com/williamsharkey/shiro |

### How to Modify Shiro

1. \`git clone https://github.com/williamsharkey/shiro\`
2. Edit files in \`shiro/src/commands/\` (one file per command)
3. Edit \`shiro/src/main.ts\` to register new commands
4. Key files:
   - \`src/commands/jseval.ts\` — Node.js runtime (~5000 lines, the JS VM)
   - \`src/commands/coreutils.ts\` — ls, cat, mkdir, rm, cp, mv, etc.
   - \`src/commands/git.ts\` — git (isomorphic-git)
   - \`src/commands/npm.ts\` — npm package manager
   - \`src/shell.ts\` — Command parser, pipes, redirects
   - \`src/filesystem.ts\` — IndexedDB POSIX filesystem
   - \`src/terminal.ts\` — xterm.js terminal

### Build & Deploy (requires real terminal access)

\`\`\`bash
cd shiro
npm run build          # TypeScript + Vite → single dist/index.html
npm run deploy         # Build + upload to shiro.computer
\`\`\`

Build output is a single self-contained HTML file (~338KB gzipped). Deploy target is a DigitalOcean droplet at shiro.computer.

## Networking

- **API proxy**: \`/api/anthropic/*\`, \`/api/platform/*\`, \`/api/mcp-proxy/*\` proxy to Anthropic/Claude APIs
- **Git proxy**: \`/git-proxy/*\` proxies git operations (CORS)
- **WebSocket relay**: \`/channel/:id\` for group networking
- **WebRTC signaling**: \`/offer\`, \`/answer/:code\` for remote connections

## Limitations

- No real processes — \`child_process.exec\` runs shell commands in the same JS VM
- No TCP/UDP sockets — networking is HTTP/WebSocket/WebRTC only
- No native binaries — everything is JavaScript
- Large packages (>16MB) may fail to load
- File operations are async (IndexedDB) but shimmed as sync for Node.js compat

## Tips

- Use \`console\` command to view browser console output
- Use \`remote start\` to generate a WebRTC connection code for external access
- The filesystem persists across page reloads (IndexedDB + localStorage backup)
- Use \`jest\` (not \`test\`) to run JavaScript test files. \`test\` is the POSIX conditional.
- \`rg\` (ripgrep) is available for fast recursive code search
- \`~/.profile\` is sourced on every boot — use it to persist env vars in IndexedDB

## Pre-configured Secrets

The following environment variables are **already set** — do NOT print, echo, export, or display them:
- \`GITHUB_TOKEN\` — GitHub API access (used by git push/pull automatically)
- \`ANTHROPIC_API_KEY\` — Anthropic API (if configured)

To verify a token is set without displaying it: \`test -n "$GITHUB_TOKEN" && echo "set" || echo "not set"\`

**NEVER run commands that would display tokens on screen** (e.g., \`echo $GITHUB_TOKEN\`, \`env | grep TOKEN\`, \`export GITHUB_TOKEN=...\`). The terminal output may be visible to others.

## Filing Bugs

If you find a bug in Shiro, file it as a GitHub issue:

\\\`\\\`\\\`bash
curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" -H "Content-Type: application/json" \\\\
  https://api.github.com/repos/williamsharkey/shiro/issues \\\\
  -d '{"title":"Bug: ...","body":"## Reproduction\\\\n...\\\\n## Expected\\\\n...\\\\n## Impact\\\\n..."}'
\\\`\\\`\\\`
`;
