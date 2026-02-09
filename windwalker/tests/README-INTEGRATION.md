# Integration Tests

Comprehensive integration tests for foam and shiro browser terminals.

## Files

### `integration-tests.js` (Node.js - Recommended)

Full integration test suite with async command execution.

**Features:**
- ✅ Git clone, init, add, commit, log, status
- ✅ File operations: create, read, append, redirect
- ✅ Pipe operations: simple, multi-stage, complex
- ✅ npm init, install, verify node_modules
- ✅ Node.js script execution and require()
- ✅ Automatic cleanup

**Usage:**
```bash
# Test both foam and shiro
node tests/integration-tests.js

# Test only foam
node tests/integration-tests.js foam

# Test only shiro
node tests/integration-tests.js shiro
```

**Test Coverage (per terminal):**

| Category | Tests | Description |
|----------|-------|-------------|
| **Basic Commands** | 3 | echo, pwd, node --version |
| **File Operations** | 5 | create, read, append, verify, redirect |
| **Pipe Operations** | 5 | simple, grep, wc, multi-stage, transform |
| **Git Workflows** | 8 | init, config, add, commit, log, status |
| **Git Clone** | 2 | clone repo, verify |
| **npm Workflows** | 4 | init, install, verify |
| **Node.js Execution** | 4 | eval, JSON, script, require |
| **Cleanup** | 1 | remove all test files |
| **Total** | **32 tests per terminal** |

### `integration-tests.sh` (Bash - Advanced)

Bash version with manual escaping. More complex but doesn't require Node.js.

**Usage:**
```bash
./tests/integration-tests.sh [foam|shiro|all]
```

## How It Works

The integration tests use the Skyeyes eval API with a promise-polling approach:

1. **Initiate Command**: Execute `window.__foam.shell.execute(cmd)` asynchronously
2. **Store Result**: Save promise result to a temporary window variable
3. **Poll for Completion**: Check every 500ms if result is available
4. **Retrieve & Clean**: Get result, cleanup temp variable
5. **Verify Output**: Match against expected pattern

### Example Flow

```javascript
// 1. Initiate
window.__foam.shell.execute(`echo "hello"`)
  .then(result => window.testResult_123 = { success: true, output: result })
  .catch(error => window.testResult_123 = { success: false, error });

// 2. Poll (every 500ms)
return window.testResult_123 ? JSON.stringify(window.testResult_123) : null

// 3. Clean up
delete window.testResult_123
```

## Expected Results

When all tests pass:

```
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║      WINDWALKER INTEGRATION TEST SUITE                        ║
║      Full Dev Workflow Testing via Skyeyes API                ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Checking Skyeyes API...
✓ Skyeyes API available
  - foam-windwalker: Active
  - shiro-windwalker: Active

======================================================================
Integration Tests - FOAM (foam-windwalker)
======================================================================

Basic Commands:
  → Echo command                                      ✓ PASS
  → PWD command                                       ✓ PASS
  → Node version                                      ✓ PASS

File Operations:
  → Create file                                       ✓ PASS
  → Read file                                         ✓ PASS
  → Append to file                                    ✓ PASS
  → Verify multiline                                  ✓ PASS
  → File redirection                                  ✓ PASS

Pipe Operations:
  → Simple pipe                                       ✓ PASS
  → Pipe with grep                                    ✓ PASS
  → Pipe with wc                                      ✓ PASS
  → Multi-stage pipe                                  ✓ PASS
  → Complex pipe                                      ✓ PASS

Git Workflows:
  → Git version                                       ✓ PASS
  → Git init                                          ✓ PASS
  → Git config                                        ✓ PASS
  → Create file in repo                               ✓ PASS
  → Git add                                           ✓ PASS
  → Git commit                                        ✓ PASS
  → Git log                                           ✓ PASS
  → Git status                                        ✓ PASS

Git Clone:
  → Clone small repo (octocat/Hello-World)            ✓ PASS
  → Verify cloned repo                                ✓ PASS

npm Workflows:
  → npm version                                       ✓ PASS
  → npm init                                          ✓ PASS
  → npm install (is-odd package)                      ✓ PASS
  → Verify node_modules                               ✓ PASS

Node.js Execution:
  → Node eval (math)                                  ✓ PASS
  → Node eval (JSON)                                  ✓ PASS
  → Node script file                                  ✓ PASS
  → Node require (use installed package)              ✓ PASS

Cleanup:
  → Remove test files                                 ✓ PASS

[... same for SHIRO ...]

======================================================================
Test Summary
======================================================================

  ✓ PASSED:  64/64 (100.0%)
  ✗ FAILED:  0/64

======================================================================

✓✓✓ ALL INTEGRATION TESTS PASSED! ✓✓✓
```

## Performance

- **Per terminal**: ~2-4 minutes (depends on network speed for git clone/npm install)
- **Both terminals**: ~4-8 minutes total
- Most time spent on: git clone (10-30s), npm install (20-40s)

## Troubleshooting

### Test hangs or times out

- **Cause**: Command taking longer than timeout
- **Solution**: Increase timeout in test definition
  ```javascript
  await runTest(pageId, 'Test name', 'command', 'expected', 60000); // 60s timeout
  ```

### "window.__foam.shell.execute is not a function"

- **Cause**: Shell object not initialized
- **Solution**: Ensure page is loaded and terminal is ready

### Git clone fails

- **Cause**: Network issues or repository unavailable
- **Solution**: Use smaller repo or increase timeout

### npm install fails

- **Cause**: Network issues or package unavailable
- **Solution**: Use different package or skip npm tests

## Configuration

Edit `integration-tests.js` to customize:

```javascript
const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const FOAM_PAGE = 'foam-windwalker';
const SHIRO_PAGE = 'shiro-windwalker';

// Adjust timeouts (in milliseconds)
await runTest(pageId, name, command, expected, 30000); // 30s
```

## Adding New Tests

```javascript
// In runIntegrationTests() function
console.log(`\n${c.yellow}My New Category:${c.reset}`);
await runTest(
  pageId,
  'Test name',
  'command to execute',
  /expected output pattern/,
  10000 // timeout ms
);
```

## Exit Codes

- `0` - All tests passed
- `1` - One or more tests failed

## Requirements

- Node.js v14+ (ES modules)
- Skyeyes API running on localhost:7777
- foam-windwalker and shiro-windwalker loaded
- Internet connection (for git clone, npm install)

## See Also

- `dev-workflow-tests.js` - Infrastructure tests only
- `README.md` - Test suite overview
- `../WORKFLOW_TEST_REPORT.md` - Technical details
