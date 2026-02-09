# Git Clone Issues in Browser-Based Operating Systems

**Repository:** spirit
**Targets:** Shiro & Foam browser-based JavaScript operating systems
**Created:** 2026-01-29
**Status:** Active Investigation

---

## Executive Summary

This document tracks issues, hurdles, and solutions for implementing `git clone` functionality in browser-based operating systems (Shiro and Foam). Both systems run entirely in-browser with virtual filesystems and shell implementations, which presents unique challenges for git operations that traditionally rely on native system capabilities.

---

## Architecture Context

### Spirit's Role
- Spirit provides Claude Code agent loop for browser-based JS operating systems
- Uses OSProvider interface to abstract filesystem and shell operations
- Supports both Shiro and Foam through adapter pattern
- Bash tool executes shell commands via `provider.exec(command)`

### Current Git Support
According to `src/tools/bash.ts`:
```
Available commands include: ls, cat, head, tail, echo, mkdir, rm, cp, mv,
touch, grep, sort, uniq, wc, tee, git, cd, pwd, env, export, and more.
```

**Status:** Git is listed as available, but implementation details and limitations need verification.

---

## Critical Hurdles

### 🔴 HURDLE 1: Git Implementation in Browser Environment

**Issue:** Traditional git requires native binaries and system calls unavailable in browser JavaScript.

**Current State:**
- Unknown which git implementation is used (isomorphic-git, git-wasm, simulated git, etc.)
- Need to verify if git commands actually work in both Shiro and Foam
- Unknown if `git clone` specifically is supported

**Action Items:**
1. [ ] Test basic git commands in Shiro: `git --version`, `git init`, `git status`
2. [ ] Test basic git commands in Foam: `git --version`, `git init`, `git status`
3. [ ] Attempt `git clone` with a small public repo in both environments
4. [ ] Document which git implementation each OS uses
5. [ ] Identify which git commands are supported vs. stubbed

**Priority:** 🔥 Critical - Blocking all git functionality

---

### 🔴 HURDLE 2: Network Access for Remote Operations

**Issue:** `git clone` requires HTTP/HTTPS network access to remote repositories, which may be restricted in browser contexts.

**Potential Issues:**
- CORS restrictions preventing connections to GitHub/GitLab
- Authentication token handling for private repos
- SSL/TLS certificate validation in browser context
- Rate limiting and API access

**Action Items:**
1. [ ] Test `git clone https://github.com/[small-public-repo]` in Shiro
2. [ ] Test `git clone https://github.com/[small-public-repo]` in Foam
3. [ ] Document CORS errors or network failures
4. [ ] Test authenticated clone with personal access token
5. [ ] Investigate proxy or CORS-bypass solutions
6. [ ] Consider GitHub API + isomorphic-git as alternative

**Priority:** 🔥 Critical - Required for remote repository cloning

**Potential Solutions:**
- Use GitHub API with `@octokit/rest` to fetch repository contents
- Implement isomorphic-git with custom HTTP backend
- Create proxy service for git operations
- Use GitHub's tarball download API as fallback

---

### 🟡 HURDLE 3: Virtual Filesystem Constraints

**Issue:** Git operations create complex directory structures with hidden `.git` folders, which may stress virtual filesystem implementations.

**Potential Issues:**
- File count limits in browser storage (IndexedDB, localStorage)
- Memory constraints for large repositories
- Performance of recursive operations on VFS
- Support for symlinks and special git files
- File permission handling (.git/hooks, executable bits)

**Action Items:**
1. [ ] Clone a small repo and inspect `.git` folder structure
2. [ ] Measure VFS performance with 100+ files from git clone
3. [ ] Test if VFS supports all file types git creates
4. [ ] Verify symlink support in both Shiro and Foam
5. [ ] Test repository with binary files (images, etc.)
6. [ ] Document VFS size/file count limits

**Priority:** 🟡 High - May cause failures on larger repos

**Potential Solutions:**
- Implement shallow clones (`--depth 1`)
- Sparse checkout for large repos
- Compress git objects in browser storage
- Lazy-load repository contents on demand

