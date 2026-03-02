# CLAUDE.md - Guide for AI Assistants Working on Shiro

## Project Vision — READ THIS FIRST

The goal is a **fully functional browser-native Linux system where Claude Code (Spirit) runs with no external server**. The nimbus dashboard is just tooling — it could be thrown away. What matters is shiro becoming a real development environment: git, npm, node, editors, compilers, and Spirit all working in-browser. **There is always work to do** — if your task is done, find the next missing Linux capability and implement it.

## What is Shiro?

Shiro is a browser-native cloud OS. A Unix-like environment that runs entirely in the browser's JavaScript VM, backed by IndexedDB for persistence. No servers, no tunnels. The end goal is running Claude Code directly in the browser with first-class access to the DOM/JS VM.

## Architecture Rationale

**Why TypeScript with separate files instead of a monolithic HTML page?**

- TypeScript catches bugs before runtime
- Separate files mean an LLM can read/edit one command at a time without loading thousands of lines of context
- Vite builds it into a static bundle (`dist/`) that can be served from anywhere with no backend
- Adding new commands is just adding a file to `src/commands/` and registering it in `src/main.ts`
- Infrequently-used commands are lazy-loaded via `lazyCommand()` — zero boot cost, loaded on first use

**The `dist/` folder after `npx vite build` is a static site** — one HTML entry file + lazy-loaded JS chunks. Deploy anywhere (GitHub Pages, S3, open it locally). `npm run dev` is just for live-reload during development.

## Project Structure

```
src/
├── main.ts              # Bootstrap - registers all commands, inits FS, starts terminal
├── terminal.ts          # xterm.js integration, line editing, tab completion, key handling
├── shell.ts             # Command parser: pipes, redirects, env vars, quoting, heredocs, history
├── filesystem.ts        # IndexedDB-backed POSIX filesystem (the foundation everything uses)
├── active-terminal.ts   # Global active terminal tracking (routes mobile input to focused terminal)
├── mobile-input.ts      # Unified mobile toolbar: virtual keys, copy/paste, voice input
├── remote-panel.ts      # Draggable floating panel UI (used by remote, group)
├── server-window.ts     # macOS-style window wrapper (iframe + terminal modes)
├── window-terminal.ts   # Lightweight xterm.js wrapper for windowed processes (+ number menu detection)
├── process-table.ts     # Global process registry with PID allocation + AbortController per process
├── split-view.ts        # Docked split pane (right/bottom) for serve --split
├── hud-panel.ts         # HUD overlay panel (status bar, shortcuts, template palette link)
├── template-palette.ts  # Template definitions (9 educational lessons across 3 categories)
├── template-runner.ts   # Template execution engine (runs multi-line cmd in windowed terminal)
├── living-templates.ts  # Living template UI (palette overlay, category tabs, launch buttons)
├── file-associations.ts # Extension-to-command registry (used by `open` to pick editor/viewer)
└── commands/            # One file per command or group of related commands
    ├── index.ts          # Command/CommandContext/TerminalLike interfaces, CommandRegistry class
    ├── shell-builtins.ts # Shell builtins needing ctx.shell: cd, export, help, command, sh, bash
    ├── shiro-cmds.ts     # Shiro-specific overrides: rm, ln, uname, which, type, cut, shasum, open
    ├── flags.ts          # Shared utilities: parseArgs, readInput, readdirEntries, statEntry
    ├── unix.ts           # Barrel export of ~100 Unix command files (ls, cat, awk, xargs, etc.)
    ├── grep.ts           # grep with -i, -v, -n, -c, -l, -r flags
    ├── sed.ts            # sed with s/pattern/replace/flags and /pattern/d
    ├── git.ts            # isomorphic-git: init, add, commit, status, log, diff, clone, remote set-url
    ├── git-utils.ts      # Git helpers: unifiedDiff, resolveRevision, diffCommits, formatCommit
    ├── find.ts           # find with -name, -type filters
    ├── fetch.ts          # fetch/curl - HTTP requests from the shell
    ├── diff.ts           # diff between two files
    ├── glob.ts           # glob pattern matching
    ├── jseval.ts         # Barrel re-export for jseval/ directory
    ├── jseval/            # Node.js runtime (split from monolithic jseval.ts)
    │   ├── index.ts       # Re-exports jsEvalCmd + nodeCmd
    │   ├── js-eval-cmd.ts # js-eval: browser JS VM evaluation
    │   ├── node-cmd.ts    # node: full Node.js-like runtime with module shims
    │   ├── crypto.ts      # Sync SHA-256, SHA-1, FNV hash implementations
    │   ├── utils.ts       # ProcessExitError, formatArg
    │   └── module-transform.ts  # ES module → CommonJS transforms
    ├── npm.ts            # npm package manager: install, list, run, uninstall
    ├── build.ts          # esbuild-wasm bundler for TypeScript/JavaScript
    ├── vi.ts             # minimal vi-like modal text editor
    ├── code-editor.ts    # code: rich editor (CodeMirror 6, CDN-loaded, lazy)
    ├── monaco-editor.ts  # monaco: VS Code editor (Monaco, CDN-loaded, lazy)
    ├── rg.ts             # ripgrep-compatible search (used by Claude Code Grep tool)
    ├── remote.ts         # WebRTC remote connection for Claude Code MCP
    ├── mcp-client.ts     # MCP Streamable HTTP client (connect to external MCP servers)
    ├── group.ts          # Encrypted group networking (peer discovery via relay)
    ├── seed.ts           # Export state as snippet, blob, gif, or html
    ├── hud.ts            # HUD redraw command
    ├── spawn.ts          # Run commands in windowed terminals (+ spawnInWindow helper for templates)
    ├── title.ts          # title: set window or document title
    ├── ps.ts             # ps (list processes) and kill (terminate by PID)
    ├── html.ts           # html (render HTML in window) and img (display image)
    ├── page.ts           # page: interact with served app iframes (click, input, text, eval, etc.)
    ├── become.ts         # become/unbecome: full-screen app mode with shareable URLs
    ├── sc.ts             # sc: spawn Claude Code in a new terminal window
    ├── python.ts         # python/python3/pip via Pyodide WASM (lazy-loaded)
    ├── sqlite.ts         # sqlite3 via sql.js WASM (lazy-loaded)
    ├── wasi.ts           # wasi run <file.wasm|url> — WASI binary execution (lazy-loaded)
    ├── pkg.ts            # WASM package manager: install, search, list, remove (lazy-loaded)
    ├── x86.ts            # x86 run/info/debug — x86-64 ELF execution (lazy-loaded)
    └── *.ts              # Individual Unix commands (cat, ls, awk, xargs, head, etc.)
├── x86/                 # x86-64 emulator (Tier 3) — from-scratch TypeScript
│   ├── cpu.ts            # CPU state: 16 64-bit registers, RFLAGS, segment bases
│   ├── memory.ts         # Virtual memory: paged 4KB demand-allocation
│   ├── elf.ts            # ELF64 parser + loader (PT_LOAD segments, stack setup)
│   ├── decode.ts         # Instruction decoder: ~40 instructions, ModR/M+SIB, REX
│   ├── syscalls.ts       # Linux syscall emulation: 25+ syscalls → Shiro VFS
│   └── runtime.ts        # Top-level executor: executeElf(), debugElf(), getElfInfo()
├── wasi-runtime.ts      # WASI preview1 runtime — 37 syscalls, fd table, preloadTree, deferred ops
├── wasi-packages.ts     # WASM package registry (12 packages), IndexedDB cache, WebC extraction
├── gif-encoder.ts       # Zero-dep GIF89a encoder + SHIRO1.0 seed extractor
├── drop-handler.ts      # Drag-and-drop seed GIF import onto terminal
└── utils/
    ├── copy-utils.ts     # bufferToString (isWrapped-aware), smartCopyProcess (indent strip)
    ├── tar-utils.ts      # gzip decompression and tar extraction
    ├── semver-utils.ts   # semantic versioning and range resolution
    └── lazy-command.ts   # Lazy-loading wrapper for on-demand command imports
server.mjs                   # Unified Node.js server (proxy, signaling, relay, static)
vite-plugin-inline.ts        # Build plugin: inlines entry JS/CSS/favicon into HTML (lazy chunks stay as files)
deploy.sh                    # Build + scp + restart on DO droplet
```

