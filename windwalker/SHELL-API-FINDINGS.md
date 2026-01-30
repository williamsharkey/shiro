# Shell API Findings Report
**Date:** January 29, 2026
**Testing:** foam-windwalker and shiro-windwalker terminals

## Executive Summary

Critical findings from testing the current windwalker terminal implementation:

1. **✗ SHIRO-WINDWALKER IS NON-FUNCTIONAL** - Missing shell API entirely
2. **⚠ FOAM-WINDWALKER PARTIALLY WORKING** - Basic commands work, advanced shell scripting fails
3. **✗ API BREAKING CHANGE** - Shell method changed from `.execute()` to `.exec()`, breaking all existing tests
4. **⚠ LIMITED SHELL SUPPORT** - Only 25% of shell scripting features work

## Critical Issues

### Issue #1: SHIRO Terminal Missing Shell API

**Severity:** CRITICAL ❌
**Impact:** Complete terminal failure

```javascript
// Expected:
window.__shiro.shell.exec(command)

// Reality:
window.__shiro === undefined
```

**Finding:** The `shiro-windwalker` page has no shell object at all. While the page is loaded and accessible via Skyeyes API, there is no `window.__shiro` object, making the terminal completely non-functional.

**Regression:** Previous test documentation assumed both terminals worked identically. This is a critical regression that makes shiro unusable.

---

### Issue #2: API Breaking Change (.execute → .exec)

**Severity:** HIGH ⚠️
**Impact:** All existing tests broken

**Change:**
```javascript
// Old API (what tests expect):
window.__foam.shell.execute(command)
  .then(result => /* string output */)

// New API (current):
window.__foam.shell.exec(command)
  .then(result => /* { stdout, stderr, exitCode } */)
```

**Impact:**
- All regression tests fail immediately (0/34 pass)
- All Spirit E2E tests fail
- All readiness tests fail
- All integration tests fail

**Required Action:**
- Rewrite all test suites to use `.exec()` instead of `.execute()`
- Update documentation
- Update API examples

---

### Issue #3: Limited Shell Scripting Support

**Severity:** HIGH ⚠️
**Impact:** Advanced workflows unsupported

**Test Results:** 6/24 tests passed (25% pass rate)

#### ✓ What Works (6 features):
1. Simple echo commands
2. Command substitution: `$(command)`
3. Exit code capture: `$?`
4. Logic operators: `&&` and `||`
5. Script file creation
6. Basic command chaining

#### ✗ What Doesn't Work (18 features):

**Variables & Expansion:**
- ✗ Variable expansion: `VAR=value; echo $VAR` (prints blank)
- ✗ Arithmetic expansion: `$((5 + 3))` (prints blank)

**Control Flow:**
- ✗ if/then/else/fi statements (exitCode 127 = command not found)
- ✗ [ ] test command (exitCode 127)
- ✗ test command (exitCode 127)
- ✗ if/elif/else chains (exitCode 127)

**Loops:**
- ✗ for loops (exitCode 127)
- ✗ while loops (exitCode 127)

**Functions:**
- ✗ Function definition and calls (exitCode 127)
- ✗ Function arguments (exitCode 127)
- ✗ Function return codes (returns 127 instead of expected code)

**File Operations:**
- ✗ Output redirection: `>` (exitCode 1, produces no output)
- ✗ Source command: `. script.sh` (exitCode 1)

**Advanced:**
- ✗ Subshells: `(commands)` (exitCode 127)
- ✗ Pipe chains with multiple stages

**Exit Code 127 Pattern:** Most failures return exit code 127, which means "command not found." This suggests the shell parser doesn't recognize these keywords (if, for, while, function) as shell builtins and is trying to execute them as external commands.

---

## Comparison to Previous Test Results

### Previous Claims (from test documentation):

| Suite | Expected | Actual |
|-------|----------|--------|
| Regression | 34/34 pass (100%) | **0/34 pass (0%)** ❌ |
| Spirit Readiness | 17/17 per terminal | **Untested** (API broken) ❌ |
| Spirit E2E | 19/19 per terminal | **Untested** (API broken) ❌ |
| Integration | 32/32 per terminal | **Untested** (API broken) ❌ |
| Compatibility | 100% foam/shiro | **Shiro non-functional** ❌ |

**Conclusion:** Previous test results were based on a different API version or were not actually run against the current codebase. All documentation claiming 100% pass rates is invalidated.

---

## Technical Details

### Current API Structure

**FOAM Terminal:**
```javascript
window.__foam = {
  vfs: {...},
  shell: {
    exec: async (command) => Promise<{stdout, stderr, exitCode}>,
    execLive: function,
    // Internal methods: _execLine, _execLogicChain, _execPipeline, etc.
  },
  terminal: {...},
  claude: {...},
  provider: {...}
}
```

**SHIRO Terminal:**
```javascript
window.__shiro = undefined  // ❌ MISSING
```

### Shell Methods Available in Foam

