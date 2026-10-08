# bench/ — Shiro speed and memory benchmarks

```bash
npm run bench                  # full run, both modes: bench/results/<date>-<sha>.json + docs/BENCHMARKS.md
npm run bench:quick            # key metrics, ~2.5 min (isolated + JSPI kernel), doesn't touch docs/
node bench/compare.mjs bench/results/A.json bench/results/B.json   # flags >10% regressions, exit 1 if any
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
| `--out file` | results path; `--docs` / `--no-docs` force the docs table on/off |

Env: `BENCH_VERBOSE=1` (time per metric), `BENCH_CONSOLE=1` (page console),
`BENCH_SERVER_LOG=1` (server.mjs output), `BENCH_PROFILE=<regex>` (CDP CPU
profile of matching metrics: top self-time functions are logged and the
`.cpuprofile` lands in `bench/.cache/profiles/`, open it in DevTools).
`CHROMIUM=/path` overrides `/opt/pw-browsers/chromium`. Never run
`playwright install`; `playwright-core` (devDependency) drives the
pre-installed Chromium.

`node bench/try.mjs 'cmd' 'js:return 1+1'` boots one page (MODE=nonisolated,
SETTLE=1 to wait for the background install) and runs shell commands or page
JS: handy for poking at something a benchmark flagged.

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