## How to Add a New Command

1. Create a new `.ts` file in `src/commands/` (or add to an existing group)
2. Export a `Command` object implementing `{ name, description, exec(ctx) }`
3. Register it in `src/main.ts` — either **static** or **lazy-loaded**
4. The `CommandContext` gives you: `args`, `fs`, `cwd`, `env`, `stdin`, `stdout`, `stderr`, `shell`

**Static** (loaded at boot — for core/frequently-used commands):
```typescript
import { myCmd } from './commands/mycmd';
registerCommand(commands, myCmd, 'src/commands/mycmd.ts');
```

**Lazy-loaded** (loaded on first use — for large/infrequent commands):
```typescript
registerCommand(commands, lazyCommand('mycmd', 'Does something useful',
  () => import('./commands/mycmd').then(m => m.myCmd)), 'src/commands/mycmd.ts');
```

Use lazy-loading when: the command pulls in large dependencies (WASM runtimes, parsers), is rarely used, or adds >5KB to the entry bundle. Currently lazy-loaded: build, nano, termcast, image, seed, gh, mcp, group, jq, ed, zip/unzip, cc/gcc, python/python3/pip, sqlite3, wasi, pkg, finder, code, monaco, builder, ffmpeg, lua, play, psql, convert/magick.

Example command file:
```typescript
import { Command } from './index';

export const myCmd: Command = {
  name: 'mycmd',
  description: 'Does something useful',
  async exec(ctx) {
    ctx.stdout = 'output here\n';
    return 0; // exit code
  },
};
```

## Key Design Decisions

- **All commands are async** - filesystem ops go through IndexedDB which is async
- **Commands write to `ctx.stdout`/`ctx.stderr`** - the shell handles piping and redirects
- **The shell converts `\n` to `\r\n`** for terminal display - commands just use `\n`
- **FileSystem paths are always absolute internally** - `resolvePath(path, cwd)` handles relative paths
- **isomorphic-git uses a compatibility wrapper** - `fs.toIsomorphicGitFS()` adapts our FS to git's expected API

## Common Tasks

```bash
npm install          # Install dependencies
npm run dev          # Start dev server with hot reload
npm run build        # Build static site to dist/
npm test             # Run tests
npx tsc --noEmit     # Type-check without building
```

## Deployment

Shiro deploys to a **DigitalOcean droplet** at https://shiro.computer (`161.35.13.177`).

A single Node.js server (`server.mjs`) handles everything: static files, API proxy, OAuth callback, WebRTC signaling, and WebSocket relay. Nginx sits in front with SSL (wildcard cert for `*.shiro.computer` via certbot-dns-porkbun).

**Build output is an HTML entry file + lazy-loaded JS chunks** — entry JS/CSS/favicon inlined by `vite-plugin-inline.ts`, dynamic imports stay as separate `.js` files in `dist/assets/`. Entry: ~361KB gzipped, lazy chunks: ~43KB total (loaded on demand).

```bash
# Build and deploy to production
npm run deploy    # builds + uploads via scp + restarts server
```

### SSH Setup (required for deploy)

`deploy.sh` uses `~/.ssh/id_ed25519` to SSH/SCP to the droplet. If deploy fails with `Permission denied (publickey)`:

