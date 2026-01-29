# Git Clone Action Plan - Clearing All Hurdles

**Target:** Enable reliable `git clone` in Shiro and Foam browser OSes
**Timeline:** Phased approach - Discovery → Fix → Optimize
**Owner:** Spirit development team

---

## Phase 1: Discovery & Diagnosis (Current Phase)

### Objective
Understand exactly what works, what doesn't, and why.

### Tasks

#### Task 1.1: Test Git Availability in Shiro
**Command sequence:**
```bash
# Test in Shiro terminal
git --version
git help
git init /tmp/test-repo
cd /tmp/test-repo
git status
ls -la .git/
```

**Expected outputs:**
- ✅ Git version information
- ✅ Help text displays
- ✅ Repository initialized
- ✅ `.git` directory created with standard structure

**If fails:** Document specific error message and move to contingency plan.

---

#### Task 1.2: Test Git Availability in Foam
**Command sequence:**
```bash
# Test in Foam terminal
git --version
git help
git init /tmp/test-repo
cd /tmp/test-repo
git status
ls -la .git/
```

**Expected outputs:**
- ✅ Git version information
- ✅ Help text displays
- ✅ Repository initialized
- ✅ `.git` directory created with standard structure

**If fails:** Document specific error message and move to contingency plan.

---

#### Task 1.3: Test Basic Clone in Shiro
**Command sequence:**
```bash
# Test with smallest possible repo
cd /tmp
git clone https://github.com/sindresorhus/is
cd is
ls -la
git log --oneline -n 5
git status
```

**Success indicators:**
- ✅ Clone completes without error
- ✅ Files appear in directory
- ✅ Git log shows commits
- ✅ Git status shows clean working tree

**Failure modes to document:**
- Network errors (CORS, connection refused)
- Authentication errors
- Filesystem errors
- Timeout errors
- Unknown command errors

---

#### Task 1.4: Test Basic Clone in Foam
**Command sequence:**
```bash
# Test with smallest possible repo
cd /tmp
git clone https://github.com/sindresorhus/is
cd is
ls -la
git log --oneline -n 5
git status
```

**Success indicators:**
- ✅ Clone completes without error
- ✅ Files appear in directory
- ✅ Git log shows commits
- ✅ Git status shows clean working tree

**Failure modes to document:**
- Network errors (CORS, connection refused)
- Authentication errors
- Filesystem errors
- Timeout errors
- Unknown command errors

---

#### Task 1.5: Identify Git Implementation
**Investigation steps:**

1. Check Shiro source code for git references:
```bash
# In Shiro repository
grep -r "isomorphic-git" .
grep -r "git-wasm" .
grep -r "class.*Git" src/
find . -name "*git*" -type f
```

2. Check Foam source code for git references:
```bash
# In Foam repository
grep -r "isomorphic-git" .
grep -r "git-wasm" .
grep -r "class.*Git" src/
find . -name "*git*" -type f
```

3. Check package.json dependencies in both repos
4. Check shell command implementation files

**Document findings:** Create a `GIT_IMPLEMENTATION.md` with architecture details.

---

## Phase 2: Fix Critical Blockers

### Scenario A: Git Not Implemented
**If git commands don't work at all:**

#### Solution A1: Integrate isomorphic-git
**Steps:**
1. Add to Shiro/Foam: `npm install isomorphic-git`
2. Create git command wrapper in shell
3. Implement core commands: init, clone, status, log, add, commit
4. Test with simple repository
5. Update Spirit documentation

**Estimated effort:** 2-3 days
**Risk:** Medium - isomorphic-git is well-tested

#### Solution A2: Use GitHub API Fallback
**Steps:**
1. Create `github-clone` command that uses Octokit
2. Fetch repo as tarball
3. Extract to VFS
4. Create minimal .git structure for basic operations
5. Document limitations

**Estimated effort:** 1-2 days
**Risk:** Low - but limited functionality

---

### Scenario B: Git Works But Clone Fails
**If git init works but clone fails:**

