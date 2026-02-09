# End-to-End (E2E) Tests

Focused end-to-end tests verifying core dev workflows work in both foam and shiro terminals.

## Overview

The E2E test suite (`e2e-tests.js`) tests 4 critical workflows:

1. **File Editing** - `echo "content" > file && cat file`
2. **Pipe Chains** - `ls | grep pattern | wc -l`
3. **Git Clone** - Clone repository and verify files
4. **npm install** - Install package and use with require()

Each test runs in **both FOAM and SHIRO** terminals to ensure compatibility.

## Quick Start

```bash
# Run all E2E tests
node tests/e2e-tests.js

# Or make executable
chmod +x tests/e2e-tests.js
./tests/e2e-tests.js
```

## Test Details

### Test 1: File Editing

Verifies file creation, reading, appending, and multiline content.

**FOAM:**
- Create: `echo "Hello from FOAM" > /tmp/e2e_foam.txt`
- Read: `cat /tmp/e2e_foam.txt`
- Append: `echo "Line 2" >> /tmp/e2e_foam.txt`
- Verify multiline content works

**SHIRO:**
- Same operations with SHIRO-specific file

**Expected:** All file operations complete successfully

### Test 2: Pipe Chains

Verifies pipes, filters, and transformations work correctly.

**FOAM:**
- Simple pipe: `echo "hello world" | grep hello`
- Multi-stage: `echo -e "apple\nbanana..." | grep "^a" | wc -l`
- Transform: `echo "HELLO" | tr A-Z a-z | sed "s/world/universe/"`

**SHIRO:**
- Simple pipe: `echo "test data" | grep data`
- Filter pipe: `echo -e "1\n2\n3..." | grep -v 3 | wc -l`
- Sort pipe: `echo -e "zebra\napple..." | sort | head -n 1`

**Expected:** All pipe chains produce correct output

### Test 3: Git Clone

Verifies git clone works and repository is usable.

**FOAM:**
- Clone: `git clone --depth 1 https://github.com/octocat/Hello-World.git`
- Verify files exist: `ls /tmp/e2e_hello_foam/README`
- Check log: `git log --oneline -n 1`

**SHIRO:**
- Same operations with SHIRO-specific directory

**Expected:** Repository clones successfully, files accessible, git log works

### Test 4: npm install

Verifies npm can install packages and they're usable.

**FOAM:**
- Init: `npm init -y`
- Install: `npm install is-odd --silent`
- Verify: `ls node_modules` contains "is-odd"
- Use: `node -e "const isOdd = require('is-odd'); console.log(isOdd(5))"`

**SHIRO:**
- Same operations with SHIRO-specific directory

**Expected:** Package installs successfully, require() works

## Expected Output

```
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║           WINDWALKER END-TO-END TEST SUITE                    ║
║           Core Dev Workflow Verification                      ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Checking Skyeyes API...
✓ Skyeyes API available
  - foam-windwalker: ✓ Active
  - shiro-windwalker: ✓ Active

Running E2E Tests...

Test: File Editing (echo > file && cat file)
──────────────────────────────────────────────────────────────────
Testing in FOAM...
  ✓ Created file in FOAM
  ✓ Read file content in FOAM
  ✓ Appended to file in FOAM
  ✓ Verified multiline content in FOAM
Testing in SHIRO...
  ✓ Created file in SHIRO
  ✓ Read file content in SHIRO
✓ File Editing (echo > file && cat file) PASSED

Test: Pipe Chains (ls | grep | wc)
──────────────────────────────────────────────────────────────────
Testing in FOAM...
  ✓ Simple pipe (echo | grep) in FOAM
  ✓ Multi-stage pipe (echo | grep | wc) in FOAM
  ✓ Complex pipe chain in FOAM
Testing in SHIRO...
  ✓ Simple pipe (echo | grep) in SHIRO
  ✓ Multi-stage pipe (echo | grep | wc) in SHIRO
  ✓ Pipe with sort in SHIRO
✓ Pipe Chains (ls | grep | wc) PASSED

Test: Git Clone
──────────────────────────────────────────────────────────────────
Testing in FOAM...
  ✓ Cloned repository in FOAM
  ✓ Verified cloned files in FOAM
  ✓ Verified git log in FOAM
Testing in SHIRO...
  ✓ Cloned repository in SHIRO
  ✓ Verified cloned files in SHIRO
✓ Git Clone PASSED

Test: npm install
──────────────────────────────────────────────────────────────────
Testing in FOAM...
  ✓ Created package.json in FOAM
  ✓ Installed npm package in FOAM
  ✓ Verified node_modules in FOAM
  ✓ Tested require() with installed package in FOAM
Testing in SHIRO...
  ✓ Created package.json in SHIRO
  ✓ Installed npm package in SHIRO
  ✓ Verified node_modules in SHIRO
  ✓ Tested require() with installed package in SHIRO
✓ npm install PASSED

══════════════════════════════════════════════════════════════════
E2E Test Summary
══════════════════════════════════════════════════════════════════

  ✓ PASSED:  4/4 (100.0%)
  ✗ FAILED:  0/4

══════════════════════════════════════════════════════════════════

✓✓✓ ALL E2E TESTS PASSED! ✓✓✓
```

