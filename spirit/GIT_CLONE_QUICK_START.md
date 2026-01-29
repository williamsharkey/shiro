# Git Clone Quick Start Guide

**For:** Immediate testing of git clone functionality in Shiro and Foam
**Time Required:** 15-30 minutes
**Prerequisites:** Access to Shiro or Foam browser OS

---

## Quick Test - 5 Minutes

Open Shiro or Foam terminal and run these commands:

```bash
# Test 1: Check if git exists
git --version

# Test 2: Try to clone a tiny repository
cd /tmp
git clone https://github.com/sindresorhus/is

# Test 3: Verify clone worked
cd is
ls -la
git status
git log --oneline -n 3
```

### Expected Results

**✅ Success looks like:**
```
$ git --version
git version 2.x.x

$ git clone https://github.com/sindresorhus/is
Cloning into 'is'...
remote: Counting objects...
Receiving objects: 100% (XX/XX), done.

$ cd is && ls -la
total XX
drwxr-xr-x  .git/
-rw-r--r--  package.json
-rw-r--r--  index.js
...

$ git status
On branch main
nothing to commit, working tree clean
```

**❌ Failure looks like:**
```
$ git --version
bash: git: command not found

OR

$ git clone https://github.com/sindresorhus/is
fatal: unable to access 'https://...': Could not resolve host
```

---

## What To Do Next

### If Tests PASS ✅
**Great!** Git clone is working. Next steps:

1. **Test larger repos:**
```bash
cd /tmp
git clone https://github.com/chalk/chalk
```

2. **Test with your actual use case:**
```bash
cd /workspace
git clone https://github.com/your-username/your-repo
```

3. **Document any issues** you encounter with larger repos

4. **Mark hurdles as resolved** in GIT_CLONE_ISSUES.md

---

### If Tests FAIL ❌

