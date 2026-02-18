# Shiro

A Unix-like development environment that runs entirely in a browser tab. Files persist in IndexedDB, the shell supports pipes and redirects, and 200+ commands are available — including git, npm, node, vi, and curl. It builds to a single static HTML file (~420 KB gzipped) with no external assets.

**Live:** [shiro.computer](https://shiro.computer)
**About:** [shiro.computer/about](https://shiro.computer/about)

> **Experimental.** Claude Code runs with `--dangerously-skip-permissions` (all tool calls auto-approved). API requests route through a CORS proxy on the server, so your Anthropic credentials transit an intermediary. Do not use with sensitive data. Performance is unreliable — treat this as a demo, not a production environment.

## What It Does

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

# Serve and interact with web apps
serve /tmp/myapp 3000
page :3000 click "#button"
page :3000 text "body"

# Claude Code (runs inside the browser)
claude -p "create a todo app"
```

## Claude Code Integration

The real `@anthropic-ai/claude-code` CLI runs inside Shiro's Node.js runtime shim. The tools Claude Code relies on — file reads, edits, grep, glob, bash — are shimmed to use the virtual filesystem. Both print mode (`claude -p "..."`) and interactive mode (`claude`) work. API calls route through a CORS proxy to Anthropic's API.

An outer Claude Code instance can also control Shiro remotely via MCP tools over WebRTC. Run `remote start` in Shiro, then connect with the `shiro-mcp` package.

## Development

```bash
npm install
npm run dev          # Dev server at localhost:5173
npm run build        # Build to dist/
npm run deploy       # Build + deploy to shiro.computer
```

## License

MIT
