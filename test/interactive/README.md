# Interactive Tests

Tests that run in a real browser via **windwalker/skyeyes**.

These tests require:
- A browser with Shiro loaded (local dev or github.io)
- Skyeyes MCP connection for browser control
- Human present (or scheduled automation)

## Why not Playwright/Puppeteer?

Those tools spawn their own browser processes, download huge binaries,
and bog down your system. Interactive tests run in YOUR existing browser
session - no extra overhead.

## Running Interactive Tests

From Claude Code with skyeyes connected:

```bash
# Run all interactive tests
source test/interactive/run-all.sh

# Or run individually
source test/interactive/virtual-server.sh
```

## Test Files

| File | Description |
|------|-------------|
| `virtual-server.sh` | Tests service worker + Express shim end-to-end |

## Skipped by Default

These tests are NOT run by `npm test` - they require a live browser.
The vitest unit tests live in `../windwalker/tests/shiro-vitest/` — run with `cd ../windwalker && npm run test:shiro`.