#### Blocker B1: CORS/Network Issues
**Solutions:**
1. **Proxy approach:** Create CORS proxy service
   - Deploy simple proxy server
   - Configure git HTTP transport to use proxy
   - Test with public and private repos

2. **Isomorphic-git custom HTTP:**
   ```javascript
   import git from 'isomorphic-git'
   import http from 'isomorphic-git/http/web'

   await git.clone({
     fs,
     http,
     dir: '/repo',
     url: 'https://github.com/user/repo',
     corsProxy: 'https://cors.example.com'
   })
   ```

3. **GitHub API approach:** Use GitHub's API endpoints instead
   - Get tree recursively
   - Download files individually
   - Reconstruct locally

**Implementation:** Choose based on discovery results
**Estimated effort:** 2-5 days depending on approach

---

#### Blocker B2: Authentication Issues
**Solutions:**
1. **Personal Access Token (PAT):**
   - Store in environment variable
   - Use in git clone URL: `https://${PAT}@github.com/user/repo`
   - Secure storage in browser (encrypted localStorage)

2. **OAuth flow:**
   - Implement GitHub OAuth
   - Store access token securely
   - Inject into git operations

**Implementation priority:** Start with PAT (simpler), add OAuth later
**Estimated effort:** 1-2 days

---

#### Blocker B3: Filesystem Limitations
**Solutions:**
1. **Shallow clones only:**
   ```bash
   git clone --depth 1 https://github.com/user/repo
   ```
   - Reduces `.git` directory size by ~80%
   - Sufficient for most Claude Code tasks

2. **VFS optimization:**
   - Implement compression for git objects
   - Use IndexedDB efficiently
   - Add garbage collection

3. **Size warnings:**
   - Check repo size before clone (GitHub API)
   - Warn user if > storage quota
   - Offer alternatives (sparse checkout, shallow clone)

**Estimated effort:** 3-5 days for full implementation

---

## Phase 3: Optimization & Polish

### Enhancement 1: Progress Reporting
**Implementation:**
```javascript
// Stream progress during clone
git.clone({
  ...options,
  onProgress: (event) => {
    terminal.write(`Cloning: ${event.phase} ${event.loaded}/${event.total}\r`)
  }
})
```

**Value:** Better UX for long-running clones
**Effort:** 1 day

---

### Enhancement 2: Smart Cloning
**Features:**
- Auto-detect large repos and suggest shallow clone
- Cache cloned repos (avoid re-cloning)
- Incremental fetch instead of full re-clone
- Parallel file downloads for faster clones

**Value:** Significantly faster and more efficient
**Effort:** 5-7 days

---

### Enhancement 3: Advanced Git Operations
**Commands to support:**
- `git pull` - Update existing repos
- `git checkout` - Switch branches
- `git branch` - Manage branches
- `git diff` - View changes
- `git commit` - Make commits (if needed)
- `git push` - Push changes (advanced)

**Value:** Full git workflow in browser
**Effort:** 10-15 days

---

## Phase 4: Testing & Documentation

### Test Suite
**Create automated tests for:**

1. **Basic Operations**
   - init, status, log in empty repo
   - config read/write

2. **Clone Operations**
   - Public repo clone (tiny)
   - Public repo clone (small)
   - Public repo clone (medium)
   - Private repo clone with auth
   - Clone with network failure (retry)
   - Clone with storage quota exceeded

3. **Post-Clone Operations**
   - Navigate cloned directory
   - Read cloned files
   - Edit cloned files
   - Git status after edits
   - Git diff after edits

4. **Cross-Platform**
   - Same tests in Shiro and Foam
   - Compare results
   - Document platform differences

**Effort:** 5 days
**Priority:** High - prevents regressions

---

### Documentation Updates

#### Update README.md
- Add section on git capabilities
- Document git clone usage
- List supported git commands
- Explain limitations

#### Update CLAUDE.md
- Add git operation examples
- Document common git errors
- Provide troubleshooting guide

#### Create GIT_GUIDE.md
- Complete git reference for Spirit users
- Best practices for cloning in browser
- Performance tips
- Storage management