---

### 🟡 HURDLE 4: Shell Command Integration

**Issue:** Git commands need proper shell environment (working directory, environment variables, stdin/stdout handling).

**Current State:**
- Spirit's bash tool uses `provider.exec(command)`
- Shell result includes stdout, stderr, exitCode
- Working directory managed through provider.getCwd/setCwd
- Environment variables available through provider.getEnv()

**Potential Issues:**
- Interactive git commands (prompts for credentials)
- Progress output during clone operations
- Git config handling (~/.gitconfig location)
- SSH key management for git+ssh:// URLs
- PATH resolution for git subcommands

**Action Items:**
1. [ ] Test git config persistence: `git config --global user.name "Test"`
2. [ ] Verify git respects VFS working directory
3. [ ] Test git clone progress output rendering
4. [ ] Document where git config files are stored in VFS
5. [ ] Test git operations that require user input
6. [ ] Verify environment variable access for git

**Priority:** 🟡 High - Required for proper git integration

**Potential Solutions:**
- Pre-configure git with sensible defaults
- Use `GIT_CONFIG` env var to point to VFS location
- Implement credential helper for browser storage
- Strip interactive prompts or provide automated responses

---

### 🟢 HURDLE 5: Claude Agent Integration

**Issue:** Claude needs clear feedback and error handling for git operations through Spirit's tool interface.

**Current State:**
- Bash tool returns stdout, stderr, and exitCode
- Long-running operations may timeout
- No built-in progress indication for slow clones

**Action Items:**
1. [ ] Test git clone of 50MB+ repo to verify timeout handling
2. [ ] Document expected output format for successful clone
3. [ ] Create helper prompts for common git clone failures
4. [ ] Add git-specific error detection to bash tool
5. [ ] Consider timeout extension for clone operations
6. [ ] Test abort functionality (Ctrl+C) during clone

**Priority:** 🟢 Medium - Improves UX but not blocking

**Potential Solutions:**
- Add timeout parameter to bash tool for long operations
- Stream progress updates to terminal during clone
- Provide git-specific error messages and suggestions
- Cache cloned repos to speed up subsequent operations

---

### 🟢 HURDLE 6: Repository Size and Performance

**Issue:** Large repositories may exceed browser storage quotas or cause performance issues.

**Constraints:**
- IndexedDB quota typically 50MB-500MB per origin
- localStorage quota typically 5-10MB
- Memory limits in browser tab (varies by browser/device)
- No native git pack file handling in browser

**Action Items:**
1. [ ] Document storage quota for Shiro and Foam
2. [ ] Test clone of 10MB, 50MB, 100MB repositories
3. [ ] Measure time to clone repos of various sizes
4. [ ] Implement storage quota checking before clone
5. [ ] Create size estimation tool for remote repos
6. [ ] Test garbage collection and cleanup

**Priority:** 🟢 Medium - Important for production use

**Potential Solutions:**
- Implement `git clone --depth 1` by default
- Warn users before cloning large repos
- Provide `git clone --filter=blob:none` for blobless clones
- Implement automatic cleanup of old clones
- Use compression for git objects in storage

---

## Testing Checklist

### Shiro Environment
- [ ] Verify git binary/implementation presence
- [ ] Test `git init` in empty directory
- [ ] Test `git clone` of tiny repo (<1MB)
- [ ] Test `git clone` of small repo (1-10MB)
- [ ] Test `git clone` of medium repo (10-50MB)
- [ ] Test authenticated clone (private repo)
- [ ] Test git operations after clone (status, log, diff)
- [ ] Test network error handling
- [ ] Test storage quota exceeded scenario
- [ ] Test concurrent git operations

### Foam Environment
- [ ] Verify git binary/implementation presence
- [ ] Test `git init` in empty directory
- [ ] Test `git clone` of tiny repo (<1MB)
- [ ] Test `git clone` of small repo (1-10MB)
- [ ] Test `git clone` of medium repo (10-50MB)
- [ ] Test authenticated clone (private repo)
- [ ] Test git operations after clone (status, log, diff)
- [ ] Test network error handling
- [ ] Test storage quota exceeded scenario
- [ ] Test concurrent git operations

