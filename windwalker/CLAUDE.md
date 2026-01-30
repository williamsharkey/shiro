# CLAUDE.md - Guide for AI Assistants Working on Windwalker

## What is Windwalker?

Windwalker is a unified test suite for Spirit running on Foam and Shiro browser OS environments. It provides leveled test progression from basic boot tests through complex workflow and self-build tests, runnable via both Puppeteer and skyeyes.

## Project Structure

```
tests/
├── runner.js               # Puppeteer-based test runner
├── runner-skyeyes.js       # Skyeyes-based test runner (uses nimbus bridge)
├── skyeyes-adapter.js      # Adapter for running tests through skyeyes API
├── helpers.js              # Shared test utilities
├── level-0-boot/           # Basic page load and boot tests
├── level-1-filesystem/     # Virtual filesystem operations
├── level-2-shell/          # Shell command parsing and execution
├── level-3-coreutils/      # Core Unix commands (ls, cat, mkdir, etc.)
├── level-4-pipes/          # Pipe and redirect functionality
├── level-5-git/            # Git operations (isomorphic-git)
├── level-6-spirit/         # Spirit AI agent integration
├── level-7-workflows/      # Multi-step workflow tests
├── level-8-fluffycoreutils/ # Shared coreutils library tests
└── level-9-selfbuild/      # Self-compilation tests
```

## Common Tasks

```bash
npm test                     # Run all tests (default target)
npm run test:foam            # Run tests against Foam
npm run test:shiro           # Run tests against Shiro
npm run test:skyeyes         # Run tests via skyeyes bridge
npm run test:skyeyes:foam    # Skyeyes tests targeting Foam
npm run test:skyeyes:shiro   # Skyeyes tests targeting Shiro
```

Set `OS_TARGET=foam` or `OS_TARGET=shiro` to select the target OS.

## Key Design Decisions

- **Leveled progression** — tests go from basic (level 0) to complex (level 9), each level builds on the previous
- **Dual runners** — Puppeteer for CI/headless, skyeyes for nimbus-integrated testing
- **OS-agnostic** — same tests run against both Foam and Shiro
- **Plain JavaScript** — no build step, Node.js scripts

## Cross-Project Integration

- **Shiro** (williamsharkey/shiro): TypeScript browser OS — primary test target
- **Foam** (williamsharkey/foam): Plain JS browser OS — primary test target
- **Spirit** (williamsharkey/spirit): Claude Code agent tested at level 6+
- **Nimbus** (williamsharkey/nimbus): Orchestrator with skyeyes bridge for test execution
- **Skyeyes** (williamsharkey/skyeyes): Browser-side bridge enabling remote test execution
- **FluffyCoreutils** (williamsharkey/fluffycoreutils): Shared commands tested at level 8

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
- `shiro-windwalker` — your isolated shiro iframe
- `foam-windwalker` — your isolated foam iframe

### Example usage:
```
mcp__skyeyes__terminal_exec({ page: "shiro-windwalker", command: "ls -la" })
mcp__skyeyes__terminal_exec({ page: "foam-windwalker", command: "git clone https://github.com/williamsharkey/windwalker" })
mcp__skyeyes__skyeyes_eval({ page: "shiro-windwalker", code: "return document.title" })
```
