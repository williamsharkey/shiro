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
- **Windwalker** (williamsharkey/windwalker): Test automation. Access via `window.__shiro` global

## Keep It Manageable

- **One command per file** (or small groups of related commands like coreutils)
- **No over-engineering** - commands should be simple and direct
- **No monolithic files** - if a file grows past ~300 lines, split it
- **Register new commands in main.ts** - that's the single wiring point
