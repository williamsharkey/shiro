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
- `src/wasi/*`: WASM programs as kernel processes (see "WASM Processes" below). `src/wasi-runtime.ts` is the old in-page runtime, kept as the fallback; `src/wasi-packages.ts` is the WASM package registry.
- `src/x86-engine/*` + `public/engines/blink/` + `vendor/blink/`: x86-64 Linux ELF in Blink (wasm), as kernel processes; `src/x86/*` is the fallback interpreter when the page isn't cross-origin isolated. See `docs/X86_ENGINES.md`.
- `src/kernel/*`: Unix kernel core (process table, fd tables, pipes, syscall dispatch, SAB syscall channel for Worker guests). Contract: `docs/KERNEL_ABI.md`; roadmap: `docs/UNIX_COMPAT.md`. `window.__shiro.kernel`; kernel processes show in `ps`.
- `src/commands/seed.ts`, `src/commands/hc.ts`, `src/seed-runtime-context.ts`: seeded sessions, host-page access, runtime orientation.
- `src/claude-config.ts`, `src/node-compat/preload.ts`, `src/node-compat/process.ts`: Claude bootstrap, auth persistence, startup defaults.
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
- `wasi-guest.ts` implements WASI preview1 once, as generators yielding kernel syscalls; `runSync` (Worker) and `runMaybeAsync` (JSPI) drive them. Path calls use the kernel's `*at` syscalls with the WASI dirfd; preview1 `sock_accept/recv/send/shutdown` map to accept4/recvfrom/sendto/shutdown (WASIX `sock_open`/`sock_connect` are not implemented). Other wasi/wasix imports become ENOSYS stubs so binaries still instantiate.
- Spawning from WASM uses WASIX `wasix_32v1` (`proc_spawn3`/`proc_spawn2`, `proc_exec*` emulated as spawn+wait+exit, `proc_join`, `fd_pipe`, `fd_dup`, `getcwd`/`chdir`) mapped onto `SYS_spawn` with `inherit: true`; dup2/open file actions become fd overrides, and a close action marks the parent fd close-on-exec for the duration of the spawn. Children can be WASM (`installWasmLoader`: by path or `NAME`/`NAME.wasm` on PATH) or Shiro builtins.
- wasi-threads: `wasi.thread-spawn` is `SYS_wasi_thread_spawn` (1100, registered by `host.ts` with `kernel.registerSyscalls`), answered with the kernel's `attachThread`, so each thread is a Worker with its own channel and kernel tid; a returning thread sends `SYS_exit`. Shared memory limits come from the binary's import section (`wasm-imports.ts`). WASIX `futex_wait/wake` use `Atomics.wait/notify` on the shared memory.
- Browsers refuse `TextDecoder.decode` on views of a SharedArrayBuffer (Node allows it, so vitest misses it): copy, or use `decodeText()` from `src/kernel/abi.ts`.
- Tests: `tests/tests/shiro-vitest/kernel-wasi.test.ts`. Fixtures are freestanding C (no wasi-sysroot needed; `fixtures/wasi/build.sh`), plus a Go `GOOS=wasip1` program built at test time when Go is installed.

## Node Processes Share The Page

- Every `node` script runs in the same page as the shell and every other script. Claude Code runs for hours while its tool calls start and finish other scripts, so a script must never remove globals on exit that another might still use. `setImmediate` is polyfilled once and never removed; deleting it from a finishing child hung Claude's Bash tool.
- When a script exits it restores `fetch`/`setTimeout`/`clearTimeout` only if the global is still the one it installed (`restoreGlobals` in `execution.ts`). Restoring blindly let `~/.profile`-launched autostart scripts clobber Claude's Node-style `setTimeout`, and Claude crashed with `.unref is not a function` on the first message.
- The terminal skips its startup prompt when `~/.profile` launched a command through `injectInput`; that command prints the prompt when it finishes.
- The module transform still assigns global `setTimeout`/`setInterval` wrappers for some bundles without restoring them. It's harmless so far, but it has the same problem.

## Build, Test, Deploy

```bash
npx tsc --noEmit
cd tests && npm run test:shiro
npm run build
npm run deploy
```

Use focused vitest runs while iterating, then run the smallest meaningful verification set before deploy. For changes touching seed/Claude/bootstrap paths, relevant files usually include:

- `tests/tests/shiro-vitest/seed.test.ts`
- `tests/tests/shiro-vitest/seed-runtime-context.test.ts`
- `tests/tests/shiro-vitest/claude-bootstrap.test.ts`
- `tests/tests/shiro-vitest/node-runtime.test.ts`
- `tests/tests/shiro-vitest/new-features.test.ts`
- `tests/tests/shiro-vitest/server-cors.test.ts`

Production is `https://shiro.computer` on a DigitalOcean droplet. `deploy.sh` handles build, upload, and restart, and it is the only place that should bump `build-number.txt`. nginx on the host sets `client_max_body_size 100m` (`/etc/nginx/sites-enabled/shiro`): the 1 MB default rejected long Claude conversations and GitHub blob uploads with 413. `deploy.sh` uploads only `server.mjs`; the host's own `/opt/shiro/package.json` holds its deps (`ws`, and `undici` so proxied model calls have no 5-minute header timeout). Each model call logs one `[proxy] messages model=… stream=… bytes=… → status headers in Nms` line (`journalctl -u shiro`).