#### Failure: "git: command not found"
**Hurdle:** Git not implemented (Hurdle #1)

**Quick check:**
```bash
# Check what commands are available
help
# or
command -v git
which git
```

**Next steps:**
1. Check Shiro/Foam documentation for git support
2. Review GIT_CLONE_ACTION_PLAN.md → Phase 2 → Scenario A
3. Consider integrating isomorphic-git
4. File issue using `.github/ISSUE_TEMPLATE/git-clone-issue.md`

---

#### Failure: Network/CORS errors
**Hurdle:** Network access blocked (Hurdle #2)

**Error examples:**
- `Could not resolve host`
- `CORS policy`
- `Failed to fetch`
- `Network error`

**Quick workaround:**
```bash
# Try GitHub's tarball API instead
cd /tmp
curl -L https://github.com/sindresorhus/is/archive/refs/heads/main.tar.gz -o repo.tar.gz
tar -xzf repo.tar.gz
ls -la is-main/
```

**Next steps:**
1. Check browser console (F12) for CORS errors
2. Review GIT_CLONE_ACTION_PLAN.md → Phase 2 → Blocker B1
3. Consider CORS proxy or GitHub API fallback
4. Document exact error in GIT_CLONE_ISSUES.md

---

#### Failure: "QuotaExceededError"
**Hurdle:** Storage quota exceeded (Hurdle #6)

**Quick check:**
```javascript
// Run in browser console
navigator.storage.estimate().then(est => {
  const used = (est.usage / 1024 / 1024).toFixed(2);
  const total = (est.quota / 1024 / 1024).toFixed(2);
  console.log(`Storage: ${used}MB / ${total}MB (${(est.usage/est.quota*100).toFixed(1)}% used)`);
});
```

**Quick workaround:**
```bash
# Try shallow clone (smaller)
git clone --depth 1 https://github.com/sindresorhus/is

# Or clean up old data
rm -rf /tmp/old-*
```

**Next steps:**
1. Implement storage quota warnings
2. Default to shallow clones
3. Review GIT_CLONE_ACTION_PLAN.md → Phase 2 → Blocker B3

---

#### Failure: Authentication required
**Hurdle:** Private repo without credentials (Hurdle #2)

**Quick workaround:**
```bash
# Create GitHub Personal Access Token at:
# https://github.com/settings/tokens

# Use token in URL (be careful with logs!)
git clone https://YOUR_TOKEN@github.com/username/private-repo

# OR set up credential helper
git config --global credential.helper store
git clone https://github.com/username/private-repo
# Enter username and token when prompted
```

**Next steps:**
1. Implement secure token storage
2. Review GIT_CLONE_ACTION_PLAN.md → Phase 2 → Blocker B2
3. Consider OAuth flow for better UX

---

## Comprehensive Testing (30 minutes)

If basic tests pass, run this comprehensive suite:

```bash
# Create test directory
mkdir -p /tmp/git-tests
cd /tmp/git-tests

# Test 1: Init and config
git init test-repo
cd test-repo
git config user.name "Test User"
git config user.email "test@example.com"
echo "test" > file.txt
git add file.txt
git commit -m "Initial commit"
git log
cd ..

# Test 2: Tiny clone
git clone https://github.com/sindresorhus/is tiny-clone
ls -la tiny-clone/
cd tiny-clone && git status && cd ..

# Test 3: Small clone
git clone https://github.com/chalk/chalk small-clone
ls -la small-clone/
cd small-clone && git log --oneline | head -5 && cd ..

# Test 4: Shallow clone
git clone --depth 1 https://github.com/expressjs/express shallow-clone
du -sh shallow-clone/.git
du -sh small-clone/.git
# Compare sizes - shallow should be much smaller

# Test 5: Check storage usage
du -sh /tmp/git-tests

# Test 6: Cleanup
cd /tmp
rm -rf git-tests
echo "Tests complete!"
```

### Record Results

Document in GIT_CLONE_ISSUES.md under "Testing Checklist":

```markdown
### Shiro Environment
- [✅/❌] Verify git binary/implementation presence
- [✅/❌] Test `git init` in empty directory
- [✅/❌] Test `git clone` of tiny repo (<1MB)
- [✅/❌] Test `git clone` of small repo (1-10MB)
- [✅/❌] Test shallow clone (`--depth 1`)
...
```

---

## Performance Benchmarks

Measure clone times for comparison:

```bash
# Tiny repo (~400KB)
time git clone https://github.com/sindresorhus/is
# Expected: < 5 seconds

# Small repo (~2MB)
time git clone https://github.com/chalk/chalk
# Expected: < 15 seconds

# Medium repo (~5MB)
time git clone https://github.com/expressjs/express
# Expected: < 30 seconds

# Shallow clone comparison
time git clone --depth 1 https://github.com/webpack/webpack
# Should be significantly faster than full clone
```

**Document times in GIT_CLONE_ISSUES.md**

---

## Filing Issues

If you encounter problems, use the issue template:

```bash
# Copy template
cat .github/ISSUE_TEMPLATE/git-clone-issue.md
```

Include:
1. ✅ Exact error message
2. ✅ Terminal output (commands + responses)
3. ✅ Browser console errors (F12)
4. ✅ Results of diagnostic commands
5. ✅ Repository URL that failed
6. ✅ Platform (Shiro/Foam) and browser

---

## Decision Tree

```
Can you run `git --version`?
├─ NO → Git not implemented (See Phase 2, Scenario A)
└─ YES → Can you run `git init`?
    ├─ NO → Git partially implemented (File issue)
    └─ YES → Can you clone tiny repo?
        ├─ NO → Network/CORS issue (See Blocker B1)
        │   ├─ Error: "Could not resolve" → Network blocked
        │   ├─ Error: "Authentication failed" → Need credentials (B2)
        │   └─ Error: "QuotaExceeded" → Storage full (B3)
        └─ YES → Can you clone larger repo (5MB)?
            ├─ NO → Size/performance issue (Hurdle #6)
            │   └─ Try: `git clone --depth 1 <url>`
            └─ YES → Git works! Document and optimize
                └─ See Phase 3 for enhancements
```

---

## Success Criteria Checklist

Check these off as you test:

**Basic Functionality:**
- [ ] `git --version` shows version
- [ ] `git init` creates repository
- [ ] `git config` persists settings
- [ ] `git add` stages files
- [ ] `git commit` creates commits
- [ ] `git status` shows state
- [ ] `git log` shows history

**Clone Functionality:**
- [ ] Can clone public repo <1MB
- [ ] Can clone public repo 1-10MB
- [ ] Can clone with `--depth 1`
- [ ] Cloned files are readable
- [ ] Can run git commands in cloned repo
- [ ] `.git` directory structure is correct

**Advanced (Optional):**
- [ ] Can clone private repo with token
- [ ] Can clone 10-50MB repo
- [ ] Performance is acceptable (<30s for 5MB)
- [ ] Progress output shows during clone
- [ ] Error messages are helpful

---

## Quick Reference Commands

**Diagnostic:**
```bash
git --version                          # Check git exists
git config --list                      # Show git config
env | grep GIT                         # Show git env vars
du -sh /path/.git                      # Check repo size
```

**Clone variants:**
```bash
git clone <url>                        # Full clone
git clone --depth 1 <url>              # Shallow clone
git clone --single-branch <url>        # One branch only
git clone --filter=blob:none <url>     # Blobless clone
```

**Storage management:**
```bash
du -sh /tmp/*                          # Check temp usage
du -sh /workspace/*                    # Check workspace usage
rm -rf /tmp/old-repo                   # Clean up
git gc                                 # Garbage collect
```

**Troubleshooting:**
```bash
GIT_TRACE=1 git clone <url>            # Verbose git output
GIT_CURL_VERBOSE=1 git clone <url>     # Verbose network output
```

---

## Next Steps After Testing

### If Everything Works
1. Update GIT_CLONE_ISSUES.md with test results
2. Mark successful hurdles as ✅ Resolved
3. Move to Phase 3 (optimization)
4. Implement enhancements from action plan

### If Some Things Fail
1. Document specific failures in detail
2. Update hurdle status in GIT_CLONE_ISSUES.md
3. Follow action plan for specific blocker
4. Implement fixes from Phase 2

### If Nothing Works
1. File detailed issue with all diagnostic info
2. Review Phase 2, Scenario A (git not implemented)
3. Consider isomorphic-git integration
4. Or implement GitHub API fallback

---

## Resources

- **Full Documentation:** GIT_CLONE_SUMMARY.md
- **Issue Tracker:** GIT_CLONE_ISSUES.md
- **Implementation Plan:** GIT_CLONE_ACTION_PLAN.md
- **Troubleshooting:** GIT_TROUBLESHOOTING.md
- **Report Issues:** .github/ISSUE_TEMPLATE/git-clone-issue.md

---

## Support

**Questions?** Check GIT_TROUBLESHOOTING.md first

**Found a bug?** Use the issue template in `.github/ISSUE_TEMPLATE/`

**Need help?** Review the comprehensive docs or file an issue

---

**Created:** 2026-01-29
**For:** Spirit repository - git clone testing
**Platforms:** Shiro & Foam browser operating systems
**Time to test:** 5-30 minutes depending on depth
