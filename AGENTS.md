# AGENTS.md

Canonical agent instructions live here. [CLAUDE.md](CLAUDE.md) is a compatibility shim and should only point back to this file.

## Mission

Shiro is a browser-native Unix-like development environment. Prioritize changes that make it feel more like a real machine in the browser: shell, filesystem, Node/npm, editors, build tools, networking, WASI/x86, and first-class AI tooling.

Do not treat the dashboard or wrappers as the product. The product is the browser OS itself.

## Architecture Snapshot

- `src/main.ts`: boot, filesystem init, command registration, seeded runtime hydration.
- `src/filesystem.ts`: IndexedDB-backed POSIX-like filesystem.
- `src/shell.ts`: bash-like parser/executor, pipes, redirects, jobs, functions, arrays, traps.
- `src/terminal.ts`: xterm integration and input handling.
- `src/commands/*`: one command per file or small group.
- `src/node-compat/*`: Node.js runtime shims used by `node` and Claude Code.
- `src/wasi/*`: WASM programs as kernel processes (see "WASM Processes" below). `src/wasi-runtime.ts` is the old in-page runtime, kept as the fallback.
- `src/pkg-manager.ts`: the package manager (`pkg`/`apt`, see "Packages"); `src/wasi-packages.ts` is the older single-binary API on top of its index.
- `src/x86-engine/*` + `public/engines/blink/` + `vendor/blink/`: x86-64 Linux ELF in Blink (wasm), as kernel processes; `src/x86/*` is the fallback interpreter when the page isn't cross-origin isolated. See `docs/X86_ENGINES.md`.
- `src/kernel/*`: Unix kernel core (process table, fd tables, pipes, syscall dispatch, SAB syscall channel for Worker guests). Contract: `docs/KERNEL_ABI.md`; roadmap: `docs/UNIX_COMPAT.md`. `window.__shiro.kernel`; kernel processes show in `ps`.
- `src/x11/*` + `src/gui/*`: Linux GUI apps (docs/GUI.md): Xshiro, an X11 server in the page (a kernel process on `/tmp/.X11-unix/X0`), rootless windows on the desktop's surface API, Debian GUI apps installed on first use (`gui`, `public/gui/apps.json`).
- `src/commands/seed.ts`, `src/commands/hc.ts`, `src/seed-runtime-context.ts`: seeded sessions, host-page access, runtime orientation.
- `src/claude-config.ts`, `src/node-compat/preload.ts`, `src/node-compat/process.ts`: Claude bootstrap, auth persistence, startup defaults.
- `src/desktop/*`: the Unix edition's desktop (menu bar, dock, window manager `wm.ts`, Terminal with tabs, lazy Files/Settings/Activity/About). `src/ui-mode.ts` picks it: every host but shiro.computer boots the desktop; `?ui=terminal|desktop` or `desktop classic` switch. API and `/dom`: [docs/DESKTOP.md](docs/DESKTOP.md).
- `server.mjs`: static hosting, API proxying, OAuth callback, signaling, relay, and the opt-in WebSocket-to-TCP relay (`/tcp`, `SHIRO_TCP_RELAY=1`).
- `src/kernel/net.ts`: kernel sockets over that relay (x86 socket syscalls and node `net` use them); see `docs/NETWORKING.md` for the protocol, security model, and nginx config.

## Working Style

- Prefer small, direct fixes over speculative rewrites.
- Read the surrounding code before editing. Shiro has a lot of compatibility shims and edge cases.
- Use `rg` / `rg --files` for search.
- Use `apply_patch` for file edits.
- Do not revert unrelated work in a dirty tree.
- Do not hard-code counts, build numbers, or implementation inventories unless you just verified them.

## Commands

When adding a command:

1. Add a file under `src/commands/`.
2. Export a `Command`.
3. Register it in `src/main.ts`.
4. Lazy-load it if it is large or rarely used.

Core pattern:

```ts
export const myCmd: Command = {
  name: 'mycmd',
  description: 'Does something useful',
  async exec(ctx) {
    ctx.stdout = '...\n';
    return 0;
  },
};
```

## Seeded Sessions And Inner Claude

- Seeded boots write runtime context to `/home/user/NEO.md` and `/home/user/.shiro-context.json`.
- If a seeded session has host-page access, inner Claude should learn that from `NEO.md` and usually start with `hc outer`.
- Keep seeded agent guidance compact and current in `src/claude-md-seed.ts`.
- `CLAUDE.md` is still written for compatibility, but it should only redirect to `AGENTS.md` plus `NEO.md`.

## Claude Code In Shiro

