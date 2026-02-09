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

Tests run via **linkedom** (fast, in-process) or **skyeyes** (real browser integration). Linkedom imports Foam's modules directly into Node.js with fake-indexeddb, so tests execute in milliseconds with no browser overhead. Skyeyes tests use the nimbus dashboard's browser bridge for full integration testing against real browser APIs.

```
windwalker/
├── README.md
├── package.json
├── .github/workflows/
│   └── test.yml              # CI: runs all tests against both Foam and Shiro
├── tests/
│   ├── runner-linkedom.js     # Fast linkedom test runner (default)
│   ├── runner-skyeyes.js     # Skyeyes-based test runner
│   ├── helpers.js            # Shared utilities for interacting with each OS
│   ├── level-0-boot/         # OS boots without errors
│   ├── level-1-filesystem/   # VFS: read, write, mkdir, stat, exists, unlink
│   ├── level-2-shell/        # Shell: command execution, exit codes, env vars
│   ├── level-3-coreutils/    # Coreutils: ls, cat, grep, find, sed, sort, etc.
│   ├── level-4-pipes/        # Pipes, redirects, && / || / ; operators
│   ├── level-5-git/          # Git: init, add, commit, status, log, diff
│   ├── level-6-spirit/       # Spirit agent: tool execution, multi-turn loops
│   ├── level-7-workflows/    # End-to-end: create project, edit, test, commit
│   ├── level-8-fluffycoreutils/ # Extended coreutils: tr, cut, seq, test, ln, etc.
│   └── level-9-selfbuild/      # Self-build: git clone own repo, inspect, commit
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
| 8 | Extended Coreutils | tr, cut, printf, test, seq, which, ln, readlink, mkdir -p, rm -r, ls -la |
| 9 | Self-Build | git clone own repo, verify source files, grep source, commit changes |

### OS Abstraction Layer

Each OS exposes its internals differently:

| Capability | Foam | Shiro |
|------------|------|-------|
| Filesystem | `window.__foam.vfs` | `window.__shiro.fs` |
| Shell | `window.__foam.shell` | `window.__shiro.shell` |
| Terminal | `window.__foam.terminal` | `window.__shiro.terminal` |
| Provider | `window.__foam.provider` | `window.__shiro.provider` |

The test helpers abstract over these differences so each test file is OS-agnostic.

## Running Tests

```bash
npm install
npm test                    # Run all tests against both OS targets
npm run test:foam           # Test Foam only
npm run test:shiro          # Test Shiro only
```

## CI

GitHub Actions runs the linkedom test suite on every push and PR. Foam modules are imported directly into Node.js -- no browser binary needed.

## Filing Issues

When tests reveal problems, issues are filed on the appropriate repo:

- **Foam bugs/gaps** → [williamsharkey/foam/issues](https://github.com/williamsharkey/foam/issues)
- **Shiro bugs/gaps** → [williamsharkey/shiro/issues](https://github.com/williamsharkey/shiro/issues)
- **Spirit bugs/features** → [williamsharkey/spirit/issues](https://github.com/williamsharkey/spirit/issues)
- **Cross-platform inconsistencies** → [williamsharkey/windwalker/issues](https://github.com/williamsharkey/windwalker/issues)

Issues are tagged with `windwalker` for traceability.