1. **Generate a key** (if you don't have one): `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`
2. **Add your public key to the droplet** — you need an existing authorized machine or the DO web console (cloud.digitalocean.com → Droplets → shiro → Console):
   ```bash
   # On the droplet:
   echo 'YOUR_PUBLIC_KEY_HERE' >> /root/.ssh/authorized_keys
   ```
3. **Test**: `ssh root@161.35.13.177 "echo connected"`
4. **Save credentials to Claude memory** — store the droplet IP, root password, and SSH key path in your auto memory directory (`~/.claude/projects/<project>/memory/MEMORY.md`) so future sessions can deploy without re-setup.

**Droplet credentials**: Root password and droplet ID are stored in Claude's auto memory file, not in the repo. If you're a new Claude instance, ask the user or check `~/.claude/projects/*/memory/MEMORY.md` for credentials. The DigitalOcean CLI (`doctl`) is also authenticated and can reset the root password if needed: `doctl compute droplet-action password-reset 550124232`.

## Testing

Tests live in `tests/tests/shiro-vitest/` (monorepo subdirectory).
Uses linkedom + fake-indexeddb for proper DOM polyfills in Node.js.
**1809 tests across 40 test files** — all passing.

```bash
npm test                          # Run from shiro root
# or:
cd tests && npm run test:shiro    # Run from tests/ directory
```

### Test Files

| File | Tests | What it covers |
|------|-------|----------------|
| `filesystem.test.ts` | VFS | IndexedDB-backed filesystem operations |
| `shell.test.ts` | Shell | Parsing, pipes, env vars, quoting |
| `commands.test.ts` | Coreutils | ls, cat, mkdir, rm, cp, mv, find, glob, which |
| `git.test.ts` | Git | init, add, commit, remote add/set-url/remove |
| `terminal-history.test.ts` | Terminal | History navigation, recall |
| `virtual-server.test.ts` | Express | Express shim, service worker routing |
| `node-runtime.test.ts` | Node.js | Runtime shim, interactive mode, setRawMode |
| `page.test.ts` | Page | iframe interaction (click, text, eval) |
| `claude-tools.test.ts` | **37 tests** | All Claude Code tool shim bugs (see below) |
| `claude-code-install.test.ts` | E2E | Full `npm install -g @anthropic-ai/claude-code` + run |
| `lazy-commands.test.ts` | **37 tests** | All lazy-loaded commands: lazyCommand helper, build, nano, termcast, image, gh, mcp, group, cc/gcc, python/pip, sqlite3 |
| `build-output.test.ts` | **7 tests** | Build validation: no unresolved `__VITE_PRELOAD__` markers, entry JS/CSS inlined, lazy chunks exist and are clean |
| `templates.test.ts` | **31 tests** | Template data integrity, command structure, full multi-line cmd execution through shell |
| `wasi.test.ts` | **48 tests** | WASI runtime (normPath, FD, WasiExit, WasiRT), WASM execution, packages, WebC extraction, pkg/wasi commands |
| `x86.test.ts` | **56 tests** | x86 CPU state, virtual memory, ELF64 parsing, instruction decoding, Hello World integration, syscalls |
| `shell-advanced.test.ts` | **455 tests** | All advanced shell features: extglob, arrays, arithmetic, control flow, namerefs, traps, builtins, /proc, kill |

### Claude Code Tool Shim Tests (`claude-tools.test.ts`)

Covers all 9 known bugs plus regression tests:
- **Bug 1**: Write tool — `writeFileSync` + `readFileSync` coherence
- **Bug 2**: Grep tool — `rg` command available and flag support
- **Bug 3**: Edit tool — `readFileSync`/`writeFileSync` round-trip for partial edits
- **Bug 4**: Glob tool — `statSync`/`readdirSync` recognize `fileCache` directories
- **Bug 5**: Shell parser — `||` inside quoted strings not split as shell operator
- **Bug 6**: Bash tool — `child_process.exec` sees files written by `writeFileSync`
- **Bug 7**: TaskCreate — `utimesSync` shim for proper-lockfile's sync adapter
- **Bug 8**: Git remote set-url — `deleteRemote` + `addRemote` pattern
- **Bug 9**: Env secrets — `SECRET_PATTERNS` masking in `env` output
- **Cache invalidation**: `fileCache` refresh after `execAsync` (shell → sync read coherence)
- **xargs -I**: Fluffycoreutils xargs with `-I{}` placeholder substitution
- **Overwrite coherence**: Multiple shell writes → sync reads always see latest

## Editors & File Associations

Shiro has two rich editors and a file association registry that `open` uses to pick the right one:

**Editors:**
- `code file.ts` — CodeMirror 6 editor (lighter, ~200KB from esm.sh CDN). Syntax highlighting, search, bracket matching.
- `monaco file.ts` — Monaco Editor / VS Code engine (~5MB from jsDelivr CDN). IntelliSense, type checking for JS/TS, minimap, multi-cursor.
- Both open in a server window, support Cmd+S save (postMessage → Shiro FS), sidebar file tree, tabs.

**File associations** (`src/file-associations.ts`):
- Maps file extensions to commands (e.g., `.ts` → `code`, `.png` → `img`)
- `open file.ts` looks up the association and runs the mapped command
- `open -a monaco file.ts` overrides the association
- `open https://...` opens URLs in a new browser tab
- `open src/` opens directories in `code`
- Call `setAssociation('ts', 'monaco')` programmatically to change defaults

**Key files:** `src/commands/code-editor.ts`, `src/commands/monaco-editor.ts`, `src/file-associations.ts`, `src/commands/shiro-cmds.ts` (openCmd)

## Shell Features

The shell supports:
- **Pipes**: `echo hello | grep hello`
- **Redirects**: `>`, `>>`, `<`, `2>`, `2>>`, `2>&1`, `N<` (FD redirect), `N>&-` (FD close)
- **Device files**: `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`
- **Virtual /proc**: `/proc/version`, `/proc/uptime`, `/proc/meminfo`, `/proc/cpuinfo`, `/proc/loadavg`, `/proc/self/*`
- **Compound commands**: `&&`, `||`, `;`
- **Heredocs**: `cat > file << 'DELIM'` ... `DELIM` (single-quoted = no expansion)
- **Here-strings**: `cat <<< "hello"`
- **Multi-line input**: `execute()` splits multi-line strings into statements, respecting heredoc blocks and quoted strings
- **Environment variables**: `$VAR`, `${VAR}`, `$?` (last exit code)
- **Positional parameters**: `$@`, `$*`, `$#`, `$0`-`$9`
- **Quoting**: single quotes (literal), double quotes (with var expansion), backslash escapes
- **Comments**: lines starting with `#`
- **Shell options**: `set -e` (errexit), `set -x` (xtrace), `set -o pipefail`, `set +e`/`+x`/`+o` to disable
- **Bash-style arrays**: `arr=(a b c)`, `${arr[0]}`, `${arr[@]}`, `${#arr[@]}`, `arr[N]=val`, `arr+=(d e)`, `${!arr[@]}`
- **Associative arrays**: `declare -A map`, `map[key]=val`, `${map[key]}`, `${!map[@]}`, `${#map[@]}`
- **Arithmetic**: `$((expr))` expansion, `(( expr ))` command/condition, `i++`, `i--`, `+=`, `-=`, `*=`, `/=`
- **String ops**: `${var^}`, `${var,}`, `${var^^}`, `${var,,}`, `${!ref}` indirect, `${#var}`, `${var:-default}`
- **Control structures**: if/elif/else/fi, while/until/do/done, for/in/do/done, case/esac
- **Functions**: `name() { ... }` and `function name { ... }`
- **Job control**: `cmd &` (background), `fg`, `bg`, `jobs`, `wait`
- **PIPESTATUS**: `${PIPESTATUS[@]}` array of pipeline exit codes, **FUNCNAME**: `${FUNCNAME[0]}` function name stack
- **mapfile/readarray**: `mapfile arr` reads lines into array, `mapfile -d, -s, -n` flags, `read -a arr` splits words into array
- **C-style for loops**: `for ((i=0; i<10; i++)); do ...; done` with full arithmetic
- **Array slicing**: `${arr[@]:start:len}`, `${arr[@]:start}`, negative offsets
- **break/continue/return**: `break [N]`, `continue [N]` in loops, `return [N]` from functions
- **trap**: `trap 'command' SIGNAL` for ERR/EXIT/INT, `trap` lists, `trap '' SIG` resets
- **select**: `select VAR in items; do ...; done` numbered menu construct
- **getopts**: `getopts OPTSTRING VAR [args...]` for option parsing with OPTIND/OPTARG
- **printf**: `printf FORMAT [ARGS...]` with %s, %d, %f, %x, %o, %c, width, precision, flags
- **type/command/hash**: command identification builtins
- **Arithmetic operators**: `&&`, `||`, `!`, `?:` (ternary), `&`, `|`, `^`, `~`, `<<`, `>>` with full precedence
- **alias/unalias**: `alias name=value`, `unalias name`, `unalias -a`
- **pushd/popd/dirs**: directory stack navigation
- **let**: `let "expr"` arithmetic evaluation
- **Brace expansion**: `{a,b,c}`, `{1..5}`, `{a..z}`, `{1..10..2}`, nested braces
- **Subshells**: `(commands)` runs in forked shell
- **Process substitution**: `<(cmd)`, `>(cmd)` virtual file descriptors
- **Regex matching**: `[[ string =~ pattern ]]` with `BASH_REMATCH` array
- **Test improvements**: `-s` (non-zero size), `-L`/`-h` (symlink), `-a`/`-o` logical, `<`/`>` string comparison
- **source / exec / builtin**: `source file` runs in current scope, `exec cmd`, `builtin cmd` bypasses functions
- **Shell stubs**: `ulimit`, `umask` (no-op stubs for script compatibility)
- **Array element length**: `${#arr[N]}` returns length of element at index N
- **shift**: `shift [N]` removes first N positional parameters, updates `$#` and `$@`
- **set --**: `set -- arg1 arg2 ...` sets positional parameters `$1`, `$2`, etc.
- **printf -v**: `printf -v varname FORMAT ARGS` assigns formatted output to variable
- **local scoping**: `local var=val` creates function-scoped variables that restore on return
- **read improvements**: `-d` (custom delimiter), `-n` (nchars), `-p` (prompt), `-s` (silent)
- **test -v / -R**: `-v` (variable is set), `-R` (variable is nameref)
- **Glob matching in [[ ]]**: `[[ str == *.txt ]]`, `[[ str != pattern ]]` with `*` and `?` wildcards
- **Array pattern replacement**: `${arr[@]/pat/rep}`, `${arr[@]//pat/rep}`, `${arr[@]/#pre/rep}`, `${arr[@]/%suf/rep}`
- **IFS support**: Custom Internal Field Separator for `read` word splitting, default space/tab/newline
- **${!prefix*}**: List variable names matching prefix
- **declare -i/-l/-u/-p**: Integer-only, lowercase, uppercase, and print variable attributes
- **xargs -0**: Null-delimited input support
- **${var@Q/E/U/u/L/A}**: Variable transformations (quote, escape, case, assignment form)
- **wait -n**: Wait for any background job to complete
- **jobs -p/-l**: Print PIDs only, long format
- **unset**: `unset VAR`, `unset -f FUNC`, `unset arr[N]` for arrays/assoc arrays, readonly enforcement
- **readonly**: `readonly VAR=val`, `readonly -p`, prevents reassignment and unsetting
- **$'...' ANSI-C quoting**: `$'\n'`, `$'\t'`, `$'\xHH'`, `$'\uHHHH'`, `$'\e'`, `$'\nnn'` octal
- **$(< file)**: Command substitution shorthand to read file contents directly
- **~+/~-**: Tilde expansion `~+` → `$PWD`, `~-` → `$OLDPWD`
- **export inline**: `export VAR=val`, `export -p` lists all exported variables
- **time**: `time cmd` measures execution time (real/user/sys)
- **$EPOCHSECONDS/$EPOCHREALTIME**: Unix epoch timestamp variables
- **case ;&  and ;;&**: Fallthrough (`;&`) and pattern-continue (`;;&`) in case/esac
- **caller**: `caller [N]` prints function call stack info
- **BASH_SOURCE**: Array tracking source filenames in call stack
- **${var@a}**: Variable attribute flags (r=readonly, a=array, A=assoc, n=nameref)
- **trap -p/-l**: `trap -p` print traps, `trap -p SIG` print specific, `trap -l` list signals
- **printf %b**: Escape interpretation in arguments, `%(fmt)T` date formatting
- **Negative array indexing**: `${arr[-1]}` last element, `${arr[-2]}` second-to-last
- **${arr[@]@op}**: Array element transformations (@Q quote, @U uppercase, @L lowercase)
- **shopt**: `shopt -s/-u/-p/-q` with extglob, nocaseglob, nullglob, dotglob, globstar, and more
- **Extended globbing (extglob)**: `?(pat)`, `*(pat)`, `+(pat)`, `@(pat|pat)`, `!(pat)` in `[[ ]]`, `case`, and filename expansion
- **Case conversion with pattern**: `${var^^[aeiou]}`, `${var,,[A-Z]}` — restrict conversion to matching chars
- **compgen**: `-W wordlist`, `-b` builtins, `-c` commands, `-a` aliases, `-v` variables, `-f` files, `-d` dirs, `-A action`
- **complete**: Accepts completion specs (silent registration for script compatibility)
- **disown**: `disown [jobspec]`, `-a` (all), `-r` (running) — remove jobs from job table
- **enable**: `enable -n cmd` disables a builtin, `enable cmd` re-enables, `enable -a` lists all, `enable -p` lists disabled
- **read -t TIMEOUT**: `read -t 0` checks input availability, `read -t N` times out after N seconds (exit 142)
- **read -u FD**: Read from file descriptor, with `exec N< file` redirect support
- **mapfile -C callback**: Invoke callback function every `-c quantum` lines during mapfile
- **coproc**: `coproc [NAME] command` — run command as coprocess, sets NAME array + NAME_PID
- **kill**: Actually terminates processes — supports `%N` job specs, PID lookup in process table and background jobs
- **Signal handling**: AbortController per command, Ctrl+C fires INT trap, exit code 130 on abort

## WASI Runtime (Tier 2)

Shiro has a full WASI preview1 runtime (`src/wasi-runtime.ts`) enabling real WASM binaries to run in-browser. This is Tier 2 of the three-tier architecture (Tier 1: JS commands, Tier 2: WASM+WASI, Tier 3: x86 emulation).

**Architecture:**
- 40 WASI syscall bindings: fd_read/write/seek/advise/allocate/datasync, path_open, clock_time_get, random_get, proc_exit, etc.
- File descriptor table with stdin(0), stdout(1), stderr(2), preopens(3+)
- Pre-opens map `/` and `.` (cwd) into the Shiro virtual filesystem
- `preloadTree()` recursively caches the cwd file tree (3 levels, 100 files cap) before WASM execution
- Directory listing cache (`dirCache`) for proper `fd_readdir` with dirent struct serialization
- Deferred filesystem operations (unlink, rmdir, rename) queued during execution, flushed after

**Package Manager (`pkg`):**
- 22 verified packages from Wasmer registry (cdn.wasmer.io webc containers)
- Categories: fun (cowsay, fortune, lolcat, figlet), coreutils (coreutils, grep, sed), languages (quickjs, lua, ruby, php), shells (bash, dash), tools (sqlite, viu, util-linux, openssl, wabt, brotli, uuid, qr2text, optipng)
- IndexedDB cache for downloaded WASM binaries, compiled WebAssembly.Module memory cache
- WebC container extraction: scans for WASM magic bytes, walks section headers to find module boundaries
- `pkg install <name>` writes `#!wasi-pkg <name>` stubs to `/usr/local/bin/` for PATH lookup
- Auto-install: unknown commands matching a package name are downloaded and run on the fly

**Usage:**
```bash
pkg available              # List 22 available WASM packages
pkg install cowsay         # Download and install (writes PATH stub)
cowsay hello               # Runs via PATH stub → WASM package cache
wasi run ./program.wasm    # Run any WASM+WASI binary
wasi exec cowsay "hello"   # Run package directly (auto-downloads, like npx)
```

**Key files:** `src/wasi-runtime.ts`, `src/wasi-packages.ts`, `src/commands/wasi.ts`, `src/commands/pkg.ts`

## x86-64 Emulator (Tier 3)

Shiro has a from-scratch x86-64 emulator written entirely in TypeScript. No external libraries — every instruction, every syscall, every memory operation is transparent, debuggable, moddable TypeScript.

**Architecture:**
- **CPU state** (`src/x86/cpu.ts`): 16 64-bit registers via BigInt64Array, RFLAGS with individual flag accessors (CF, ZF, SF, OF, PF, AF, DF), segment bases (FS/GS for TLS)
- **Virtual memory** (`src/x86/memory.ts`): Paged 4KB demand-allocation, little-endian read/write for 8/16/32/64-bit values, cross-page boundary handling
- **ELF64 loader** (`src/x86/elf.ts`): Parses ELF64 headers, loads PT_LOAD segments, sets up Linux ABI stack (argc/argv/envp), 16-byte aligned RSP
- **Instruction decoder** (`src/x86/decode.ts`): ~130 instructions, full ModR/M+SIB decoding, REX prefix handling, RIP-relative addressing, SSE2 packed ops
- **Linux syscalls** (`src/x86/syscalls.ts`): ~46 syscalls mapped to Shiro VFS (read, write, open, close, stat, fstat, lseek, mmap, brk, ioctl, access, dup, getpid, exit, uname, getcwd, chdir, getuid/gid, arch_prctl, clock_gettime, openat, newfstatat, writev, getrandom, fcntl, and more)

**Usage:**
```bash
./hello              # Auto-detect ELF binary, run in x86 emulator
x86 run ./hello      # Explicit execution
x86 info ./hello     # Show ELF headers (educational)
x86 debug ./hello    # Step-through with register dumps
```

**Instructions (~130):** MOV, LEA, PUSH, POP, ADD, SUB, CMP, AND, OR, XOR, TEST, SHL, SHR, SAR, JMP, Jcc (all 16 conditions), CALL, RET, SYSCALL, NOP, MOVZX, MOVSX, MOVSXD, CDQ, CQO, CDQE, SETcc, CMOVcc, IMUL, MUL, DIV, IDIV, NEG, NOT, INC, DEC, REP MOVSB, REP STOSB, LEAVE, XCHG, BSF, BSR, ADC, SBB, HLT, PAUSE, ENDBR64, PUNPCKLQDQ, PUNPCKHQDQ, PCMPEQB, PCMPGTB, PCMPEQD, PMOVMSKB, PAND, PANDN, POR, PSUBB, PADDB, PADDQ, PMINUB, PMAXUB, PSHUFD, PUNPCKLBW, PUNPCKHBW, PSLLQ, PSRLQ, PSRLDQ, PSLLDQ, MOVQ, UCOMISD, UCOMISS, and more SSE2 variants

**Key files:** `src/x86/cpu.ts`, `src/x86/memory.ts`, `src/x86/elf.ts`, `src/x86/decode.ts`, `src/x86/syscalls.ts`, `src/x86/runtime.ts`, `src/commands/x86.ts`

## Filesystem

- IndexedDB-backed with in-memory cache for performance
- POSIX-like API: stat, readdir, readFile, writeFile, mkdir, unlink, rename, symlink, chmod, glob
- Path resolution handles `.`, `..`, and `~`
- `clearCache()` method available if external DB modifications occur
- **Virtual filesystem providers** (`VirtualFSProvider` interface): `/dev` (null, zero, random, urandom) and `/proc` (version, uptime, meminfo, cpuinfo, loadavg, self/*) are dynamically generated — no IndexedDB storage
- Virtual entries appear in `ls /` and `readdir('/')` alongside real directories

## Mobile Input

On touch devices (`pointer: coarse`), a unified 2-row toolbar appears at the bottom of the screen. Implemented in `src/mobile-input.ts`, styled in `index.html`.

**Layout:**
```
Row 1: [Esc] [Tab] [Ctrl] [[] []] [{] [}]  ···spacer···  [Paste] [Mic]      [ ↑ ]
Row 2: [ - ] [ | ] [ / ]  [~] [`] [$] [&]  ···spacer···  [ Copy] [ ; ]   [←] [↓] [→]
```

- **Arrows**: Inverted-T layout — `↑` centered above `↓`, `←` and `→` flanking
- **Ctrl**: Sticky toggle (turns blue when active, next key sends Ctrl+key)
- **Paste/Copy**: Clipboard API with prompt() fallback; Copy grabs selection or last command output
- **Mic**: Voice dictation via Web Speech API; says "send"/"enter" to submit. Button changes to "Stop" while recording
- **z-index**: `2147483647` — stays above spawned windows and remote panels
- **Keyboard repositioning**: Uses `visualViewport` API to sit above the iOS keyboard
- **Active terminal routing**: Input routes to whichever terminal last received focus (main or spawned window) via `src/active-terminal.ts`. Spawned windows auto-focus on creation.
- **Number menu detection**: `WindowTerminal` scans output for numbered menu items (e.g., Claude Code theme picker) and shows tappable pill buttons at the bottom of the spawned window. Buttons send the digit + Enter. Auto-hides after 15s or on input.

## Monorepo Subdirectories

- **`tests/`**: Test suite — vitest unit tests. Run: `npm test`
- **`shiro-mcp/`**: MCP server for connecting Claude Code to Shiro via WebRTC

## Related Projects (separate repos)

- **Foam** (williamsharkey/foam): Sister browser OS in plain JS. Compatible shell semantics
- **Nimbus** (williamsharkey/nimbus): Multi-repo orchestrator with live dashboard preview

## Remote Connection (shiro-mcp)

Shiro can be controlled remotely from Claude Code via WebRTC peer-to-peer connection.

**In Shiro browser:**
```bash
remote start    # Generate connection code, copy to clipboard
remote stop     # End remote session
remote status   # Check connection status
```

**In Claude Code:** Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "shiro": {
      "command": "shiro-mcp"
    }
  }
}
```

Then use tools: `shiro:connect`, `shiro:exec`, `shiro:read`, `shiro:write`, `shiro:list`, `shiro:eval`

**Architecture:**
- Signaling handled by `server.mjs` on the DigitalOcean droplet
- WebRTC DataChannel for direct P2P after signaling
- Connection codes have ~46 bits entropy, expire in 5 minutes

**Key files:**
- `src/commands/remote.ts` — remote command, WebRTC setup, message handlers
- `shirocode/shiro-mcp/` — MCP server package for Claude Code

## MCP Client

Shiro can connect to external MCP servers as a client using the Streamable HTTP protocol:
```bash
mcp connect <url>        # Initialize session, list available tools
mcp disconnect [url]     # Close session (or all sessions)
mcp tools [url]          # List tools
mcp call <tool> [json]   # Call a tool with JSON arguments
mcp status               # Show active connections
```

Same-origin MCP servers work without CORS issues. External servers need CORS headers.

## Group Networking

Encrypted peer discovery via WebSocket relay. Multiple Shiro instances can find each other:
```bash
group join <name> <password>   # Join an encrypted group
group leave                    # Leave current group
group peers                    # List discovered peers
group status                   # Show group info
```

Uses PBKDF2 key derivation + AES-GCM encryption. The WebSocket relay (built into `server.mjs`) never sees plaintext — it only forwards encrypted blobs.

**Key files:**
- `src/commands/mcp-client.ts` — MCP client command
- `src/commands/group.ts` — Group networking command
- `server.mjs` — Server with built-in WebSocket relay at `/channel/:id`

## Seed Command

Export Shiro state in four modes:
```bash
seed            # Clipboard JS snippet (paste in DevTools console)
seed blob       # Clipboard snippet, self-contained (CSP-safe blob URL)
seed gif        # Download .gif with embedded SHIRO1.0 seed data
seed html       # Download self-contained .html (open in any browser)
seed yolo       # Target yolo.shiro.computer subdomain
```

The blob mode inlines all JS/CSS, gzips (~70% reduction), and creates a blob URL at runtime.

**GIF mode** captures a terminal screenshot, encodes it as GIF89a with a `SHIRO1.0` Application Extension containing gzipped filesystem + localStorage. The overlay shows stats and "Drag this GIF to restore". Zero npm dependencies — pure TypeScript LZW encoder in `src/gif-encoder.ts`.

**HTML mode** inlines all resources and injects a `<script>` that decompresses and posts `shiro-seed-v2` on load.

**Drag-to-import**: Drop a seed GIF onto the terminal to detect the SHIRO1.0 extension, show a confirmation prompt, and restore state. Handled by `src/drop-handler.ts`, initialized in `main.ts`.

## Split View

Dock a served app beside or below the terminal instead of a floating window:
```bash
serve /tmp/app 3000 --split right    # Start server + open split pane
serve /tmp/app 3000 --split bottom   # Split below terminal
serve open 3000 --split right        # Open existing server in split
serve unsplit                         # Close split pane
```

- Only one split at a time (opening a new one closes the old)
- `serve stop <port>` also closes the split if it's showing that port
- The split iframe gets `data-virtual-port` so `page` command finds it
- `#shiro-layout` is a flex container wrapping `#terminal` + `#split-pane`
- CSS classes `split-right` / `split-bottom` control layout direction
- Hidden in become mode (`.become-active #split-pane { display: none }`)
- `window.__shiro.closeSplit()` available from browser console

**Key files:** `src/split-view.ts`, `src/commands/serve.ts` (`openInSplit`, `unsplit`), CSS in `index.html`

## Become (App Mode)

Make Shiro "become" a served app — full-screen with no terminal, accessible via path-based URLs like `shiro.computer/myapp`:
```bash
serve /tmp/myapp 3000       # Start serving an app
become 3000 myapp           # Full-screen app mode, URL → /myapp
become                      # Auto-detect if only one server running
unbecome                    # Return to terminal (also: __shiro.unbecome() in console)
```

**How it works:**
- `become` saves config to `localStorage['shiro-become']` (synchronous — no flash on reload)
- Hides terminal via `.become-active` CSS class, creates a full-screen iframe with app content
- On page reload, `main.ts` detects become config, starts the server, and re-enters app mode
- `server.mjs` SPA fallback means `shiro.computer/myapp` loads index.html which boots into become mode
- Server windows have a purple "Become" button (4th traffic light) for one-click activation
- `unbecome` clears config, removes iframe, shows terminal, resets URL to `/`

**Key files:** `src/commands/become.ts`, boot logic in `src/main.ts`, button in `src/server-window.ts`

## Claude Code (Inner Claude)

The real `@anthropic-ai/claude-code` CLI (v2.1.38, 11MB bundled ESM) runs inside Shiro's Node.js runtime (`src/commands/jseval/`). Both print mode (`claude -p "..."`) and interactive mode (`claude`) work.

**How it works:**
- Shell finds `claude` → bin stub at `/usr/local/bin/claude` → follows to `cli.js`
- `jseval/node-cmd.ts` transforms the ESM bundle, wraps in AsyncFunction, provides ~50 Node.js module shims
- API calls go through CORS proxy: `globalThis.fetch` → rewrite URLs → `/api/anthropic/*` → `api.anthropic.com`
- OAuth tokens auto-refresh before CLI runs (pre-flight check in jseval.ts)

**Key details:**
- OAuth credentials: `/home/user/.claude/.credentials.json` (persisted in IndexedDB)
- Token refresh: `POST /api/platform/v1/oauth/token` with `grant_type=refresh_token`
- Telemetry blocked: datadoghq.com, sentry.io, event_logging → fake 200 responses
- Stdin piping works: `echo "text" | claude -p "analyze this"`
- Interactive mode uses ink (React for terminal) with stdin passthrough bridging
- Tree-sitter WASM gracefully degraded (syntax highlighting disabled; browser can't compile the emscripten binary)
- Vendored ripgrep (ELF binary) shimmed to Shiro's builtin `rg` command (full flag support)
- `fileCache` keeps sync/async fs operations coherent — FileHandle, `fs.promises`, and sync all update it
- `pendingPromises` array tracks all async IDB writes; drained before `execAsync` and script exit
- ES module transforms in `jseval/module-transform.ts` (pure string transforms, extracted for readability)

**Dual-layer cache coherence (`execAsync`):**
- `writeFileSync` updates `fileCache` and queues an async IDB write in `pendingPromises`
- Before `shell.execute()`, `pendingPromises` is drained so child processes see written files
- After `shell.execute()`, `fileCache` is refreshed from Shiro FS cache so `readFileSync` sees shell-modified files
- This two-phase drain/refresh keeps sync and async fs views coherent across `child_process.exec` calls

**Bundled library compatibility:**
- `__stubProxy` wraps failed module factories in Proxy that auto-stubs missing properties
- `transformBundledESM` (in `jseval/module-transform.ts`) patches the lazy factory to catch init failures gracefully
- `proper-lockfile` (bundled in CLI for TaskCreate file locking) uses a `toSync` wrapper that requires: `mkdirSync`, `realpathSync`, `statSync`, `rmdirSync`, `utimesSync` — all shimmed

## Git Push Auth Quirk

When running `git push` inside Shiro, the `GITHUB_TOKEN` environment variable may not propagate automatically. Use this pattern:

```bash
GITHUB_TOKEN=$GITHUB_TOKEN git push origin main
```

## Shell & Node Gotchas

- **Semicolons in `js-eval`**: The shell splits on `;` before passing to `js-eval`. Use `node script.js` for multi-statement JS.
- **`//` in node scripts**: The AsyncFunction wrapper can sometimes fail on `//` comment syntax. Prefer `/* */` comments or remove comments.
- **Unicode in string concatenation**: When building HTML strings with `+`, `\u2014` and similar escapes may double-escape. Use HTML entities (`&mdash;`) instead.

## Hot-Loading Commands

Inject commands into a running Shiro session without rebuilding:

```javascript
var shiro = window.__shiro;
var myCmd = { name: 'mycmd', description: '...', exec: function(ctx) { ... } };
try { shiro.registry.register('commands/mycmd', myCmd, 'src/commands/mycmd.ts'); }
catch(e) { shiro.registry.replace('commands/mycmd', myCmd, 'src/commands/mycmd.ts'); }
```

The try/catch handles re-loading (first load uses `register`, subsequent loads use `replace`).

## Setup Command (OAuth)

The `setup` command (`src/commands/setup.ts`) provides a mobile-friendly OAuth sign-in GUI:

- Uses PKCE flow with `crypto.subtle.digest('SHA-256', ...)` for code_challenge
- Redirect URI: `https://platform.claude.com/oauth/code/callback` (manual code paste flow)
- `shiro.computer/oauth/callback` is NOT a registered redirect URI
- srcdoc iframes have `null` origin — pass `window.location.origin` from the parent TypeScript context
- srcdoc iframes can't `window.open()` cross-origin due to COOP headers — use `postMessage` to parent
- OAuth `state` and PKCE `code_challenge` parameters are both required
- Already-authorized users may see a 400 error on the consent page (server-side stale session issue)

## DigitalOcean Deployment

Shiro deploys to a DigitalOcean droplet (IP: 161.35.13.177, ID: 550124232). The `doctl` CLI cannot run inside Shiro (Go binary). Deploy via `npm run deploy` which uses SSH/SCP. Credentials should be stored in Claude's auto memory.

## Keep It Manageable

- **One command per file** (or small groups of related commands like coreutils)
- **No over-engineering** - commands should be simple and direct
- **No monolithic files** - if a file grows past ~300 lines, split it
- **Register new commands in main.ts** - that's the single wiring point

## Standing Instruction for AI Agents

**Compare with the vision documents and keep going to implement the full vision. Continue updating docs, updating tests, commit, push, and continue toward full vision.**

The workflow cycle is: **implement shell features → write tests → update CLAUDE.md → commit → push → deploy → repeat**.

The vision: a **fully functional browser-native Linux system** where Claude Code (Spirit) runs with no external server. There is always work to do — if your current task is done, find the next missing Linux capability and implement it.

### Current State (Build #858, 1885 tests)

The shell (`src/shell.ts`, ~4800 lines) has comprehensive bash compatibility. Core features working: pipes, redirects, heredocs, arrays (indexed + associative), arithmetic, functions, control structures, job control, process substitution, extglob, brace expansion, namerefs, traps, and 30+ inline builtins. All three architecture tiers are operational: Tier 1 (220+ JS commands), Tier 2 (WASM+WASI, 22 packages), Tier 3 (x86-64 emulator, Phase 3 complete — ~130 instructions, ~46 syscalls, SSE2, TLS, runs real musl-static ELF binaries, Phases 4-6 complete — enhanced commands, JIT basic block cache, network syscall stubs, debug enhancements).

### Future Plans — Next Features to Implement (Priority Order)

> **Recently Completed (Shiro Vision Stages 1-3 + x86 Phases 1-3 + Command Expansion):**
> - `enable` builtin with -n/-a/-p flags and builtin gating
> - `read -t TIMEOUT` and `read -u FD`
> - `mapfile -C callback` with quantum
> - `coproc` with named coprocesses
> - Signal handling (AbortController, Ctrl+C → SIGINT)
> - Process table robustness (kill actually terminates, abort controllers)
> - `/proc` virtual filesystem (version, uptime, meminfo, cpuinfo, loadavg, self/*)
> - `/dev` virtual filesystem refactor (null, zero, random, urandom)
> - x86-64 emulator Phase 1: CPU, memory, ELF64 loader, ~40 instructions, 25+ syscalls
> - Tab completion engine, nocaseglob, nullglob, dotglob, failglob, globstar, LINENO, EXIT trap
> - x86-64 emulator Phase 2: ~100 instructions, ~40 syscalls, auxv, FS/GS segment, SSE2, XMM regs
> - x86-64 emulator Phase 3: ~130 instructions, ~46 syscalls, TLS, runs real musl-static ELF binaries
> - Living OS — speak, listen, notify, camera, top (TUI), man (manual pages), less (full TUI pager)
> - Batch 1 coreutils — rev, tac, shuf, cmp, dd, xxd, dc, split
> - Batch 2 coreutils — factor, cksum, base32, numfmt, csplit, nice
> - Batch 3 coreutils — lsof, w, who, users, dos2unix, unix2dos
> - Enhanced sort (-k/-t/-f/-h/-V/-s/-b/-c), ls (--color/-1/-S/-t/-d/-F/--group-directories-first)
> - watch real TUI (alternate screen, -n interval, -d diffs, -t, -e, -g)
> - grep --color, -F fixed strings, -q quiet, -x whole line, -m maxcount, -H/-h filename
> - POSIX ustar tar (512-byte blocks, gzip via CompressionStream, backward compat with FLUFFY-TAR-V1)
> - find expression tree AST (!, -not, -o/-or, -a/-and, -empty, -mtime, -delete, -prune)
> - sed hold space (h/H/g/G/x), branching (b/t/:label), y transliterate, c/q/= commands, regex ranges
> - awk if/else, while, C-style for, next, exit, delete arr[key], (key in arr), ternary, indirect $var
> - x86 network syscall stubs (socket/connect/sendto/recvfrom → fetch() for HTTP)
> - x86 debug breakpoints (--break ADDR), watchpoints (--watch ADDR), memory dump (--dump ADDR SIZE)
> - x86 JIT basic block cache (identification, FNV-1a hash invalidation, LRU eviction)

#### P1: Binary Package Manager (`xpkg`) — Phase 7
4. **xpkg install/list/search/remove** — downloads musl-static x86-64 ELF binaries from a JSON manifest on CDN
5. **Initial packages** — busybox (~800KB, 300+ commands), dash, tree, file, bc
6. **JIT Phase 2** — compile hot basic blocks to JS functions (scaffold exists in jit.ts)

#### P2: Terminal Multiplexer + Compression — Phases 8-9
7. **tmux-lite** — split-pane, new-session, select-pane, detach/attach, visual pane splitting, status bar
8. **Compression suite** — bzip2/bunzip2, xz/unxz, zstd/unzstd, tar -j/-J/--zstd integration

#### P3: Networking + Services — Phases 10-11
9. **SSH-over-WebRTC** — `ssh <code>` bidirectional terminal over WebRTC DataChannel, `scp` file transfer
10. **Init system + cron** — crontab, systemctl start/stop/restart/status, /etc/services/, journalctl

#### P4: Real Interpreters — Phase 12
11. **CPython + Bash via x86** — extend decoder (10-30 more instructions), extend syscalls (mmap file-backed, pipe, dup2, signals), JIT Phase 3 full codegen, cross-compile python3.12-musl-static and bash-5.2-musl-static

### Technical Notes for New Agents

- **Inline builtins** in `src/shell.ts` have access to `this.env`, `this.arrays`, `this.assocArrays`, `this.readonlyVars`, `this.shoptopts`, `this.backgroundJobs`, `this.functions`, `this.aliases`, `this.namerefs`, `this.callStack`. They use `continue` to skip to the next pipeline segment — but MUST also set the local `exitCode` variable (not just `this.lastExitCode`), or the exit code gets overwritten to 0 by line ~1905.
- **ANSI-C quoting** `$'...'` is handled ONLY in the tokenizer — never in `expandVars`.
- **Tests** are in `tests/tests/shiro-vitest/shell-advanced.test.ts`. Sections are numbered (currently 1-81). Add new sections sequentially. The `run(shell, cmd)` helper returns `{ output, exitCode }`. Stderr goes to stdout in the test helper.
- **Deploy cycle**: `npm run deploy` auto-increments build number, runs tsc + vite build, and scp's to the DO droplet.
- **x86 emulator**: Tests use `buildElf64(code)` helper to hand-craft minimal ELF64 binaries from raw byte arrays. The emulator uses `bigint` for all 64-bit values (registers, addresses). Phase 3 complete: ~130 instructions, ~58 syscalls (including network stubs), XMM registers, FS/GS segment overrides, SSE2, TLS support. JIT basic block cache with FNV-1a hash invalidation. Debug mode with breakpoints, watchpoints, and memory dumps. Runs real musl-static ELF binaries. Test fixture at `tests/tests/shiro-vitest/fixtures/hello-musl`.
- **Virtual filesystem providers**: `VirtualFSProvider` interface in `filesystem.ts`. `/dev` and `/proc` are fully virtual — add new providers to the `virtualProviders` array.

