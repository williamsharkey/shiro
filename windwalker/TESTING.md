# Windwalker Testing Guide

Complete testing infrastructure for foam and shiro browser terminals.

## Overview

Windwalker includes three types of automated tests:

1. **Infrastructure Tests** (`tests/dev-workflow-tests.js`) - Verify API and page connectivity
2. **E2E Tests** (`tests/e2e-tests.js`) - Verify core dev workflows (4 critical tests)
3. **Integration Tests** (`tests/integration-tests.js`) - Comprehensive workflow testing (64 tests)

## Quick Start

```bash
# Test infrastructure (fast, ~5 seconds)
node tests/dev-workflow-tests.js

# Test core workflows (medium, ~2-4 minutes) ⭐ RECOMMENDED
node tests/e2e-tests.js

# Test comprehensive workflows (slow, ~4-8 minutes)
node tests/integration-tests.js

# Test only one terminal (integration)
node tests/integration-tests.js foam
node tests/integration-tests.js shiro
```

## Test Suites

### 1. Infrastructure Tests ✅ FAST (~5s)

**File:** `tests/dev-workflow-tests.js`

**Purpose:** Verify Skyeyes infrastructure is operational

**Tests:**
- ✓ Skyeyes API availability (port 7777)
- ✓ foam-windwalker page active
- ✓ shiro-windwalker page active
- ✓ Eval endpoint connectivity
- ✓ Shell objects available

**When to run:** Before starting development, in CI/CD pipelines

**Expected result:**
```
✓ PASSED: 6/6 (100.0%)
Infrastructure Tests: ALL PASSED ✓
```

### 2. E2E Tests ⭐ RECOMMENDED (~2-4min)

**File:** `tests/e2e-tests.js`

**Purpose:** Verify core dev workflows work in both terminals

**Tests (4 critical workflows):**
- ✓ File editing (`echo > file && cat file`)
- ✓ Pipe chains (`ls | grep | wc`)
- ✓ Git clone (clone repo, verify files)
- ✓ npm install (install package, verify require)

**When to run:** Before commits, in CI/CD, pre-deployment

**Expected result:**
```
✓ PASSED: 4/4 (100.0%)
✓✓✓ ALL E2E TESTS PASSED! ✓✓✓
```

### 3. Integration Tests 🔄 SLOW (~4-8min)

**File:** `tests/integration-tests.js`

**Purpose:** Test actual dev workflows with real commands

**Coverage (32 tests per terminal × 2 = 64 tests):**

| Category | Tests | Examples |
|----------|-------|----------|
| Basic Commands | 3 | echo, pwd, node --version |
| File Operations | 5 | create, read, append, redirect |
| Pipe Operations | 5 | grep, wc, multi-stage |
| Git Workflows | 8 | init, config, commit, log |
| Git Clone | 2 | clone repo, verify |
| npm Workflows | 4 | init, install, verify |
| Node.js Execution | 4 | eval, scripts, require |
| Cleanup | 1 | remove test files |

**When to run:** After code changes, before releases

**Expected result:**
```
✓ PASSED: 64/64 (100.0%)
✓✓✓ ALL INTEGRATION TESTS PASSED! ✓✓✓
```

## Test Architecture

### Infrastructure Tests

Simple synchronous tests via eval API:

```javascript
// Check if object exists
await evalCode(pageId, 'return typeof window.__foam');
// → "object"
```

### Integration Tests

Async command execution with promise polling:

```javascript
// 1. Initiate command
window.__foam.shell.execute(`echo "hello"`)
  .then(result => window.testResult_123 = { success: true, output: result });

// 2. Poll for result (every 500ms)
return window.testResult_123 ? JSON.stringify(window.testResult_123) : null;

// 3. Verify and cleanup
```

## Documentation

- **`tests/README.md`** - Infrastructure test documentation
- **`tests/README-INTEGRATION.md`** - Integration test documentation
- **`WORKFLOW_TEST_REPORT.md`** - Technical investigation
- **`TEST_SUITE_SUMMARY.md`** - Executive summary

## Test Results

### Latest Run

**Infrastructure:**
- Status: ✅ PASSING
- Tests: 6/6 (100%)
- Duration: ~5 seconds

**Integration:**
- Status: 📝 READY (not run yet)
- Tests: 0/64 (pending first run)
- Expected duration: ~4-8 minutes

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Test Windwalker

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'

      # Quick infrastructure check
      - name: Infrastructure Tests
        run: node tests/dev-workflow-tests.js

      # Full integration tests (optional, slow)
      - name: Integration Tests
        run: node tests/integration-tests.js
        if: github.event_name == 'pull_request'