## Terminals And Signals (kernel, phase 3)

- `src/kernel/pty.ts`: `Pty` is a master/slave pair with Linux termios (36-byte `struct termios`, `winsize`), the n_tty line discipline (canonical editing, echo, ISIG, VMIN/VTIME, IXON), OPOST/ONLCR, and the tty ioctls (TCGETS/TCSETS*, TIOCGWINSZ/TIOCSWINSZ, TIOCSCTTY, TIOCGPGRP/TIOCSPGRP, FIONREAD, ...). Calls that need the caller's identity take an optional trailing `caller` or ask `setTtyCallerResolver`. Background reads get SIGTTIN (writes SIGTTOU with `tostop`); a stopped caller waits inside the call and retries when continued, which is the syscall restart.
- `src/kernel/signals.ts`: Linux signal numbers, `SignalState` (dispositions, mask, pending), and `jobControl` (process groups, sessions, `kill`, stop/continue, SIGCHLD, orphaned groups, `waitJob`). Stopping is cooperative: stopped processes don't get syscall replies (`whileStopped`). `createSignalTarget` makes an in-page process.
- `attachKernelTty(kernel)` (main.ts, at boot) adopts every kernel `Process` into `jobControl` (`kernel.onSpawn`): its `signalHook` routes all delivery there, `proc.dispositions`/`sigmask`/`deferredSignals` back its `SignalState` (so `rt_sigprocmask`/`kernel.setSigmask` deliver held signals), kernel-side stops and exits become job events, and the `AbortSignal` the kernel passes to `read`/`write`/`ioctl` identifies the caller (`Process.fromSyscallSignal`) for SIGTTIN/SIGTTOU and TIOCSCTTY. It also registers `/dev/ptmx` and `/dev/pts/N`. `TtySession.spawnJob(kernel, …)` binds the session to an idle `-sh` kernel session leader (ctty = the pty) and spawns the job in a new group under it; the leader reaps children on SIGCHLD.
- Every `ShiroTerminal`/`WindowTerminal` owns a `TtySession` (`terminal.tty`): the pty plus a session-leader process standing in for the shell. Keystrokes go to the pty only while a kernel job is in the foreground (`tty.jobInForeground`); otherwise the shell's own line editor handles them as before. Resizes call `tty.resize` (SIGWINCH to the foreground group).
- Programs typed at the prompt that are WASM (`NAME.wasm` on PATH, `#!wasi-pkg` stubs) or x86-64 ELF (`#!x86-pkg` stubs, ELF files) run as kernel processes (`src/shell-kernel.ts`, called from the pipeline loop's `tryKernelRun`): consecutive such segments are spawned together joined by kernel pipes, in one process group under the terminal's pty session (`tty.spawnJob`), and waited for with `runKernelJob`. Filter builtins piped to or from them (cat, grep, tr, wc, sed, ... — `PIPE_FILTERS`) join the same job as kernel processes through `kernel.runBuiltin`, over real pipes; other builtin segments feed the run and read its output as strings. `prog &` (all kernel stages) is a real background job; in-page `&` jobs get the terminal without its `tty` so nothing inside them takes the foreground. WASM needs `wasmProcessMode() !== 'none'` (SAB+Worker or JSPI), otherwise the old in-page runtime runs it; x86 always runs as a kernel process (`src/x86/kernel-runner.ts`: blocking stdin on fd 0, stop at syscalls, killed via an AbortSignal, yields every 1M instructions).
- Shell job control for kernel jobs: `runKernelJob` in `src/commands/jobs.ts`; Ctrl-Z puts the job in `backgroundJobs` as `stopped`, and `fg`/`bg`/`jobs`/`kill %N`/`wait` signal and wait on its process group. Plain in-page `&` jobs are promises that can only be aborted.
- `kill` is one implementation (`src/commands/trap.ts`, re-exported by `ps.ts`) with bash's options; `stty` reads and sets the terminal's pty (a per-shell detached pty when there is no terminal); `tput lines/cols` use the pty size, overridden by `LINES`/`COLUMNS`.

## Gotchas

- Blink engine: rebuild `public/engines/blink/blink.{mjs,wasm}` with `vendor/blink/build.sh` after changing `vendor/blink/patches/` or `shiro-net.js`; don't hand-edit the generated files. `host.mjs` is hand-written. Browsers refuse `TextDecoder.decode()` on SharedArrayBuffer views (Node doesn't), so decode a `.slice()` of channel data.

