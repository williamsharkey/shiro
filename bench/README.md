# bench/ — Shiro speed and memory benchmarks

```bash
npm run bench                  # full run, both modes: bench/results/<date>-<sha>.json + docs/BENCHMARKS.md
npm run bench:quick            # key metrics, ~2.5 min (isolated + JSPI kernel), doesn't touch docs/
node bench/compare.mjs bench/results/A.json bench/results/B.json   # flags >10% regressions, exit 1 if any
node bench/ab.mjs origin/unix/integration                          # A/B: that ref vs the working tree, with a significance test
node bench/report.mjs bench/results/X.json                          # regenerate the docs table from a file
```

Options for `node bench/run.mjs`:

| option | meaning |
|---|---|
| `--quick` | fewer/lighter metrics; isolated mode plus the non-isolated kernel suite |
| `--runs N` | samples per metric (default 5; boot uses 3 in `--quick`) |
| `--suites a,b` | any of `boot shell kernel wasm x86 net node hygiene` |
| `--modes isolated,nonisolated` | cross-origin isolated (SAB, Workers, Blink) and/or the fallbacks |
| `--only re1,re2` | only metrics whose name matches |
| `--no-build` | reuse `dist/` (otherwise `vite build` first) |
| `--no-gh` | skip the 59 MB `gh --version` x86 fixture |
| `--offline` | never fetch; external requests must be in `bench/.cache/net` |
| `--src dir` | measure another checkout's `dist/` (and record its git state) with this harness; `ab.mjs` uses it |
| `--out file` | results path; `--docs` / `--no-docs` force the docs table on/off |

Env: `BENCH_PATH=/?ui=terminal` (page to boot, default `/`: on localhost that is the desktop), `BENCH_VERBOSE=1` (time per metric), `BENCH_CONSOLE=1` (page console),
`BENCH_SERVER_LOG=1` (server.mjs output), `BENCH_JS_FLAGS="--flag ..."` (extra V8
flags for Chromium, e.g. wasm tiering experiments), `BENCH_PROFILE=<regex>` (CDP CPU
profile of matching metrics: top self-time functions are logged and the
`.cpuprofile` lands in `bench/.cache/profiles/`, open it in DevTools).
`CHROMIUM=/path` overrides `/opt/pw-browsers/chromium`. Never run
`playwright install`; `playwright-core` (devDependency) drives the
pre-installed Chromium.

`node bench/try.mjs 'cmd' 'js:return 1+1'` boots one page (MODE=nonisolated,
SETTLE=1 to wait for the background install) and runs shell commands or page
JS: handy for poking at something a benchmark flagged.

## A/B (`bench/ab.mjs`)

Two runs of the same commit here differ by up to ~25% on many metrics, and
a metric can cross a fixed 10% threshold in one run and not the next, so a single
`compare.mjs` of two result files can't tell a regression from noise. `ab.mjs`
does the whole comparison in one command:

```bash
node bench/ab.mjs <base-ref> [<new-ref>] [--rounds 3] [--runs 5] [--suites shell,wasm] [--only re,re]
                  [--modes isolated] [--quick] [--alpha 0.01] [--min-effect 3] [--out file.json] [--gh]
node bench/ab.mjs 68dbbbc 1d9582a --suites shell,wasm --only 'shell.loop_1000|wasm.startup|wasm.peak_rss' --runs 7
node bench/ab.mjs origin/unix/integration --quick          # integration vs your uncommitted tree
```

- `<new-ref>` defaults to the working tree as it is, uncommitted changes
  included (built in place). Any other ref is checked out once per commit
  under `bench/.cache/ab/<sha>` (git worktree, `node_modules` symlinked from
  here) and built there; later A/Bs reuse the build. Remove old ones with
  `git worktree remove --force bench/.cache/ab/<sha>`.
- Both sides run with **this** checkout's harness (`run.mjs --src`), so
  metric definitions are identical. Each round runs base and new back to
  back, alternating which goes first; `--runs` samples per metric per round
  (single-sample metrics such as `wasm.tree_create` get one per round).
