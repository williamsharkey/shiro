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

Builds to `dist/fluffycoreutils.js` (ES module) with TypeScript declarations.

**This is a subdirectory of the shiro monorepo** — not a separate git repo. After making changes, rebuild with `cd fluffycoreutils && npm run build`, then rebuild shiro from the root.

## Key Design Decisions

- **Library, not an app** — imported by host OSes, not run standalone
- **Vite library build** — outputs ES module for browser consumption
- **TypeScript** — type-safe command implementations
- **Monorepo subdirectory** — lives at `fluffycoreutils/` inside shiro, imported directly
- **Shared interface** — commands follow the same `Command` pattern as Shiro/Foam built-in commands
