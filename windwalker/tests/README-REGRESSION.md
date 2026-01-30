# Regression Test Suite

Fast, focused regression tests for critical Spirit prerequisites. Run on every deployment to ensure core functionality works.

## Quick Start

```bash
# Run regression tests
node tests/regression.js

# Expected duration: ~30-60 seconds
# Expected result: All tests pass
```

## What It Tests

The regression suite tests the 5 most critical Spirit prerequisites:

### 1. File CRUD (4 tests per terminal)
- **Create:** `echo "data" > file`
- **Read:** `cat file`
- **Update:** `echo "more" >> file`
- **Delete:** `rm file`

**Why Critical:** Spirit needs reliable file I/O for state management, code editing, and documentation.

### 2. Command Execution (3 tests per terminal)
- **Success commands:** `true && echo "success"`
- **Output capture:** `echo "test"`
- **Chained commands:** `cmd1 && cmd2 && cmd3`

**Why Critical:** Spirit needs command execution with proper exit codes to verify tool success/failure.

### 3. Pipe Chains (3 tests per terminal)
- **Simple pipe:** `echo "test" | grep test`
- **Multi-stage:** `echo ... | grep | wc`
- **Pipe with redirect:** `echo ... | cat > file`

**Why Critical:** Spirit needs pipes to compose complex workflows and process data streams.

### 4. Git Operations (4 tests per terminal)
- **Git init:** Initialize repositories
- **Git config:** Set user configuration
- **Git add:** Stage files
- **Git commit:** Create commits

**Why Critical:** Spirit needs git for version control and tracking code changes.

### 5. Environment Variables (3 tests per terminal)
- **Set variable:** `export VAR=value`
- **Use in command:** `cat $FILE`
- **Multiple variables:** `export A=1 B=2`

**Why Critical:** Spirit needs env vars for configuration and passing parameters to tools.

## Test Coverage

| Category | Tests per Terminal | Total |
|----------|-------------------|-------|
| File CRUD | 4 | 8 |
| Command Execution | 3 | 6 |
| Pipe Chains | 3 | 6 |
| Git Operations | 4 | 8 |
| Environment Variables | 3 | 6 |
| **Total** | **17** | **34** |

## Expected Output

```
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║           WINDWALKER REGRESSION TEST SUITE                ║
║           Critical Spirit Prerequisites                   ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

Checking Skyeyes API...
✓ API available, pages active

═══ FOAM ═══

File CRUD:
  ✓ Create file
  ✓ Read file
  ✓ Update file
  ✓ Delete file

Command Execution:
  ✓ Success command
  ✓ Command output
  ✓ Chained commands

Pipe Chains:
  ✓ Simple pipe
  ✓ Multi-stage pipe
  ✓ Pipe with redirect

Git Operations:
  ✓ Git init
  ✓ Git config
  ✓ Git add
  ✓ Git commit

Environment Variables:
  ✓ Set variable
  ✓ Use in command
  ✓ Multiple vars

═══ SHIRO ═══

[... same tests ...]

════════════════════════════════════════════════════════════
REGRESSION TEST SUMMARY
════════════════════════════════════════════════════════════

  Tests Run:     34
  Passed:        34
  Failed:        0
  Pass Rate:     100%
  Duration:      45.3s

════════════════════════════════════════════════════════════

✓ ALL REGRESSION TESTS PASSED
Spirit prerequisites verified - safe to deploy
```

## Exit Codes

- **0** - All tests passed ✅ Safe to deploy
- **1** - One or more tests failed ❌ Do not deploy

## Performance

- **Duration:** 30-60 seconds
- **Tests:** 34 total (17 per terminal)
- **Timeouts:** 15s per test
- **Total max time:** ~8.5 minutes (if all tests timeout)

## CI/CD Integration

### GitHub Actions

```yaml
name: Regression Tests

on: [push, pull_request]

jobs:
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'

      - name: Run Regression Tests
        run: node tests/regression.js

      - name: Block Deploy on Failure
        if: failure()
        run: exit 1
```

### Pre-Deployment Hook

