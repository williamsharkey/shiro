# HANDOFF — tabcomputer coordinator and workers

Written 2026-10-10 ~11:15 UTC, when the work moved from one Claude account to
another, and updated ~11:50 UTC by the old cloud coordinator after it stopped.
It is everything a fresh cloud coordinator needs to recreate the worker sessions
and pick each one up mid-task. **Start with §0a, the final state from the old
coordinator: it supersedes the per-worker "ahead" counts and SHAs in §6.**

Read this whole file once, then `AGENTS.md`, then the docs it points to.

---

## 0. Resume checklist (do these in order)

1. **Environment.** A Claude Code cloud environment with:
   - GitHub access (push) to `williamsharkey/shiro` and `williamsharkey/tabcomputer`.
   - Network: npm registry, GitHub (api, codeload, objects), Debian mirrors
     (deb.debian.org, snapshot.debian.org), busybox.net, jsdelivr/unpkg,
     api.digitalocean.com and api.porkbun.com (the coordinator only),
     tabcomputer.com.
   - Secrets as environment variables, for the coordinator only (never print
     them, never commit them):
     - `DIGITALOCEAN_ACCESS_TOKEN`: droplet replacement only.
     - `PORKBUN_API_KEY` and `PORKBUN_SECRET_KEY`: DNS and the DNS-01 cert renewal.
     - `CLAUDE_CODE_OAUTH_TOKEN` (optional): only if an agent-CLI tester needs a real sign-in.
2. **Coordinator clone.** Clone shiro, check out `unix/integration`, and add the
   deploy remote: `git remote add tab https://github.com/williamsharkey/tabcomputer.git`.
3. **Check what moved since this file.** Run `git fetch origin`, then list the
   worker branches that are ahead of integration (§4). Some workers were still
   committing when the old account was paused.
4. **Recreate the workers** (§6) from the template in §7. Each is told its
   branch, its scope and its in-flight task from §6.
5. **Recreate the routines** (§5) on the new account.
6. **Check the GitHub issues** on `williamsharkey/tabcomputer` (§8), including
   whether the in-tab agent's claim on #12 is still live.

The old account's sessions are **not** reachable from the new account; the IDs
in §6 are for reference only (the user may archive them).

---

## 0a. Final state from the old coordinator (2026-10-10 ~11:50 UTC)

The old coordinator (session 01AcE1vJZcwt64s5QkThfEFt) stopped at the user's
request. Before stopping it interrupted every worker. Its only follow-up was
asking workers to commit and push work they already had; nothing new was
started. Where this section disagrees with §6, this section wins.

### Concurrency with the old coordinator (read first)
The new coordinator may start while the old one is still finishing. Until a
commit titled **"HANDOFF: old coordinator done"** appears on
`origin/unix/integration`, the old coordinator still owns the following. Don't
do them:
- pushing `unix/integration`, tab `main` or tab `deploy`;
- messaging or archiving the old workers.

What is still being finished:
1. The suite is running on the tidy-up merges (agent-clis, compat-dev,
   compat-tools, conformance, docs). If it passes, they are pushed and deployed.
2. perf-blink, perf-kernel and gui were asked to push their finished work (to
   `unix/<area>-wip` if their suite is red).
3. This section gets its final SHAs.

In the meantime the new coordinator can safely:
- read this file and AGENTS.md;
- set up its clone and the `tab` remote;
- recreate the routines (§5);
- read the issues (§8 and below);
- create the new worker sessions, each starting by reading its §6 and
  §0a entries but **not pushing until the "done" commit lands**.

