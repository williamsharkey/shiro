# CLAUDE.md - Guide for AI Assistants Working on Windwalker

## What is Windwalker?

Windwalker is a unified test suite for Spirit running on Foam and Shiro browser OS environments. It provides leveled test progression from basic boot tests through complex workflow and self-build tests, runnable via **linkedom** (fast, in-process) and **skyeyes** (real browser integration).

## Project Structure

```
tests/
├── runner-linkedom.js      # Fast linkedom-based test runner (default)
├── runner-skyeyes.js       # Skyeyes-based test runner (uses nimbus bridge)
├── skyeyes-adapter.js      # Adapter for running tests through skyeyes API
├── helpers.js              # Shared test utilities (page.evaluate style)
├── helpers-linkedom.js     # Direct module access helpers
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
npm test                     # Run fast linkedom tests (levels 0-4)
npm run test:linkedom        # Same as above
npm run test:skyeyes         # Run all tests via skyeyes (real browser)
npm run test:skyeyes:foam    # Skyeyes tests targeting Foam
npm run test:skyeyes:shiro   # Skyeyes tests targeting Shiro
npm run test:all             # Run both linkedom and skyeyes tests
```

## Test Runner Strategy

| Runner | Startup | Levels | Use Case |
|--------|---------|--------|----------|
| **linkedom** | ~10ms | 0-4 | Fast CI, unit tests, VFS/shell logic |
| **skyeyes** | ~1s | 0-9 | Full integration, real browser APIs |

### linkedom Runner (Default)
- Imports Foam's VFS/Shell modules directly into Node.js
- Uses `fake-indexeddb` for VFS storage
- No browser overhead, tests run in-process
- Perfect for: filesystem, shell, coreutils, pipes

### skyeyes Runner
- Uses real browser via nimbus dashboard
- Required for: git operations, Spirit AI, workflows
- Tests actual browser behavior and DOM rendering

## Key Design Decisions

- **Leveled progression** — tests go from basic (level 0) to complex (level 9)
- **Dual runners** — linkedom for speed, skyeyes for integration
- **No Puppeteer** — removed in favor of lighter alternatives
- **OS-agnostic** — same tests run against both Foam and Shiro
- **Plain JavaScript** — no build step, Node.js ES modules

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

## Dependencies

```json
{
  "dependencies": {
    "linkedom": "^0.18.0",
    "fake-indexeddb": "^6.0.0"
  }
}
```

No puppeteer, no heavy browser binaries. Fast and lightweight.
