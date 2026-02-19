# CLAUDE.md - Shiro Test Suite

## Overview

Test suite for Shiro browser OS. Uses linkedom + fake-indexeddb for DOM/VFS polyfills in Node.js.

## Running Tests

```bash
npm run test:shiro           # Vitest suite
```

Or from the shiro root: `npm test`

## Structure

```
tests/
├── vitest.config.ts          # Vitest configuration
├── package.json              # Test dependencies
└── tests/
    ├── helpers-linkedom.js   # DOM/IndexedDB polyfills (vitest setup)
    └── shiro-vitest/         # All vitest test files
        ├── setup.ts          # Test setup
        ├── helpers.ts        # createTestShell(), createTestOS(), run()
        ├── filesystem.test.ts
        ├── shell.test.ts
        ├── commands.test.ts
        ├── git.test.ts
        ├── node-runtime.test.ts
        ├── claude-tools.test.ts
        └── ...
```

**This is a subdirectory of the shiro monorepo.** Run tests from `tests/` directory.
