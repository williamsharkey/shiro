# CLAUDE.md - Guide for AI Assistants Working on Spirit

## What is Spirit?

Spirit is a Claude Code agent loop for browser-based JavaScript operating systems. It provides the agent loop, tool execution, and API client that lets Claude operate inside Shiro and Foam as an autonomous coding assistant with full access to the browser's virtual filesystem, shell, and DOM.

## Project Structure

```
src/
├── index.ts            # Public API exports
├── spirit.ts           # Main Spirit class — orchestrates the agent loop
├── agent-loop.ts       # Core agent loop: message → tool calls → results → repeat
├── api-client.ts       # Anthropic API client (browser-compatible fetch)
├── command.ts          # Command execution interface
├── sub-agent.ts        # Sub-agent spawning for parallel tasks
├── system-prompt.ts    # System prompt generation
├── browser-tools.ts    # Browser-specific tools (DOM, JS eval)
├── types.ts            # All TypeScript interfaces
├── providers/          # OS provider adapters (Shiro, Foam)
└── tools/              # Tool implementations for the agent
```

## Common Tasks

```bash
npm run build       # Build library with Vite + emit type declarations
npm run dev         # Watch mode build
```

Spirit builds to `dist/spirit.es.js` (ES module) with TypeScript declarations.

**This is a subdirectory of the shiro monorepo** — not a separate git repo. Shiro imports Spirit directly via relative path.

## Key Design Decisions

- **Library, not an app** — Spirit is imported by host OSes (Shiro/Foam), not run standalone
- **OSProvider interface** — host OS implements this to give Spirit filesystem, shell, and terminal access
- **Vite library build** — outputs ES module for browser consumption
- **Browser-native fetch** — no Node.js dependencies, works in any modern browser
- **Monorepo subdirectory** — lives at `spirit/` inside shiro, imported directly
