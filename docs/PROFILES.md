# Product profiles

One engine, two products:

- **shiro** (shiro.computer, `*.shiro.computer`): the full-page terminal,
  Claude Code first. The page keeps its own title.
- **tabcomputer** (tabcomputer.com, `*.tabcomputer.com`, and every other host,
  so localhost too): the Unix edition with the desktop, the TCP relay, Debian
  and native programs.

A **profile** is data, in `profiles/<id>/`:

| File | What it holds |
| --- | --- |
| `profile.json` | hosts, `ui`, `brand`, `banner`, `preinstall`, `shims` (below) |
| `server.env` | `server.mjs`'s environment on that product's host (tabcomputer's ships with each release; shiro.computer's lives in its systemd unit, the file documents it) |

The page picks the profile in `src/profile.ts` and `server.mjs` picks it in
`profileFor`. Both use the same host matching (`profiles/select.mjs`; server.mjs
carries a copy, because a release has only `dist/` and `server.mjs`).
`profiles.test.ts` checks the two choose alike. `?profile=ID` overrides the
host and is remembered (localStorage `tabcomputer-profile`); `?profile=` with no
value forgets it. `?ui=` still overrides the profile's UI mode on its own.

## profile.json

| Field | Meaning | shiro | tabcomputer |
| --- | --- | --- | --- |
| `name` | the product's name in messages, help, man pages, banners | Shiro | tabcomputer |
| `hostname` | the machine's hostname: prompt `\h`, `uname -n`, `/etc/hostname`, `/etc/os-release`, `os.hostname()`, git's default email | shiro | tabcomputer |
| `hosts` | host patterns (`example.com`, `*.example.com`) | shiro.computer, *.shiro.computer | tabcomputer.com, *.tabcomputer.com |
| `default` | serves hosts no profile names | | yes |
| `ui` | `terminal` or `desktop` (src/ui-mode.ts) | terminal | desktop |
| `brand` | name, domain, tagline, description: tab title, desktop wordmark, About, app shell `<title>` and Open Graph tags; `null` keeps the page's own | null | tabcomputer |
| `banner` | the terminal's startup banner: `hud` (full) or `desktop` (the desktop's compact welcome) | hud | desktop |
| `preinstall` | installed in the background after boot (`claude-code`: the pinned npm build) | claude-code | claude-code |
| `shims.claude` | what plain `claude` runs: `npm` (the pinned JS build) or `native` (the binary from `claude install --native`) | npm | npm |
| `shims.claudeInstallSh` | `curl claude.ai/install.sh` returns a stand-in that npm-installs the pinned build | on | on |
| `shims.tabSsh` | `ssh CODE` is the tab-to-tab ssh over WebRTC (`remote start`); off, every `ssh` is OpenSSH | on | on |
| `shims.binCommandStat` | builtins stat as executables in `/bin`, `/usr/bin` for WASM and x86 programs searching PATH | on | on |
| `shims.debianOverlay` | Debian mode diverts hot programs to the builtins by default (`src/debian/overlay-policy.json`); off, Debian's own stay | on | on |
| `shims.python` | `pyodide`: `python`/`python3`/`pip` are the Pyodide builtins until a package shadows them; `package`: only `pkg`/`apt` python3 | pyodide | pyodide |

Checks per product: the full suite runs as the default profile (`tabcomputer`;
`setActiveProfile` switches it, `profiles.test.ts` turns each shim off), and
`tests/browser/first-run.mjs` runs against both UIs: the desktop (default URL)
and the terminal (`?ui=terminal` or `?profile=shiro`), where it clicks the
HUD's `help` link and types the programs at the prompt.

Both profiles turn every shim on today. That is what the code did before
profiles: none of these were per host. A product changes behavior by editing
its `profile.json`, not code.

## Engine vs profile

Everything under `src/` is the engine: the kernel, filesystem, shell,
commands, node runtime, WASI and x86 engines, Debian mode, X11, the desktop
and terminal UIs. It must not look at the hostname to decide behavior. It asks
`activeProfile()` (or `uiMode()`, `BRAND`, which read it). The places that do:

