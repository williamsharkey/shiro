# Windwalker Test Suite

Automated tests for foam-windwalker and shiro-windwalker browser terminals.

## Quick Start

```bash
# Run the test suite
node tests/dev-workflow-tests.js

# Or make it executable and run directly
chmod +x tests/dev-workflow-tests.js
./tests/dev-workflow-tests.js
```

## What This Tests

### ✅ Infrastructure Tests (Automated)

The test runner verifies:

1. **Skyeyes API Availability** - Confirms API is running on port 7777
2. **Page Status** - Checks foam-windwalker and shiro-windwalker are active
3. **Page Connectivity** - Tests eval endpoint communication
4. **Shell Objects** - Verifies `window.__foam` and `window.__shiro` are available

### 📋 Workflow Tests (Documented)

The test runner documents intended coverage for:

- **Git Workflows**: init, config, add, commit, status, log, clone
- **npm Workflows**: init, install, run, node_modules verification
- **Node.js Execution**: version check, inline eval, script execution, require
- **File Operations**: create, read, append, delete, list, mkdir
- **Pipe Operations**: grep, wc, sort, multi-stage pipes, complex chains

## Current Limitations

⚠️ **Workflow tests cannot be executed via the current test runner** due to Skyeyes API limitations.

### Why?

The Skyeyes `/eval` endpoint executes JavaScript **synchronously**, but shell commands require **async/await** support:

```javascript
// ❌ This fails with: "await is only valid in async functions"
return await window.__foam.shell.execute("pwd")
```

### Solutions

To actually test workflows, you need one of:

1. **Manual Interactive Testing** - Use the browser terminals directly
2. **Async-Capable API** - Add `/api/skyeyes/{page}/exec-async` endpoint
3. **MCP Tools** - Use `mcp__skyeyes__terminal_exec` if available
4. **WebSocket API** - Implement streaming terminal I/O

## Test Results

Expected output:

```
✓ PASSED:  6/6 (100.0%)
✗ FAILED:  0/6

Infrastructure Tests: ALL PASSED ✓
```

All infrastructure tests should pass, confirming:
- ✅ Skyeyes is running
- ✅ foam-windwalker is active and connected
- ✅ shiro-windwalker is active and connected
- ✅ Shell objects are available

## Exit Codes

- `0` - All infrastructure tests passed
- `1` - One or more infrastructure tests failed

## Requirements

- Node.js v14+ (ES modules support)
- Skyeyes API running on `localhost:7777`
- foam-windwalker page loaded
- shiro-windwalker page loaded

## Configuration

Edit `tests/dev-workflow-tests.js` to customize:

```javascript
const SKYEYES_API = 'http://localhost:7777/api/skyeyes';
const FOAM_PAGE = 'foam-windwalker';
const SHIRO_PAGE = 'shiro-windwalker';
const TIMEOUT = 5000; // ms
```

## Related Files

- `WORKFLOW_TEST_REPORT.md` - Detailed investigation report
- `test_workflows.sh` - Bash version (deprecated)
- `test_workflows.py` - Python version (deprecated)

## Future Improvements

1. **Async Endpoint** - Add `/exec-async` to Skyeyes API
2. **Promise Polling** - Improve async result retrieval
3. **Timeout Handling** - Better long-running command support
4. **Output Streaming** - Real-time command output
5. **Exit Code Verification** - Check command success/failure

## Contributing

When adding new tests:

1. Add infrastructure tests to `main()` function
2. Add workflow tests to `testCategories` array
3. Document any new limitations
4. Update this README

## License

Part of the Windwalker project.