```bash
#!/bin/bash
# .git/hooks/pre-push or deployment script

echo "Running regression tests..."
node tests/regression.js

if [ $? -eq 0 ]; then
    echo "✓ Tests passed - proceeding with deployment"
else
    echo "✗ Tests failed - blocking deployment"
    exit 1
fi
```

## Comparison to Other Test Suites

| Suite | Tests | Duration | Use Case |
|-------|-------|----------|----------|
| **Regression** | 34 | ~45s | Pre-deployment verification |
| Infrastructure | 6 | ~5s | Quick health check |
| E2E | 4 workflows | ~2-4min | Core workflow validation |
| Integration | 64 | ~4-8min | Comprehensive testing |
| Comprehensive | 44 | ~2-4min | Full command coverage |

**Use Regression Tests for:**
- ✅ Every deployment
- ✅ CI/CD pipelines
- ✅ Pre-merge validation
- ✅ Quick verification
- ✅ Blocking failed deployments

## What Makes This Different

### Focused on Critical Features
Only tests what Spirit **absolutely needs** to function:
- File I/O (no Spirit without this)
- Command execution (required for tools)
- Pipes (needed for workflows)
- Git (version control)
- Environment vars (configuration)

### Fast Execution
- Small test set (34 tests vs 64+ in other suites)
- No slow operations (no npm install, minimal git clone)
- Parallel execution where possible
- ~45 seconds vs ~4-8 minutes

### Deployment Blocking
- Exit code 0 = safe to deploy
- Exit code 1 = block deployment
- Clear pass/fail reporting
- No ambiguity

## Troubleshooting

### Test Timeout
**Symptom:** Tests hang or timeout

**Solution:**
- Check Skyeyes API is running
- Verify pages are loaded
- Increase timeout in code if needed

### API Connection Failed
**Symptom:** "Skyeyes API error"

**Solution:**
- Ensure Skyeyes running on port 7777
- Check `curl http://localhost:7777/api/skyeyes/status`
- Verify firewall not blocking

### Intermittent Failures
**Symptom:** Tests pass sometimes, fail others

**Solution:**
- Check system load (slow machine may timeout)
- Verify no concurrent tests running
- Check for file system conflicts

## Maintenance

### Adding New Tests

Only add tests that are **critical** for Spirit:

```javascript
// In main() function, within the terminal loop:
await test(page, 'Test name', 'command', /expected/);
```

### Removing Tests

Only remove if feature is no longer required by Spirit.

### Updating Thresholds

Currently: 100% pass rate required

To change:
```javascript
// In main() summary section:
const REQUIRED_PASS_RATE = 95; // Allow 5% failure
if (passRate >= REQUIRED_PASS_RATE) {
  // Pass
}
```

## Best Practices

### Run Before Every Deploy

```bash
# Automated deployment script
npm run build
node tests/regression.js || exit 1
./deploy.sh
```

### Include in PR Checks

```yaml
# .github/workflows/pr.yml
- name: Regression Tests
  run: node tests/regression.js
```

### Monitor Execution Time

If tests start taking >2 minutes:
1. Investigate slow tests
2. Optimize or remove non-critical tests
3. Keep suite fast (<1 minute)

### Update When Spirit Requirements Change

If Spirit gains new critical requirements:
1. Add test to regression suite
2. Verify it's actually critical
3. Keep total tests <50

## Success Criteria

✅ **Good Regression Suite:**
- Fast (<1 minute)
- Focused (only critical features)
- Reliable (no flaky tests)
- Blocking (fails deployment on errors)

❌ **Bad Regression Suite:**
- Slow (>5 minutes)
- Comprehensive (tests everything)
- Flaky (intermittent failures)
- Advisory (doesn't block)

This suite aims for "good" by being fast and focused.

## Related Documentation

- `spirit-readiness-report.md` - Full Spirit capability assessment
- `e2e-tests.js` - Core workflow tests
- `integration-tests.js` - Comprehensive test suite
- `TESTING.md` - Complete testing guide

---

**Quick Commands:**
```bash
# Run regression tests
node tests/regression.js

# Run with verbose output
NODE_DEBUG=* node tests/regression.js

# Check if tests exist
test -f tests/regression.js && echo "Regression suite ready"
```

**Remember:** These tests are the **last line of defense** before deployment. If they fail, do not deploy.
