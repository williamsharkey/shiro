# Compatibility scoreboard

What popular Unix software runs in Shiro, by which route, and how it was
checked. Each row has an automated smoke test; sections are owned by the
workstream named in their heading, so append rows to your own section.

Routes: **pkg** = `pkg install` of a WASM build (recipe under
`scripts/pkgbuild/`, sha256-pinned), run as a kernel process; **builtin** =
implemented in Shiro (TypeScript); **Blink** = static x86-64 Linux ELF in the
Blink engine.

## Languages and toolchains (unix/compat-dev)

Smoke tests: `tests/tests/shiro-vitest/compat-dev.test.ts` (kernel processes
in Node worker threads). Browser checks: `scripts/browser-check.mjs` against a
built app in headless Chromium, cross-origin isolated.

| Software | Version | Route | Status | Tested | Known issues |
| --- | --- | --- | --- | --- | --- |
| python3 (CPython) | 3.13.7 | pkg `python3` (`python3.sh`: upstream WASI port + zlib + sqlite3; stdlib as a 4.3 MB zip of .pyc) | works | `-c`, `--version`, zlib/sqlite3/json/hashlib/decimal, `#!/usr/bin/env python3` scripts with argv/stdin/files, a package + `python -m unittest -v`; in Chromium: start-up ≈0.25 s | no subprocess, sockets, ssl, ctypes, threads (WASI preview1); REPL needs blocking stdin |
| pip | Shiro (pip-compatible CLI) | builtin `pip`/`pip3`/`python3 -m pip` | works for pure-Python wheels | resolver with PEP 440/508 (specifiers, markers, extras, pre-releases), console scripts, `-r`, `--target`, `-U`, uninstall/list/freeze/show/download, sha256 check; fake index in vitest, real PyPI in Chromium (`six`, `attrs`, `requests` + deps) | no sdists (needs a build backend run), no native wheels, no `-e` |
| venv | Shiro | `python3 -m venv` | works | `pyvenv.cfg`, `bin/python` symlinks, `bin/pip`, `activate`/`deactivate`; `sys.prefix` is the venv and pip installs into it (vitest and Chromium) | `--copies` ignored (always symlinks) |

Shell and platform fixes these needed (all with tests in the same file):

- Shebangs: `#!/usr/bin/env NAME` (with `-S` and `VAR=value`) and absolute
  interpreters run any builtin, installed package or script on PATH; an
  interpreter missing on disk falls back to the command of that name; a
  missing one is `bad interpreter`, exit 126.
- Sourced files and scripts group multi-line `name() { … }` bodies and
  `{ … }` groups; a sourced file starting with a comment ran nothing.
- `${1:-x}` (positional parameters with operators), `[ ! a = b ]` inside
  `if`, and `awk -f progfile`.
- Packages can ask for argv[0] to be the absolute path they were found at
  (`"argv0": "path"`), which CPython needs to find a venv.
- Builds: the entry chunk was both inlined into index.html and imported
  from its file by lazy chunks, so every module in it existed twice with
  separate state (`pkg install` updated one copy of the package cache, the
  shell read the other). The inline script now only imports the file.
