---
name: Git Clone Issue
about: Report problems with git clone or git operations in Shiro/Foam
title: '[GIT] '
labels: git, needs-triage
assignees: ''
---

## Issue Summary
<!-- Brief description of the git-related problem -->

## Environment
**Platform:**
- [ ] Shiro
- [ ] Foam
- [ ] Both

**Browser:** <!-- e.g., Chrome 120, Firefox 121 -->

**Spirit Version:** <!-- e.g., 0.1.0 -->

**Git Implementation:** <!-- If known: isomorphic-git, git-wasm, other -->

## Problem Description

### What I tried to do
<!-- Example: Clone a public GitHub repository -->

```bash
# The command I ran
git clone https://github.com/username/repo
```

### What I expected
<!-- Example: Repository should clone successfully into current directory -->

### What actually happened
<!-- Example: Error message appeared, partial clone, timeout, etc. -->

**Error Output:**
```
[Paste complete error message and stack trace here]
```

**Terminal Output:**
```
[Paste full terminal output including commands and responses]
```

## Repository Details

**Repository URL:** <!-- https://github.com/... -->

**Repository Size:** <!-- Approximate size if known, e.g., 5MB, 50MB -->

**Public/Private:**
- [ ] Public repository
- [ ] Private repository (with authentication)

## Additional Context

### Network
- [ ] Used proxy
- [ ] Direct connection
- [ ] Corporate network/firewall
- [ ] VPN active

### Storage
**Available storage:** <!-- If known, e.g., 100MB free in IndexedDB -->

**Storage quota exceeded:**
- [ ] Yes
- [ ] No
- [ ] Unknown

### Authentication
- [ ] No authentication needed (public repo)
- [ ] Used Personal Access Token (PAT)
- [ ] Used OAuth
- [ ] SSH key
- [ ] Other: _______

## Diagnostic Information

### 1. Git Version Test
```bash
# Please run and paste output:
git --version
```
**Output:**
```
[paste here]
```

### 2. Git Init Test
```bash
# Please run and paste output:
mkdir /tmp/git-test
cd /tmp/git-test
git init
git status
ls -la .git/
```
**Output:**
```
[paste here]
```

### 3. Filesystem Check
```bash
# Please run and paste output:
pwd
df -h
ls -la /tmp
```
**Output:**
```
[paste here]
```

### 4. Environment Variables
```bash
# Please run and paste output (redact sensitive values):
env | grep -i git
```
**Output:**
```
[paste here - REDACT sensitive data]
```

## Attempted Workarounds
<!-- What have you tried to fix this? -->
- [ ] Tried smaller repository
- [ ] Tried shallow clone (--depth 1)
- [ ] Cleared storage/cache
- [ ] Restarted browser
- [ ] Used different repository host
- [ ] Other: _______

**Results:** <!-- Did any workarounds help? -->

## Impact
**Severity:**
- [ ] Critical - Cannot use any git functionality
- [ ] High - Cannot clone specific repos needed for work
- [ ] Medium - Works with workarounds
- [ ] Low - Inconvenience only

**Frequency:**
- [ ] Always happens
- [ ] Happens with specific repos
- [ ] Intermittent
- [ ] Happened once

## References
<!-- Link to related issues, documentation, or external resources -->
- Related issue: #
- Documentation: [link]
- Similar report: [link]

## Reproducible Test Case
<!-- If possible, provide a minimal test case -->

**Minimal repository that reproduces issue:**
- URL: `https://github.com/...`
- Size: ~XMB
- Special characteristics: (binary files, many files, deep nesting, etc.)

**Exact steps to reproduce:**
1. Open Shiro/Foam
2. Navigate to directory: `cd /tmp`
3. Run command: `git clone https://...`
4. Observe: [error/behavior]

## Logs
<!-- If applicable, attach or paste relevant logs -->

**Browser Console:**
```
[Paste browser console errors/warnings]
```

**Spirit Debug Output:**
<!-- If debug mode available -->
```
[Paste debug logs]
```

---

## For Maintainers

**Triage Notes:**
- [ ] Reproduced by maintainer
- [ ] Related to known issue: #____
- [ ] Needs investigation in: [ ] Shiro [ ] Foam [ ] Spirit [ ] Git implementation

**Priority:**
- [ ] P0 - Blocking all git usage
- [ ] P1 - Blocking important use cases
- [ ] P2 - Workaround exists
- [ ] P3 - Enhancement/optimization

**Assigned to:**
**Target milestone:**
**Linked PRs:**

**Investigation checklist:**
- [ ] Tested in both Shiro and Foam
- [ ] Identified root cause
- [ ] Verified fix
- [ ] Added regression test
- [ ] Updated documentation
