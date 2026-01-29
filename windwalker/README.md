# Windwalker

Unified test suite for [Spirit](https://github.com/williamsharkey/spirit) operating on two browser-native cloud OS environments:

- **[Foam](https://github.com/williamsharkey/foam)** -- Pure JavaScript, no build step, IndexedDB VFS, custom terminal renderer
- **[Shiro](https://github.com/williamsharkey/shiro)** -- TypeScript/Vite, IndexedDB VFS, xterm.js terminal, isomorphic-git

Spirit is an adapted Claude Code agent loop designed for browser-based JavaScript virtual machines that simulate Linux tooling. Windwalker ensures both OS environments provide consistent, correct behavior for Spirit and for general development workflows.

## Goals

1. Verify that both Foam and Shiro implement equivalent OS primitives (filesystem, shell, coreutils)
2. Catch discrepancies between the two OS implementations
3. Validate Spirit's agent loop functions correctly on each platform
4. Simulate real-world development activity to surface edge cases
5. File GitHub issues when inconsistencies, bugs, or feature gaps are found

## Test Architecture

All tests run via **Puppeteer** in headless Chrome. Each OS is loaded as a web page, and tests interact through the browser console by calling the OS's exposed JavaScript APIs directly. This tests the real runtime, not mocks.

```
windwalker/
├── README.md
├── package.json
├── .github/workflows/
│   └── test.yml              # CI: runs all tests against both Foam and Shiro
├── tests/
│   ├── runner.js             # Puppeteer test harness
│   ├── helpers.js            # Shared utilities for interacting with each OS
│   ├── level-0-boot/         # OS boots without errors
│   ├── level-1-filesystem/   # VFS: read, write, mkdir, stat, exists, unlink
│   ├── level-2-shell/        # Shell: command execution, exit codes, env vars
│   ├── level-3-coreutils/    # Coreutils: ls, cat, grep, find, sed, sort, etc.
│   ├── level-4-pipes/        # Pipes, redirects, && / || / ; operators
│   ├── level-5-git/          # Git: init, add, commit, status, log, diff
│   ├── level-6-spirit/       # Spirit agent: tool execution, multi-turn loops
│   └── level-7-workflows/    # End-to-end: create project, edit, test, commit
```

### Test Levels

Tests are organized from simple to complex. Each level builds on the previous.

| Level | Name | What it tests |
|-------|------|---------------|
| 0 | Boot | OS loads, global objects exist, no console errors |
| 1 | Filesystem | VFS CRUD: readFile, writeFile, mkdir, stat, readdir, unlink, rename |
| 2 | Shell | Command execution, exit codes, environment variables, working directory |
| 3 | Coreutils | Individual commands: ls, cat, echo, head, tail, grep, find, sed, sort, wc, diff |
| 4 | Pipes & Redirection | Pipelines, stdout/stderr redirection, &&/||/;, command substitution |
| 5 | Git | init, add, commit, status, log, diff, branch (via JS git implementations) |
| 6 | Spirit Tools | Each Spirit tool (bash, read, write, edit, glob) runs correctly on the OS |
| 7 | Workflows | Multi-step development scenarios: scaffold project, edit files, run commands |

### OS Abstraction Layer

Each OS exposes its internals differently:

| Capability | Foam | Shiro |
|------------|------|-------|
| Filesystem | `window.__foam.vfs` | `window.__shiro.fs` (TBD) |
| Shell | `window.__foam.shell` | `window.__shiro.shell` (TBD) |
| Terminal | `window.__foam.terminal` | `window.__shiro.terminal` (TBD) |
| Provider | `window.__foam.provider` | `window.__shiro.provider` (TBD) |

The test helpers abstract over these differences so each test file is OS-agnostic.

## Running Tests

```bash
npm install
npm test                    # Run all tests against both OS targets
npm run test:foam           # Test Foam only
npm run test:shiro          # Test Shiro only
```

## CI

GitHub Actions runs the full test suite on every push and PR. Both Foam and Shiro are checked out as sibling directories and served locally for Puppeteer to load.

## Filing Issues

When tests reveal problems, issues are filed on the appropriate repo:

- **Foam bugs/gaps** → [williamsharkey/foam/issues](https://github.com/williamsharkey/foam/issues)
- **Shiro bugs/gaps** → [williamsharkey/shiro/issues](https://github.com/williamsharkey/shiro/issues)
- **Spirit bugs/features** → [williamsharkey/spirit/issues](https://github.com/williamsharkey/spirit/issues)
- **Cross-platform inconsistencies** → [williamsharkey/windwalker/issues](https://github.com/williamsharkey/windwalker/issues)

Issues are tagged with `windwalker` for traceability.
