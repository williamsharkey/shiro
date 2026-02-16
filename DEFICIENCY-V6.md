# Shiro Deficiency Report v6

## Testing Date: 2026-02-16
## Build: #571

---

## CRITICAL: Shell script multi-line control structures broken

**Impact: HIGH** — Blocks running any non-trivial shell script

Shell scripts with newline-separated control structures (`for/do/done`, `while/do/done`, `if/then/fi`) are parsed line-by-line instead of as compound statements. Each line runs independently, producing errors like `done: can only be used to close a for/while/until loop`.

**Works (inline `;` style):**
```bash
for x in a b c; do echo $x; done        # OK
while [ $i -lt 3 ]; do echo $i; done    # OK
if [ -f foo ]; then echo yes; fi         # OK
```

**Fails (multi-line / script style):**
```bash
#!/bin/sh
for x in a b c
do
  echo "$x"
done
# ERROR: for: syntax error, do: can only be used as part of...
```

**Root cause:** The script executor (likely in `shell.ts` or script execution path) splits on newlines and executes each line as a separate command instead of collecting multi-line compound statements.

**Note:** This only affects script files (`.sh`) and multi-line heredoc-style input. Interactive one-liners with `;` work correctly.

---

## HIGH: `if` condition with variable expansion gives wrong result

**Impact: HIGH** — Conditional logic unreliable

```bash
export x=5; if [ "$x" -gt 3 ]; then echo "greater"; else echo "less"; fi
# OUTPUT: less (WRONG — should be "greater")

# But this works:
if [ 5 -gt 3 ]; then echo "greater"; else echo "less"; fi
# OUTPUT: greater (correct)

# And this works:
x=5; [ "$x" -gt 3 ] && echo "gt" || echo "lt"
# OUTPUT: gt (correct)
```

Variable expansion inside `if [ ... ]` conditions appears to fail when combined with `elif`/`else` branches. The `test`/`[` command works correctly outside of `if` constructs. The bug is specifically in how the `if` statement evaluates its condition when variables are involved.

---

## MEDIUM: `xargs -I{}` doesn't split on newlines

**Impact: MEDIUM** — Common Unix pattern broken

```bash
printf "one\ntwo\nthree\n" | xargs -I{} echo "item: {}"
# OUTPUT: item: onentwonthree    (WRONG — single invocation with literal \n)
# EXPECTED: item: one\n item: two\n item: three
```

`xargs` without `-I` works (splits on whitespace). The `-I{}` mode receives the entire input as one blob instead of splitting on newlines first. The pipe delivers newlines correctly (`wc -l` counts 3 lines from the same pipe).

---

## MEDIUM: Shell script `$@` iteration only yields last arg

**Impact: MEDIUM** — Script argument handling broken

```bash
#!/bin/sh
for x in "$@"; do
  echo "arg: $x"
done
# Running with: ./script.sh one two three
# OUTPUT: arg: three (only last arg)
# EXPECTED: arg: one\n arg: two\n arg: three
```

Related to the multi-line script parsing bug — only the last argument is processed because the `for` loop isn't parsed as a compound statement.

---

## LOW: `git log --all` doesn't show all branches

**Impact: LOW** — Minor git feature gap

```bash
git branch test-branch && git checkout test-branch && git commit ...
git log --oneline --all
# Only shows commits from current branch, not all branches
```

---

## LOW: Missing commands

- `rev` — reverse string (low priority)
- `yes` — repeat string (low priority)

---

## WORKING WELL (verified)

| Feature | Status |
|---------|--------|
| Shell basics (pipes, redirects, &&, \|\|, ;) | PASS |
| Quoting (single, double, escape, nested) | PASS |
| Subshells `(cmd)` with variable isolation | PASS |
| Environment variables, ${#}, ${:-}, $? | PASS |
| Command substitution `$(...)`, nested | PASS |
| Arithmetic `$((...))`, +, -, *, /, %, ** | PASS |
| Brace expansion `{a,b,c}`, `{1..5}` | PASS |
| Here-strings `<<<` and heredocs `<<EOF` | PASS |
| Inline for/while/if/case/functions | PASS |
| Coreutils (ls, cat, cp, mv, rm, mkdir, find, grep, wc, head, tail, sort, uniq, cut, tr, tee, diff, touch, stat, chmod, basename, dirname, realpath, mktemp, readlink) | PASS |
| `printf` with escape sequences | PASS |
| `echo -e` with escape sequences | PASS |
| `sed` substitution and delete | PASS |
| `rg` (ripgrep) with -n, -c flags | PASS |
| `git` (init, add, commit, log, diff, branch, checkout, stash, status) | PASS |
| `node` execution and fs shims | PASS |
| `curl` (CORS-friendly URLs) | PASS |
| `npm list` | PASS |
| Symlinks (ln -s, readlink) | PASS |
| `serve` with `--split` | PASS |
| `page` (title, text, html, attr, input, eval, click) | PASS |
| Page virtual navigation (extensionless HTML, hash stripping) | PASS |
| MCP tools (exec, read, write, list, eval) | PASS |
| `remote start` (instant output, clipboard copy) | PASS |
| Remote auto-reconnect on page reload | PASS |
| Glob patterns in ls (`*.txt`, `**/*.txt`) | PASS |
| Stderr redirect `2>` | PASS |
| `date` with format strings | PASS |
| `cp -r` recursive copy | PASS |
| `rm -rf` recursive delete | PASS |

---

## Priority Order for Fixes

1. **Shell script multi-line parsing** — CRITICAL, blocks all non-trivial scripts
2. **`if` variable expansion bug** — HIGH, conditional logic unreliable
3. **`xargs -I{}` newline splitting** — MEDIUM, common pattern
4. **`$@` iteration in scripts** — MEDIUM (likely fixed by #1)
5. **`git log --all`** — LOW
6. **Missing commands (rev, yes)** — LOW
