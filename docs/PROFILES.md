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
host and is remembered (localStorage `shiro-profile`); `?profile=` with no
value forgets it. `?ui=` still overrides the profile's UI mode on its own.

## profile.json

| Field | Meaning | shiro | tabcomputer |
| --- | --- | --- | --- |
| `hosts` | host patterns (`example.com`, `*.example.com`) | shiro.computer, *.shiro.computer | tabcomputer.com, *.tabcomputer.com |
| `default` | serves hosts no profile names | | yes |
| `ui` | `terminal` or `desktop` (src/ui-mode.ts) | terminal | desktop |
| `brand` | name, domain, tagline, description: tab title, desktop wordmark, About, app shell `<title>` and Open Graph tags; `null` keeps the page's own | null | tabcomputer |
| `banner` | the terminal's startup banner: `hud` (full) or `desktop` (the desktop's compact welcome) | hud | desktop |
| `preinstall` | installed in the background after boot (`claude-code`: the pinned npm build) | claude-code | claude-code |
| `shims.claude` | what plain `claude` runs: `npm` (the pinned JS build) or `native` (the binary from `claude install --native`) | npm | npm |
| `shims.claudeInstallSh` | `curl claude.ai/install.sh` returns a stand-in that npm-installs the pinned build | on | on |
| `shims.tabSsh` | `ssh CODE` is the tab-to-tab ssh over WebRTC (`remote start`); off, every `ssh` is OpenSSH | on | on |
| `shims.binCommandStat` | Shiro builtins stat as executables in `/bin`, `/usr/bin` for WASM and x86 programs searching PATH | on | on |
| `shims.debianOverlay` | Debian mode diverts hot programs to Shiro builtins by default (`src/debian/overlay-policy.json`); off, Debian's own stay | on | on |
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

Still engine defaults, not product choices. They are candidates if a third
product needs them different:

- `DEFAULT_MIRROR` (src/pkg-manager.ts, `https://shiro.computer`): where
  packages come from when the page isn't served with them.
- `getShiroOrigin()` (src/utils/shiro-origin.ts): the API/proxy origin for
  embedded and seeded pages.
- The relay's default allowed origins in server.mjs (`*.shiro.computer`).
  Each deployment sets `SHIRO_TCP_ORIGINS` in its server.env.
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
3. **What has to move with it**: `public/*.html` marketing pages (shiro's),
   `deploy/` (tabcomputer's), and the tests that pin a product's look
   (`desktop-wm.test.ts` brand checks, `tests/browser/first-run.mjs` per UI).

Until then, the profile files are the only per-product source, and adding a
product is a new `profiles/<id>/` plus its import in `src/profile.ts`.
