# Spirit AI End-to-End Workflow Test

Complete simulation of a Spirit AI development cycle from project creation to version control.

## Overview

This test verifies that Spirit AI can perform a **complete, realistic development workflow** from start to finish, including:

1. Project setup (directory creation)
2. Code creation (writing JavaScript files)
3. Code execution (running with Node.js)
4. Version control (git init, add, commit)
5. Code modification (editing with sed)
6. Re-execution (verifying changes)
7. Version tracking (committing updates, viewing history)

## Quick Start

```bash
# Run Spirit E2E workflow test
node tests/spirit-e2e-workflow.js

# Expected duration: ~2-3 minutes
# Expected result: All workflow steps pass
```

## What It Tests

### Complete Development Workflow (9 Steps × 2 Terminals = 38 Total Tests)

#### Step 1: Project Setup
- **Create project directory:** `mkdir -p /tmp/spirit_project`
- **Verify working directory:** `pwd`

**Why Critical:** Spirit needs to organize code in project directories.

#### Step 2: Create Initial Code
- **Write app.js v1:** `echo "console.log('Hello from Spirit v1');" > app.js`
- **Verify file exists:** `ls -la app.js`

**Why Critical:** Spirit needs to create code files from scratch.

#### Step 3: Execute Code
- **Run app.js (first execution):** `node app.js`
- **Verify output:** Matches "Hello from Spirit v1"

**Why Critical:** Spirit needs to run code to verify it works.

#### Step 4: Version Control - Initial Commit
- **Git init:** Initialize repository
- **Git config:** Set user name and email
- **Git add:** Stage all files
- **Git commit:** Create initial commit with message
- **Verify commit:** Check git log shows commit

**Why Critical:** Spirit needs to version control AI-generated code.

#### Step 5: Code Modification
- **Edit with sed:** Replace "v1" with "v2" in app.js
- **Verify git detects changes:** `git status` shows modified

**Why Critical:** Spirit needs to modify existing code based on user feedback.

#### Step 6: Verify Modified Code
- **Run app.js (after edit):** `node app.js`
- **Verify output:** Matches "Hello from Spirit v2"

**Why Critical:** Spirit needs to verify modifications work correctly.

#### Step 7: Version Control - Commit Changes
- **Git add modified file:** Stage changes
- **Git commit update:** Create commit with update message

**Why Critical:** Spirit needs to track iterative improvements.

#### Step 8: Verify Version History
- **Check git log:** Shows both commits
- **Git diff:** View changes between commits

**Why Critical:** Spirit needs to review change history.

#### Step 9: Workflow Verification
- **Verify clean working directory:** No uncommitted changes
- **Count total commits:** Should be exactly 2

**Why Critical:** Spirit needs to ensure workflows complete cleanly.

## Test Coverage

| Category | Steps per Terminal | Total Tests |
|----------|-------------------|-------------|
| Project Setup | 1 | 2 |
| Code Creation | 2 | 4 |
| Code Execution | 1 | 2 |
| Git Initial Commit | 5 | 10 |
| Code Modification | 2 | 4 |
| Verify Changes | 1 | 2 |
| Git Update Commit | 2 | 4 |
| Version History | 2 | 4 |
| Workflow Verification | 2 | 4 |
| **Total** | **19** | **38** |

## Expected Output

```
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║         SPIRIT AI END-TO-END WORKFLOW TEST                ║
║         Complete Development Cycle Simulation             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

Checking Skyeyes API...
✓ API available, pages active

═══ FOAM SPIRIT WORKFLOW ═══

Step 1: Project Setup
  ✓ Create project directory

Step 2: Create Initial Code
  ✓ Write app.js v1
  ✓ Verify file exists

Step 3: Execute Code
  ✓ Run app.js (first execution)

Step 4: Version Control - Initial Commit
  ✓ Git init
  ✓ Git config user
  ✓ Git add files
  ✓ Git commit initial version
  ✓ Verify commit in log

Step 5: Code Modification
  ✓ Edit with sed (v1 -> v2)
  ✓ Verify git detects changes

Step 6: Verify Modified Code
  ✓ Run app.js (after edit)

Step 7: Version Control - Commit Changes
  ✓ Git add modified file
  ✓ Git commit update

Step 8: Verify Version History
  ✓ Check git log shows 2 commits
  ✓ Git diff between commits

Step 9: Workflow Verification
  ✓ Verify clean working directory
  ✓ Count total commits

═══ SHIRO SPIRIT WORKFLOW ═══

[... same workflow steps ...]

════════════════════════════════════════════════════════════
SPIRIT E2E WORKFLOW SUMMARY
════════════════════════════════════════════════════════════

  Workflow Steps:  38
  Passed:          38
  Failed:          0
  Pass Rate:       100%
  Duration:        145.7s

════════════════════════════════════════════════════════════

✓ SPIRIT WORKFLOW COMPLETE
All development cycle steps verified successfully
Spirit can perform complete development workflows
```

