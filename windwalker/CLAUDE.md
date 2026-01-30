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

## Skyeyes MCP Tools

You have skyeyes MCP tools for browser interaction (see `~/.claude/CLAUDE.md` for full tool list). Your dedicated page IDs:
- `shiro-windwalker` — your shiro iframe
- `foam-windwalker` — your foam iframe

## Fast Headless Testing with linkedom

For rapid unit testing without browser overhead, consider using **linkedom** - a fast DOM implementation for Node.js.

### Why linkedom?

| Approach | Startup | DOM Fidelity | Use Case |
|----------|---------|--------------|----------|
| Puppeteer | ~2s | Full browser | E2E, visual, real browser APIs |
| Skyeyes | ~1s | Full browser | Integration with nimbus dashboard |
| **linkedom** | ~10ms | Synthetic DOM | Fast unit tests, CI, DOM manipulation |

### Usage Pattern

```javascript
const { parseHTML } = require('linkedom');

// Parse HTML into a fast synthetic DOM
const { document, window } = parseHTML(`
  <!DOCTYPE html>
  <html><body><div id="app"></div></body></html>
`);

// Test DOM operations directly
document.querySelector('#app').innerHTML = '<span>test</span>';
assert(document.querySelector('span').textContent === 'test');
```

### Potential for Windwalker

linkedom could enable a third test runner (`runner-linkedom.js`) for:
- **Level 0-4 tests**: Boot, filesystem, shell, coreutils, pipes (no real browser needed)
- **CI speed**: Run hundreds of DOM tests in seconds
- **Hypercompact testing**: The `hc` DSL works with any Document object

See also: [hypercompact](https://github.com/williamsharkey/hypercompact) - uses linkedom for token-efficient DOM navigation testing.

### Limitations

linkedom is NOT a full browser:
- No `fetch`, `WebSocket`, `IndexedDB` (need polyfills)
- No CSS rendering or layout
- No JavaScript execution context (no `<script>` tags)

For tests requiring real browser APIs, continue using Puppeteer or skyeyes.
