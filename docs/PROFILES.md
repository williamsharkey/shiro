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
| `preinstall` | installed in the background after boot (`claude-code`: the pinned npm build; other names are `pkg` packages, skipped when installed or when every path the package links already exists) | claude-code, ca-certificates | claude-code, ca-certificates |
| `shims.claude` | what plain `claude` runs and `claude install` installs: `npm` (the pinned JS build) or `native` (Anthropic's binary, in the x86-64 engine); `--npm`/`--native` or `CLAUDE_NATIVE=0/1` pick the other | npm | native |
| `shims.claudeInstallSh` | `curl claude.ai/install.sh` returns a stand-in that npm-installs the pinned build | on | on |
| `shims.tabSsh` | `ssh CODE` is the tab-to-tab ssh over WebRTC (`remote start`); off, every `ssh` is OpenSSH | on | on |
| `shims.binCommandStat` | builtins stat as executables in `/bin`, `/usr/bin` for WASM and x86 programs searching PATH | on | on |
| `shims.debianOverlay` | Debian mode diverts hot programs to the builtins by default (`src/debian/overlay-policy.json`); off, Debian's own stay | on | on |
| `shims.python` | `cpython`: `python`/`python3`/`pip` install the CPython package (`pkg install python3`) on first use and run it, after which its links shadow them; `pyodide`: they are the Pyodide builtins until a package shadows them; `package`: only `pkg`/`apt` python3. Pyodide is `pyodide` in every case | cpython | cpython |

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

- `DEFAULT_MIRROR` (src/pkg-manager.ts, `https://tabcomputer.com`): where
  packages come from when the page isn't served with them.
- `getShiroOrigin()` (src/utils/shiro-origin.ts): the API/proxy origin for
  embedded and seeded pages.
- The relay's default allowed origins in server.mjs (`*.shiro.computer`).
  Each deployment sets `TABCOMPUTER_TCP_ORIGINS` in its server.env.
- The HUD's displayed host (src/terminal.ts) shows `*.shiro.computer`
  subdomains specially. That is display, not behavior.

## Splitting into repos later

The boundary above is meant to make a split mechanical:

1. **The engine as a package** (`@shiro/engine`: today's `src/` minus
   `src/profile.ts`'s two JSON imports, plus `server.mjs` as `createServer`):
   it takes a profile object at boot (`setActiveProfile`) and a profile list at
   server start (`profileFor(host, override, profiles)` already takes one).
2. **A product as a thin app**: its `profile.json`, `server.env`, deploy
   scripts (`deploy/tabcomputer/`; shiro.computer's `deploy.sh` is in its repo), its brand assets, and an entry
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

**Renamed outright, no migration (a hard cut).** tabcomputer.com had only test
data, so nothing is carried over from the old names:

| Old | New |
| --- | --- |
| localStorage/sessionStorage `shiro-*`, `shiro_*` (`shiro_github_token`, `shiro-ui`, `shiro-desktop-session`, `shiro-profile`, …) | `tabcomputer-*`, `tabcomputer_*` |
| IndexedDB `shiro-fs` (the filesystem), `shiro-x86-cache`, `shiro-wasm-cache`, `shiro-pkg-cache`, `shiro-cc-cache` | `tabcomputer-fs`, `tabcomputer-x86-cache`, … |
| Cache Storage `shiro-debian-chunks-v1`, `shiro-debs-v1` | `tabcomputer-debian-chunks-v1`, `tabcomputer-debs-v1` |
| `window.__shiro`, `globalThis.__shiroKernel` | `window.__tabcomputer`, `globalThis.__tabcomputerKernel` |
| `SHIRO_*` environment variables (server, page, tests, scripts, bench) | `TABCOMPUTER_*` |
| `/opt/shiro` on a host | `/opt/tabcomputer` |

**Left as they are, and why:**

- Names inside users' installed Debian systems. These are `/var/lib/shiro/*` (`alternatives.json`,
  `rootfs.json`) and the kernel programs `shiro-apt-method`, `shiro-apt-store` and
  `shiro-dpkg-preconfigure`, which installed files name in `#!` lines. Renaming them needs a
  rootfs migration.
- Names compiled into wasm builds: Blink's `SHIRO_BLINK_CRASH` and `SHIRO_BLINK_PROBE`
  guest variables (`vendor/blink/patches`, `shiro-net.js`, `shiro-kernel.js`), and
  `SHIRO_LLVM_WASM` in the clang driver. They change with the next
  `vendor/blink/build.sh` or LLVM package build.
- Wire and page-internal names: postMessage types, BroadcastChannel names
  (`shiro-oauth-callback`), DOM ids and CSS classes (`#shiro-panes`),
  the other `__shiro…` page globals (`__shiroDesktop`, `__shiroNet`, …), and the
  `shiro://cmd/` terminal links.
- The `shiro-mcp` package name (it now reads `TABCOMPUTER_SIGNALING_URL`).
- Infrastructure URLs on shiro.computer: `/bins`, the
  WebRTC signaling server and the GitHub OAuth app. They are real services, which
  tabcomputer.com mirrors where it serves them itself.
- Engine internals: TS constants such as `SHIRO_VERSION`, class and file names (`ShiroTerminal`, `shell.ts`,
  `shiro-cmds.ts`, `shiro-origin.ts`), the `src/kernel` API, the
  `tests/tests/shiro-vitest/` directory and the `@shiro/` import alias. They are
  invisible to users. Renaming them is churn that conflicts with every
  branch in flight, so it is better done once the parallel work has landed.
