# CLAUDE.md - Guide for AI Assistants Working on FluffyCoreutils

## What is FluffyCoreutils?

FluffyCoreutils is a shared library of Unix coreutils for browser-based virtual operating systems (Foam, Shiro). It provides common commands (ls, cat, grep, etc.) as a reusable ES module so both browser OSes share the same implementations.

## Project Structure

```
src/
├── index.ts        # Public API — exports all commands
├── types.ts        # Shared TypeScript interfaces
├── flags.ts        # Command-line flag parsing utilities
└── commands/       # Individual command implementations
```

## Common Tasks

```bash
npm run build       # Build library with Vite + emit type declarations
npm run dev         # Watch mode build
```

Builds to `dist/fluffycoreutils.es.js` (ES module) with TypeScript declarations. Consumed as a git submodule by Shiro and Foam.

## Key Design Decisions

- **Library, not an app** — imported by host OSes, not run standalone
- **Vite library build** — outputs ES module for browser consumption
- **TypeScript** — type-safe command implementations
- **Git submodule** — consumed by Shiro (`fluffycoreutils/`) and Foam (`fluffycoreutils/`)
- **Shared interface** — commands follow the same `Command` pattern as Shiro/Foam built-in commands

## Cross-Project Integration

- **Shiro** (williamsharkey/shiro): Consumes as submodule, bridges via command registry
- **Foam** (williamsharkey/foam): Consumes as submodule, bridges via `src/fluffy-bridge.js`
- **Spirit** (williamsharkey/spirit): Commands available to the agent loop
- **Windwalker** (williamsharkey/windwalker): Tests at level 8
- **Nimbus** (williamsharkey/nimbus): Orchestrator managing development

## Skyeyes MCP Tools

You have skyeyes MCP tools for browser interaction (see `~/.claude/CLAUDE.md` for full tool list). Your dedicated page IDs:
- `shiro-fluffycoreutils` — your shiro iframe
- `foam-fluffycoreutils` — your foam iframe
