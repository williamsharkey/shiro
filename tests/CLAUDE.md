# CLAUDE.md - Shiro Test Suite

## Overview

Test suite for Shiro browser OS. Uses linkedom + fake-indexeddb for DOM/VFS polyfills in Node.js.

## Running Tests

```bash
npm run test:shiro           # Vitest suite (315 tests, ~45s)
npm run test:skyeyes:shiro   # Browser tests via skyeyes
npm run test:all             # All test runners
```

Or from the shiro root: `npm test`

## Structure

```
tests/
├── shiro-vitest/             # Vitest tests (main test suite)
│   ├── setup.ts              # DOM/IndexedDB polyfills
│   ├── helpers.ts            # createTestShell(), createTestOS(), run()
│   ├── filesystem.test.ts    # VFS operations
│   ├── shell.test.ts         # Shell parsing, pipes, env vars
│   ├── commands.test.ts      # Coreutils
│   ├── git.test.ts           # isomorphic-git
│   ├── node-runtime.test.ts  # Node.js runtime shim (jseval.ts)
│   ├── claude-tools.test.ts  # Claude Code tool shim bugs (37 tests)
│   ├── claude-code-install.test.ts # E2E install + run
│   └── ...
├── level-0-boot/ ... level-12-hotreload/  # Leveled test progression
├── runner-linkedom.js        # Fast linkedom-based runner
├── runner-skyeyes.js         # Real browser runner
└── helpers.js                # Shared test utilities
```

**This is a subdirectory of the shiro monorepo.** Run tests from `tests/` directory.
