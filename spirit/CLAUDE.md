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

Spirit builds to `dist/spirit.es.js` (ES module) with TypeScript declarations. It's consumed as a git submodule by Shiro and Foam.

## Key Design Decisions

- **Library, not an app** — Spirit is imported by host OSes (Shiro/Foam), not run standalone
- **OSProvider interface** — host OS implements this to give Spirit filesystem, shell, and terminal access
- **Vite library build** — outputs ES module for browser consumption
- **Browser-native fetch** — no Node.js dependencies, works in any modern browser
- **Git submodule** — consumed by Shiro and Foam as `spirit/` submodule

## Cross-Project Integration

- **Shiro** (williamsharkey/shiro): Implements `ShiroProvider` in `src/spirit-provider.ts`
- **Foam** (williamsharkey/foam): Implements `FoamProvider` in `src/foam-provider.js`
- **FluffyCoreutils** (williamsharkey/fluffycoreutils): Shared commands available to Spirit
- **Windwalker** (williamsharkey/windwalker): Tests Spirit at levels 6+
- **Nimbus** (williamsharkey/nimbus): Orchestrator managing Spirit's development
- **Skyeyes** (williamsharkey/skyeyes): Browser bridge for remote testing of Spirit

## Skyeyes MCP Tools

You have skyeyes MCP tools for browser interaction (see `~/.claude/CLAUDE.md` for full tool list). Your dedicated page IDs:
- `shiro-spirit` — your shiro iframe
- `foam-spirit` — your foam iframe
