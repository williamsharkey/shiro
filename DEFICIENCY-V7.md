# Shiro Deficiency Report v7

## Testing Date: 2026-02-16
## Build: #583
## Tested via: Claude Code MCP → Shiro WebRTC remote

---

## Summary

Comprehensive testing of Claude Code tooling in Shiro after v6 fixes. All v6 fixes confirmed working after browser reload. Found and fixed 4 additional issues. Remaining known gaps documented below.

## Fixes Applied in This Session

### Fix 1: `sh` piped stdin compound statements (HIGH)
**File: `src/commands/coreutils.ts`**

The `sh` command's piped stdin path (`echo "script" | sh`) was still executing line-by-line. Now delegates to `executeShellScript()` for proper compound statement accumulation.

### Fix 2: `tr` escape sequences (MEDIUM)
**File: `fluffycoreutils/src/commands/tr.ts`**

`tr ':' '\n'` failed because `expandSet()` didn't process escape sequences like `\n`, `\t`, `\\`. Added escape handling before character class/range expansion.

### Fix 3: `ln -sf` combined flags (MEDIUM)
**File: `src/commands/coreutils.ts`**

`ln -sf target link` failed because the flag parser only matched `-s` exactly. Now parses combined flags character-by-character and supports `-f` (force unlink before creating).

### Fix 4: `realpath` symlink resolution (LOW)
**File: `fluffycoreutils/src/commands/realpath.ts`**

`realpath /tmp/link` returned the symlink path instead of the target. Now follows symlinks up to 20 levels deep using `readlink`.

---

## Remaining Known Gaps (Not Fixed)

### 1. Bash arrays not supported (LOW)
`arr=(a b c); echo ${arr[0]}` outputs literal `${arr[0]}`. Array variable expansion (`${arr[N]}`, `${#arr[@]}`) is not implemented in `expandVars`.

### 2. `trap` silently ignored (LOW)
`trap "echo trapped" EXIT` produces no output and no error. Signal trap handling not implemented.

### 3. Subshell `()` in pipe context (LOW)
`(echo a; echo b) | grep a` fails with "command not found: (echo". The parser doesn't recognize subshell groups at the start of a pipeline segment.

### 4. MCP JSON `\n` in commands (QUIRK — not a Shiro bug)
When Claude Code sends `echo -e "one\ntwo"` through MCP, the `\n` is JSON-decoded as a real newline before the shell sees it. So `echo -e` doesn't find backslash-n sequences to convert. Workaround: use `\\n` (which JSON-decodes to backslash-n) or use literal newlines in heredocs. This is inherent to the MCP JSON transport, not a Shiro deficiency.

---

## Test Results

### Confirmed Working
- Multi-line `for/do/done`, `while/do/done`, `if/then/fi` in shell scripts
- `if [ "$x" -gt 3 ]` with quoted variables
- `cat file | xargs -I{}` newline splitting
- `git log --oneline --all` across branches
- `rev`, `yes` commands
- Pipes, redirects, heredocs, here-strings
- Command substitution `$()`, nested subshells
- Arithmetic `$(())`
- Variable expansion `${VAR:-default}`, `${VAR:=assign}`
- Functions: `greet() { echo "Hello, $1!"; }`
- `case/esac` statements
- `grep -i -v -n -c -l -r`, `rg`, `find -name -type`
- `sort`, `uniq -c`, `wc -l -w -c`
- `sed` substitution, line addressing
- `awk` with field separators
- `basename`, `dirname`, `mktemp`, `stat`, `chmod`, `touch`
- `tee`, `head`, `tail -n +N`
- `tr` with ranges, `-d`, `-s` flags
- `tar czf`, `od -c`
- Backtick substitution, `read` command