## Performance

- **Duration:** ~2-4 minutes total
- **Breakdown:**
  - File Editing: ~5-10 seconds
  - Pipe Chains: ~5-10 seconds
  - Git Clone: ~30-60 seconds (network dependent)
  - npm install: ~60-120 seconds (network dependent)

## How It Works

Uses the same async promise-polling approach as integration tests:

```javascript
// 1. Initiate command
window.__foam.shell.execute(`command`)
  .then(result => window.e2eTest_123 = { success: true, output: result })

// 2. Poll every 500ms
return window.e2eTest_123 ? JSON.stringify(window.e2eTest_123) : null

// 3. Verify output matches expected pattern
if (pattern.test(output)) { pass(); }

// 4. Cleanup temp variable
delete window.e2eTest_123
```

## Timeouts

Different timeouts for different operations:

- **Short (15s):** File ops, simple commands, verification
- **Medium (30s):** Git clone
- **Long (60s):** npm install

## Comparison to Other Tests

| Test Suite | Tests | Duration | Purpose |
|------------|-------|----------|---------|
| **Infrastructure** (`dev-workflow-tests.js`) | 6 | ~5s | Verify API connectivity |
| **E2E** (`e2e-tests.js`) | 4 | ~2-4min | Verify core workflows |
| **Integration** (`integration-tests.js`) | 64 | ~4-8min | Comprehensive testing |

**Use E2E tests for:**
- Quick smoke testing
- Pre-deployment verification
- CI/CD critical path

**Use Integration tests for:**
- Full feature verification
- Pre-release testing
- Deep workflow validation

## Troubleshooting

### Git clone times out

**Solution:** Increase timeout or use smaller repo
```javascript
const TIMEOUT_MEDIUM = 60000; // Increase to 60s
```

### npm install fails

**Possible causes:**
- Network issues
- npm registry unavailable
- Package doesn't exist

**Solution:** Check network, try different package, or skip npm test

### File operations fail

**Possible causes:**
- /tmp directory doesn't exist
- Permission issues
- Shell not ready

**Solution:** Check browser console for errors, verify terminal is loaded

## Adding New E2E Tests

```javascript
async function testMyWorkflow() {
  console.log(`${c.yellow}Testing in FOAM...${c.reset}`);

  let result = await execCommand(FOAM_PAGE, 'my command', TIMEOUT_SHORT);
  verify(result, /expected pattern/, 'Description of what passed');

  console.log(`${c.yellow}Testing in SHIRO...${c.reset}`);

  result = await execCommand(SHIRO_PAGE, 'my command', TIMEOUT_SHORT);
  verify(result, /expected pattern/, 'Description of what passed');

  // Cleanup
  await execCommand(FOAM_PAGE, 'cleanup command', TIMEOUT_SHORT);
  await execCommand(SHIRO_PAGE, 'cleanup command', TIMEOUT_SHORT);
}

// Add to main()
await runE2ETest('My Workflow', testMyWorkflow);
```

## Exit Codes

- `0` - All E2E tests passed
- `1` - One or more E2E tests failed

## Requirements

- Node.js v14+ (ES modules)
- Skyeyes API on localhost:7777
- foam-windwalker loaded
- shiro-windwalker loaded
- Internet connection (for git clone, npm install)

## CI/CD Integration

```yaml
# .github/workflows/test.yml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'

      # Run E2E tests
      - name: E2E Tests
        run: node tests/e2e-tests.js
```

## Best Practices

1. **Run E2E before commits** - Catch issues early
2. **Run full integration before releases** - Comprehensive validation
3. **Monitor test duration** - Track performance regressions
4. **Clean up test files** - Avoid /tmp clutter
5. **Handle network failures gracefully** - Retry or skip flaky tests

## See Also

- `dev-workflow-tests.js` - Infrastructure tests
- `integration-tests.js` - Full integration tests
- `README.md` - Test suite overview
- `../TESTING.md` - Complete testing guide
