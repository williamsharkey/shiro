/**
 * AGENTS.md / CLAUDE.md content seeded into the Shiro home directory
 * so inner Claude Code gets one canonical instruction file plus a compatibility shim.
 */
export const AGENTS_MD = `# AGENTS.md — You are running inside Shiro Browser OS

Read \`/home/user/NEO.md\` first. It contains runtime context for this boot, including whether this instance came from \`seed\` or \`seed blob\`, what page spawned it, and whether \`hc outer\` should be your first move.

## Environment

- Shiro is a browser-native Unix-like system.
- Filesystem: IndexedDB-backed, persistent across reloads.
- Shell: pipes, redirects, env vars, globbing, scripts, many bash-like features.
- Home directory: \`/home/user\`
- There is no real Linux kernel, process tree, or package manager outside what Shiro implements.

## First Moves

- If \`/home/user/NEO.md\` says host-page access is available, usually start with \`hc outer\`.
- Use \`rg\` for code search.
- Assume serial, low-concurrency work is safer than background-task-heavy orchestration.

## Useful Commands

- \`git\`, \`node\`, \`npm\`, \`npx\`, \`rg\`, \`curl\`, \`fetch\`, coreutils, \`vi\`
- Shiro source can be edited directly if the repo is present.
- Many Node.js builtins are shimmed under \`src/node-compat/\`.

## Claude In Shiro

- OAuth credentials live in \`/home/user/.claude/.credentials.json\`.
- Trust/onboarding/bypass settings are preseeded.
- Runtime context also exists at \`/home/user/.shiro-context.json\`.
- Background tasks and multi-agent fan-out may be constrained for stability inside the browser runtime.

## Key Shiro Files

- \`src/main.ts\`
- \`src/filesystem.ts\`
- \`src/shell.ts\`
- \`src/terminal.ts\`
- \`src/commands/*\`
- \`src/node-compat/*\`
- \`src/commands/seed.ts\`
- \`src/commands/hc.ts\`
- \`src/seed-runtime-context.ts\`
- \`server.mjs\`

## Limits

- \`child_process\` is shimmed.
- Networking is fetch/WebSocket/WebRTC, not raw sockets.
- Native binaries only work through Shiro's WASI/x86 layers.
- Do not print tokens or secrets already present in the environment.
`;

export const CLAUDE_MD = `# CLAUDE.md

Deprecated. Read \`/home/user/AGENTS.md\`, then \`/home/user/NEO.md\`.

This file remains only for clients that still auto-load \`CLAUDE.md\`.
`;
