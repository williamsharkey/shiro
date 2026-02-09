# Terminal Capabilities Matrix
**Generated:** 2026-01-30T03:46:31.860Z
**Terminals Tested:** FOAM-windwalker, SHIRO-windwalker

## Summary

| Terminal | Total Tests | ✅ Pass | ❌ Fail | ⚠️ Error | 🚫 No Shell | Pass Rate |
|----------|-------------|---------|---------|----------|-------------|----------|
| **FOAM** | 65 | 49 | 16 | 0 | 0 | 75.4% |
| **SHIRO** | 65 | 0 | 0 | 0 | 65 | 0.0% |

## Detailed Results

### File Operations

| Capability | Command | FOAM | SHIRO | Notes |
|------------|---------|------|-------|-------|
| List files | `ls /tmp` | ✅ | 🚫 | SHIRO: No shell API |
| List files long | `ls -la /tmp` | ✅ | 🚫 | SHIRO: No shell API |
| Read file | `cat /etc/hostname 2>/dev/null \|\| echo test` | ✅ | 🚫 | SHIRO: No shell API |
| Create directory | `mkdir -p /tmp/testdir_$$ && ls -d /tmp/testdir_$$` | ✅ | 🚫 | SHIRO: No shell API |
| Write file (echo) | `echo test123` | ✅ | 🚫 | SHIRO: No shell API |
| Write file (redirect) | `echo "testdata" > /tmp/test_$$.txt 2>&1` | ✅ | 🚫 | SHIRO: No shell API |
| Read written file | `cat /tmp/test_$$.txt 2>&1` | ❌ | 🚫 | FOAM: Exit 1, SHIRO: No shell API |
| Append to file | `echo "line2" >> /tmp/test_$$.txt 2>&1` | ✅ | 🚫 | SHIRO: No shell API |
| Count lines | `echo -e "line1\nline2\nline3" \| wc -l` | ✅ | 🚫 | SHIRO: No shell API |
| Find files | `ls /tmp 2>&1` | ✅ | 🚫 | SHIRO: No shell API |
| Copy file | `echo data > /tmp/src_$$ && cp /tmp/src_$$ /tmp/dst...` | ✅ | 🚫 | SHIRO: No shell API |
| Move file | `echo data > /tmp/old_$$ && mv /tmp/old_$$ /tmp/new...` | ✅ | 🚫 | SHIRO: No shell API |
| Remove file | `touch /tmp/del_$$ 2>&1 ; rm /tmp/del_$$ 2>&1; echo...` | ✅ | 🚫 | SHIRO: No shell API |

### Git Operations

| Capability | Command | FOAM | SHIRO | Notes |
|------------|---------|------|-------|-------|
| Git version | `git --version` | ❌ | 🚫 | FOAM: Exit 1, SHIRO: No shell API |
| Git init | `cd /tmp && rm -rf gittest_$$ && mkdir gittest_$$ &...` | ❌ | 🚫 | FOAM: Exit 1, SHIRO: No shell API |
| Git config | `cd /tmp/gittest_* 2>/dev/null && git config user.n...` | ❌ | 🚫 | FOAM: Exit 1, SHIRO: No shell API |
| Git status | `cd /tmp/gittest_* 2>/dev/null && git status` | ❌ | 🚫 | FOAM: Exit 1, SHIRO: No shell API |
| Git add | `cd /tmp/gittest_* 2>/dev/null && echo test > file....` | ❌ | 🚫 | FOAM: Exit 1, SHIRO: No shell API |
| Git commit | `cd /tmp/gittest_* 2>/dev/null && git commit -m "te...` | ❌ | 🚫 | FOAM: Exit 1, SHIRO: No shell API |
| Git log | `cd /tmp/gittest_* 2>/dev/null && git log --oneline...` | ✅ | 🚫 | SHIRO: No shell API |
| Git diff | `cd /tmp/gittest_* 2>/dev/null && echo change > fil...` | ✅ | 🚫 | SHIRO: No shell API |

### NPM & Node

| Capability | Command | FOAM | SHIRO | Notes |
|------------|---------|------|-------|-------|
| Node version | `node --version` | ❌ | 🚫 | FOAM: Exit 1, SHIRO: No shell API |
| Node execute | `node -e "console.log(1+1)"` | ✅ | 🚫 | SHIRO: No shell API |
| NPM version | `npm --version` | ✅ | 🚫 | SHIRO: No shell API |
| NPX available | `which npx \|\| echo not-found` | ✅ | 🚫 | SHIRO: No shell API |

### Pipes & Redirection

| Capability | Command | FOAM | SHIRO | Notes |
|------------|---------|------|-------|-------|
| Simple pipe | `echo hello \| cat` | ✅ | 🚫 | SHIRO: No shell API |
| Multi pipe | `echo "a\nb\nc" \| grep b \| cat` | ✅ | 🚫 | SHIRO: No shell API |
| Pipe to wc | `echo test \| wc -c` | ✅ | 🚫 | SHIRO: No shell API |
| Pipe chain | `echo "line1\nline2" \| cat \| wc -l` | ✅ | 🚫 | SHIRO: No shell API |
| Stdout redirect | `echo test > /tmp/redir_$$ 2>&1; echo $?` | ✅ | 🚫 | SHIRO: No shell API |
| Stderr redirect | `ls /nonexistent 2>/dev/null; echo ok` | ✅ | 🚫 | SHIRO: No shell API |
| Combined redirect | `echo test 2>&1` | ✅ | 🚫 | SHIRO: No shell API |

### Environment Variables