- `claude` is a Shiro builtin (`src/commands/claude.ts`) wrapping the npm CLI: it installs the pinned build if needed, opens the sign-in panel (`src/claude-signin.ts`) when there are no credentials, and adds `--dangerously-skip-permissions` for sessions. `claude-window` (old name `sc`) runs it in a new window.
- The npm package is pinned to 2.1.112, the last pure-JS release (`src/claude-code-version.ts`). Boot installs it in the background from the npm tarball. At load time `execution.ts` rewrites its inlined `VERSION` constant to `CLAUDE_CODE_REPORTED_VERSION`, because the API gates newer models (e.g. `claude-opus-5-5`, the default `ANTHROPIC_MODEL`) on the version in the billing header.
- The same load-time rewrite teaches 2.1.112 about newer models (`CAPABILITY_PATCHES`): Opus/Sonnet 5+ get adaptive thinking, effort control including xhigh, and the xhigh launch default, like Opus 4.7. Without it the pinned build sent fixed-budget thinking, no effort, and defaulted subscriptions to medium effort. Opus 5.5 delivers thinking as one chunk at the end, so the token counter stalls during long thinking; that is the API, not a hang.
- Also patched: interactive sessions use the in-memory `TodoWrite` list instead of the file-backed task tools (`TaskCreate`…), whose proper-lockfile locking hung in Shiro; `CLAUDE_CODE_ENABLE_TASKS=1` restores them. Callback and promise `fs.rmdir` now remove directories (they used `unlink`, so lock directories never released).
- The bundle patch also replaces Claude Code's Opus 4.7 launch card with a Shiro one and names `claude-opus-5-5` "Opus 5.5".
- Tiling panes (`src/panes.ts`): every pane in `#shiro-panes` has tiny corner triangles; dragging one splits the pane (mostly sideways = side by side, mostly vertical = stacked), dividers drag to resize (double-click evens them), and `exit`/Ctrl-D at an extra pane's prompt closes it. `#terminal` stays the main pane (`window.__shiro.terminal`); extra panes get fresh shells (copied env and cwd, no `~/.profile`). The layout is saved in localStorage `shiro-panes` and rebuilt on reload; `window.__shiroPanes.layout()` / `.reset()` inspect or clear it. Don't hand-build split layouts with page scripts anymore.
- The startup banner (`drawHud` in `terminal.ts`) lists `claude`, `gh auth login`, `remote start`, and help/files/github; `shiro://cmd/<cmd>` links type the command at an idle prompt. A terminal that is busy (command running or alternate screen) never gets in-place banner rewrites; remote status goes to an idle sibling terminal instead (e.g. the upper shell of a split), drawing a banner there if needed. `help` is a curated getting-started page; `help --all` lists every command.
- Claude defaults in `process.ts`: tool concurrency 4 and 3 planner agents (were 1), background tasks off. Export the env vars to override.
- Scripts run through bin symlinks execute under their real path (`shell.ts` → `fs.realpath`), so Claude-specific preload/env tweaks key off `/@anthropic-ai/claude-code/`.
- Claude's `tui` setting is seeded to `fullscreen` (alt-screen renderer). The classic renderer leaves stale frames in scrollback when the window is resized or a frame is taller than the terminal.
- Commands run through the `child_process` shim execute in a forked shell with no terminal, so their output returns to the caller instead of painting over Claude's UI.
- Console output is captured from boot into a bounded log (`src/console-log.ts`): the newest 3000 entries / 1.5M characters, 2000 characters per entry, consecutive repeats collapsed, text only (no retained objects). The newest 300 entries are saved to `localStorage` (`shiro-console-log`) every 5s and on pagehide, so the previous page load's log is queryable after a reload or crash. Query it with `console -g RE [--since S] [--prev]`, the remote `{type:'console'}` request, the shiro-mcp `console` tool, or `curl 'localhost:7788/console?grep=RE&level=error&since=-600000&limit=100&previous=1'` via the probe. Replies default to 100 entries / 64 KB.
- To profile a live session: `remote start` in Shiro, then `node shiro-mcp/probe.mjs <code>` (run `npm install` in `shiro-mcp/` first; set `SHIRO_SIGNALING_URL` for subdomains like `https://music.shiro.computer`). Every 2s it logs heap, long tasks, page response time, IndexedDB filesystem traffic, errors, tagged console lines, and shell commands still running after 30s into `probe.jsonl`, and serves `curl localhost:7788/eval --data-binary '<js>'` and `/exec`. Replies over the data channel are size-limited; fetch large files in ~100 KB slices.
- Fullscreen TUIs copy a selection with OSC 52; both terminals handle it (`src/utils/osc52.ts`, with an `execCommand` fallback), and `pbcopy`/`xclip`/`wl-copy` are builtins that copy stdin.
- Claude's Bash tool opens its task output file with `fs.promises.open` and reads it back with `handle.read()` inside `await using`, so the shim's FileHandle must keep a real registered fd, `read`, `stat`, and `[Symbol.asyncDispose]`.
- Claude auth/bootstrap lives in `src/claude-signin.ts`, `src/claude-auth.ts`, `src/claude-config.ts`, `src/node-compat/preload.ts`, and `src/node-compat/process.ts`.
- Shiro pre-seeds trust/onboarding/bypass settings for Claude Code.
- Browser-hosted Claude is more stable with conservative runtime defaults. Prefer serial/single-lane behavior over background worker fan-out unless you have verified a broader mode works.
- In `seed blob`, Claude runs cross-origin from the host page. Shiro-backed calls must resolve through the Shiro origin, not the parent site, and `server.mjs` CORS preflight handling must tolerate Claude headers like `x-app` and `x-stainless-*`.

## Git And GitHub

- `git` is isomorphic-git through the `/git-proxy/` route in `server.mjs`. The proxy drops `WWW-Authenticate` from responses: a same-origin 401 carrying it makes the browser show a native login prompt that stalls the request, and every later one to the origin, until the command times out.
- `githubAuth()` in `src/commands/git.ts` sends the token on the first request (`x-access-token` basic auth) for github.com remotes only, and cancels on auth failure instead of retrying. Clone, push, fetch, and pull use it. The token comes from `GITHUB_TOKEN`/`GH_TOKEN` or `localStorage.shiro_github_token` (`gh auth login --with-token`).
- `gh auth login` (no flags) is GitHub's OAuth device flow (`src/github-auth.ts`): it prints the one-time code like gh, opens a panel with Copy/Open buttons (even without a terminal, so it works from Claude's `!` mode and Bash tool), polls through the server's `/api/github-login/` route (only POST to `/login/device/code` and `/login/oauth/access_token` is allowed), saves the token to `localStorage.shiro_github_token`, and fills in `~/.gitconfig` user.name/email from the account if unset. `gh auth refresh -s <scopes>` re-authorizes with extra scopes. The OAuth app is "shiro.computer" (`GITHUB_OAUTH_CLIENT_ID`), owned by williamsharkey.
- Spawns like Claude's `zsh -c -l <cmd>`: flags after `-c` are skipped (`extractShellArgs`), otherwise a cwd prefix turned `-l` into a command.
- `git config` supports get/set/`--list`/`--unset`, local and `--global` (`~/.gitconfig`). Commit authors come from repo config, then `~/.gitconfig`, then `GIT_AUTHOR_*`.
- `gh` (`src/commands/gh*.ts`) follows the real CLI's flags where implemented: `auth` (status/login/logout/token/setup-git), `repo` (view `--json`, list, create `--source --push`, clone, delete `--yes`), `api` (`-q/--jq`, `-f/-F`, `-X/--method`), `pr`, `issue`, `release`, `workflow`, `run`, `label`, `search`.
- Known gaps: git only works from the repository root (no upward `.git` discovery), and `git log --oneline` prints full messages.

## WASM Processes

