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
- `shiro-fluffycoreutils` — your isolated shiro iframe
- `foam-fluffycoreutils` — your isolated foam iframe

### Example usage:
```
mcp__skyeyes__terminal_exec({ page: "shiro-fluffycoreutils", command: "ls -la" })
mcp__skyeyes__terminal_exec({ page: "foam-fluffycoreutils", command: "git clone https://github.com/williamsharkey/fluffycoreutils" })
mcp__skyeyes__skyeyes_eval({ page: "shiro-fluffycoreutils", code: "return document.title" })
```
