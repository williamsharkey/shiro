# Git Troubleshooting Guide for Spirit

Quick reference for diagnosing and fixing git issues in Shiro and Foam.

---

## Quick Diagnostic Commands

Run these to quickly identify the problem:

```bash
# 1. Check git availability
git --version

# 2. Check filesystem
pwd
ls -la
df -h

# 3. Test basic git
git init /tmp/test && echo "Success: git init works"

# 4. Check network (if clone failing)
curl -I https://github.com 2>&1 | head -n 5

# 5. Check storage
ls -la ~/.gitconfig
env | grep GIT
```

---

## Common Issues & Solutions

### Issue 1: "git: command not found"

**Symptom:**
```
bash: git: command not found
```

**Diagnosis:**
Git is not implemented or not available in the shell.

**Solutions:**

**Quick Fix:**
```bash
# Check if git is in a different location
which git
echo $PATH
```

**If git truly missing:**
1. Check Shiro/Foam documentation for git support
2. File issue with platform maintainers
3. Use GitHub API as fallback (see Alternative Approaches below)

**Workaround:**
Create `github-clone` wrapper:
```bash
# Use GitHub API to download repo as tarball
# (Implementation depends on platform tools)
curl -L https://github.com/user/repo/archive/main.tar.gz | tar xz
```

---

### Issue 2: "fatal: unable to access... Could not resolve host"

**Symptom:**
```
fatal: unable to access 'https://github.com/...': Could not resolve host
```

**Diagnosis:**
Network access restricted or DNS not available.

**Solutions:**

1. **Check network access:**
```bash
# Test if fetch/curl works
curl https://api.github.com/zen
```