| Capability | Command | FOAM | SHIRO | Notes |
|------------|---------|------|-------|-------|
| Set variable | `TEST=hello; echo set` | ✅ | 🚫 | SHIRO: No shell API |
| Use variable | `TEST=world; echo $TEST` | ✅ | 🚫 | SHIRO: No shell API |
| Export variable | `export VAR=value; echo done` | ✅ | 🚫 | SHIRO: No shell API |
| Read PATH | `echo $PATH` | ✅ | 🚫 | SHIRO: No shell API |
| Read HOME | `echo $HOME` | ✅ | 🚫 | SHIRO: No shell API |
| Read PWD | `echo $PWD` | ✅ | 🚫 | SHIRO: No shell API |

### Shell Scripting

| Capability | Command | FOAM | SHIRO | Notes |
|------------|---------|------|-------|-------|
| Command substitution | `echo "Result: $(echo nested)"` | ✅ | 🚫 | SHIRO: No shell API |
| Arithmetic | `echo $((5 + 3))` | ✅ | 🚫 | SHIRO: No shell API |
| Exit code | `true; echo $?` | ✅ | 🚫 | SHIRO: No shell API |
| Logic AND | `true && echo ok` | ✅ | 🚫 | SHIRO: No shell API |
| Logic OR | `false \|\| echo ok` | ✅ | 🚫 | SHIRO: No shell API |
| If statement | `if true; then echo yes; fi` | ❌ | 🚫 | FOAM: Exit 127, SHIRO: No shell API |
| If/else | `if false; then echo no; else echo yes; fi` | ❌ | 🚫 | FOAM: Exit 127, SHIRO: No shell API |
| For loop | `for i in 1 2 3; do echo $i; done` | ❌ | 🚫 | FOAM: Exit 127, SHIRO: No shell API |
| While loop | `i=0; while [ $i -lt 2 ]; do echo $i; i=$((i+1)); d...` | ❌ | 🚫 | FOAM: Exit 127, SHIRO: No shell API |
| Function def | `func() { echo "hi"; }; func` | ❌ | 🚫 | FOAM: Exit 127, SHIRO: No shell API |
| Source script | `echo "VAR=sourced" > /tmp/src.sh; . /tmp/src.sh 2>...` | ✅ | 🚫 | SHIRO: No shell API |

### Text Processing

| Capability | Command | FOAM | SHIRO | Notes |
|------------|---------|------|-------|-------|
| grep search | `echo "test\nline\ntest" \| grep test` | ✅ | 🚫 | SHIRO: No shell API |
| grep count | `echo "a\nb\na" \| grep -c a` | ❌ | 🚫 | FOAM: Exit 0, SHIRO: No shell API |
| sed replace | `echo hello \| sed "s/hello/world/"` | ✅ | 🚫 | SHIRO: No shell API |
| cut fields | `echo "a:b:c" \| cut -d: -f2` | ✅ | 🚫 | SHIRO: No shell API |
| wc lines | `echo -e "a\nb\nc" \| wc -l` | ❌ | 🚫 | FOAM: Exit 0, SHIRO: No shell API |
| wc words | `echo "one two three" \| wc -w` | ✅ | 🚫 | SHIRO: No shell API |
| head lines | `echo -e "1\n2\n3\n4\n5" \| head -n 2` | ✅ | 🚫 | SHIRO: No shell API |
| tail lines | `echo -e "1\n2\n3\n4\n5" \| tail -n 2` | ✅ | 🚫 | SHIRO: No shell API |
| sort | `echo -e "c\na\nb" \| sort` | ✅ | 🚫 | SHIRO: No shell API |
| uniq | `echo -e "a\na\nb" \| uniq` | ✅ | 🚫 | SHIRO: No shell API |

### Process & System

| Capability | Command | FOAM | SHIRO | Notes |
|------------|---------|------|-------|-------|
| pwd | `pwd` | ✅ | 🚫 | SHIRO: No shell API |
| cd command | `cd /tmp && pwd` | ❌ | 🚫 | FOAM: Exit 1, SHIRO: No shell API |
| whoami | `whoami \|\| echo user` | ✅ | 🚫 | SHIRO: No shell API |
| hostname | `hostname \|\| cat /etc/hostname 2>/dev/null \|\| e...` | ✅ | 🚫 | SHIRO: No shell API |
| date | `date \|\| echo date-unavailable` | ✅ | 🚫 | SHIRO: No shell API |
| which | `which ls \|\| echo /bin/ls` | ✅ | 🚫 | SHIRO: No shell API |

## Analysis

### FOAM Terminal

- **Total Capabilities Tested:** 65
- **Working:** 49 (75.4%)
- **Not Working:** 16

### SHIRO Terminal

- **Total Capabilities Tested:** 65
- **Working:** 0 (0.0%)
- **Not Working:** 0
- **Shell Missing:** 65 (100.0%)

## Critical Findings

### File Operations Issues (FOAM)

- **Read written file**: Exit 1

### Git Operations Issues (FOAM)

- **Git version**: Exit 1
- **Git init**: Exit 1
- **Git config**: Exit 1
- **Git status**: Exit 1
- **Git add**: Exit 1
- **Git commit**: Exit 1

### NPM & Node Issues (FOAM)

- **Node version**: Exit 1

### SHIRO Terminal

❌ **CRITICAL:** SHIRO terminal has no shell API (`window.__shiro` is undefined)

All 65 tests failed due to missing shell object.

## Recommendations

### Priority 1: Critical Blockers

1. **Fix file redirection in FOAM** - Write/append operations don't work
2. **Restore SHIRO shell API** - Terminal completely non-functional
3. **Fix shell scripting features** - if/then, loops, functions not supported

### For Spirit AI Deployment

⚠️ **PARTIAL** - Some capabilities work but critical features missing

**FOAM Support:** 75.4% of tested capabilities work
**SHIRO Support:** 0.0% of tested capabilities work