## Exit Codes

- **0** - All workflow steps passed ✅
- **1** - One or more steps failed ❌

## Performance

- **Duration:** 2-3 minutes
- **Tests:** 38 total (19 per terminal)
- **Timeouts:** 20s per test
- **Total max time:** ~12.6 minutes (if all tests timeout)

## Workflow Stages Explained

### Stage 1: Project Initialization
Spirit creates a clean workspace and verifies the environment.

```bash
mkdir -p /tmp/spirit_project
cd /tmp/spirit_project
pwd  # Verify we're in the right place
```

### Stage 2: Code Generation
Spirit writes initial code based on requirements.

```bash
echo "console.log(\"Hello from Spirit v1\");" > app.js
ls -la app.js  # Verify file was created
```

### Stage 3: Code Validation
Spirit runs the code to ensure it works.

```bash
node app.js  # Should output: Hello from Spirit v1
```

### Stage 4: Version Control Foundation
Spirit establishes version control for tracking changes.

```bash
git init
git config user.name "Spirit AI"
git config user.email "spirit@ai.com"
git add .
git commit -m "Initial version: Spirit v1"
git log --oneline  # Verify commit
```

### Stage 5: Iterative Development
Spirit modifies code based on feedback.

```bash
sed -i "s/v1/v2/g" app.js  # Update version
cat app.js  # Verify changes
git status  # Should show modified
```

### Stage 6: Change Verification
Spirit re-runs code to verify modifications work.

```bash
node app.js  # Should output: Hello from Spirit v2
```

### Stage 7: Track Improvements
Spirit commits the iteration for history.

```bash
git add app.js
git commit -m "Update: Spirit v2"
```

### Stage 8: Review History
Spirit can review what changed over time.

```bash
git log --oneline  # Shows 2 commits
git log -p -1  # Shows diff of last commit
```

### Stage 9: Workflow Completion
Spirit ensures everything is clean and complete.

```bash
git status  # Should be clean
git rev-list --count HEAD  # Should show 2 commits
```

## Real-World Spirit Scenarios

This workflow simulates real Spirit AI operations:

### Scenario A: "Create a Hello World app"
1. ✅ Creates project directory
2. ✅ Writes JavaScript code
3. ✅ Runs it to verify
4. ✅ Commits to git

### Scenario B: "Update the greeting"
1. ✅ Edits existing code with sed
2. ✅ Runs to verify changes
3. ✅ Commits the update

### Scenario C: "Show me the version history"
1. ✅ Runs git log to show commits
2. ✅ Runs git diff to show changes

## Why This Test Matters

### For Spirit Deployment
This is the **ultimate integration test** - it verifies Spirit can:
- Create projects from scratch
- Write and execute code
- Use version control throughout
- Modify and iterate on code
- Track changes over time

### For Development Confidence
If this test passes, you know:
- ✅ Complete development workflows work end-to-end
- ✅ Git integration is fully functional
- ✅ Code execution (Node.js) works reliably
- ✅ File editing (sed) works correctly
- ✅ Both terminals support the full workflow

## Comparison to Other Test Suites

| Suite | Tests | Duration | Use Case |
|-------|-------|----------|----------|
| **Spirit E2E** | 38 | ~2-3min | Complete workflow validation |
| Regression | 34 | ~45s | Pre-deployment verification |
| Infrastructure | 6 | ~5s | Quick health check |
| Integration | 64 | ~4-8min | Comprehensive testing |

**Use Spirit E2E for:**
- ✅ Validating complete Spirit capabilities
- ✅ Pre-production readiness testing
- ✅ Demonstrating Spirit workflows
- ✅ End-to-end integration verification

## Troubleshooting

