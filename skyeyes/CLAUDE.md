# CLAUDE.md - Guide for AI Assistants Working on Skyeyes

## What is Skyeyes?

Skyeyes is a browser-side WebSocket bridge for remote JS execution in live pages. It's a single self-contained JS file (~39KB) injected into browser OS iframes by `static-serve.cjs`, giving Claude workers the ability to execute JavaScript, run shell commands, inspect the DOM, and test live pages.

## How It Works

1. `static-serve.cjs` injects `<script src="http://localhost:7777/skyeyes.js" data-page="shiro-spirit" data-ws="localhost:7777"></script>` into HTML
2. On load, skyeyes connects to `ws://localhost:7777/skyeyes?page=shiro-spirit`
3. Extracts worker name from page ID (e.g., `shiro-spirit` -> `spirit`) and sets `shell.env.USER` so prompts show `spirit@shiro`
4. Server routes eval/terminal commands from workers to the iframe via WebSocket
5. Results (including resolved Promises) are serialized and sent back

## File Structure

```
skyeyes.js      # The entire library — single self-contained IIFE, no dependencies, no build step
package.json    # Metadata only
```

## Capabilities

- **JS eval** — execute arbitrary JS in the page's global scope via `new Function(code)()`
- **Terminal integration** — execute shell commands, read output, detect exit codes, check busy state
- **Terminal sessions** — tmux-like concurrent sessions (create, list, attach, detach, kill)
- **DOM snapshots** — full page HTML, viewport info, computed styles
- **Visual snapshots** — structured DOM tree descriptions, layout zones, interactive elements
- **Accessibility tree** — ARIA roles, landmarks, headings, forms, navigation
- **Page diffing** — capture snapshots and compute DOM changes over time
- **Element interaction** — click, type, scroll, focus, keyboard simulation, clipboard paste
- **CSS queries** — find elements with metadata (rect, visibility, attributes, auto-generated selectors)
- **Mutation observer** — real-time DOM change tracking
- **Network interception** — capture fetch/XHR requests with full details
- **Performance monitoring** — execution stats, Core Web Vitals, long task detection
- **Screenshots** — canvas-based capture with visual regression comparison
- **Storage monitoring** — localStorage/sessionStorage tracking and manipulation
- **File transfer** — upload/download files to browser OS VFS via base64
- **Console forwarding** — monkey-patched console output sent to server
- **Auto-reconnect** — reconnects on disconnect with message queuing (max 100)
- **Heartbeat** — 5-second pings for immediate disconnect detection

## Key Design Decisions

- **No dependencies, no build step** — single IIFE that runs in any browser
- **`new Function(code)()`** for eval — runs in global scope, not skyeyes closure
- **`data-page` attribute** on script tag identifies which page this bridge serves
- **`data-ws` attribute** overrides WebSocket host for cross-port iframes
- **Username propagation** — worker name extracted from page ID, sets `shell.env.USER`
- **Monkey-patched console** preserves original behavior while forwarding to server
- **HTMLElement serialization** returns truncated outerHTML (2000 chars max)
- **Message queue (max 100)** — ensures delivery across reconnections

## Cross-Project Integration

- **Nimbus** (williamsharkey/nimbus): Hosts the WebSocket server; `static-serve.cjs` injects skyeyes into iframes
- **Shiro** (williamsharkey/shiro): Browser OS — primary skyeyes target (port 8001)
- **Foam** (williamsharkey/foam): Browser OS — primary skyeyes target (port 8002)
- **Windwalker** (williamsharkey/windwalker): Test automation using skyeyes for browser-side execution

## Skyeyes MCP Tools

You have skyeyes MCP tools for browser interaction (see `~/.claude/CLAUDE.md` for full tool list). Your dedicated page IDs:
- `shiro-skyeyes` — your shiro iframe
- `foam-skyeyes` — your foam iframe