**Effort:** 2 days

---

## Contingency Plans

### Plan C1: Minimal Git
**If full git proves too difficult:**
- Implement only: clone, status, log
- Document as "git-lite"
- Focus on read-only operations
- Warn users about limitations

**When to use:** After 2 weeks if full git blocked
**Effort:** 3 days
**Risk:** Low - but reduced functionality

---

### Plan C2: No Git, GitHub Only
**If git cannot work in browser:**
- Remove git from bash tool description
- Create separate `github clone <url>` command
- Use GitHub API exclusively
- Clear messaging about limitations

**When to use:** If git fundamentally incompatible
**Effort:** 2 days
**Risk:** Low - but disappointing for users

---

## Success Metrics

### Minimum Viable Product (MVP)
- ✅ `git clone` works for public repos < 10MB
- ✅ Cloned files accessible to Claude
- ✅ Basic git commands work (status, log)
- ✅ Clear error messages
- ✅ Works in both Shiro and Foam

### Full Success
- ✅ Git clone works for repos up to 50MB
- ✅ Authenticated clone for private repos
- ✅ Progress reporting during clone
- ✅ Smart size detection and warnings
- ✅ All basic git commands functional
- ✅ Performance < 30s for 5MB repos
- ✅ Comprehensive documentation
- ✅ Automated test coverage

---

## Resource Requirements

### Development Time
- **Phase 1 (Discovery):** 2-3 days
- **Phase 2 (Fix Blockers):** 5-10 days (varies by issue)
- **Phase 3 (Optimization):** 7-10 days
- **Phase 4 (Testing/Docs):** 7 days
- **Total:** 3-5 weeks

### External Dependencies
- CORS proxy service (if needed)
- GitHub OAuth app (for auth)
- Test repositories
- Browser testing environments

### Skills Needed
- Git internals knowledge
- Browser storage APIs (IndexedDB)
- Network programming (fetch, CORS)
- Shiro and Foam architecture understanding
- isomorphic-git library expertise

---

## Communication Plan

### Status Updates
**Frequency:** Daily during active development
**Format:** Update GIT_CLONE_ISSUES.md with:
- Completed tasks ✅
- Blockers encountered 🔴
- Next steps 📋
- Questions for team ❓

### Milestones
1. **Discovery Complete** - All tests run, implementation identified
2. **Basic Clone Working** - First successful clone in both OSes
3. **MVP Complete** - All MVP success criteria met
4. **Full Launch** - All optimizations done, docs complete

### Issue Reporting
**Template for discovered issues:**
```markdown
### Issue #X: [Short Title]
**Severity:** Critical | High | Medium | Low
**Platform:** Shiro | Foam | Both
**Status:** Open | In Progress | Resolved | Blocked

**Description:**
[What's wrong]

**Steps to Reproduce:**
1. [Step one]
2. [Step two]

**Expected:** [What should happen]
**Actual:** [What actually happens]

**Error Output:**
```
[paste error]
```

**Proposed Solution:**
[Ideas for fixing]

**Blockers:**
[What's preventing resolution]
```

---

## Next Immediate Steps

### Right Now (Today)
1. ✅ Create GIT_CLONE_ISSUES.md - **DONE**
2. ✅ Create GIT_CLONE_ACTION_PLAN.md - **DONE**
3. ⏭️ Test git availability in Shiro (if MCP tools available)
4. ⏭️ Test git availability in Foam (if MCP tools available)
5. ⏭️ Document findings in GIT_CLONE_ISSUES.md

### Tomorrow
1. Complete discovery phase testing
2. Identify git implementation used
3. Update action plan based on findings
4. Begin Phase 2 implementation if blockers found

### This Week
1. Complete Phase 1 and Phase 2
2. Have working basic git clone
3. Document all discovered issues
4. Create test repositories

---

**Document Owner:** Spirit Development Team
**Created:** 2026-01-29
**Status:** Active - Phase 1 in progress
**Next Review:** After discovery phase completes