| Engine code | Reads |
| --- | --- |
| `src/ui-mode.ts` | `ui` |
| `src/brand.ts` (desktop, About, Settings, tour) | `brand` (the default profile's when the active one has none) |
| `src/main.ts` | `banner`, `preinstall`, `shims.python` |
| `src/commands/claude.ts` | `shims.claude` |
| `src/commands/fetch.ts` | `shims.claudeInstallSh` |
| `src/commands/ssh.ts` | `shims.tabSsh` |
| `src/wasi/host.ts` | `shims.binCommandStat` |
| `src/debian/overlay.ts` | `shims.debianOverlay` |
| `server.mjs` | `hosts`, `brand` (app shell) |
| `src/kernel/kernel.ts`, `src/x86/syscalls.ts`, `src/shell.ts`, `src/filesystem.ts` (/etc), `src/commands/shiro-cmds.ts` (uname), `src/node-compat/modules/os.ts`, git's default email | `hostname`, `name` |

Still engine defaults, not product choices. They are candidates if a third
product needs them different:

- `DEFAULT_MIRROR` (src/pkg-manager.ts, `https://shiro.computer`): where
  packages come from when the page isn't served with them.
- `getShiroOrigin()` (src/utils/shiro-origin.ts): the API/proxy origin for
  embedded and seeded pages.
- The relay's default allowed origins in server.mjs (`*.shiro.computer`).
  Each deployment sets `TABCOMPUTER_TCP_ORIGINS` (or `SHIRO_TCP_ORIGINS`) in its server.env.
- The HUD's displayed host (src/terminal.ts) shows `*.shiro.computer`
  subdomains specially. That is display, not behavior.

## Splitting into repos later

The boundary above is meant to make a split mechanical:

1. **The engine as a package** (`@shiro/engine`: today's `src/` minus
   `src/profile.ts`'s two JSON imports, plus `server.mjs` as `createServer`):
   it takes a profile object at boot (`setActiveProfile`) and a profile list at
   server start (`profileFor(host, override, profiles)` already takes one).
2. **A product as a thin app**: its `profile.json`, `server.env`, deploy
   scripts (`deploy/tabcomputer/`, `deploy.sh`), its brand assets, and an entry
   that imports the engine, calls `setActiveProfile(profile)` and boots.
3. **What has to move with it**: `public/*.html` marketing pages (renamed to tabcomputer; shiro.computer's own copies are in its repo),
   `deploy/` (tabcomputer's), and the tests that pin a product's look
   (`desktop-wm.test.ts` brand checks, `tests/browser/first-run.mjs` per UI).

Until then, the profile files are the only per-product source, and adding a
product is a new `profiles/<id>/` plus its import in `src/profile.ts`.

## The rename

This repository is tabcomputer's (williamsharkey/tabcomputer); shiro.computer
is served from the Shiro repository. The `shiro` profile stays here so the
engine can still run as either product. Always write "tabcomputer": one word,
all lowercase.

**Renamed for users.** README, docs, `public/*.html`, package.json, the app
shell's `<title>`, the welcome text, `help`, man pages, error messages
(`tabcomputer: foo: No such file or directory`), version strings, the X
server's vendor, the x86 engine's User-Agent, and the Claude Code launch card.
The machine's identity comes from the profile's `name` and `hostname`
(`user@tabcomputer`). Strings that are not identity are plain text that says
tabcomputer, so the `shiro` profile shows them too. The Shiro repository keeps
its own copies.

New command names, with the old ones kept: `tabcomputer` (API keys,
`tabcomputer config set …`; was `shiro`) and `tabcomputer-alternatives` (was
`shiro-alternatives`; `--set NAME tabcomputer|debian`, and `shiro` is still
accepted as the side).

**Renamed with a migration (user data).** `src/legacy-storage.ts`, tested by
`legacy-storage.test.ts`:

| Old | New | How |
| --- | --- | --- |
| localStorage/sessionStorage `shiro-*`, `shiro_*` (`shiro_github_token`, `shiro-ui`, `shiro-desktop-session`, `shiro-profile`, …) | `tabcomputer-*`, `tabcomputer_*` | copied at boot (`src/boot-migrate.ts`, the first import in main.ts) when the new key doesn't exist. Old keys stay, so a tab still on an old build keeps working. Runs every boot and never overwrites. |
| IndexedDB `shiro-fs` (the filesystem) | `tabcomputer-fs` | copied once under a Web Lock, record count checked, then `shiro-fs` is deleted. If the copy fails (quota), the partial copy is dropped and the page keeps using `shiro-fs`. |
| `window.__shiro` | `window.__tabcomputer` | the same object under both names |
| `SHIRO_*` environment variables | `TABCOMPUTER_*` | the new name wins and the old one still works: `aliasEnv()` in server.mjs, `envVar()` (src/env-alias.ts) in the page, and the test setup |
| `/opt/shiro` on a host | `/opt/tabcomputer` | server.mjs uses `/opt/shiro` when only it exists |

**Left as they are, and why:**

- Re-downloadable caches. These are the IndexedDB `shiro-x86-cache`, `shiro-wasm-cache`, `shiro-pkg-cache` and
  `shiro-cc-cache`, and the Cache Storage `shiro-debian-chunks-v1` and `shiro-debs-v1`. Renaming
  them would only force a re-download and leave the old copies taking quota.
- Names inside users' installed Debian systems. These are `/var/lib/shiro/*` (`alternatives.json`,
  `rootfs.json`) and the kernel programs `shiro-apt-method`, `shiro-apt-store` and
  `shiro-dpkg-preconfigure`, which installed files name in `#!` lines. Renaming them needs a
  rootfs migration.
- Names compiled into the Blink build, such as the `SHIRO_BLINK_CRASH` and `SHIRO_BLINK_PROBE` guest variables
  and `shiro-net.js`. They change with the next `vendor/blink/build.sh`.
  `TABCOMPUTER_BLINK_STRACE` and `TABCOMPUTER_BLINK_DEBUG` already work.
- Wire and page-internal names: postMessage types, BroadcastChannel names
  (`shiro-oauth-callback`), DOM ids and CSS classes (`#shiro-panes`),
  `__shiroKernel`, and the `shiro://cmd/` terminal links. Seeded and embedded pages and
  older tabs talk to each other with them.
- The `shiro-mcp` npm package and its `SHIRO_SIGNALING_URL`, which is published separately.
- Infrastructure URLs on shiro.computer: `DEFAULT_MIRROR`, `/bins`, the
  WebRTC signaling server and the GitHub OAuth app. They are real services, which
  tabcomputer.com mirrors where it serves them itself.
- Engine internals: class and file names (`ShiroTerminal`, `shell.ts`,
  `shiro-cmds.ts`, `shiro-origin.ts`), the `src/kernel` API, the
  `tests/tests/shiro-vitest/` directory and the `@shiro/` import alias. They are
  invisible to users. Renaming them is churn that conflicts with every
  branch in flight, so it is better done once the parallel work has landed.
