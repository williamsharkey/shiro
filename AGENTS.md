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
- `src/wasi-runtime.ts` + `src/wasi-packages.ts`: Tier 2 WASI support.
- `src/x86/*`: Tier 3 x86-64 emulator.
- `src/commands/seed.ts`, `src/commands/hc.ts`, `src/seed-runtime-context.ts`: seeded sessions, host-page access, runtime orientation.
- `src/claude-config.ts`, `src/node-compat/preload.ts`, `src/node-compat/process.ts`: Claude bootstrap, auth persistence, startup defaults.
- `server.mjs`: static hosting, API proxying, OAuth callback, signaling, relay.

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
- Scripts run through bin symlinks execute under their real path (`shell.ts` → `fs.realpath`), so Claude-specific preload/env tweaks key off `/@anthropic-ai/claude-code/`.
- Claude's `tui` setting is seeded to `fullscreen` (alt-screen renderer). The classic renderer leaves stale frames in scrollback when the window is resized or a frame is taller than the terminal.
- Commands run through the `child_process` shim execute in a forked shell with no terminal, so their output returns to the caller instead of painting over Claude's UI.
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
- `git config` supports get/set/`--list`/`--unset`, local and `--global` (`~/.gitconfig`). Commit authors come from repo config, then `~/.gitconfig`, then `GIT_AUTHOR_*`.
- `gh` (`src/commands/gh*.ts`) follows the real CLI's flags where implemented: `auth` (status/login/logout/token/setup-git), `repo` (view `--json`, list, create `--source --push`, clone, delete `--yes`), `api` (`-q/--jq`, `-f/-F`, `-X/--method`), `pr`, `issue`, `release`, `workflow`, `run`, `label`, `search`.
- Known gaps: git only works from the repository root (no upward `.git` discovery), and `git log --oneline` prints full messages.

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

Production is `https://shiro.computer` on a DigitalOcean droplet. `deploy.sh` handles build, upload, and restart, and it is the only place that should bump `build-number.txt`.

## Gotchas

- `child_process` is shimmed. There is no real process tree.
- Most filesystem work is async under the hood even when sync APIs are emulated.
- Background-task-heavy or highly concurrent agent flows can stall in the browser runtime.
- `seed` and `seed blob` are not equivalent. Preserve their runtime-context differences.
- Per-command env (`NAME=value cmd`) is applied for that pipeline only (`splitEnvPrefix` in `shell.ts`), and `>&2`/`1>&2` duplicate onto stderr left to right, as in bash.
- `ls` prints columns even when piped.
- Keep docs unified: update `AGENTS.md` first, keep `CLAUDE.md` as a shim.