2. **If network works but git fails:**
   - CORS issue (browser blocking git's HTTP requests)
   - Need to use CORS proxy or different approach

3. **Use CORS proxy** (if using isomorphic-git):
```javascript
// In shell implementation
await git.clone({
  ...options,
  corsProxy: 'https://cors.isomorphic-git.org'
})
```

4. **Alternative: GitHub API:**
```bash
# Download repository contents via API
# (More reliable in browser contexts)
```

---

### Issue 3: "fatal: could not create work tree dir... Permission denied"

**Symptom:**
```
fatal: could not create work tree dir 'repo': Permission denied
```

**Diagnosis:**
Filesystem permissions issue or directory already exists.

**Solutions:**

1. **Check current directory is writable:**
```bash
pwd
touch test-write && rm test-write && echo "Directory is writable"
```

2. **Try different location:**
```bash
cd /tmp
git clone https://github.com/user/repo
```

3. **Remove existing directory:**
```bash
ls -la
rm -rf repo  # If safe to do so
git clone https://github.com/user/repo
```

4. **Check VFS implementation:**
   - May be a bug in virtual filesystem
   - Check available storage quota
   - Verify parent directory exists

---

### Issue 4: Clone hangs or times out

**Symptom:**
```
Cloning into 'repo'...
[hangs indefinitely or times out after several minutes]
```

**Diagnosis:**
Repository too large, network too slow, or implementation issue.

**Solutions:**

1. **Try shallow clone:**
```bash
git clone --depth 1 https://github.com/user/repo
```
   - Reduces download size by ~80%
   - Gets only latest commit

2. **Check repository size first:**
```bash
# Use GitHub API to check size
curl https://api.github.com/repos/user/repo | grep size
```

3. **Try smaller repository:**
```bash
# Test with tiny repo to verify git works
git clone https://github.com/sindresorhus/is
```

4. **Monitor progress:**
   - Check browser console for errors
   - Look for network activity in DevTools
   - Check storage quota not exceeded

---

### Issue 5: "Error: QuotaExceededError"

**Symptom:**
```
QuotaExceededError: The quota has been exceeded
```

**Diagnosis:**
Repository size exceeds browser storage quota.

**Solutions:**

1. **Check current storage usage:**
```bash
# In browser console:
navigator.storage.estimate().then(est =>
  console.log(`Used: ${est.usage / 1024 / 1024}MB / ${est.quota / 1024 / 1024}MB`)
)
```

2. **Clear old data:**
```bash
# Remove old cloned repos
rm -rf /tmp/old-repo-*
rm -rf /old-projects/*
```

3. **Use shallow clone:**
```bash
git clone --depth 1 https://github.com/user/repo
```

4. **Use sparse checkout:**
```bash
git clone --filter=blob:none --sparse https://github.com/user/repo
cd repo
git sparse-checkout set src/  # Only checkout src directory
```

5. **Request persistent storage** (in browser console):
```javascript
navigator.storage.persist().then(granted =>
  console.log('Persistent storage:', granted)
)
```

---

### Issue 6: Authentication failures

**Symptom:**
```
fatal: Authentication failed for 'https://github.com/...'
```

**Diagnosis:**
Attempting to clone private repository without credentials.

**Solutions:**

1. **Use Personal Access Token (PAT):**
```bash
# Create token at: https://github.com/settings/tokens
# Use in URL:
git clone https://YOUR_TOKEN@github.com/user/private-repo
```

2. **Set up credential helper:**
```bash
git config --global credential.helper store
# Then enter credentials once
git clone https://github.com/user/private-repo
# Enter username and token when prompted
```

3. **Use environment variable:**
```bash
export GIT_AUTH_TOKEN="ghp_xxxxxxxxxxxxx"
# Then clone (if shell supports token injection)
```

4. **Verify token permissions:**
   - Token needs `repo` scope for private repos
   - Check token hasn't expired
   - Verify repository access

---

### Issue 7: "fatal: not a git repository"

**Symptom:**
```
fatal: not a git repository (or any of the parent directories): .git
```

**Diagnosis:**
Trying to run git command outside of a git repository.

**Solutions:**

1. **Verify you're in the right directory:**
```bash
pwd
ls -la
ls -la .git/  # Should show git directory
```

2. **Navigate to repository:**
```bash
cd /path/to/cloned/repo
git status  # Should work now
```

3. **Check if clone actually completed:**
```bash
ls -la /path/to/repo
# Look for .git directory
```

4. **Re-clone if .git missing:**
```bash
cd /parent/directory
rm -rf incomplete-repo
git clone https://github.com/user/repo
```

---

### Issue 8: Files missing after clone

**Symptom:**
```
# Clone appears successful but files are missing
git clone https://github.com/user/repo
cd repo
ls
# Shows no files or only some files
```

**Diagnosis:**
Partial clone, checkout issues, or VFS sync problem.

**Solutions:**

1. **Check git status:**
```bash
cd repo
git status
git log --oneline
ls -la .git/
```

2. **Force checkout:**
```bash
git checkout -f main  # or master
```

3. **Check actual file count:**
```bash
find . -type f | wc -l
# Compare with GitHub's file count
```

4. **Re-clone with verification:**
```bash
cd /parent
rm -rf repo
git clone https://github.com/user/repo
cd repo
git fsck  # Verify repository integrity
```

5. **Check for submodules:**
```bash
ls -la .gitmodules
git submodule update --init --recursive
```

---

## Testing Strategy

### Step 1: Verify Basic Functionality
```bash
# Create test directory
mkdir /tmp/git-test-$(date +%s)
cd /tmp/git-test-*

# Test init
git init
echo "test" > file.txt
git add file.txt
git config user.name "Test"
git config user.email "test@example.com"
git commit -m "test"
git log

# If all work, basic git is functional
```

### Step 2: Test Network Clone
```bash
# Test with tiny public repo
cd /tmp
git clone https://github.com/sindresorhus/is

# Check results
cd is
ls -la
git status
git log --oneline
```

### Step 3: Test Medium Clone
```bash
# Only if Step 2 succeeded
cd /tmp
git clone https://github.com/chalk/chalk
cd chalk
ls -la
```

### Step 4: Test Authenticated Clone
```bash
# With your PAT
git clone https://YOUR_TOKEN@github.com/your-username/private-repo
```

---

## Alternative Approaches

If git clone fundamentally doesn't work, use these alternatives:

### Option 1: GitHub API Download
```bash
# Download and extract tarball
cd /desired/location
curl -L https://github.com/user/repo/archive/refs/heads/main.tar.gz -o repo.tar.gz
tar -xzf repo.tar.gz
mv repo-main repo
rm repo.tar.gz
```

**Pros:** Reliable, no git needed
**Cons:** Not a git repository, can't use git commands

### Option 2: GitHub API + Manual .git
```bash
# Download via API and create minimal git structure
# (Complex - requires script)
```

### Option 3: Use GitHub's Raw Content API
```javascript
// Fetch individual files via API
const response = await fetch(
  'https://api.github.com/repos/user/repo/contents/path'
)
const files = await response.json()
// Download each file
```

**Pros:** Fine-grained control
**Cons:** Slow for large repos, rate limited

---

## Performance Optimization

### For Large Repositories

1. **Shallow clone:**
```bash
git clone --depth 1 https://github.com/user/repo
```

2. **Single branch:**
```bash
git clone --single-branch --branch main https://github.com/user/repo
```

3. **Sparse checkout:**
```bash
git clone --filter=blob:none --sparse https://github.com/user/repo
cd repo
git sparse-checkout set src/ docs/
```

4. **Partial clone:**
```bash
git clone --filter=blob:limit=1m https://github.com/user/repo
# Only downloads objects < 1MB
```

### For Better Speed

1. **Use shallow clones by default**
2. **Clone only needed branches**
3. **Use caching** (if implementation supports it)
4. **Parallel downloads** (if using custom implementation)

---

## Debug Mode

Enable verbose output to see what's happening:

```bash
# Git verbose mode
GIT_TRACE=1 git clone https://github.com/user/repo
GIT_CURL_VERBOSE=1 git clone https://github.com/user/repo

# Or in Spirit/Claude context
export GIT_TRACE=1
export GIT_CURL_VERBOSE=1
spirit "clone the repository"
```

---

## Reporting Issues

When filing an issue, include:

1. **Exact command run:**
```bash
git clone https://github.com/user/repo
```

2. **Complete error output:**
```
[Full error message and stack trace]
```

3. **Diagnostic info:**
```bash
git --version
pwd
df -h
env | grep GIT
```

4. **Repository details:**
   - URL
   - Size (approximate)
   - Public/private
   - Special characteristics

5. **What you've tried:**
   - Different repos
   - Different directories
   - Workarounds attempted

Use the issue template: `.github/ISSUE_TEMPLATE/git-clone-issue.md`

---

## Emergency Workarounds

### If git is completely broken:

1. **Use direct file download:**
```bash
# GitHub provides download links
curl -L "https://github.com/user/repo/archive/refs/heads/main.zip" -o repo.zip
unzip repo.zip
```

2. **Ask user to provide files:**
   - "Please zip and share the files"
   - Manual upload to VFS

3. **Use snippets for small code:**
   - For single files, paste content directly
   - Create files manually

---

## Success Checklist

After resolving git issues, verify:

- [ ] `git --version` shows version
- [ ] `git init` creates repository
- [ ] `git clone https://github.com/sindresorhus/is` succeeds
- [ ] Cloned files are accessible
- [ ] `git status` works in cloned repo
- [ ] `git log` shows commits
- [ ] Can navigate and read cloned files
- [ ] Storage usage is reasonable
- [ ] Performance is acceptable (<30s for small repos)

---

## Resources

- **Main Issue Tracker:** `GIT_CLONE_ISSUES.md`
- **Action Plan:** `GIT_CLONE_ACTION_PLAN.md`
- **Spirit Architecture:** `README.md`
- **Provider Interfaces:** `src/providers/types.ts`
- **Bash Tool:** `src/tools/bash.ts`

---

**Last Updated:** 2026-01-29
**Maintainer:** Spirit Development Team