```

## Troubleshooting

### Infrastructure Tests Fail

**Symptom:** "Skyeyes API not available"

**Solutions:**
1. Check Skyeyes is running: `curl http://localhost:7777/api/skyeyes/status`
2. Verify pages are loaded in browser
3. Check port 7777 is not blocked

### Integration Tests Timeout

**Symptom:** Tests hang or timeout

**Solutions:**
1. Increase timeout in test definition
2. Check network connection (for git clone, npm install)
3. Use smaller test repositories
4. Skip slow tests (npm install, git clone)

### Async Commands Fail

**Symptom:** "window.__foam.shell.execute is not a function"

**Solutions:**
1. Ensure terminal is fully loaded
2. Check browser console for errors
3. Verify shell object exists: `node tests/dev-workflow-tests.js`

## Performance Optimization

### For CI/CD

```javascript
// Skip slow tests in CI
if (process.env.CI) {
  console.log('Skipping slow tests in CI');
} else {
  await runTest(pageId, 'Git clone', ...); // Slow
  await runTest(pageId, 'npm install', ...); // Slow
}
```

### Parallel Execution

```bash
# Run foam and shiro in parallel
node tests/integration-tests.js foam &
node tests/integration-tests.js shiro &
wait
```

## Adding New Tests

### Infrastructure Test

```javascript
// In tests/dev-workflow-tests.js
const testShellMethod = await testShellObject(FOAM_PAGE, '__foam.shell.vfs');
console.log(`window.__foam.shell.vfs: ${testShellMethod ? '✓' : '✗'}`);
```

### Integration Test

```javascript
// In tests/integration-tests.js, in runIntegrationTests()
console.log(`\n${c.yellow}My New Category:${c.reset}`);
await runTest(
  pageId,
  'Test description',
  'command to execute',
  /expected output regex/,
  15000 // timeout in ms
);
```

## Test Coverage

### What's Tested ✅

- Skyeyes API connectivity
- Page registration and status
- Shell object availability
- File create, read, write, delete
- Pipe operations (|, >, >>)
- Git init, config, add, commit, log, status, clone
- npm init, install
- Node.js script execution
- Package require() functionality

### What's Not Tested ❌

- Browser UI interactions
- Terminal rendering
- Keyboard input handling
- Copy/paste functionality
- Terminal history
- Auto-completion
- Performance metrics
- Memory usage
- Concurrent command execution

## Future Improvements

1. **Visual Regression Testing** - Screenshot comparison
2. **Performance Benchmarks** - Command execution timing
3. **Stress Testing** - Many concurrent commands
4. **Browser Compatibility** - Test across browsers
5. **Error Recovery** - Test error handling
6. **Resource Monitoring** - Memory, CPU usage
7. **Security Testing** - Input sanitization

## Continuous Monitoring

### Daily Health Check

```bash
#!/bin/bash
# Run every day at 9 AM
0 9 * * * cd /path/to/windwalker && node tests/dev-workflow-tests.js
```

### Pre-Commit Hook

```bash
#!/bin/bash
# .git/hooks/pre-commit
echo "Running E2E tests..."
node tests/e2e-tests.js || exit 1
```

## Exit Codes

All test scripts follow standard exit codes:

- `0` - All tests passed ✅
- `1` - One or more tests failed ❌

## Getting Help

- **Test failures**: Check `WORKFLOW_TEST_REPORT.md` for debugging
- **API issues**: See `SKYEYES.md` for API documentation
- **General questions**: See `README.md` for project overview

## Summary

```
📊 Test Coverage:
   - Infrastructure: 6 tests (API, connectivity, objects)
   - E2E: 4 tests (core workflows in both terminals)
   - Integration: 64 tests (32 per terminal, comprehensive)
   - Total: 74 automated tests

⚡ Performance:
   - Infrastructure: ~5 seconds
   - E2E: ~2-4 minutes (⭐ recommended for regular use)
   - Integration: ~4-8 minutes (comprehensive validation)

✅ Status:
   - Infrastructure: PASSING
   - E2E: READY
   - Integration: READY
   - Documentation: COMPLETE
```

---

**Last Updated:** 2026-01-29
**Test Framework Version:** 1.0.0
**Skyeyes API:** http://localhost:7777/api/skyeyes