- Per metric it reports both medians (all rounds pooled), the
  Hodges–Lehmann shift (median of pairwise differences) as a percent of the
  base median with `+` meaning worse, a `1 − alpha` confidence interval of
  the median shift from a **hierarchical bootstrap** (resample rounds, then
  samples within each chosen round; seeded, so reruns print the same
  interval), each round's direction (`+-+`), and a pooled Mann–Whitney p for
  reference.
- A metric is **regressed**/**improved** only when the bootstrap interval
  excludes 0, the shift is at least `--min-effect` percent (3), and every
  round moved the same way. Significant but split rounds print as
  **inconsistent**; everything else is **same** (`AB_ALL=1` lists those
  too). The pooled p is not used for the decision: samples within one run
  share a page and the machine's state at that moment, so pooling them
  overstates significance (with it, two 3-round runs of the same pair flagged
  different metrics at p < 0.01). Metrics whose
  samples are all identical on each side (request counts, decoded bytes,
  DOM nodes) are compared exactly: a difference of at least `--min-effect`
  percent is regressed/improved, a smaller one is reported as **changed**.
- Exit status 1 when anything regressed. The summary goes to
  `bench/.cache/ab/runs/<time>/ab.json` (or `--out`), next to every raw
  per-round result file.
- Use `--rounds 5` or more: with 3 rounds "every round agrees" happens by
  chance one time in four, and the bootstrap has few rounds to resample.
  Shifts under ~10% on the shell/WASM startup metrics are below what the
  browser runs can resolve; a Node microbenchmark of the code path (vitest
  with `createTestShell`) is the sharper tool there.

## How it works

- `run.mjs` builds the app, copies fixtures to `dist/__bench/`, starts a TCP
  test server (echo/source/sink on this machine's non-loopback address,
  since Shiro keeps 127/8 inside the page) and `server.mjs` twice: isolated
  (COOP/COEP) and `SHIRO_ISOLATION=0`. The relay is on (`SHIRO_TCP_RELAY=1`)
  with the bandwidth/rate limits raised and the test server's address allowed.
- Chromium (headless, `--enable-blink-features=ForceEagerMeasureMemory`)
  loads the page with `lib/inpage.js` injected first: boot marks (first
  prompt = `$ ` at the cursor), long tasks, weak refs to every
  SharedArrayBuffer/shared memory, and `window.__bench` helpers. The kernel
  "lab" there spawns processes with `kernel.spawn` and real kernel pipes, so
  kernel numbers don't include the shell.
- Every request to another origin (npm registry, Wasmer CDN) is served from
  `bench/.cache/net` (`lib/netcache.mjs`), filled with curl on a miss. Runs
  are repeatable and work offline once the cache is warm; download time is
  not part of any metric.
- Each suite gets a freshly booted page that has finished its background
  Claude Code install, so leaks in one suite can't fail the next.
- Memory: main-thread JS heap from CDP `Performance.getMetrics` after a forced
  GC, `performance.measureUserAgentSpecificMemory()` (isolated only), and the
  renderer process RSS from `/proc/<pid>/status` (includes Workers; peaks are
  sampled every 25 ms around a run, so very short programs under-report).
- Results: one JSON per run with environment info and every sample.
  `report.mjs` rewrites the table between the `bench:table` markers in
  `docs/BENCHMARKS.md`; the hotspot list there is hand-written.

## Fixtures

- `fixtures/kbench.c` → `kbench.wasm` (committed; `sh fixtures/build.sh`):
  freestanding WASI program for syscall loops, pipe and file throughput and a
  CPU loop. It times itself with `clock_time_get`, which the guest answers
  without a syscall.
- x86: Go hello / net/http from `tests/.../fixtures/x86`, the Go cpuloop from
  `vendor/blink/bench`, a static glibc hello, and GitHub CLI 2.62.0, built or
  downloaded into `bench/.cache/fixtures` when go/gcc/network are there;
  missing ones are recorded as skipped.

## Adding a metric

Add it to a suite in `suites/`: wrap it in `h.try(name, unit, fn)` (a failure
becomes a recorded skip with the error), take ≥ `h.runs` samples and call
`h.sample(name, samples, unit, { notes })`. Units `MB/s` and `proc/s` are
higher-is-better in `compare.mjs`; everything else is lower-is-better.