### Test Fails at "Git init"
**Symptom:** Git commands don't work

**Solution:**
- Verify git is available: `node -e "console.log(window.__foam.shell.execute('git --version'))"`
- Check WebAssembly git is loaded
- Verify `/tmp` is writable

### Test Fails at "Run app.js"
**Symptom:** Node.js execution fails

**Solution:**
- Verify Node.js available: `node --version`
- Check file was created: `ls -la /tmp/spirit_project/app.js`
- Verify file contents: `cat /tmp/spirit_project/app.js`

### Test Times Out
**Symptom:** Tests hang or timeout

**Solution:**
- Check Skyeyes API is running
- Verify pages are loaded
- Increase timeout in code (currently 20s)
- Check system resources

### Intermittent Failures
**Symptom:** Tests pass sometimes, fail others

**Solution:**
- Check for concurrent tests (stop other test runners)
- Verify `/tmp` cleanup between runs
- Ensure no file system conflicts

## CI/CD Integration

### GitHub Actions

```yaml
name: Spirit E2E Workflow Test

on: [push, pull_request]

jobs:
  spirit-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'

      - name: Run Spirit E2E Test
        run: node tests/spirit-e2e-workflow.js

      - name: Block on Failure
        if: failure()
        run: exit 1
```

### Pre-Production Checklist

```bash
#!/bin/bash
# Pre-production Spirit verification

echo "Running Spirit E2E workflow test..."
node tests/spirit-e2e-workflow.js

if [ $? -eq 0 ]; then
    echo "✓ Spirit E2E passed - ready for production"
else
    echo "✗ Spirit E2E failed - fix before deploying"
    exit 1
fi
```

## Success Criteria

### Complete Workflow
- ✅ All 9 workflow stages complete
- ✅ Both terminals pass all steps
- ✅ 100% pass rate

### Git Integration
- ✅ Repository initialization works
- ✅ Commits are created successfully
- ✅ History tracking is accurate

### Code Execution
- ✅ Node.js runs JavaScript correctly
- ✅ Output matches expected results
- ✅ Modifications are reflected in re-runs

### File Operations
- ✅ Files created successfully
- ✅ Files edited correctly with sed
- ✅ File system state is consistent

## Maintenance

### Expanding the Workflow

To add more workflow steps:

```javascript
// In main() function, within the terminal loop:
console.log(`\n${c.yellow}Step 10: New Feature${c.reset}`);
await testStep(
  page,
  'Description of step',
  'command to execute',
  /expected output pattern/
);
```

### Modifying the Workflow

Current workflow simulates:
1. Initial development (create + commit)
2. Iteration (modify + commit)
3. Review (check history)

You can modify to simulate:
- Multiple iterations
- Branch creation
- Merge workflows
- More complex code changes

### Performance Tuning

If tests run too slowly:
1. Reduce timeout per step (currently 20s)
2. Remove less critical verification steps
3. Optimize command chaining
4. Use faster operations

## Best Practices

### Run Before Major Releases
```bash
# Before deploying Spirit
npm run build
node tests/spirit-e2e-workflow.js || exit 1
./deploy-spirit.sh
```

### Include in Test Suite
```bash
# Complete test sequence
node tests/regression.js          # Fast check (~45s)
node tests/spirit-e2e-workflow.js # Complete workflow (~2-3min)
node tests/integration-tests.js   # Comprehensive (~4-8min)
```

### Monitor Execution Time
If E2E test starts taking >5 minutes:
1. Investigate slow steps
2. Check for performance regressions
3. Optimize command execution
4. Consider test parallelization

## Related Documentation

- `regression.js` - Fast deployment gate tests
- `spirit-readiness-test.js` - Capability verification
- `integration-tests.js` - Comprehensive test suite
- `e2e-tests.js` - Core workflow tests
- `spirit-readiness-report.md` - Deployment approval

---

**Quick Commands:**
```bash
# Run Spirit E2E workflow test
node tests/spirit-e2e-workflow.js

# Run with verbose output
NODE_DEBUG=* node tests/spirit-e2e-workflow.js

# Check if test exists
test -f tests/spirit-e2e-workflow.js && echo "Spirit E2E test ready"
```

**Remember:** This test simulates a **complete Spirit development cycle**. If it passes, Spirit can handle real-world development workflows from start to finish.