### Cross-Platform
- [ ] Compare git capabilities between Shiro and Foam
- [ ] Document API differences requiring provider adaptation
- [ ] Verify Spirit's OSProvider abstracts git differences
- [ ] Test same repos in both environments
- [ ] Document platform-specific workarounds

---

## Recommended Test Repositories

### Tiny (< 1MB)
- `https://github.com/sindresorhus/is` - 400KB, 50 files
- `https://github.com/jonschlinkert/kind-of` - 200KB, 30 files

### Small (1-10MB)
- `https://github.com/chalk/chalk` - 2MB, 100 files
- `https://github.com/expressjs/express` - 5MB, 200 files

### Medium (10-50MB)
- `https://github.com/webpack/webpack` - 25MB, 500 files
- `https://github.com/facebook/react` - 40MB, 1000 files

**Note:** Start with tiny repos to validate basic functionality before attempting larger clones.

---

## Success Criteria

A git clone implementation is considered successful when:

1. ✅ `git clone <public-repo>` completes without errors
2. ✅ Cloned files appear in virtual filesystem
3. ✅ `.git` directory is properly structured
4. ✅ `git status` works in cloned directory
5. ✅ `git log` shows commit history
6. ✅ File contents match remote repository
7. ✅ Claude can navigate and edit cloned files
8. ✅ Error messages are clear and actionable
9. ✅ Performance is acceptable (<30s for small repos)
10. ✅ Storage usage is reasonable and documented

---

## Next Steps

### Immediate Actions (Phase 1: Discovery)
1. Test basic git availability in both Shiro and Foam
2. Attempt simple `git clone` of tiny repo
3. Document specific errors and failure modes
4. Identify which git implementation is in use

### Short-term (Phase 2: Implementation)
1. Fix critical blockers preventing any git clone
2. Implement network access or proxy if needed
3. Configure git environment properly in both OSes
4. Add error handling and user feedback

### Long-term (Phase 3: Optimization)
1. Optimize for larger repositories
2. Implement caching and performance improvements
3. Add advanced git features (branches, submodules)
4. Create comprehensive documentation

---

## Related Files

- `src/tools/bash.ts` - Shell command execution including git
- `src/providers/shiro-provider.ts` - Shiro OS adapter
- `src/providers/foam-provider.ts` - Foam OS adapter
- `src/providers/types.ts` - OSProvider interface definition
- `README.md` - Spirit architecture overview
- `CLAUDE.md` - AI assistant guide

---

## Issue Tracking

Issues should be tracked in this document with status updates:

**Format:**
```
### Issue #N: [Title]
Status: 🔴 Open | 🟡 In Progress | 🟢 Resolved | ⚫ Blocked
Priority: Critical | High | Medium | Low
Assignee: [name or "unassigned"]
Updated: YYYY-MM-DD

[Description]

**Resolution:** [When closed, describe solution]
```

---

## Appendix: Git in Browser Implementations

### Option 1: isomorphic-git
- Pure JavaScript implementation
- Full git functionality in browser
- Network support via fetch API
- Good GitHub integration
- **Pros:** Most complete, well-maintained
- **Cons:** Large bundle size (~200KB), slower than native

### Option 2: git-wasm
- WebAssembly compilation of git
- Near-native performance
- Full command compatibility
- **Pros:** Fast, complete feature set
- **Cons:** Large binary (~5MB), complex integration

### Option 3: Simulated/Minimal Git
- Subset of git commands
- Custom implementation for browser constraints
- **Pros:** Small, tailored to needs
- **Cons:** Limited functionality, maintenance burden

### Option 4: GitHub API + Custom
- Use GitHub API to fetch repository
- Simulate git locally
- **Pros:** Reliable, avoids git complexity
- **Cons:** GitHub-only, not true git

**Recommendation:** Start with testing existing implementation, then consider isomorphic-git if replacement needed.

---

**Document Status:** Active
**Last Updated:** 2026-01-29
**Next Review:** After initial testing phase completes
