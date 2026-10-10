# Agent experiments: building real projects inside tabcomputer

Research worker (unix/research), 2026-10-09. The question: when a coding agent
works *inside* tabcomputer, where does it hit limits, and which OS features
would it actually use? This includes the proposed "GitHub repos mounted as a
desktop smart folder".

**Method.** No vendor API key is available inside the guest for this
research, so I acted as the agent myself. I drove tabcomputer only through the
shell, the way Claude Code, Codex or aider would, through their Bash tool:
heredocs to write files, then test, read the failure, patch with `sed`, test,
commit. Every command ran in headless Chromium against https://tabcomputer.com
(production, cross-origin isolated), from a fresh browser profile, through
`run.mjs`, a copy of `scripts/browser-check.mjs` that adds per-command timeouts
and multi-line blocks. The command list is in "Reproducing" below. The
agent CLIs themselves are already scored in [COMPAT.md, "Agent
CLIs"](../COMPAT.md#agent-clis-unixagent-clis): Codex, Grok Build, Gemini CLI,
native Claude Code and aider all reach their APIs from tabcomputer.

Legend: **verified** = I ran it in tabcomputer and quote the result;
**read** = from docs or the web, not run.

## Experiment 1: a Python CLI with tests, git, branches and worktrees

The task was "write `wordfreq`, a CLI that prints the N most common words, with
unit tests; then add `--json` on a branch and merge it". It used only `pkg`
packages (`git python3 ripgrep make`, installed in 5.8 s).

| Step (as an agent would issue it) | Result | Wall time |
|---|---|---|
| `pkg install git python3 ripgrep make` | ok | 5.8 s |
| `git clone --depth 1 https://github.com/sindresorhus/is-plain-obj.git` (real git over the TCP relay) | ok | 11.1 s |
| write `wordfreq.py` and `test_wordfreq.py` with `cat > f <<'EOF'` | ok | <0.1 s |
| `python3 -m unittest -v` | 1 test failed, as designed (hyphenated words) | 0.8 s |
| patch with `sed -i`, rerun the tests | 5/5 pass | 0.4 s |
| `echo "To be or not to be" \| ./wordfreq.py -n 2` (shebang script) | ok | 0.2 s |
| `make test` | ok | 0.5 s |
| `git add -A && git commit` | ok | 3.6 s |
| `git checkout -b json-output`, edit, run, `git commit -a` | ok | — |
| `git worktree add ../wordfreq-main main` | ok, both trees listed by `git worktree list` | 1.5 s |
| `git merge json-output` in the second worktree, run the tests | ok (fast-forward, 5/5) | 2.5 s |
| `rg -n "def " --type py` | ok, but prints a `--` separator between every match (no context flags were given) | <0.1 s |
| `pip install pytest` (tabcomputer's pip, PyPI over fetch) | ok: pytest 9.1.1 and 4 deps | 3.1 s |
| `python3 -m pytest -q` | 5 passed | 4.3 s |
| second `git clone https://github.com/pallets/itsdangerous.git` | failed to connect: the test harness's proxy, not tabcomputer (see limit 3) | 3.9 s |

**Verdict: the inner loop is fast.** For a small Python or shell project
(edit, test, fix, commit, branch, worktree), every step took under 5 s, mostly
under 1 s, because `pkg`'s python3 and git are WASM/x86 builds that start
quickly. An agent would not notice it is in a browser.

### Limits an agent hits (verified)

1. **No file watching.** In Node, `fs.watch('.')` delivered **0 events** when
   a file in the directory was written. `inotifywait`, `entr` and `watchexec`
   are absent. So `nodemon`, `vite`/webpack HMR, `jest --watch`,
   `pytest-watch` and `tsc --watch` won't react to edits. Agents mostly re-run
   commands, so this hurts humans with dev servers more than agents, but it
   blocks the "agent edits, preview refreshes" loop. **Proposed fix:** the
   VFS already sees every write (`fs.onChange` is what the dock uses), so
   back `fs.watch`/`fs.watchFile` with it. Later, add a kernel inotify
   (`inotify_init1`/`inotify_add_watch`) for x86 and WASM guests.
2. **`git` background maintenance is expensive.** After a few commits,
   `ps` showed three `git maintenance run --auto --quiet --detach`
   processes that had used 11–18 s of CPU each, under emulation, for nothing.
   **Proposed fix:** ship `maintenance.auto=false` and `gc.auto=0` in
   tabcomputer's default `/etc/gitconfig`.
3. **Outbound TCP: not testable from this harness (not a tabcomputer
   bug).** The first clone over the relay worked (11 s). Later ones, and
   every `curl https://api.github.com`, failed with "Failed to connect". The
   page console showed why: Chromium sends the relay's
   `wss://tabcomputer.com/tcp` WebSocket through the research container's
   egress proxy, which doesn't support WebSocket upgrades ("HTTP
   Authentication failed; no valid credentials available"). A user's
   browser connects directly. The relay path itself is verified in
   [COMPAT.md](../COMPAT.md#agent-clis-unixagent-clis) (Codex, Grok, aider and
   pip reach their hosts). Everything here that needed the relay is marked
   untested. What tabcomputer could still do better: `curl` and git say only
   "Could not connect to server" while the reason ("relay refused: auth")
   sits in the page console. A kernel log line or `dmesg` entry for relay
   failures would let an agent tell "network down" from "relay refused".
4. **`time` reports `user 0m0.000s sys 0m0.000s`** for everything: there is
   no CPU accounting, so agents that profile with `time` learn nothing.
5. **Paths in tracebacks.** Python under `pkg` printed
   `File "/test_wordfreq.py"` for a file in `~/proj/wordfreq`, because the
   WASI preopen makes the cwd look like `/`. Agents parse tracebacks to find
   files to edit, so a wrong path costs them a search.
6. **Three Pythons.** After `pkg install python` (WASIX CPython), `python3`
   at the prompt still started Pyodide ("Loading Python (Pyodide)...", the
   profile's Pyodide shim), which can't listen on a port. Debian's
   `python3` wins once it is installed. An agent can't tell which one it
   will get. **Proposed fix:** `python3 --version` should say which build it
   is, and `which -a python3` should list all three.
7. **Colour codes in piped output.** pytest wrote ANSI colours although its
   stdout was a pipe (`| tail -3`), so a tool thought it was on a tty. This
   may only affect the terminal-less shell fork the harness uses; it needs a
   check on the real pty. Agents strip ANSI, but it costs tokens.

## Experiment 2: a web app with a server and a client

This is [examples/fullstack-notes](../../examples/fullstack-notes/): a
dependency-free Node HTTP server with a JSON API, a static client using
`fetch()`, the same API in Python (`server.py`), and an API test (`test.js`).
Details and screenshots are in [SANDBOXES.md](SANDBOXES.md#5-prototype-fullstack-notes).
In short:

- **Verified working:** `node server.js 3000 &`; `serve fetch 3000 /api/health`;
  `serve open 3000` opens a desktop window on the app; `page :3000 input` /
  `click` / `text` drive the client, and the server's writes land in
  `notes.json`; `curl http://localhost:3000/api/notes` from the shell reaches
  the same server.
- **Agent-relevant:** the `page` command is an excellent agent tool. An agent
  can test its own UI (`page :3000 click #save; page :3000 text #list`)
  without Playwright, which no cloud sandbox gives for free. It should be
  documented in the system prompt or CLAUDE.md that tabcomputer seeds.
- **Gaps hit:** `assert.match` is missing from tabcomputer's `assert` (the
  test was changed to `assert.ok(re.test())`); the builtin `wget -qO-` saved
  to a file named after the path instead of writing to stdout; `fs.watch`
  as above. WebSocket and EventSource from the preview: see SANDBOXES.md.

## Experiment 3: compilers an agent might be asked to use

These come from the language batch (Debian mode, `apt-get install`), in
headless Chromium, with 4–5 other tabcomputer pages running on the same
4-vCPU machine, so times are pessimistic.

| Language | Install | Compile + run hello | Result |
|---|---:|---:|---|
| Fortran (`gfortran`) | 392 s | 12.6 s | `sum= 5050` |
| COBOL (`gnucobol4`) | 103 s | 26.7 s | `HELLO FROM COBOL` |
| Pascal (`fp-compiler`) | 150 s | 12.3 s (fpc reports 10.5 s) | `hello from pascal` |
| Ada (`gnat`) | 445 s | 59 s | `hello from ada` |
| Prolog (`swi-prolog-core`) | 129 s | 7.4 s | `grandchild: ann` |
| Common Lisp (`sbcl`) | 103 s | 1.9 s | `lisp: 5050` |
| x86-64 asm (`nasm` + `ld`) | 79 s | 5.6 s | `hello from nasm` |
| OCaml (`ocaml-nox`, `ocamlopt`) | 393 s | 15.8 s | `hello from ocaml` |
| Haskell (`ghc`) | 584 s | 47 s (`ghc -e` 10 s) | `5050`, since perf-blink patch 0061 |
| R (`r-base-core`) | 10 min | 18 s (`Rscript` with `lm()`) | coefficients printed |

Every language an agent is likely to be asked for, except Java, runs. The
cost is the first `apt-get install` (2–10 min each). So for agent use, the
platform should snapshot a "toolchains" image rather than installing per
session.

## Would an agent use "GitHub repos mounted as a desktop smart folder"?

The idea: your GitHub repos appear as folders on the desktop and in Files;
opening one shows the repo's files (fetched lazily, like the Debian rootfs),
and edits sync back.

**Short answer: an agent would not use it, and a human would be confused by it
as soon as they edit. The parts worth keeping are lazy fetching and a repo
picker; the metaphor itself is wrong for git.**

### Why the folder metaphor is wrong for git

A GitHub repository isn't a folder. It is:

- a **history** (commits),
- several **refs** (branches and tags, on the remote and locally),
- and, on your machine, **one or more working trees**, each a checkout of one
  ref plus uncommitted changes.

A "smart folder" has to pick one snapshot and then give answers to questions
that git leaves to the user on purpose:

| Question | Smart folder must answer implicitly | git's answer |
|---|---|---|
| Which branch am I looking at? | the default branch, probably | whatever you checked out; `git status` says |
| I edited a file: is it saved to GitHub? | auto-commit and push? (Dropbox semantics) | no: uncommitted, until you commit and push |
| Someone pushed meanwhile | silent pull? conflict dialog? | `git pull` / `fetch` + merge or rebase, when you choose |
| I want to try something risky | ? | a branch, or a second worktree |
| Two agents working at once | they share one folder and trample each other | one worktree (or clone) per agent |
| What changed? | ? | `git diff`, `git log` |

Auto-syncing edits to a remote is the failure mode of every "git as a
filesystem" product (GitFS-style FUSE mounts, "Dropbox for code"). It makes a
commit per save, has nowhere for a commit message to go, races
concurrent pushes, and can break CI on main. Not auto-syncing makes it a
plain clone with a confusing icon.

### What agents actually do

Every agent CLI tested in COMPAT.md (Claude Code, Codex, Gemini CLI, aider)
drives git through the shell, and their workflows assume a real working tree:

- they run `git status`, `git diff` and `git log` to orient themselves;
- they commit to a branch and open a PR with `gh pr create` (or the GitHub
  API);
- aider auto-commits each change; Claude Code and Codex use branches;
- parallel agents use **`git worktree add`**, one worktree per task (Claude
  Code's documented pattern, Codex's cloud tasks, Conductor-style tools).

A mounted folder that isn't a git working tree breaks all of that. A mount
that is a working tree is just `git clone` with a different icon. Experiment
1 showed that the real thing works in tabcomputer today: clone 11 s,
worktree 1.5 s, branch and merge in seconds.

### The better UX (proposal)

Keep git's model and make it visible, rather than hiding it behind a folder:

1. **"Clone…" as a verb, not a mount.** In Files and the dock: paste a GitHub
   URL or pick from "Your repositories" (the user's GitHub token already
   exists for the git proxy and sign-in). That runs
   `git clone --filter=blob:none` (partial clone: the lazy-fetch benefit of
   the smart-folder idea, done by git itself) into `~/src/OWNER/REPO`, then
   opens a Terminal there. One click, standard result.
2. **Worktree-as-folder.** In Files, a repo folder shows its worktrees as
   sibling folders with a branch badge (`wordfreq [main]`,
   `wordfreq-json [json-output]`), plus "New branch in a new folder", which
   runs `git worktree add ../REPO-BRANCH -b BRANCH`. This is the one place
   where "folder" is the right metaphor: a worktree *is* a folder holding one
   branch. It also matches how parallel agents work: "start an agent in a new
   worktree" becomes a context-menu item, and each agent gets its own folder
   on the desktop.
3. **A graphical git client.** Use a status, diff, stage, commit, log and
   branches view for humans, rather than a sync engine. Options, from cheapest:
   - `tig` (apt, TUI);
   - `lazygit` and `gitui` (static binaries, TUI; see
     [DEV-TOOLS.md](DEV-TOOLS.md));
   - `git gui`/`gitk` (Tk, over X11);
   - a native desktop panel built on the same `git` the shell uses.

   Start with lazygit in the Developer dock group: it is the best git UI
   that runs today.
4. **A read-only repo browser** for "I just want to look": browse a GitHub
   repo's tree and files through the API without cloning, with a big "Clone to
   edit" button. This covers the reading half of the smart-folder idea
   honestly: no edits, so no sync semantics to explain.
5. **Status badges, not sync.** Folder icons in Files can show git state
   (ahead or behind, dirty) from `git status --porcelain=v2 --branch`, run
   lazily. That gives the "smart" part without changing what a folder is.

What an agent needs from the OS is more mundane: a reliable clone (the
intermittent connect failure above), `gh` with the user's token, no surprise
background CPU from `git maintenance`, and file watching for dev servers.

## Reproducing

```sh
# from this repo, with Chromium and playwright as in scripts/browser-check.mjs
node run.mjs https://tabcomputer.com/ @batch-agent.txt   # blocks separated by lines of "%%"
```

`run.mjs` and the batch files are in the research worker's scratch area. They
are not committed because they are throwaway harness code. The committed
equivalents are `scripts/browser-check.mjs` (one command per argument) and
`examples/fullstack-notes/` with its README.