- `wasi run`, `wasi exec`, `.wasm` files on PATH, `#!wasi-pkg` stubs, package auto-install and the lua fallback all go through `runWasiProgram` (`src/wasi/run-command.ts`). When the page can block it spawns a kernel process; when `canBlock()` is `'none'` it uses the old `WasiRT` (preloaded files, fixed stdin).
- Cross-origin isolated page (SAB): each WASM thread is a Worker (`guest-worker.ts`, bundled inline via `?worker&inline`) making blocking syscalls through `Kernel.syscall`, so `fd_read` on an empty pipe or the terminal blocks, files open on demand, output streams. Without SAB but with JSPI (Chrome) the module runs on the main thread with `WebAssembly.Suspending` imports; wasi-threads programs then fail with a clear message.
- `wasi-guest.ts` implements WASI preview1 once, as generators yielding kernel syscalls; `runSync` (Worker) and `runMaybeAsync` (JSPI) drive them. Path calls use the kernel's `*at` syscalls with the WASI dirfd; preview1 `sock_accept/recv/send/shutdown` map to accept4/recvfrom/sendto/shutdown. Other wasi/wasix imports become ENOSYS stubs so binaries still instantiate.
- Spawning from WASM uses WASIX `wasix_32v1` (`proc_spawn3`/`proc_spawn2`, `proc_join`, `fd_pipe`, `fd_dup`, `getcwd`/`chdir`) mapped onto `SYS_spawn` with `inherit: true`; dup2/open file actions become fd overrides, and a close action marks the parent fd close-on-exec for the duration of the spawn. Children can be WASM (`installWasmLoader`: by path or `NAME`/`NAME.wasm` on PATH) or Shiro builtins.
- WASIX fork, setjmp/longjmp and exec (`src/wasi/asyncify.ts`, `host.ts`): WASIX binaries are already asyncified (they export `asyncify_*`), so `stack_checkpoint`/`stack_restore`/`proc_fork` unwind the main thread's stack into a buffer at the bottom of its shadow stack (`__data_end`, like Wasmer), and the Worker driver (`runEntry` in `guest-worker.ts`) rewinds it. Checkpoints are kept by content hash (key written into the jmp_buf); longjmp restores wasm locals and `__stack_pointer`, not linear memory. Fork (`SYS_wasix_fork`, vfork too) copies the shared memory into a new kernel process (fds via `FdTable.fork`, signal state copied) whose Worker rewinds into `proc_fork` returning 0. `proc_exec*` is a real exec (`SYS_wasix_exec`: same pid, close-on-exec fds closed, caught signals reset; JSPI keeps spawn+wait+exit).
- WASIX signals: `callback_signal` makes every catchable non-ignored signal a guest handler (`WASIX_HANDLER`), delivered after the next syscall reply by calling the export. WASIX libc runs default actions itself (prints "Program recieved … signal" and aborts); inside the callback that write is intercepted and the kernel takes the real default action (`SYS_wasix_signal`). Ignored-by-default signals (CHLD, WINCH, CONT, URG) restart the interrupted call instead of EINTR, and when the main thread spins in WASM without syscalls (WASIX `sigsuspend` is a no-op, so dash's `wait` busy-waits) the host runs such a signal on a signal thread with its own stack page.
- WASIX sockets (`sock_open`, `sock_connect`/`bind`/`listen`/`accept_v2`, `sock_send_to`/`recv_from`, `sock_addr_*`, `sock_set/get_opt_*`, `sock_status`) map onto the kernel socket syscalls (net.ts); `__wasi_addr_port_t` is tag u8, port u16 at 2 (host order), address bytes at 4. `resolve` is `SYS_wasix_resolve` on the NetStack `installNet` gave the kernel (`netStackOf`), answering one address because early libcs (curl's) and later ones disagree on the entry size. curl does HTTP and HTTPS (its own OpenSSL) through the relay.
- Dynamic linking (`src/wasi/dylink.ts`): a position-independent main module (`dylink.0`, python) gets its data at 1024 and an 8 MiB stack after it, a table per Worker, `__memory_base`/`__table_base`/`__stack_pointer`, GOT globals (filled from its own exports after instantiation) and EH tags; the main thread of a fresh process applies `__wasm_apply_data_relocs` and `__wasm_apply_tls_relocs`. dlopen of side modules is not implemented (ENOSYS). WASIX `reflect_signature`/`call_dynamic`/`closure_*` (`src/wasi/dyncall.ts`) get function types from the module's sections (an exported funcref's `name` is its function index); closures are generated one-import modules re-exporting a JS function.
- Package mounts: an index entry's `mounts` (guest path → package dir) become per-process preopens named after the guest path (`wasmRunner(…, mounts)`; libcs resolve absolute paths through the longest matching preopen), for package binaries and for package programs started by path (`packageMountsForPath`: clang's driver running wasm-ld). curl gets its CA dir at `/openssl`, python its `/nix/store/...` stdlib, tzdata and terminfo, clang `/sysroot` and `/lib`. A bin's `self` names the command `/proc/self/exe` reports (and an empty-name exec runs): clang's slim driver re-runs the full `clang-16` for `-cc1`, like Wasmer's exec-name. Volume installs create the volume's empty directories and symlinks too.
- `tty_get`/`tty_set` map onto TCGETS/TCSETS of the first terminal among fds 0-2. Shiro commands stat as executables in `/bin`, `/usr/bin`, `/usr/local/bin` (`binCommandStat`), so shells searching PATH find `ls`, `cat`, ...
- wasi-threads: `wasi.thread-spawn` is `SYS_wasi_thread_spawn` (1100, registered by `host.ts` with `kernel.registerSyscalls`), answered with the kernel's `attachThread`, so each thread is a Worker with its own channel and kernel tid; a returning thread sends `SYS_exit`. Shared memory limits come from the binary's import section (`wasm-imports.ts`). WASIX `futex_wait/wake` use `Atomics.wait/notify` on the shared memory.
- Browsers refuse `TextDecoder.decode` on views of a SharedArrayBuffer (Node allows it, so vitest misses it): copy, or use `decodeText()` from `src/kernel/abi.ts`.
- Preview1 follows Wasmtime where the wasi-testsuite checks it (`tests/conformance/syscalls-wasi.conf.ts`, 71/72; regressions in `wasi-conformance.test.ts`): fixed rights per filetype (`fd_fdstat_set_rights` is ENOTSUP), `path_open` without `symlink_follow` is O_NOFOLLOW, O_DIRECTORY with write rights is EISDIR, `fd_seek` on a directory is EISDIR, preview1 `fd_renumber` needs an open target (WASIX's doesn't: dash's dup2). When the guest's "/" is a mounted directory rather than Shiro's root (`confined`), dirfd paths can't be absolute or climb above the dirfd and symlink targets can't be absolute (ENOTCAPABLE); with the real root they keep POSIX meaning. The kernel's path syscalls carry the Linux rules underneath (trailing slashes, ELOOP, rename/rmdir ENOTEMPTY/EISDIR/ENOTDIR, utimensat with nanoseconds and AT_SYMLINK_NOFOLLOW; FSNode keeps `mtimeNs`, `atime`, `atimeNs`). No hard links: `link()` is EPERM (after its EEXIST/ENOENT/EINVAL checks).
- Tests: `tests/tests/shiro-vitest/kernel-wasi.test.ts`; the real WASIX packages (dash, bash, php from Wasmer's CDN, cached in `tests/.pkg-cache`) in `kernel-wasix.test.ts`. Fixtures are freestanding C (no wasi-sysroot needed; `fixtures/wasi/build.sh`), plus a Go `GOOS=wasip1` program built at test time when Go is installed.

## Node Processes Share The Page

- Every `node` script runs in the same page as the shell and every other script. Claude Code runs for hours while its tool calls start and finish other scripts, so a script must never remove globals on exit that another might still use. `setImmediate` is polyfilled once and never removed; deleting it from a finishing child hung Claude's Bash tool.
- When a script exits it restores `fetch`/`setTimeout`/`clearTimeout` only if the global is still the one it installed (`restoreGlobals` in `execution.ts`). Restoring blindly let `~/.profile`-launched autostart scripts clobber Claude's Node-style `setTimeout`, and Claude crashed with `.unref is not a function` on the first message.
- The terminal skips its startup prompt when `~/.profile` launched a command through `injectInput`; that command prints the prompt when it finishes.
- The module transform still assigns global `setTimeout`/`setInterval` wrappers for some bundles without restoring them. It's harmless so far, but it has the same problem.

## Packages

- `pkg` / `apt` / `apt-get` (`src/commands/pkg.ts`, `src/pkg-manager.ts`) install prebuilt WASM programs from `src/pkg-index.json`: sha256-checked downloads into `/usr/lib/pkg/<name>/`, symlinks in `/usr/bin`, state in `/var/lib/pkg/status.json`. Details, the index format and the package status table are in [docs/PACKAGES.md](docs/PACKAGES.md).
- The shell runs anything resolving into `/usr/lib/pkg/` through `runPackageBinary`: a kernel process via `runWasiProgram` when the page can block, else the in-page `WasiRT` (always for `wasi_unstable` programs). An installed package's command wins over a builtin of the same name unless its bin entry says `"shadow": false` (coreutils applets, every WASIX command); `builtin NAME` reaches the builtin.
- Packages built here come from `scripts/pkgbuild/<name>.sh` (wasi-sdk, pinned sources) and live in `public/pkg/`; registry packages are Wasmer WebC containers read by `src/webc.ts`.
- x86-64 packages (`abi: x86_64-linux`, recipes in `scripts/pkgbuild/x86/`) are static musl builds run in Blink; [docs/COMPAT.md](docs/COMPAT.md) is the scoreboard of popular tools (less, vim, ...) with a smoke test each in `compat-tools.test.ts`.
- Packages that need kernel features (`needs`: wasix, processes, threads, sockets, ...) stay gated until the WASM process mode (`src/wasi/host.ts`) or `globalThis.__shiroKernel.features` provides them.

## Debian Mode

- `debian install` streams Debian 13 trixie in (docs/DEBIAN.md): `public/debian/` is built by `scripts/debian/build-rootfs.sh` (debootstrap minbase from a pinned snapshot.debian.org timestamp, run as root) and `pack-rootfs.mjs` (content-addressed gzip chunks grouped by package + a path index). Installing writes every path as a placeholder (`FSNode.lazy`); the first read fetches the chunk (sha256-checked, Cache API) and stores the bytes in IndexedDB. Boot re-attaches the loader from `/var/lib/shiro/rootfs.json` (`src/debian/rootfs.ts`).
- Debian's binaries (dynamic glibc) run in Blink. `sudo` sets kernel uid/gid 0 for its children (`SpawnOptions.uid`, `Shell.uid`). The kernel runs `#!` scripts whose interpreter is an ELF or a `Command.program` itself (`shebangLoader`), so maintainer scripts run under Debian's dash. `link()` copies and reports the source's inode (dpkg's backups need it).
- apt's http method is diverted to `http.debian`; its place holds `#!/usr/bin/shiro-apt-method`, a kernel program (`Command.program`, `src/debian/apt-method.ts`) fetching `http://HOST/PATH` as `/debian/mirror/HOST/PATH` from `server.mjs` (`SHIRO_DEBIAN_MIRRORS` allowlist, `SHIRO_DEBIAN_CACHE`).
- Overlay (`src/debian/overlay.ts`): dpkg local diversions are the policy (diverted to `PATH.debian` = Shiro's). `shiro-alternatives --list|--set NAME shiro|debian|--auto`. Defaults in `src/debian/overlay-policy.json`; only programs whose cases in `debian-overlay.test.ts` match Debian's may default to Shiro. In Debian mode a program file in `/usr/{local/,}{s,}bin` replaces a builtin of the same name (`debianShadows` → `packageShadows`); `builtin NAME` still reaches Shiro's.
- Scoreboard: `npm run debian-score -- --top 100` (scripts/debian/score.mjs, headless Chromium) → docs/DEBIAN_SCORE.md. Bench: `node bench/run.mjs --suites debian --modes isolated`. Tests: `debian.test.ts` (apt end to end with `SHIRO_DEBIAN_NET=1`).

## Languages And Toolchains

- Scoreboard and per-entry tests: [docs/COMPAT.md](docs/COMPAT.md), `tests/tests/shiro-vitest/compat-dev.test.ts`.
- `pkg install python3` is CPython 3.13 for WASI (`scripts/pkgbuild/python3.sh`, prefix `/usr/lib/pkg/python3`, stdlib in `lib/python313.zip`). It shadows the Pyodide `python3`/`python` builtins while installed. `pip` (`src/commands/pip.ts`, rules in `src/utils/pep440.ts`) resolves against PyPI's JSON API from the page and installs pure-Python wheels; `python3 -m pip|venv|ensurepip` are intercepted in `runPackageBinary`/`packageKernelProgram` (`pythonFrontend`) because WASI python has no sockets or subprocess. Without the package, `pip` is still Pyodide's micropip.
- A package bin entry with `"argv0": "path"` gets the absolute path it was found at as argv[0] (CPython finds `pyvenv.cfg` next to it).
- Shebangs: `executeScript` → `runInterpreter`; `#!/usr/bin/env X` and `#!/abs/X` reach builtins, packages and PATH scripts.
- `scripts/browser-check.mjs URL 'cmd' ...` runs commands in headless Chromium against a built app (`npm run build`, `PORT=5299 STATIC_DIR=$PWD/dist node server.mjs`), in a terminal-less shell fork so kernel jobs' output is captured; it routes https through `$HTTPS_PROXY` when set.
- `scripts/browser-tui.mjs URL 'run:pkg install vim' 'type:vim x\r' 'wait:x' 'type::q\r' 'shot:/tmp/v.png'` drives full-screen programs on the real terminal (xterm.js keyboard input, waits on the rendered screen, screenshots); a `wait:` can match the echoed command line, so wait for something only the program draws.
- `tests/browser/first-run.mjs [URL] [--only NAME] [--shots DIR]` is the desktop's first-impression check: from a fresh profile per case it clicks every welcome-banner suggestion and dock app (and zooms a window running htop) and waits on the rendered terminal; it works against https://tabcomputer.com through `$HTTPS_PROXY` too.
- `pkg install make llvm` gives GNU make and clang 21 (wasm32-wasip1). Programs built with wasi-sdk get processes from `scripts/pkgbuild/compat/wasi-proc.c` (posix_spawn/waitpid/pipe/dup2/exec*/system/popen over the guest's WASIX `proc_spawn3`/`proc_join`/`fd_pipe`/`fd_dup`; `setup_proc` in `common.sh`, headers in `compat/include/`). It syncs wasi-libc's cwd with the kernel's at startup. WASI LLVM can't spawn, so `compat/clang-driver.c` runs `clang -###` and then each step as `yowasp-llvm TOOL ...`.
- `pkg install go` is Go 1.24.7 running on wasip1 (`scripts/pkgbuild/go.sh` + `go/wasip1-processes.patch`; one tarball the index unpacks into bin/, pkg/, src/, cache/). `GOROOT/go.env` sets GOTOOLCHAIN=local, GOPROXY=off, GOFLAGS=-p=4 and GOCACHE=/usr/lib/pkg/go/cache, which ships common std packages compiled natively by the same patched toolchain (release tool IDs match, so the wasm go command hits them). The guest's spawn treats a close of fd 0xffffffff as "inherit only the dup2'd fds".
- Package ABI `x86_64-linux` (perl): static ELF programs under /usr/lib/pkg run in Blink through the shell's ELF path (`executeScript` only sends WASM to `runPackageBinary`); `needs: [threads, processes]` (Blink needs SharedArrayBuffer). Boot's PATH shims live in `src/path-shims.ts` (`createPathShims`), shared with tests.
- Kernel inodes (`src/kernel/fd.ts`) follow renames and detach on unlink; kernel-spawned WASM without WASIX libc gets top-level preopens (`childPreopens` in `src/wasi/host.ts`); the kernel's builtin loader defers to installed packages that shadow a builtin.
- `FileSystem.writeFile` copies a Uint8Array that is a view of a larger buffer (IndexedDB clones the whole buffer otherwise).
- Builds: `vite-plugin-inline.ts` makes the inline entry script `import "./assets/index-….js"` instead of inlining its code; inlining made two instances of every module in the entry chunk (lazy chunks import the file), with separate state.

## Build, Test, Deploy

```bash
npx tsc --noEmit
cd tests && npm run test:shiro
npm run build
npm run deploy
```

Performance: `npm run bench:quick` (~2.5 min) before and after a performance change, `node bench/compare.mjs old.json new.json` to diff; the baseline, the ranked hotspot list and bugs found are in [docs/BENCHMARKS.md](docs/BENCHMARKS.md), the harness in [bench/README.md](bench/README.md). It drives the pre-installed Chromium (`/opt/pw-browsers/chromium`); never run `playwright install`.

Use focused vitest runs while iterating, then run the smallest meaningful verification set before deploy. For changes touching seed/Claude/bootstrap paths, relevant files usually include:

- `tests/tests/shiro-vitest/seed.test.ts`
- `tests/tests/shiro-vitest/seed-runtime-context.test.ts`
- `tests/tests/shiro-vitest/claude-bootstrap.test.ts`
- `tests/tests/shiro-vitest/node-runtime.test.ts`
- `tests/tests/shiro-vitest/new-features.test.ts`
- `tests/tests/shiro-vitest/server-cors.test.ts`

Production is `https://shiro.computer` on a DigitalOcean droplet. `deploy.sh` handles build, upload, and restart, and it is the only place that should bump `build-number.txt`. nginx on the host sets `client_max_body_size 100m` (`/etc/nginx/sites-enabled/shiro`): the 1 MB default rejected long Claude conversations and GitHub blob uploads with 413. `deploy.sh` uploads only `server.mjs`; the host's own `/opt/shiro/package.json` holds its deps (`ws`, and `undici` so proxied model calls have no 5-minute header timeout). Each model call logs one `[proxy] messages model=… stream=… bytes=… → status headers in Nms` line (`journalctl -u shiro`).

### Cross-origin isolation

- `server.mjs` sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on the app shell (`index.html`, including SPA fallbacks like `/s/:id`), on `.js`/`.mjs` (so same-origin Workers can start), and on `/oauth/callback`. The page is then `crossOriginIsolated`, so `SharedArrayBuffer` and `Atomics.wait` work. `vite.config.ts` sends the same pair for `npm run dev`/`vite preview`. `SHIRO_ISOLATION=0` turns both off (set it in the systemd unit for the server). `isIsolated()` in `src/utils/isolation.ts` is the runtime check, and boot logs one `[shiro] Cross-origin isolated…` / `Not cross-origin isolated…` line.
- nginx proxies everything to node, so it passes these headers through and needs no change. If nginx ever serves `dist/` itself, it needs `add_header Cross-Origin-Opener-Policy same-origin always;` and `add_header Cross-Origin-Embedder-Policy credentialless always;` on `index.html` and `*.js`.
- `credentialless` (not `require-corp`) lets no-cors CDN loads (scripts, CSS, images, fonts) through without CORP; they go out without cookies. CORS loads (Pyodide, esm.sh, jsdelivr, unpkg, the npm registry) are unaffected.
- Carve-outs: a cross-origin `<iframe>` inside the app is blocked (`ERR_BLOCKED_BY_RESPONSE`) unless the framed site sends COEP/CORP or the iframe has the `credentialless` attribute. This applies to user pages in server windows that embed third-party frames. srcdoc/blob/about:blank frames inherit isolation. The `public/*.html` docs pages are not isolated. `seed blob` runs in the host page's origin, so it is isolated only if the host is. URL-mode `seed` iframes carry `allow="cross-origin-isolated"`, so they are isolated only when the host page is.
- COOP severs `window.opener` once a popup visits another origin. The `/oauth/callback` page falls back to the `shiro-oauth-callback` BroadcastChannel, which `main.ts` also listens on. Claude sign-in and `gh auth login` use pasted codes or the device flow and don't depend on the opener.
## Terminals And Signals (kernel, phase 3)

- `src/kernel/pty.ts`: `Pty` is a master/slave pair with Linux termios (36-byte `struct termios`, `winsize`), the n_tty line discipline (canonical editing, echo, ISIG, VMIN/VTIME, IXON), OPOST/ONLCR, and the tty ioctls (TCGETS/TCSETS*, TIOCGWINSZ/TIOCSWINSZ, TIOCSCTTY, TIOCGPGRP/TIOCSPGRP, FIONREAD, ...). Calls that need the caller's identity take an optional trailing `caller` or ask `setTtyCallerResolver`. Background reads get SIGTTIN (writes SIGTTOU with `tostop`); a stopped caller waits inside the call and retries when continued, which is the syscall restart.
- `src/kernel/signals.ts`: Linux signal numbers, `SignalState` (dispositions, mask, pending), and `jobControl` (process groups, sessions, `kill`, stop/continue, SIGCHLD, orphaned groups, `waitJob`). Stopping is cooperative: stopped processes don't get syscall replies (`whileStopped`). `createSignalTarget` makes an in-page process.
- `attachKernelTty(kernel)` (main.ts, at boot) adopts every kernel `Process` into `jobControl` (`kernel.onSpawn`): its `signalHook` routes all delivery there, `proc.dispositions`/`sigmask`/`deferredSignals` back its `SignalState` (so `rt_sigprocmask`/`kernel.setSigmask` deliver held signals), kernel-side stops and exits become job events, and the `AbortSignal` the kernel passes to `read`/`write`/`ioctl` identifies the caller (`Process.fromSyscallSignal`) for SIGTTIN/SIGTTOU and TIOCSCTTY. It also registers `/dev/ptmx` and `/dev/pts/N`. `TtySession.spawnJob(kernel, …)` binds the session to an idle `-sh` kernel session leader (ctty = the pty) and spawns the job in a new group under it; the leader reaps children on SIGCHLD.
- Every `ShiroTerminal`/`WindowTerminal` owns a `TtySession` (`terminal.tty`): the pty plus a session-leader process standing in for the shell. Keystrokes go to the pty only while a kernel job is in the foreground (`tty.jobInForeground`); otherwise the shell's own line editor handles them as before. Resizes call `tty.resize` (SIGWINCH to the foreground group).
- Programs typed at the prompt that are WASM (`NAME.wasm` on PATH, `#!wasi-pkg` stubs) or x86-64 ELF (`#!x86-pkg` stubs, ELF files) run as kernel processes (`src/shell-kernel.ts`, called from the pipeline loop's `tryKernelRun`): consecutive such segments are spawned together joined by kernel pipes, in one process group under the terminal's pty session (`tty.spawnJob`), and waited for with `runKernelJob`. Filter builtins piped to or from them (cat, grep, tr, wc, sed, ... — `PIPE_FILTERS`) join the same job as kernel processes through `kernel.runBuiltin`, over real pipes; other builtin segments feed the run and read its output as strings. `prog &` (all kernel stages) is a real background job; in-page `&` jobs get the terminal without its `tty` so nothing inside them takes the foreground. WASM needs `wasmProcessMode() !== 'none'` (SAB+Worker or JSPI), otherwise the old in-page runtime runs it; x86 always runs as a kernel process (`src/x86/kernel-runner.ts`: blocking stdin on fd 0, stop at syscalls, killed via an AbortSignal, yields every 1M instructions).
- Shell job control for kernel jobs: `runKernelJob` in `src/commands/jobs.ts`; Ctrl-Z puts the job in `backgroundJobs` as `stopped`, and `fg`/`bg`/`jobs`/`kill %N`/`wait` signal and wait on its process group. Plain in-page `&` jobs are promises that can only be aborted.
- `kill` is one implementation (`src/commands/trap.ts`, re-exported by `ps.ts`) with bash's options; `stty` reads and sets the terminal's pty (a per-shell detached pty when there is no terminal); `tput lines/cols` use the pty size, overridden by `LINES`/`COLUMNS`.

## Desktop (Unix edition)

- The window manager API (`window.__shiro.desktop`, `src/desktop/wm.ts`) is a contract with unix/gui (X11/Wayland windows as `surface` content): keep it additive and log changes in docs/DESKTOP.md.
- `#terminal` moves into the first Terminal window before `ShiroTerminal` is created, so `window.__shiro.terminal` is the same in both UIs (scripts and the bench rely on it). Closing that tab parks it in `#sd-parking`; the next Terminal window adopts it. Panes (`initPanes`) are classic-only.
- Desktop shortcuts are Alt+Shift+… and Alt+\` (`isDesktopShortcut`), caught in the capture phase before xterm. Don't take plain Alt keys: readline uses them.
- The desktop is a separate chunk that `main()` starts importing before IndexedDB opens (the terminal UI never loads it); apps under `src/desktop/apps/` are further chunks `import()`ed on launch. Keep `src/desktop` out of static imports from the entry; measure both UIs (`BENCH_PATH='/?ui=terminal'`). Fonts (`public/fonts`, OFL) are injected by the desktop only.
- `/dom` (`src/dom-fs.ts`) is a FileSystem virtual provider (`fs.addVirtualProvider`, `mountPoint`) plus kernel devices for `/dom/events/<type>`; `cat` follows those live at a terminal.
- Network sign-in: call `requireNetworkSignIn()` (`src/net-signin.ts`) before outbound network that needs a signed-in user; never for same-origin requests. The relay token fetch does; `SHIRO_TCP_REQUIRE_SIGNIN=1` makes server.mjs demand a GitHub token.

## Linux GUI Apps (X11)

- `Xshiro :0` (`src/x11/display.ts`) starts at boot and only listens; `src/x11/session.ts` builds the server (`server.ts`, `render.ts`, fonts) on the first client. `DISPLAY=:0` is in the shell env. `xserver` shows clients and windows; `window.__shiroX` is `{server, rootless}`.
- Rootless: each X toplevel is a desktop `surface` window (`src/gui/desktop-host.ts`, scale 1, no auto-resize) or a stand-in floating window in the classic UI (`standin-host.ts`). Windows' app id is the WM_CLASS instance, so dock entries (`src/gui/desktop-apps.ts`) find them.
- `gui APP` installs from `public/gui/apps.json` (regenerate with `scripts/gui/gen-apps.py`; it needs the Debian Packages index, network, dpkg-deb, readelf and the host's update-mime-database): packages by sha256 through the server's `/debian/` route, Cache Storage, unpack in the page, triggers in Blink, overlays from `public/gui/overlay/`.
- Debug a client without the browser: `tests/tests/shiro-vitest/gui-probe.test.ts` (`GUI_PROBE_ROOT` = a rootfs from `scripts/gui/debfetch.py`) or `scripts/gui/xdev.ts` (the server on a real Unix socket for native clients). Browser numbers and screenshots: `scripts/gui/shoot.mjs`.
- Server code reads requests with `Reader` and writes with `Writer` in the client's byte order; throw `XError(code, value)` for protocol errors. Drawing goes through `Painter` (raster.ts) so clips, raster ops and damage stay right; never write `Pix.data` without calling `damage`.

## Gotchas

- Blink guests (patch 0011) make their fd/file/process syscalls in the kernel: guest fd N is kernel fd N, `vfork`/`posix_spawn` run the child on the parent's thread until `execve`/`_exit`; `fork()` itself copies the process into a new worker (patch 0013).
- Filesystem paths resolve symlinks in directory components (`_canon` in filesystem.ts); `lstat`/`unlink`/`readlink` don't follow the last one.
- `vite-plugin-inline.ts` inlines the entry CSS into index.html but must keep the `.css` file: lazy chunks preload it, and the 404 made every such `import()` (WASM processes, the kernel shell) reject in production builds.
- Blink engine: rebuild `public/engines/blink/blink.{mjs,wasm}` with `vendor/blink/build.sh` after changing `vendor/blink/patches/` or `shiro-net.js`; don't hand-edit the generated files. `host.mjs` is hand-written. Browsers refuse `TextDecoder.decode()` on SharedArrayBuffer views (Node doesn't), so decode a `.slice()` of channel data.

- `child_process` is shimmed. There is no real process tree.
- Most filesystem work is async under the hood even when sync APIs are emulated.
- `FileSystem` reopens IndexedDB when the browser closes the connection (`onclose`/`onversionchange`, or an `InvalidStateError` from `transaction()`), retrying the request once. Writes resolve on transaction commit, and `fs.pendingWrites` makes `beforeunload` warn before leaving mid-write.
- Background-task-heavy or highly concurrent agent flows can stall in the browser runtime.
- `seed` and `seed blob` are not equivalent. Preserve their runtime-context differences.
- Expansion results are data: `$VAR`, `${NAME}`, `$1`–`$9`, and `$(...)`/backtick output have their quotes, `\`, `$`, backticks, and `| < > & ;` swapped for private-use stand-ins (`protectExpansion` in `shell.ts`) before the command text is tokenized, and swapped back when `parseSegment` finalizes args, redirect targets, and here-strings (`restoreExpansion`). Without this, JSON in variables lost its quotes and `$(echo '$HOME')` expanded. `"$@"` is left alone (it relies on embedded quotes).
- A loop, `if`, `case`, or subshell can head a pipeline (`for …; done | tail -1`): `splitTopLevelPipes` finds the pipe after the closing keyword and `runHeadedPipeline` feeds the head's output to the rest. Redirections after `done`/`fi`/`esac` (`< in`, `> out`, `2>&1`) are applied by `splitCompoundRedirects`. `printf` (except `-v`) is the regular command, so redirects and pipes apply; `ctx.stdoutIsTTY` is false for piped/redirected commands (`ls` then prints one name per line).
- Node scripts end like node on an empty event loop: after the synchronous part, the runner waits until nothing tracked is in flight (`fetch`, `fs.promises`, timers; see `node-compat/activity.ts`) and output has been quiet for 60–150 ms, with the old 10 s ceiling as a fallback. Missing Node APIs come from `auto-stub.ts`, which logs `[AutoStub] called missing …` the first time; a stubbed callback API never calls back, so check the console for these when something hangs.
- ES modules with top-level await run as async functions; static imports in async modules and `import()` wait for the imported module's body (`requireModule.ready`, `compileAsyncModule` in `node-compat/require.ts`). esbuild code-split chunks (they import `__esm`/`__export`… from a sibling) get live import bindings and getter exports (`src/commands/jseval/esm-live.ts`); Gemini CLI depends on both. The node runner's script timeouts end only idle scripts (nothing in flight, no new output).
- Agent CLIs scoreboard (Codex, Grok Build, Gemini CLI, native Claude Code, agy, opencode): docs/COMPAT.md "Agent CLIs"; `agent-cli-probe.test.ts` runs a native one in Blink under Node. Bun and Go-with-SSE4 binaries need SSE4.1/4.2 in Blink, which it lacks; `curl -o` writes bytes unchanged.
- `require('sharp')` is a browser-backed implementation (`shims/browser-sharp.ts`: createImageBitmap + canvas, real metadata/resize/JPEG/PNG/WebP). Claude Code's image loader is patched to use it; its bundled native/sharp path stalled image Reads.
- Builtins and shell functions write straight to the writers passed to `execute()`. When a segment feeds a pipe or has output redirects, the pipeline loop swaps in capture writers (`startCapture`) and, once the builtin `continue`s, runs the captured text through the same `applyOutputRedirects` as regular commands (`flushCapture`). Functions, `eval`, `sh -c`, aliases, `exec`, `builtin`, and `time` get the segment's stdin through `injectedStdin` (the next `execute()`'s first command; `executeWithStdin` is the public form), and functions/brace groups also set `__PIPE_STDIN` so `read` inside them consumes it line by line.
- A shell that runs as a kernel process (`sh -c` spawned by a program, scripts via `runViaShell`) has `kernelStdio` (`src/shell-stdio.ts`): its fds are its stdio. `liveStdin()` says whether a segment reads fd 0 (no pipe, here-doc, `<`, injected string or `__PIPE_STDIN`); then `read` takes one record from fd 0, `mapfile` reads it all, registered commands go through `execLazyStdin` (ctx.stdin read on first use, the command re-run), and kernel programs get the fds (`runKernelPipeline` `fds`) when the writers reach fd 1/2 (`writesTo` sees through `exec >` routing). Anything that hands a fork a string stdin must clear the fork's `kernelStdinLive` (`executeWithStdin`/`setInjectedStdin` do).
- A pipeline with a loop/if/case/`{ …; }` after the first segment (`echo y | while read l; …`) is split with `splitTopLevelPipes` before expansion, and those segments are left unexpanded so loop variables expand per iteration. Brace groups run in the current shell, take redirects after `}` (`compoundEnd` knows `{`/`}`), and can head or sit inside a pipeline; a `( … )` subshell can follow a pipe.
- `read` takes its own `<<<` and `< file` before the enclosing loop's piped stdin. Bare `set` lists variables. Code that uses expanded text without `parseSegment` (`evalTest`, heredoc bodies, `for` lists, `case` words, compound redirect targets) must `restoreExpansion` it.
- Assignment values aren't word-split: `quoteAssignmentValues` double-quotes simple unquoted values that expand something (`y=$x`, `export P=$HOME/bin:$PATH`, `local q=${x:-a b}`) before expansion. `a=1 b=2` sets both. Known gap: a heredoc body is expanded before the rest of its line runs, so `x=1; cat <<EOF … $x` sees the old `x`.
- Node scripts stream stdout to the terminal only when the shell says stdout is a TTY (`ctx.stdoutIsTTY`; false when piped or redirected), so `node x.js | grep` and `> file` work at the prompt; `process.stdout.isTTY` follows it. Buffered output keeps each entry's own newlines (`console.log` adds one, `stdout.write` doesn't). stderr still streams.
- `timeout DURATION CMD…` really runs CMD (in a forked shell, with stdin and the terminal) and exits 124 after aborting it when time runs out; its options end at DURATION. It used to only print `Command: …`.
- The large-bundle ESM transform (`transformBundledESM`, files over 500 KB, including Claude Code's `cli.js` and typescript's `_tsc.js`) only rewrites `import`/`export` where the match starts in code: `codeMask` marks strings, templates, comments, and regex literals. Before it, message strings like `"export import"` were rewritten and typescript failed to load. `process.exit()` thrown while a module loads propagates instead of becoming "Error loading module".
- npm version ranges follow npm semver (`src/utils/semver-utils.ts`): partial versions are x-ranges (`typescript@5.7` → newest 5.7.x), `||`, hyphen ranges, and comparator sets work, and prereleases only match ranges that name one.
- Per-command env (`NAME=value cmd`) is applied for that pipeline only (`splitEnvPrefix` in `shell.ts`), and `>&2`/`1>&2` duplicate onto stderr left to right, as in bash.
- Multi-line source (scripts, `source`, `sh -c`, multi-line input) is cut into complete statements by `groupStatements` (`src/shell-statements.ts`), which tracks quotes, `(`/`$(`, `for/while/until…done`, `if…fi`, `case…esac`, `{…}`, here-docs and trailing `|`/`&&`/`\`, and joins a statement's lines into the one-line form the executor runs (`; ` where a newline separates commands, a space after `do`/`then`/`{`/`;;`/a case pattern). Comments are removed first by `stripComments` (`src/shell-comments.ts`): POSIX rules for scripts/`source`/`eval`/`sh -c`; at the prompt (`shell.execute` at depth 0) only `# ` or a trailing `#` starts a comment, so `page click #btn` keeps its selector.
- `sh FILE`, `bash FILE`, `./script`, `sh -c` and `$(…)` run in a forked child `Shell` (`executeShellScript`/`runScriptText`, `subshellExec`): their variables, functions, traps, `cd` and `exit` stay inside. `exit [N]` throws `ExitSignal`, caught by the shell's outermost `execute()` (or `runScriptText`), which runs the EXIT trap. `set -e` throws `ExitSignal` from `checkErrexit`, except inside if/while/until conditions (`errexitSuppressed`), non-final `&&`/`||` members and `!` pipelines. `execute()` restores `executeDepth` when break/return/exit unwind through it.
- Unquoted `$VAR`/`${VAR}`/`$N` are field-split on `IFS` by `splitFields` (blanks inside a field become private-use stand-ins, empty fields `''`); `''`/`""` are real empty arguments.
- Conformance suites live in `tests/conformance/` (`npm run conformance` → `docs/CONFORMANCE.md`); see its README before adding a suite.
- Arrays: indexed arrays are sparse JS arrays (holes = unset elements; `shell-arrays.ts` helpers), associative ones `Map`s. `a=(…)`, `a+=(…)`, `a[i]=v` and `declare/local … a=(…)` are taken from the raw text by `tryArrayAssignment` before expansion, so each element keeps its quoting; `"${a[@]}"`/`${!a[@]}`/slices/per-element operators go through `expandArrayRef`. Use `getVar`/`setVar` (they handle `NAME[SUB]`, namerefs, readonly) rather than `env[...]` for anything that may be an array.
- Arithmetic is `src/utils/arith.ts` (bash grammar, 64-bit BigInt, variables holding expressions, `a[i]` lvalues) through `evalArithBig`/`arithEnv`; an error throws `ArithError` (`((…))`/`let` return 1). Command substitutions expand before `$((…))`, so `$(…)` and backticks work inside it.
- Expansion errors: a bad substitution (`validParamExpansion`) or a `$((…))` error throws `LineAbort`, which `runScriptText` turns into status 1 for that line only (the script goes on, as in bash); `${x?msg}` and nounset throw a plain `Error`, which ends the script with status 1 (its output kept). In `( … )` either ends only the subshell. Inside `"…"` the word of `${x-word}` is double-quoted (its `"` only group, `'` is literal).
- `break`/`continue` act only inside a loop of the current shell (`loopDepth`; 0 in a function body or subshell), and top-level `return` is status 2 (`canReturn`: a function, a sourced file, or a subshell of either).
- `[[ … ]]` is parsed from raw text by `shell-dbracket.ts` (operands expanded without splitting; `==` patterns keep quoted parts literal with extglob on; `=~` is a POSIX ERE via `utils/posix-regex.ts`). `parseCompound`/`splitTopLevelPipes`/`groupStatements` treat `[[ … ]]` and `${…}` as single words.
- `read` is `shell-read.ts` (bash's IFS splitting and backslash rules). Redirections: `parseSegment` makes `Redirect`s (`N>`, `N>&M`, `{name}>`, `<>`, `&>`); `applyOutputRedirects` follows where fd 1 and 2 point left to right; `exec` with only redirections changes `userFds`, and `execute()` routes default output through them. A quoted or escaped `< >` (like quoted glob chars) carries the `\x01` marker so it's a word, not a redirection; data `\x01` bytes travel as `\uE00D`.
- Pipeline elements: compound commands (`{ }`, loops, `( )`) and state-changing builtins (`PIPELINE_SUBSHELL_BUILTINS`: cd, eval, export, exit …) run in a forked subshell (`inSubshell`), except the last with `shopt -s lastpipe`; `read`/`mapfile` deliberately still set variables in this shell. Background `cmd &` (also mid-line) runs in a fork; `$!` is a made-up pid for in-page jobs.
- cd keeps the working directory physical (the filesystem only follows a symlink as a path's last component) and the logical path in `$PWD`/`shell.logicalPwd`, which `pwd` prints.
- Known gaps (see docs/CONFORMANCE.md): output is a JS string, so bytes ≥ 0x80 written through a pipe or `>` are UTF-8 encoded (`printf '\377' | wc -c` is 2; the compressors undo this for their own formats); alias expansion happens after expansion, not at parse time; `$LINENO` inside functions/loops; `/proc/self` is the page, not the calling process; every variable is exported (no `export -n`/export attribute); `cmd > f` writes `f` after `cmd` finishes, so a command that writes `f` itself is overwritten; the command hash table (`hash`) isn't kept; no hard links (`ln` without `-s`, `cp -l`, tar's hard-link members).
- Keep docs unified: update `AGENTS.md` first, keep `CLAUDE.md` as a shim.