- `child_process` is shimmed. There is no real process tree.
- Most filesystem work is async under the hood even when sync APIs are emulated.
- `FileSystem` reopens IndexedDB when the browser closes the connection (`onclose`/`onversionchange`, or an `InvalidStateError` from `transaction()`), retrying the request once. Writes resolve on transaction commit, and `fs.pendingWrites` makes `beforeunload` warn before leaving mid-write.
- Background-task-heavy or highly concurrent agent flows can stall in the browser runtime.
- `seed` and `seed blob` are not equivalent. Preserve their runtime-context differences.
- Expansion results are data: `$VAR`, `${NAME}`, `$1`–`$9`, and `$(...)`/backtick output have their quotes, `\`, `$`, backticks, and `| < > & ;` swapped for private-use stand-ins (`protectExpansion` in `shell.ts`) before the command text is tokenized, and swapped back when `parseSegment` finalizes args, redirect targets, and here-strings (`restoreExpansion`). Without this, JSON in variables lost its quotes and `$(echo '$HOME')` expanded. `"$@"` is left alone (it relies on embedded quotes).
- A loop, `if`, `case`, or subshell can head a pipeline (`for …; done | tail -1`): `splitTopLevelPipes` finds the pipe after the closing keyword and `runHeadedPipeline` feeds the head's output to the rest. Redirections after `done`/`fi`/`esac` (`< in`, `> out`, `2>&1`) are applied by `splitCompoundRedirects`. `printf` (except `-v`) is the regular command, so redirects and pipes apply; `ctx.stdoutIsTTY` is false for piped/redirected commands (`ls` then prints one name per line).
- Node scripts end like node on an empty event loop: after the synchronous part, the runner waits until nothing tracked is in flight (`fetch`, `fs.promises`, timers; see `node-compat/activity.ts`) and output has been quiet for 60–150 ms, with the old 10 s ceiling as a fallback. Missing Node APIs come from `auto-stub.ts`, which logs `[AutoStub] called missing …` the first time; a stubbed callback API never calls back, so check the console for these when something hangs.
- `require('sharp')` is a browser-backed implementation (`shims/browser-sharp.ts`: createImageBitmap + canvas, real metadata/resize/JPEG/PNG/WebP). Claude Code's image loader is patched to use it; its bundled native/sharp path stalled image Reads.
- Builtins and shell functions write straight to the writers passed to `execute()`. When a segment feeds a pipe or has output redirects, the pipeline loop swaps in capture writers (`startCapture`) and, once the builtin `continue`s, runs the captured text through the same `applyOutputRedirects` as regular commands (`flushCapture`). Functions, `eval`, `sh -c`, aliases, `exec`, `builtin`, and `time` get the segment's stdin through `injectedStdin` (the next `execute()`'s first command; `executeWithStdin` is the public form), and functions/brace groups also set `__PIPE_STDIN` so `read` inside them consumes it line by line.
- A pipeline with a loop/if/case/`{ …; }` after the first segment (`echo y | while read l; …`) is split with `splitTopLevelPipes` before expansion, and those segments are left unexpanded so loop variables expand per iteration. Brace groups run in the current shell, take redirects after `}` (`compoundEnd` knows `{`/`}`), and can head or sit inside a pipeline; a `( … )` subshell can follow a pipe.
- `read` takes its own `<<<` and `< file` before the enclosing loop's piped stdin. Bare `set` lists variables. Code that uses expanded text without `parseSegment` (`evalTest`, heredoc bodies, `for` lists, `case` words, compound redirect targets) must `restoreExpansion` it.
- Assignment values aren't word-split: `quoteAssignmentValues` double-quotes simple unquoted values that expand something (`y=$x`, `export P=$HOME/bin:$PATH`, `local q=${x:-a b}`) before expansion. `a=1 b=2` sets both. Known gap: a heredoc body is expanded before the rest of its line runs, so `x=1; cat <<EOF … $x` sees the old `x`.
- Node scripts stream stdout to the terminal only when the shell says stdout is a TTY (`ctx.stdoutIsTTY`; false when piped or redirected), so `node x.js | grep` and `> file` work at the prompt; `process.stdout.isTTY` follows it. Buffered output keeps each entry's own newlines (`console.log` adds one, `stdout.write` doesn't). stderr still streams.
- `timeout DURATION CMD…` really runs CMD (in a forked shell, with stdin and the terminal) and exits 124 after aborting it when time runs out; its options end at DURATION. It used to only print `Command: …`.
- The large-bundle ESM transform (`transformBundledESM`, files over 500 KB, including Claude Code's `cli.js` and typescript's `_tsc.js`) only rewrites `import`/`export` where the match starts in code: `codeMask` marks strings, templates, comments, and regex literals. Before it, message strings like `"export import"` were rewritten and typescript failed to load. `process.exit()` thrown while a module loads propagates instead of becoming "Error loading module".
- npm version ranges follow npm semver (`src/utils/semver-utils.ts`): partial versions are x-ranges (`typescript@5.7` → newest 5.7.x), `||`, hyphen ranges, and comparator sets work, and prereleases only match ranges that name one.
- Per-command env (`NAME=value cmd`) is applied for that pipeline only (`splitEnvPrefix` in `shell.ts`), and `>&2`/`1>&2` duplicate onto stderr left to right, as in bash.
- Keep docs unified: update `AGENTS.md` first, keep `CLAUDE.md` as a shim.