Based on prototype inspection:
- `exec` - Main command execution (async)
- `execLive` - Live command execution
- `_execLine` - Internal: parse and execute single line
- `_execLogicChain` - Internal: handle && and ||
- `_execPipeline` - Internal: handle pipes
- `_execSingle` - Internal: execute single command
- `_expandVars` - Internal: variable expansion (exists but doesn't work?)
- `_expandCommandSubstitution` - Internal: handle $()
- `_tokenize` - Internal: tokenize command
- `_splitStatements` - Internal: split on ;
- `_splitLogic` - Internal: split on && ||
- `_splitPipes` - Internal: split on |
- `_parseRedirects` - Internal: parse > < >>
- `_readRedirectTarget` - Internal: get redirect target

**Observation:** The shell has internal methods for variable expansion, redirects, and parsing, but they don't appear to work correctly. This suggests partial implementation.

---

## Shell Scripting Test Results Detail

### Category: Basic Shell Features (3/5 pass = 60%)

| Feature | Status | Notes |
|---------|--------|-------|
| Simple echo | ✓ | Works perfectly |
| Command substitution | ✓ | `$(cmd)` works |
| Variable expansion | ✗ | `$VAR` prints blank line |
| Pipe chain | ✗ | `wc -l` counts 1 line instead of 2 |
| Redirect output | ✗ | Exit code 1, no output |

### Category: Conditional Statements (0/5 pass = 0%)

All if/then/else constructs fail with exit code 127 (command not found):
- if/then/fi
- if/else/fi
- if/elif/else/fi
- [ ] test syntax
- test command

**Root Cause:** Shell doesn't recognize `if`, `then`, `else`, `fi` as keywords.

### Category: Loops (0/3 pass = 0%)

All loop constructs fail with exit code 127:
- for loops
- while loops

**Root Cause:** Shell doesn't recognize `for`, `do`, `done`, `while` as keywords.

### Category: Shell Script Files (1/3 pass = 33%)

| Feature | Status | Notes |
|---------|--------|-------|
| Create script file | ✓ | File creation works |
| Source script | ✗ | `. file.sh` fails (exit 1) |
| Source with variables | ✗ | Variable not set after source |

### Category: Functions (0/3 pass = 0%)

All function constructs fail with exit code 127:
- Function definition
- Function calls
- Function return values (returns 127 instead of expected)

**Root Cause:** Shell doesn't recognize function syntax.

### Category: Advanced Features (3/5 pass = 60%)

| Feature | Status | Notes |
|---------|--------|-------|
| Arithmetic expansion | ✗ | `$((expr))` prints blank |
| Exit code capture | ✓ | `$?` works |
| Logic operators && | ✓ | Works correctly |
| Logic operators \|\| | ✓ | Works correctly |
| Subshell | ✗ | `(cmd)` fails (exit 127) |

---

## Impact Assessment

### For Spirit AI Deployment

**Status:** ❌ **NOT READY FOR DEPLOYMENT**

Critical blockers:
1. **Shiro terminal completely broken** - 50% of target terminals unusable
2. **No shell scripting support** - Spirit cannot use if/then, loops, functions
3. **Variable persistence broken** - Cannot maintain state across commands
4. **File redirection broken** - Cannot write to files reliably

### For Development Workflows

**Status:** ⚠️ **LIMITED FUNCTIONALITY**

What works:
- ✓ Simple commands (ls, cat, echo)
- ✓ Command substitution
- ✓ Basic command chaining (&&, ||)
- ✓ Reading files

What doesn't work:
- ✗ Writing to files (redirects)
- ✗ Scripts with conditionals
- ✗ Scripts with loops
- ✗ Persistent variables
- ✗ Functions

### For Testing

**Status:** ❌ **ALL TESTS BROKEN**

Required actions:
1. Rewrite all test suites for new API
2. Remove shiro from test coverage (non-functional)
3. Lower expectations for shell scripting features
4. Update all documentation

---

## Recommendations

### Immediate Actions (Priority 1)

1. **Fix Shiro Terminal**
   - Investigate why `window.__shiro` is undefined
   - Ensure shiro-windwalker initializes shell object
   - Test parity with foam-windwalker

2. **Update All Test Suites**
   - Rewrite tests to use `.exec()` instead of `.execute()`
   - Update from string output to `{stdout, stderr, exitCode}` structure
   - Remove tests for unsupported features

3. **Document Limitations**
   - Update README with clear list of unsupported features
   - Add warnings about shell scripting limitations
   - Set correct expectations for users

### Short-term Fixes (Priority 2)

1. **Fix File Redirection**
   - `echo "text" > file.txt` should work
   - Critical for many workflows

2. **Fix Variable Persistence**
   - `VAR=value; echo $VAR` should work
   - Required for scripts

3. **Fix Source Command**
   - `. script.sh` should work
   - Required for setup scripts

### Long-term Enhancements (Priority 3)

1. **Add Shell Scripting Support**
   - Implement if/then/else
   - Implement for/while loops
   - Implement function definitions
   - These are complex but valuable for advanced use

2. **Add Missing Features**
   - Subshells
   - Arithmetic expansion
   - Advanced redirects (>>, 2>&1, etc.)

---

## Test Methodology

All tests performed using:
- **Date:** January 29, 2026
- **Skyeyes API:** http://localhost:7777/api/skyeyes
- **Method:** POST to `/exec` endpoint with JSON
- **Pages Tested:** foam-windwalker, shiro-windwalker
- **Timeout:** 20 seconds per test
- **Command Execution:** Async via `window.__foam.shell.exec()` with promise polling

Tests are reproducible via:
```bash
node test-shell-api.js        # Basic API test
node test-shell-scripting.js  # Shell scripting features test
```

---

## Conclusion

The windwalker terminal implementation is currently in a **partially functional** state:

- **Foam:** 25% of shell scripting features work (basic commands only)
- **Shiro:** 0% functional (shell object missing entirely)

**Previous test documentation claiming 100% pass rates across all test suites is invalidated** by these findings. The API has changed, breaking all existing tests, and many documented features (shell scripting, conditionals, loops, functions) do not actually work.

**For Spirit AI deployment:** The terminal is not ready. Critical features are missing or broken.

**For basic development:** Foam terminal can handle simple commands but cannot run shell scripts.

**Priority action:** Fix shiro terminal and update all documentation to reflect actual capabilities.