### Integration and deploy
- **Live on tabcomputer.com:** `d739673a`. tab `deploy` = `d739673a`.
- **`unix/integration` and tab `main`:** the merges listed below are being tested by the old coordinator, which pushes and deploys them if the suite passes. *Pending: the old coordinator fills this in when it finishes (see "Concurrency" above).*
- **Merged in the final tidy-up:**
  - agent-clis 51abefaa: the doctor parts of #16 (`node -v`/`node -e` probes, a /dev/null rerun of a failing node probe, `page --help`).
    - It conflicted with toolchains' doctor `packages` check. **Kept toolchains' `packagesCheck`** (local index, covered by `pkg-outdated.test.ts`); dropped agent-clis' `pkg outdated` runner and adjusted the `doctor.test.ts` expectation.
  - compat-dev 77db5b9f: **Next.js builds and serves in worker mode** (AsyncLocalStorage across await, web streams, ServerResponse internals).
  - compat-tools 86ffcfb4: fixes "`npm run dev` prints nothing while running", a regression from its own 2ebca8d5.
  - conformance 0854da2f: Blink 0506 (another process's CPU clock); the scoreboard re-measured on integration dff2c0d. **LTP 283/322, Open POSIX 1375/1448.**
    - 26 Open POSIX cases regressed from Blink 0112's munmap assert (`memorymalloc.c:834`). perf-blink has it; about 1401 is expected once it's fixed.
  - docs 5d9e31fe / 8bd1e652: README and About carry these numbers. The in-tab AGENTS.md covers the eval stdin trap and its `{ cmd; } </dev/null` workaround, says builtins have no /proc entry, and recommends one subagent and serial gh/curl.
- **Not merged on purpose (for the new coordinator):**
  - **`unix/compat-tools-flip`** (c13a1bf7), node in a Worker by default:
    - The user approved this directly in the old coordinator's chat ("yes lets do node in background worker by default").
    - compat-tools wanted that confirmation first-hand, because it only got it relayed. Tell the new compat-tools worker it's approved.
    - Still to do: rebuild, run the full suite plus `npm run test:worker` on the latest commit, and the vite-react browser check.
    - The last `test:worker` run failed 8: chokidar's timing case, a compat-dev test now pinned to in-page node, and 6 cascade failures that pass alone.
    - Then land it on `unix/compat-tools`.
  - **`unix/gl`:** `6d8c2d0`, all committed. Stage 2 code is described under gl below. It is **not merged** because the suite hasn't been run on it and it has no tests of the in-page path. Merge it once it passes the suite.
  - Any `*-wip` branches the workers push in the tidy-up. *Pending: the old coordinator fills this in when it finishes (see "Concurrency" above).*
- **Benchmark:** no new run since `integration-89e9559-quick.json`. Run one on the first cycle.

### Per-worker state at the stop (supersedes §6 where they differ)
- **perf-blink:** asked to commit and push what it has. *Pending: the old coordinator fills this in when it finishes (see "Concurrency" above).*
  - Patch 0116 makes compiled code do SSE ss/sd/ps/pd arithmetic, ucomis/comis, movd/movq and leave itself, with no handler calls; 3.2 M handler calls → 0 on a libc-heavy run.
  - go_nethttp A/B reads as noise.
  - **New for its queue:**
    - Firefox and Thunderbird exit before a window appears. Blink aborts at `memorymalloc.c:834` mapping a 242,716-byte shared `memfd:mozilla-ipc` region. It's the same assert as the conformance regression above (from gui).
    - Blink returns EINVAL for memfd F_ADD_SEALS/F_GET_SEALS. The kernel side is on gui's branch.
  - The compiled-entry work for GUI startup is still the top item.
- **perf-kernel:** asked to commit and push what it has. *Pending: the old coordinator fills this in when it finishes (see "Concurrency" above).*
  - The tabcomputer#14 kernel parts:
    - init reaps orphans at once;
    - Linux-style decaying /proc/loadavg and sysinfo;
    - /proc/PID/fd shows `pipe:[N]` and `anon_inode:[eventfd|timerfd|signalfd]`;
    - real `.` and `..` in `ls -a`;
    - `kill PID` ends a `bash -c` blocked in a command (143 for SIGTERM, 137 for SIGKILL).
  - Codex finding: "Reconnecting… waiting for network" is not a kernel deadlock. Codex retries failed HTTPS without limit (`codex-rs/core/src/responses_retry.rs`).
- **gui:** asked to commit and push what it has. *Pending: the old coordinator fills this in when it finishes (see "Concurrency" above).*
  - OSMesa/llvmpipe pixels now match softpipe after 0114. The first frame takes 26–29 s, then 0.44 s per frame at 512² and about 1.3 s at 720p, so it's only a slow fallback.
  - Cross-process shared mappings work (the shm2 repro).
  - Zathura passes everything; qpdfview loads its SQLite driver; nine new apps added.
  - Not yet rescored: Krita, Audacious, LXImage-Qt, Shotwell, Audacity.
- **gl:** stage 2 code exists:
  - `scripts/gl` (gen.mjs from gl.xml, `libGLX_tabcomputer.c`, build.sh, the gldev.ts harness);
  - `src/gl` (wire, exec, ff, formats, mat, glsl/translate, the server on `/tmp/.tabcomputer-gl/0`, present), wired into src/main.ts.
  - In the native harness (SwiftShader), glxinfo shows core 3.3 and compat 2.1, and glxgears renders correctly at 55–65 FPS, about 285 bytes per frame.
  - **No tests yet and the full suite hasn't been run.** Next: run it in the page through Blink, with libGLX_tabcomputer shipped via `src/gui/apps.ts`.
  - The gui worker's GL.md edits favour llvmpipe GLX (option A). The user approved the WebGL2 route (option B); reconcile GL.md.
- **agent-clis:** pushed and merged (51abefaa). **Findings never sent to perf-kernel:**
  1. Codex's HTTPS fails about 0.6 s after TCP connects to api.openai.com. The likely cause is a missing CA bundle: `/etc/ssl/certs/ca-certificates.crt` is absent in plain mode. Untested.
  2. The "turn interrupted" SIGINT arrives 0.1–0.2 s after codex's 30 s timeout kills a `git fetch` child. That points to a kernel process-group signalling bug.
  3. In Debian mode, codex stalls during setup on a `git fetch` of github.com/openai/plugins.
- **compat-dev:** pushed and merged (77db5b9f). **An open regression it reported:** `npm run dev` for the vite React template never reaches "ready" on integration.
  - Last good: 1f804b76. Bad at 32781119.
  - Two candidates left untested: 1fb270da (a compat-dev merge) and fea40c54 (a compat-tools merge).
  - compat-tools' 86ffcfb4, now merged, fixes a related "npm run dev prints nothing" regression from 2ebca8d5. **Check whether `npm run dev` is fixed on the new integration head before bisecting further.**
  - Untriaged in-page bugs from peers:
    - a backgrounded server's redirected output is never written;
    - one of two back-to-back servers sometimes exits at once;
    - redirected npm script output ends lines with `\r\r\n`.
- **compat-tools:** next is #13 after the flip. Also: a child spawned with `stdio:'inherit'` in Debian mode doesn't see a tty on stdin.
- **shell-stdio, toolchains, debian, docs, conformance, bench, desktop:** idle at the stop. Everything they pushed is merged.

### Issues at the stop (supersedes the §8 table)
- **#12 (eval `<` dropped):** the in-tab agent finished.
  - It posted a reviewed but **not test-run** diff to `src/shell.ts` ~2715 and `agent-shell.test.ts` in its 11:16 comment. It couldn't push because pushing needs the owner's approval in its session.
  - It verified a runtime hot-patch in the live tab: `timeout 5 cat` and `timeout 15 node -v` stop hanging.
  - **Next:** apply its diff (`git apply`), run the suite, and commit with "Fixes williamsharkey/tabcomputer#12", crediting the in-tab agent. Or ask the user whether the in-tab agent should push it itself.
  - Its notes: Claude Code only adds `< /dev/null` when a command has no `<` of its own, and a text-rewriting hot-patch broke heredocs.
- **#13 (`node -e` hangs in-tab):** compat-tools, after the flip. It blocks the in-tab agent running vitest and esbuild.
- **#14:** perf-kernel's kernel parts (above), plus shell-stdio's tty and builtin parts.
- **#15:** **closed**. The toolchains fix is live in d739673a.
- **#16:** the docs and agent-clis parts are merged. Left: shell-stdio's `FORCE_COLOR` only when stdout is a tty. Then close it.
- **#17 (new, unclaimed, filed by the in-tab agent):**
  - `js-eval` runs code twice when it throws and can't run statements (`src/commands/jseval/js-eval-cmd.ts`).
  - It asks for a supported way to hot-swap core code: `reload --bundle`, exposing esbuild/Shell/kernel to js-eval, a `hotpatch --ttl` safety net, and in-tab vitest (blocked by #13).
  - The js-eval bug is small (shell-stdio or compat-tools). The hot-swap feature is a design question for the user.

---

## 1. What the project is

tabcomputer (tabcomputer.com) is a Unix-compatible computer in one browser tab:
- a JS kernel with processes, fds, pipes, a pty, signals, sockets over a
  WebSocket-to-TCP relay, procfs and SysV/POSIX IPC;
- a bash-compatible shell;
- WASI and WASIX guests;
- an x86-64 Linux emulator (Blink, compiled to wasm with a JIT) that runs real
  Debian (`debian install`, real `apt`/`dpkg`, popcon top-1000: 990/991 pass);
- a desktop with an X server ("Xshiro") for real Linux GUI apps (GIMP,
  Firefox, LibreOffice…);
- Node (node-compat, in the page or as a kernel guest in a Worker) and the
  agent CLIs (Claude Code native and npm, Codex, Gemini, opencode, aider,
  Grok, agy).

The user's goal: make it fully Unix-compatible, fast, and good enough that
real developer workflows (Vite/Astro/Next.js, Go, Python, apt, git, AI coding
agents) run in it. The work is run as many parallel workers coordinated by one
coordinator session, which merges, tests, benchmarks and deploys.

---

## 2. Repositories and branches

- **`williamsharkey/shiro`**: the source of truth for development.
  - Workers develop on `unix/<area>` branches.
  - The coordinator merges them into `unix/integration`.
  - shiro.computer, the old product, is a separate deployment. Don't touch it.
    It no longer serves `/pkg/`, so the pkg fallback mirror is now
    tabcomputer.com (fa84cad).
- **`williamsharkey/tabcomputer`**: the deploy mirror and the issue tracker.
  - `main` mirrors `unix/integration`.
  - Pushing to the `deploy` branch makes the droplet build and go live.
  - Issues are filed here, including by Claude agents running inside tabcomputer.
  - At handoff, every `unix/*` branch from shiro has also been pushed to
    tabcomputer under the same names, so the new owner can make tabcomputer
    canonical if wanted. If you do, repoint workers' `origin` and update this
    file; until then shiro stays canonical.
- **Remotes in the coordinator clone:** `origin` = shiro, `tab` = tabcomputer.

---

## 3. Infrastructure

### Droplet
- **Droplet:** DigitalOcean droplet `tabcomputer`, id 607764974, nyc1, size
  s-1vcpu-2gb-amd, IP 68.183.97.101. DNS at Porkbun points `tabcomputer.com`,
  `*.tabcomputer.com` and `*.web.tabcomputer.com` at it.
- **Self-deploy:**
  - cloud-init (`deploy/tabcomputer/cloud-init.yaml`) installs a systemd timer, `tabcomputer-deploy`, that runs every 2 min.
  - It runs `git ls-remote` on tabcomputer `deploy`, then clones the commit and runs `deploy/tabcomputer/release.sh`.
  - release.sh does `npm ci && npm run build`, rsyncs into `/opt/tabcomputer/releases/<sha>` and flips `current`.
  - It carries a week of old `/assets` forward, restarts `tabcomputer`, runs `tls-install.sh`, and starts the toolchain layer build in the background.
- **Live commit:** `https://tabcomputer.com/deployed.txt`. **Deploy log:** `http://68.183.97.101/_deploy/log` (by IP; on the apex the SPA swallows it).
- **Toolchain layers** (`toolchain install c|python|node|java|classic|tex|go`):
  - built on the droplet by `scripts/debian/build-layers.sh` (via systemd-run `tabcomputer-layers`, PrivateMounts) into `/opt/tabcomputer/layers`;
  - served at `/debian/layers/`;
  - only sets whose recipe changed are rebuilt, and a builder change rebuilds all of them once;
  - the builder runs in its own mount namespace. An earlier version unmounted the host's cgroups and took the site down: the outage of 2026-10-09 23:10–23:26. `check-layer-mounts.sh` guards against it.
- **Server env** (`profiles/tabcomputer/server.env`):
  - the TCP relay is on, with limits of 300 connects/min and 64 concurrent;
  - `TABCOMPUTER_TCP_TOKEN_BIND_IP=0` (the user's decision);
  - **`TABCOMPUTER_BROWSE_SERVER_FETCH` must never be on in production.**

### TLS
- **Apex/www:** certbot on the droplet (the `tabcomputer-cert` timer, certbot's own renewal).
- **Wildcard** (`*.tabcomputer.com`, `*.web.tabcomputer.com`):
  - issued off-droplet with certbot DNS-01 through the Porkbun API;
  - encrypted with CMS to the droplet's own key (`/_deploy/tls-recipient.crt`) and committed as `deploy/tabcomputer/tls/bundle.cms`; `tls-install.sh` installs it.
  - **Never commit or print the unencrypted key, and keep the Porkbun keys off the droplet.**
  - Renew around **2026-12-01**, following `deploy/tabcomputer/tls/README.md`.
  - A replaced droplet has a new key, so re-encrypt the bundle for it.

### Standing authorisations from the user
- **Deploys:** deploy integration to tabcomputer.com whenever the full suite passes: `git push --force tab HEAD:refs/heads/deploy && git push tab HEAD:refs/heads/main`.
- **Droplet:** the coordinator may replace the `tabcomputer` droplet, and only that one. **Never touch the user's other droplets** (cmdfn, xp-lotus123, functionserver, parasharkgod, shiro, ruffian, sharkey-server, catenary-core, ghosts-garden).
- **Approvals from workers:** if a worker asks for approval, report it to the user rather than approving.
- **Google:** never automate Google sign-in or scrape passwords.google.com.
- **Model identifiers:** none in commits, PRs or code.

---

## 4. The integration cycle (the coordinator's main loop)

This ran every 2 h as a routine and between whenever workers reported. Steps:

1. **Fetch and list unmerged worker branches.**
   ```
   git fetch -q origin
   for b in $(git branch -r | grep 'origin/unix/' | grep -vE 'integration|/unix/kernel$|x86-engine|compat-tools-flip'); do
     n=$(git rev-list --count HEAD..$b); [ "$n" -gt 0 ] && echo "$b $n"; done
   ```
   - Mind the filter: an earlier `kernel$` pattern also excluded `perf-kernel`. Use `/unix/kernel$`.
   - `unix/kernel` and `unix/x86-engine` are retired. They carry an old syslog patch superseded by perf-blink's 0060.
2. **Merge perf-blink first.** On a conflict, take its `vendor/blink/patches`,
   `vendor/blink/build.sh` and `public/engines/blink` wholesale
   (`git checkout origin/unix/perf-blink -- vendor/blink public/engines/blink`).
   Resolve conflicts in **`src/` hunk by hunk, never by taking whole files**:
   once, taking perf-blink's `kernel.ts` whole dropped three other branches'
   changes. After the merge, check:
   - `git diff --stat origin/unix/perf-blink HEAD -- vendor/blink/build.sh public/engines/blink` is empty;
   - `ls vendor/blink/patches | sed -E 's/^([0-9]+)-.*/\1/' | sort | uniq -d` finds no duplicate patch numbers. **Numbering:** perf-blink uses <0500 (new ones from 0100 up), conformance uses 0500–0599.
3. **Merge every other branch.** On additive conflicts keep both sides. Hand
   real conflicts back to the owner.
4. **Build and run the full suite.**
   ```
   npx tsc --noEmit -p . && node --check server.mjs && npm run build
   cd tests && npx vitest run --config vitest.config.ts > /tmp/vitest-full.log 2>&1
   ```
   - Always pass `--config vitest.config.ts` from `tests/`. A run from the wrong cwd once "ran" 1275 files and no tests.
   - Rerun a lone failure in isolation before calling it real. Known timing flakes under load: `kernel-wasix` dash/bash pty, x86-engine POSIX-timer/futex cases, `toolchain-layers` "Killed".
   - `pkill -f "vitest run"` kills the calling shell (exit 144). That's expected.
5. **Push and deploy.** `git push origin unix/integration`, then deploy (§3), then watch `deployed.txt`.
6. **Benchmark** about every 2 h.
   - Run `npm run bench:quick -- --no-build --out bench/results/integration-<sha>-quick.json`.
   - Compare with `node bench/compare.mjs <prev>.json <new>.json`. It A/Bs candidate regressions on the same machine.
   - Only "A/B-confirmed" counts. Containers differ in speed, so compare absolute numbers only on one machine.
   - Commit the result file.
   - Last committed result: `integration-89e9559-quick.json`.
7. **Give finished workers their next task.** Use the open issues, the hot spots and the scoreboards: `docs/CONFORMANCE.md`, `docs/COMPAT.md`, `docs/DEBIAN_SCORE.md`, `docs/GUI_SCORE.md`, `docs/BENCHMARKS.md`.
8. **Check the tabcomputer issues** (§8) and report a short status to the user.

---

## 5. Routines to recreate on the new account

- **The integration cycle:** every 2 h (`4 */2 * * *`), bound to the coordinator session. Its prompt is §4 plus §8 plus the worker list. On the old account it was `trig_01NWHeCFzHRUPzYAvUBxUB6R`, now **disabled**.
- **Cert renewal:** one-shot at 2026-12-01 16:00 UTC, which renews the wildcard certificate per `deploy/tabcomputer/tls/README.md` (the old routine's full prompt is in that README's steps). Old account: `trig_01Ho1pJYSBUGszRUmWVQ1925`, still enabled there; the user should disable it once the new one exists, or two renewals will run.
- **#12 claim check:** the old account's one-shot "check the in-tab agent's claim on #12" was disabled. Replace it with an issue check on the new coordinator's first cycle.

---

## 6. Workers: scope, state at handoff, in-flight task, queue

Branch tips are as of handoff. "Ahead" means commits not yet in integration;
merge these in the first cycle. The old session IDs are listed so the user can
find or archive them; they can't be messaged from the new account.

### Engine and kernel

**perf-blink**: `unix/perf-blink` @ 8eb1803c (merged). Old session 0175bWtnDVKZckVGn77ATz2Z.
- **Scope:** the Blink x86-64 emulator (`vendor/blink/patches`, `vendor/blink/build.sh`, `public/engines/blink/*`). It owns `blink.wasm` builds, and patches go in <0500.
- **Recent:**
  - 0112, the Blink half of cross-instance shared mappings (shmobj): `sem_open` across exec, and Firefox's memfd font list;
  - 0114, an unpckhpd fix (llvmpipe's wrong 4-pixel blocks);
  - 0115, `exit_group` no longer waits for sibling threads (go_nethttp −22%);
  - conformance's 0500–0504 folded in.
- **In flight:** compiled entry at returns and mid-block. 72–88% of Inkscape/GIMP/Firefox startup is interpreted ("not at a branch target"). That's the biggest GUI-startup lever and likely helps native Claude startup (~52 s to first screen, 64% of it in compiled code).
- **Queue:**
  1. About 100 ms of the go_nethttp regression since 0053 is still unexplained. bench's `bench/engine-swap.sh` is the repro tool.
  2. Copy-on-write fork: 3.9 ms + 0.8 ms/MB today vs 0.12 ms native.
  3. Conformance regressions: `pthread_join_1-2` exits 1 after PASSED; `aio_cancel_6-1` times out.
  4. calibre's dpkg abort: `blink/memory.c:62 assertion failed: s->real` in the fork child's restore.
  5. PostgreSQL WAL: bytes gathered for its WAL writes are already zero before the kernel (debian's repro uses `SHIRO_BLINK_MMLOG=3`).
  6. The librsvg gradients (GIMP uses a PNG icon theme as a workaround). Recheck after 0114.

**perf-kernel**: `unix/perf-kernel` @ 4a61f5c2 (**2 ahead**: klog of group signals, job-control stops). Old session 012AHGL7ZyHXsztTa3H2ZoQS.
- **Scope:** the JS kernel (`src/kernel/*`): syscalls, procfs, signals, sockets and the relay client, SysV/POSIX IPC.
- **Done:**
  - SysV shm/sem/msg plus `ipcs`/`ipcrm`;
  - the shmobj kernel half (`src/kernel/shmobj.ts`, calls 1020–1022, PTE bit 48; design in `docs/research/SHARED_MAPPINGS.md`);
  - `/proc/PID/syscall` and `wchan`;
  - ENOENT plus a "needs glibc: run `debian install`" message for a missing loader;
  - sync O_CREAT/unlink fast paths.
- **In flight:**
  1. **The codex HTTPS-fallback hang.**
     - `codex exec` with a dummy key gets 401s over wss, logs "Falling back from WebSockets to HTTPS transport", then hangs.
     - What agent-clis captured: the socket count goes 4→5 across the fallback, dmesg is empty, and the shell prompt comes back while codex prints "turn interrupted" (a stray SIGINT to the foreground group?).
     - perf-kernel is building a local TLS/401/h2 repro, since running the downloaded codex binary needs the user's OK.
  2. **Issue #14, kernel parts:**
     - real `/proc/self/fd` targets (pipe:[N] etc.) and no ".." entry;
     - prompt reaping of orphan zombies;
     - `/proc/loadavg`;
     - SIGTERM to blocked processes.
- **Queue:** nothing beyond that.

**perf-fs-shell**: `unix/perf-fs-shell` @ d4034ddc (merged). Old session 01HPVBgYdcKryVcyqww1pN9T.
- **Scope:** the filesystem (VFS, IndexedDB persistence, content cache), shell speed, built-in git speed.
- **Done:**
  - content-cache eviction (idle ≥30 s, committed, not open; >8 MiB dropped at once, otherwise LRU beyond 64 MiB);
  - `rm -rf` durable in 0.6 s;
  - big-home boot in 230 ms;
  - built-in `git log` 64 s → 0.5 s;
  - http(s) `git clone` routed through the built-in even with full git installed (93 s → 13.6 s), with credentialed URLs going to full git.
- **In flight:** a streaming write path, so large writes (apt's xz decode → Packages, npm tarballs) don't need whole-file buffers.

**conformance**: `unix/conformance` @ 52f81d1b (merged). Old session 01AjkpX4wkXikkXDTcQEuwgf.
- **Scope:** POSIX/Linux conformance suites and fixing what they find. Blink patches go in 0500–0599; perf-blink folds them in and builds.
- **Scores:**
  - LTP **282/322**;
  - Open POSIX **1370/1448** (1379 at best, on a quiet machine);
  - scoreboard in `docs/CONFORMANCE.md`.
- **In flight:** re-measure both suites on the dff2c0d+ engine, with pthread_cancel (0501) and CPU clocks (0502), and send docs the numbers.
- **Queue:**
  - process-shared pthread objects across processes (now possible with shmobj);
  - `pthread_kill` interrupting another thread's syscall;
  - mmap SIGBUS past EOF;
  - fork corner cases.
  - Beyond that, the next suite by real-world value.

### Shell, Node, tools

**shell-stdio**: `unix/shell-stdio` @ c8dd0580 (**5 ahead**). Old session 013U6R3ZeCeKi8pyVqm7uXu5.
- **Scope:** the shell (`src/shell.ts`, `src/shell-*.ts`), builtins, stdio, tty/termios, job control.
- **Done:**
  - lazy stdin for builtins;
  - irb and the node REPL on the tty;
  - oils spec tests 2034/2417 (the 117-file set) and smoosh 159/162;
  - GNU hello's `./configure` passes;
  - `timeout` sends a real signal and waits;
  - termios and DEC modes restored when a raw TUI dies, plus `reset`.
- **In flight (the 5 ahead may include some of it):**
  - #14 shell parts: `tmux new-session -d` without a tty, killable and waitable `$!` for background builtins, `setsid`/`script`/`tty` builtins;
  - #16: `FORCE_COLOR` only when stdout is a tty;
  - builtins (`cat`, `ls`…) reading the kernel's procfs for `/proc/<pid>/*`.
- **Rule:** **don't touch the `eval` redirect code (src/shell.ts ~2708) while #12's in-tab claim is live** (§8).

**compat-tools**: `unix/compat-tools` @ db0b3e23 (merged); **`unix/compat-tools-flip` @ 6aab3144 (6 ahead, 99 behind)**. Old session 01WtTmmwRo8fYfgDDsRWjdvg.
- **Scope:** CLI tools and node-compat's worker/guest mode (`src/node-worker/*`, `src/node-compat/*` shared with compat-dev); gh, git built-in, magick.
- **In flight (the user APPROVED this):** make **node run in a background Worker by default**:
  - "worker when the page can": SAB + Worker, with `TABCOMPUTER_NODE_WORKER=0` to opt out, and non-isolated pages staying in-page;
  - steps: merge integration into the flip branch, run the full suite plus `npm run test:worker`, fix or pin tests, update the docs (COMPAT node row, AGENTS.md, the in-tab AGENTS.md in `src/agent-docs.ts`: "`node server.js` stays in the foreground; background it with `&`"), then push to `unix/compat-tools` so the cycle merges it.
  - Measured:
    - node -e 107→64 ms;
    - claude --npm --version 899→801 ms;
    - vite 8 build 1.13→0.83 s;
    - page heap after a Vite session 336→112 MB;
    - first guest +24 MiB, each extra guest +5 MiB.
- **Then:** issue **#13** (`node -e` wedged after earlier timeout-killed instances; worker mode should make instances real kernel processes).

**compat-dev**: `unix/compat-dev` @ fb4858c5 (merged). Old session 018Q8AvwCpcyRr19yfmtpfyD.
- **Scope:** languages and dev workflows: in-page node-compat, npm-tree, Vite/Astro/Next.js, the module transform.
- **Done:**
  - Vite 8 + React with HMR (~13–15 s end to end), Vite 7, Astro 5;
  - `vite build`;
  - `npm i x` without a package.json creates one;
  - linux-x64 optional deps installed when they ship an executable (codex, opencode), and install scripts run;
  - memory: seven leaks of ended processes fixed, the page esbuild freed when idle.
- **In flight:** **Next.js on worker mode.** `next build --webpack` compiles in worker mode (needs `NEXT_TEST_WASM_DIR` because the relay can't fetch SWC's download). Then `next dev`.

**agent-clis**: `unix/agent-clis` @ 1be9b34e (merged). Old session 01KQH1JFMpsgu6BMYV46QMNb.
- **Scope:** agent CLIs end to end (Claude native/npm, Codex, Gemini, opencode, aider, Grok, agy) and `doctor`.
- **Status:** every CLI installs and reaches its vendor API with a dummy key, except the codex HTTPS-fallback hang (with perf-kernel). The table is in COMPAT.md. Claude's sign-in has been verified as far as the paste-code step.
- **In flight:**
  - `codex exec` after `debian install` prints nothing for 7+ minutes (a different node or binary path?);
  - #16 doctor parts: re-run the node probe with stdin=/dev/null and say which run failed, a separate `node -e` probe, upgradable packages, `page --help` listing its actions.
- **Constraint:** it can't run downloaded binaries without the user's OK in some containers, and has no vendor accounts.

**toolchains**: `unix/toolchains` @ 0af895d5 (**1 ahead**: pkg shows stale packages and upgrades known-broken builds). Old session 01HqAR1L38Vix3nbCNKzRTJr.
- **Scope:** prebuilt toolchain layers (`src/debian/toolchains.json`, `scripts/debian/build-layers.sh`) and pkg.
- **Done:** the go layer (std precompiled, cache dated 2100 so Go doesn't trim it, CGO_ENABLED=0).
- **In flight:** issue **#15**: `pkg outdated`/`--dry-run`, "installed X, index Y", a doctor WARN, upgrade-on-boot for known-broken builds.
- **Note:** the cold `go run` hang is fixed (Blink 0091); `GOFLAGS=-p=1` is no longer needed.

### Debian, GUI, GL, desktop

**debian**: `unix/debian` @ 509a2258 (**1 ahead**: popcon 1001–1250 scored, all pass so far). Old session 01CQBoqfB6VuBUiyPPpxg6GQ.
- **Scope:** the Debian userland (`debian install`, apt-guard, the scoreboard in `docs/DEBIAN_SCORE.md`, `npm run debian-score`).
- **Score:** popcon top 1000 is 990/991. The only failure is linux-image-amd64 (dracut-install aborts in the engine).
- **In flight:** popcon 1001–2000, from `scripts/debian/popcon-top2000.txt`.
- **Blocked on perf-blink:** PostgreSQL end to end (WAL zero bytes) and calibre (the `memory.c:62` abort).
- **Also:** apt memory. `apt-get update` peaks at +600 MiB; perf-fs-shell's eviction cut what's left afterwards.

**gui**: `unix/gui` @ 99aadb4a (merged). Old session 01BTnm46q6Kk6gwKSSRHohXj.
- **Scope:** real Linux GUI apps through Xshiro (`src/gui`, `scripts/gui`, `docs/GUI.md`, `docs/GUI_SCORE.md`, `npm run gui-score`).
- **Score:**
  - 28/29 windows, 27 render, 20 input, 20 DOM text;
  - Firefox works (needs the `gfx.e10s.font-list.shared=false` overlay; retest without it now that shmobj landed);
  - LibreOffice runs;
  - Blender needs GL.
- **In flight:**
  - the **Xshiro side of fast GL**: a GLX extension entry with QueryVersion, `server.glSurface(xid)` (a positioned, clipped bitmaprenderer canvas per window), and the vendor env plus library in the app environment;
  - re-run the osmesa probe after Blink 0114 (llvmpipe correctness and speed, the software fallback);
  - why 9 of 29 apps don't take input;
  - time-to-window for Firefox (274 s), Inkscape and GIMP;
  - 5–10 more apps (Thunderbird, Geany, Meld, Xournal++…).

**gl (new)**: `unix/gl` @ eebb5c63 (**1 ahead**: the design addendum in `docs/research/GL.md`). Old session 01YGAi25EGVNScm6mKm6DDBE.
- **Scope:** fast OpenGL forwarded to WebGL2. The user APPROVED it because many programs depend on GL: Blender, KiCad 3D, FreeCAD, OpenSCAD, games, mpv, Qt Quick, GTK4 GL.
- **Design (approved):**
  - a glvnd vendor library `libGLX_tabcomputer.so.0`, selected by `__GLX_VENDOR_LIBRARY_NAME=tabcomputer` (set only when WebGL2 is available, otherwise Mesa);
  - batched 256 KB buffers over an AF_UNIX socket to a page `glshiro` kernel process. Not the shmobj ring: remote pages bypass the JIT.
  - a Worker holding one WebGL2 context on an OffscreenCanvas, with an FBO per drawable;
  - an in-house GLSL 110–330 → ESSL 300 front end in TS;
  - GL 3.3 gaps: geometry shaders emulated with transform feedback, texture buffers as 2D textures, page-built index buffers for polygonMode.
- **Stages:**
  1. design — done;
  2. **glxinfo + glxgears**, in flight;
  3. a GL 2.1 app (OpenSCAD or SuperTuxKart) with FPS;
  4. Blender GL 3.3;
  5. breadth, plus a GL column in GUI_SCORE.
- **Notes from the coordinator:**
  - measure socket throughput early;
  - drive the shader front end by tests on a real-shader corpus;
  - frames mustn't pile up when the tab is hidden.

**desktop**: `unix/desktop` @ e2939d22 (merged, idle). Old session 01Ebwk6YqvWU1Sajjczd7Xsu.
- **Scope:** the desktop shell (menu bar, dock, windows, previews, Settings, icon sets).
- **Done:**
  - preview windows and an "Open Preview" offer;
  - a first-run welcome card with demos;
  - phone/tablet fixes (`tests/browser/small-screens.mjs`).
- **Idle;** give it the next desktop task.

### Infrastructure workers

**bench**: `unix/bench` @ 2dd8810c (merged). Old session 01FfPX6V1vscdHTWgf62w95b.
- **Scope:** the benchmark harness (`bench/*`, `docs/BENCHMARKS.md`).
- **Done:**
  - the workflows suite (Vite, go, apt, node REPL/worker), with `--skip` to drop parts;
  - `*_net` RSS twins net of DevTools' buffer partition;
  - the compare `gate` fix;
  - `bench/engine-swap.sh`.
- **Idle.**

**docs**: `unix/docs` @ a5c3e7e2 (**1 ahead**: the in-tab AGENTS.md tracker-first notes, pkg upgrade, hung processes, concurrency). Old session 01Xhv5nJHLdwacGL2RZvQbVQ.
- **Scope:** README, AGENTS.md, the in-tab AGENTS.md (`src/agent-docs.ts`), docs/.
- **In flight:** the #16 AGENTS.md parts.
- **Note:** it couldn't read the tabcomputer repo (403), so issue text was pasted to it. Give the new docs worker read access or paste issue bodies to it.

### Older, idle or paused
- **browser** (`unix/browser`, idle): the light browser (iframe tabs plus a service-worker proxy over the relay). Brotli decoder queued.
- **wasix** (`unix/wasix`, idle).
- **relay** (`unix/relay`): **paused awaiting the user** (one relay protocol: hosted with GitHub sign-in, local helper, Cloudflare). Ask the user before resuming it.
- **research** (`unix/research`): finished research drafts; see `docs/research/`.
- **Finished:** `net`, `pty`, `wasi`, `kernel`, `isolation`, `packages`, `x86-engine`. Don't merge `unix/kernel` or `unix/x86-engine`; they're superseded.

---

## 7. Worker recreation template

Create each worker as a cloud session on shiro, with
`source_revision: unix/<area>` (or `unix/integration` for a new branch). Prompt:

```
You are the unix/<area> worker for tabcomputer (repo williamsharkey/shiro,
deployed to tabcomputer.com). Read HANDOFF.md (section 6, "<area>") and
AGENTS.md first, then `git log -15` on your branch to see where you were.

Scope: <scope from §6>.
Continue: <in-flight task from §6>. Then: <queue>.

Rules:
- develop on branch unix/<area>; merge origin/unix/integration before pushing;
  push your branch; the coordinator merges and deploys;
- report each finished step to the coordinator session <new coordinator id>
  with send_message: what changed, the commit, tests, numbers;
- tests for what you build (vitest under tests/, browser tests under
  tests/browser); keep the full suite green
  (`cd tests && npx vitest run --config vitest.config.ts`);
- A/B anything perf-sensitive with bench/ab.mjs;
- Blink patches: perf-blink only (<0500); conformance uses 0500–0599;
- never commit secrets or model identifiers; end commit messages with
  Co-Authored-By: Claude <noreply@anthropic.com>;
- if you need the user's approval, ask the coordinator, don't proceed.
```

Workers can't comment on `williamsharkey/tabcomputer` unless that repo is
attached to their session; the coordinator posts issue comments for them.

---

## 8. GitHub issues and the in-tab agent

Issues live on **`williamsharkey/tabcomputer`**. A Claude Code agent running
**inside tabcomputer** (in the browser tab) files issues and claims some. The
user is testing its ability to fix issues from inside tabcomputer.

**Protocol:**
- Check open issues and their comments every cycle.
- **Never take an issue the in-tab agent claimed while its claim is fresh.** Its
  claims say "🔒 Claimed by a Claude Code agent running inside tabcomputer".
  Only if a claim has had no update for over 1 hour may you take it over, and
  then comment first.
- For unclaimed issues: assign a worker, post a claim comment naming it, and
  have the worker commit with `Fixes williamsharkey/tabcomputer#N`. The push to
  tab `main` closes the issue.
- End every comment with the "Generated by Claude Code" footer.
- Report the in-tab agent's claims, progress and commits to the user.

**Open at handoff:**

| # | Title (short) | Owner |
|---|---|---|
| 12 | eval drops `< /dev/null`, the root cause of agents' stdin hangs | **the in-tab agent** (claimed ~11:00 UTC). The fix is in `src/shell.ts` ~2708: the eval special case sets `injectedStdin` but ignores eval's own `<`. Hand it to shell-stdio only if the claim goes stale. |
| 13 | `node -e` hangs after earlier killed instances; instances invisible to ps/kill | compat-tools (claimed) |
| 14 | /proc/self/fd targets, tmux -d, `$!` for builtins, zombie reaping, loadavg | perf-kernel (kernel parts) and shell-stdio (tty/builtin parts) (claimed) |
| 15 | pkg packages go stale silently | toolchains (claimed) |
| 16 | AGENTS.md and doctor gaps | docs (AGENTS.md), agent-clis (doctor), shell-stdio (FORCE_COLOR) (claimed) |

Closed earlier: #1–#11. #10 was the audit tracker.

---

## 9. Decisions the user has made (don't re-ask)

- **Node worker default:** node runs in a background Worker by default (approved 2026-10-10). The flip is in flight with compat-tools.
- **Fast OpenGL:** via WebGL2 (approved). Mesa llvmpipe stays the slow fallback.
- **Naming and defaults:**
  - Native Claude Code is the default `claude`; `--npm` for the npm build.
  - `claude login` maps to `auth login`; no auto sign-in panel.
  - Drafting is the default dock icon set; other sets in Settings.
- **Approved features:** toolchain snapshots; GitHub as Clone + worktrees; dock stacks.
- **Relay:** limits raised for everyone; browse-origin storage stays shared; relay token IP binding off on tabcomputer.
- **TLS:** the wildcard cert via DNS-01, encrypted to the droplet's key.
- **Deploys:** standing approval after a green suite.
- **Approvals:** report worker approval requests to the user; don't approve for them.

## 10. Known open problems (cross-cutting)

- **codex** HTTPS-fallback hang (perf-kernel) and silent `codex exec` after `debian install` (agent-clis).
- **Native Claude Code startup** takes about 52 s to the first screen (perf-blink).
- **PostgreSQL and calibre** are blocked on engine bugs (perf-blink).
- **Firefox** needs the font-list overlay until it's retested on shmobj (gui).
- **Memory:** Vite dev uses about 700 MB resident; apt update peaks at about +600 MiB.
- **shiro.computer** no longer serves `/pkg/`, so the fallback mirror is tabcomputer.com.
