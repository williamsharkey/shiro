# Benchmarks

Speed and memory baseline for Shiro, measured by the harness in [`bench/`](../bench/README.md)
(`npm run bench`; `npm run bench:quick` in ~2.5 min). Every number is a median
and nearest-rank p90 of the samples in the linked results file; compare two
runs with `node bench/compare.mjs base.json new.json` (flags >10% regressions).

How to read it:

- **isolated** is the production configuration (COOP/COEP from `server.mjs`):
  WASM processes run in Workers over the SAB syscall channel, x86 in Blink.
  **not isolated** (`SHIRO_ISOLATION=0`) measures the fallbacks: WASM on the
  main thread with JSPI, x86 in the `src/x86` interpreter, no WASIX packages.
- Shell metrics call `shell.execute` directly (no terminal rendering);
  kernel metrics spawn processes with `kernel.spawn` and real kernel pipes
  (no shell). WASM/x86 program metrics go through the shell at the prompt.
- External downloads (npm registry, Wasmer CDN) come from a local cache, so
  network time is not in any metric except the `net.*` relay ones, which go
  through `server.mjs`'s relay to a TCP server on the same machine.
- Memory: `js_heap` is the main thread after a forced GC; `renderer_rss` is
  the whole renderer process from `/proc` (page + Workers); `uasm` is
  `performance.measureUserAgentSpecificMemory()`. `peak_rss.*` is the RSS
  peak above the level before the run, sampled every 25 ms (short programs
  under-report).
- The baseline was taken on `unix/integration` (fc0af54) plus two fixes the
  harness needed (see "Bugs found"); without them most WASM/x86/node metrics
  fail in the built app and the relay refuses every IPv4 address.

Noise: two runs of the same commit on this 4-vCPU container differ by up to
~20% on throughput-style metrics (`kernel.pipe_*`, `kernel.file_read`,
`net.tcp_download`, `wasm.sqlite.recursive_cte`, spawn throughput) and much
more on the `hygiene.*_delta` ones. Compare full runs with full runs and
quick with quick (`--quick` uses smaller sizes for some metrics), and re-run
a flagged metric (`--suites X --only name`) before acting on one regression.

## Hotspots (ranked by expected payoff)

Measured while recording the baseline; the profiles come from
`BENCH_PROFILE=<metric regex>` (CDP CPU profile of the main thread).

1. **Shell history is rewritten to IndexedDB on every command, including
   every loop iteration.** `Shell.execute` calls `saveHistory()` (un-awaited:
   the whole history, up to 1000 lines, as one `fs.writeFile`) for each
   top-level line, and `execWhile` runs each iteration body through that same
   path (profile of `shell.loop_1000`: `saveHistory < execute < execWhile`,
   with IndexedDB `put`/`transaction`/`encode` ≈ 45% of the CPU). Costs:
   `shell.loop_1000` 136 ms (≈136 µs/iteration), `shell.for_seq_1000` 180 ms,
   and a backlog of queued transactions: after ~800 commands a single
   `fs.writeFile` waited **~22 s** for the queue to drain
   (`shell.fs_write_after_burst` shows the small-burst version, 48 ms).
   Fix: skip history for loop/function/eval bodies, and debounce
   `saveHistory` (one write per idle period, or append-only). Expect the
   loops to drop severalfold and every IndexedDB-heavy metric to stop
   depending on what ran before.
2. **SAB syscall round trip is ~93 µs** (`kernel.syscall_rtt.sab`) vs
   5.9 µs with JSPI and 0.85 µs for the in-page dispatch floor. The guest
   posts `'sys'` with `postMessage` and the kernel answers in a main-thread
   message task; the profile puts ~88 µs/call self time in
   `KernelChannel.reply` (the `Atomics.notify` wake of the waiting Worker).
   This one number drives most isolated-mode WASM costs: 512-byte pipe I/O
   at 10.7 MB/s (JSPI 69), `rg -l` over 10k files in 3.2 s while the builtin
   `grep -rl` takes 172 ms, sqlite on a file 122 ms (JSPI 40),
   startup of lua/sqlite 15–19 ms (JSPI 4–8). Ideas: serve the channel with
   `Atomics.waitAsync` on the state word instead of a message per call,
   spin briefly on the guest side before `Atomics.wait`, batch the kernel's
   replies, and answer pure queries (fstat of stdio, getpid, clock) in the
   guest.
3. **Exited WASM processes' Workers linger (isolated mode).**
   `hygiene.procs100`: **91 live Workers** after 300 short processes,
   renderer RSS +17–87 MiB per 100 processes (non-isolated: 0 Workers,
   +0.1 MiB). The host does call `worker.terminate()` when the process exits,
   but the Workers stay alive for seconds afterwards (20 sequential
   `kbench nop` spawns → 20 Workers still listed 1 s later; they drain
   slowly while other work runs). Under bursty spawning they pile up, and
   after ~200 spawns in one page new processes fail with
   `WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory for
   new instance` (seen in `kernel.file_write` before suites got fresh pages).
   Each Worker also holds its own wasm memory reservation and a blob URL
   from `?worker&inline` that is never revoked. A long Claude Code session
   runs hundreds of processes, so this is user-visible. Reusing Workers
   (hotspot 5) fixes both; short of that, terminate from inside the guest
   (`self.close()` after `proc_exit`) and revoke the blob URL.
4. **WASM writes to a file are quadratic.** `kernel.file_write` 8.5 MB/s
   isolated (JSPI 205 MB/s, reads 808 MB/s). `RegularFile.touch()` schedules
   `flush()` on `setTimeout(0)`, and `flush()` writes a full snapshot of the
   file to IndexedDB; under SAB every syscall is its own task, so the timer
   fires between nearly every 64 KiB write and a 16 MiB file is re-put ~256
   times (profile: `flush`/`put` ≈ 90%). Debounce longer (or flush on
   close/fsync/idle only) and the isolated number should approach JSPI's.
5. **Spawning a WASM process costs a fresh Worker: 8.7 ms**
   (`kernel.spawn_wait.wasm`, JSPI 1.05 ms; throughput 169 vs 3093 proc/s).
   A pool of pre-started guest Workers (the module is already compiled and
   cached) would cut shell pipelines, `make`-style workloads and Claude's
   Bash tool calls. Blink processes have the same shape (`hello_musl`
   87 ms vs 14.6 ms in the src/x86 interpreter).
6. **The 1.7 MB entry chunk is downloaded twice and never cached.** Boot
   fetches `index.html` with the entry inlined (1.7 MB) *and* the same entry
   as `assets/index-*.js` (1.6 MB, lazy chunks import it), 3.3 MB per boot,
   uncompressed; warm reloads transfer the same 3.3 MB (`boot.warm.transfer`)
   because `server.mjs` sends no `Cache-Control`/`ETag` and no gzip/brotli.
   Fixes: `Cache-Control: immutable` for `/assets/*`, compression, and not
   inlining the entry (or having lazy chunks import a shared chunk instead of
   the entry). First prompt is already fast (281 ms cold, 169 ms warm), so
   this is mostly bytes on slow links and parse time.
7. **Kernel TCP throughput** through the relay: 62 MB/s down, 25 MB/s up,
   0.55 ms echo RTT, 11 ms per connect. Upload is the weak side (64 KiB
   writes each become a WebSocket frame plus flow-control acks). Fine for git
   and npm; matters for big downloads in guests.
8. **Pane close leaks** ~160 DOM nodes and ~110 listeners per 10 split/close
   cycles (`hygiene.panes10`, +0.9 MiB heap per round), and closing a pane
   right after opening it throws `Cannot read properties of undefined
   (reading 'dimensions')` from xterm (a render scheduled after `dispose`).
9. **Background Claude Code install** takes ~4.2 s after boot and moves
   21 MiB (`boot.settled.*`), during which renderer RSS goes 221 → 236 MiB.
   Not on the critical path (prompt is up at ~0.4 s), listed for memory
   budgets.
10. **x86 `gh --version` takes 17.8 s and 157 MiB peak** in Blink (native
    ~75 ms); Go CPU loops run ~120× native (`go_cpuloop_5m` 1.2 s). That is
    the interpreter ceiling documented in `X86_ENGINES.md`; startup work
    (snapshotting a Go runtime after init) is the lever there.

Healthy, for contrast: builtin shell commands 0.14–0.43 ms per call, pty
echo 0.1 ms to the terminal buffer (frame-bound at ~11 ms), large-chunk pipe
throughput 443 MB/s, CPU-bound WASM at native speed (`wasm.cpu_loop.ratio_vs_node`
≈ 1.0), `node -e 1` 108 ms, `claude --version` 0.86 s warm (2.9 s first).

## Bugs found while benchmarking

Fixed on `unix/bench` (separate commits, so other branches can cherry-pick):

- **Built app: every lazy chunk that imports the entry failed with "Unable
  to preload CSS"** — `vite-plugin-inline.ts` deleted the inlined CSS file
  that the entry's preload deps still name. Broke WASM/x86 programs at the
  prompt, `node`, lua and more in `npm run build` output (dev mode was fine).
- **TCP relay refused every public IPv4 address**: node's `BlockList`
  matches IPv4 addresses against the IPv6 subnet `::ffff:0:0/96`, so
  `isBlockedAddress('8.8.8.8')` was true. One list per family now, with a
  regression test in `kernel-net.test.ts`.

Not fixed (reported for the owning workstreams):

- `shell.execute(...)` with a terminal attached: output of a kernel
  pipeline's last stage (`lua -v | wc -c`, `prog | cat`) goes to the tty, not
  to the caller's stdout callback, so programmatic callers (remote exec, MCP)
  get nothing. Redirecting to a file works.
- `timeout N ./elf > file`: the program runs and exits 0 but the file stays
  empty (output lost in the forked shell).
- `x=$(./prog.wasm …)` for a raw `.wasm` path keeps the pty's `\r` (ONLCR)
  in the captured text (`calls=2000\r`); package commands don't.
- src/x86 can't run Go (`fatal error: float64nan`) or static glibc
  (`Unknown two-byte opcode: 0F 62`) — known, see `X86_ENGINES.md`.

## Performance log

Each entry: what changed, and `node bench/compare.mjs` medians against a
baseline run **on the same machine** (the committed
`integration-970831e-quick.json` was recorded on a slower/busier host; even
untouched kernel metrics differ by up to 2× against it). Kernel/net/x86
metrics swing ±25% between identical runs here, so a flag on them was re-run
3× alternating base/new before being called noise.

### unix/desktop 3 — the terminal's first layout: system font lookups

perf-fs-shell's cold-boot profile showed `new ShiroTerminal` dominated by
xterm's first forced layout. A trace of that layout (`devtools.timeline` +
`fonts` categories, from `shiro:terminal:start` to `shiro:terminal:ready`)
shows it is not box layout: 17 `FontCache::GetFontPlatformData` calls, 12 of
them blocking `MatchFamilyName` IPCs to the browser's font service, for every
family in the desktop's font stacks that isn't installed (`ui-sans-serif`,
`Cascadia Code`, `Menlo`, `Consolas`, `ui-monospace`, …), about 1 ms each. The
terminal UI's first layout does 5. Containment (`contain: strict` on the
window/pane), hiding the wallpaper, title bar or wordmark, and dropping the
`@font-face` rules changed nothing measurable.

Change: the font stacks are the web font plus its generic family
(`'Inter', sans-serif`, `"JetBrains Mono", monospace`, in the CSS, xterm and
the icon glyphs), and the wallpaper wordmark joins the page with the menu bar
and dock, after the terminal exists. First layout: 12 → 7 font lookups, ~14 →
~10 ms (4 traced boots each; the terminal UI's is ~4 ms).

`node bench/ab.mjs origin/unix/integration --quick --suites boot --rounds 5`
(79594fd vs this): no significant change end to end — cold first prompt
213 → 202 ms (p = 0.97), warm 130 → 114 ms (−10%, lower in all 5 rounds,
p = 0.15), first command and long tasks unchanged. A 3-round run of the same
pair showed cold first prompt +9.5% (p = 0.09) and first command +3 ms
(p = 0.003); the 5-round run didn't reproduce either, so both are read as noise.

### unix/desktop 2 — fewer requests and DOM nodes at first prompt

Integration 1d9582a counted 15 boot requests and 414 DOM nodes (68dbbbc: 10
and 353). What the page loaded before the first prompt, by source:

- desktop: the chunk's CSS file (since the chunk split), 3 `data:` SVGs (the
  traffic-light glyphs), and icon tiles built from SVG gradients (106 of the
  dock's 132 nodes were `<defs>`, gradients, stops and frame rects);
- unix/gui: `gui/desktop-apps` (dock icons for Debian GUI apps), `x11/display`;
- unix/debian: `debian/rootfs`.

Changes: the desktop CSS is inlined into its chunk (`?inline`, injected at
boot); the traffic-light glyphs are text; a tile's gradient, shine and border
are CSS (`.sd-tile`) so the SVG holds only the glyph; the GUI apps register on
idle (`requestIdleCallback`) instead of before the first prompt. `x11/display`
and `debian/rootfs` are unchanged (the X socket and the Debian PATH set-up
belong at boot).

Quick suite `--suites boot`, integration c14344d vs. this change, two rounds
alternated on one machine, medians of 6:

| metric | before | after |
|---|---:|---:|
| boot.cold.requests (until TTI) | 15 | 11 |
| boot.settled.requests | 16 | 12 |
| boot.mem.dom_nodes (at TTI) | 414 | 349 |
| boot.cold.first_prompt | 210 ms | 212 ms |
| boot.warm.first_prompt | 158 ms | 122 ms |
| boot.cold.transfer | 1575 KiB | 1574 KiB |
| boot.mem.renderer_rss | 232 MiB | 229 MiB |

At the first prompt itself (CDP, before idle work): 14 → 9 requests and 241 →
177 DOM nodes; the bench's TTI is a second later and includes the GUI apps.
### unix/gui — X11 server in the page, Debian GUI apps on first use

New: `Xshiro :0` (a kernel process listening on `/tmp/.X11-unix/X0`, ~1 KB in
the main bundle; the server, RENDER and fonts are a 180 KB gzip chunk loaded
on the first X client), dock entries for four GUI apps, and `gui`
(docs/GUI.md). Boot cost, `--quick --suites boot --runs 5 --modes isolated`,
base 4970079 (unix/integration) vs. this branch, two rounds alternated on one
machine, medians of all samples:

| metric | base | unix/gui |
|---|---:|---:|
| boot.cold.first_prompt | 305 ms | 307 ms |
| boot.warm.first_prompt | 199 ms | 163 ms (noise) |
| boot.cold.long_tasks | 2 | 2 |
| boot.cold.requests | 12 | 12 |
| boot.cold.transfer | 1550 KiB | 1554 KiB |
| boot.mem.js_heap | 3.8 MiB | 3.9 MiB |
| boot.mem.renderer_rss | 230 MiB | 231 MiB |
| boot.mem.dom_nodes | 355 | 387 (+4 dock icons) |

The first version loaded the display listener and the dock list as two lazy
chunks: +2 requests on every boot. Both are static imports now.

GUI apps in headless Chromium (`scripts/gui/shoot.mjs`, local server with
network to deb.debian.org), from `gui APP` to the first drawn frame; install
is download + unpack + triggers:

| app | download | install | first frame | warm start |
|---|---:|---:|---:|---:|
| xeyes (Xt, SHAPE) | 7.5 MB | 1.9 s | 0.9–1.3 s | 0.5 s |
| xterm (Xaw, pty) | 9.3 MB | 2.1 s | 2.5–2.7 s | 1.6–1.9 s |
| GPicView (GTK 2) | 26.8 MB | 4.8–7.6 s | 6.9–9.7 s | 6.7 s |
| FeatherPad (Qt 5) | 35.0 MB | 6.1–7.8 s | 10.5–16 s | 8.9–14.7 s |
| L3afpad (GTK 3) | 33.1 MB | 10.3–12.2 s | 12.9 s | — |
| Ristretto (GTK 3) | 35.1 MB | 10.9 s | 14.4–15.5 s | 13.1 s |
| GIMP 2.10 (GTK 2) | 53.2 MB | 19 s | 290 s (main window) | 84 s |

Reinstalling from the browser's Cache Storage (by sha256, no network): xeyes
1.4 s, xterm 1.7 s, GPicView 7.2 s, FeatherPad 7.0–8.2 s — unpacking (JS xz)
and writing files dominates. Start-up is Blink loading ~70–100 shared
libraries and toolkit init, so a warm start is barely faster than the first.
GTK 3 needed Blink patch 0029 (it spun in cairo/pixman SSE compares).

### unix/desktop — the desktop shell (menu bar, dock, windows) on the boot path

The Unix edition boots to the desktop (docs/DESKTOP.md); shiro.computer keeps
the full-page terminal. The bench loads `/` on localhost, which is the desktop;
`BENCH_PATH='/?ui=terminal'` boots the terminal UI instead.

The integration run of the first push (`integration-68dbbbc-quick.json`) showed
cold first prompt 198 → 249 ms, 2 long tasks and +13% transfer, and the terminal
UI carried the desktop's code and CSS. Since then:

- **The desktop is its own chunk** (`import('./desktop/index')` at the top of
  `main()`: 53 KB JS + 22 KB CSS, fetched while IndexedDB opens). The terminal
  UI loads none of it; Files, Settings, Activity and About are further chunks
  loaded on launch.
- **Boot-path work removed:** the clock no longer builds `Intl.DateTimeFormat`s
  (≈9 ms); `workArea()` uses the CSS sizes instead of reading layout (it forced the
  first style+layout pass before the terminal existed); the main terminal gets
  its theme and font at construction (`ShiroTerminal.optionOverrides`) instead
  of a re-theme; the mono-font swap re-measure (≈9 ms of xterm `_measure`) runs
  on idle; `term.focus()` (forced layout of the whole desktop) waits for the
  first frame; the menu bar and dock join the page after the main terminal is
  created. Marks `shiro:desktop:start`, `shiro:desktop:end`, `shiro:terminal:ready`.

Quick suite, `--suites boot`, base db9f698 (before the desktop) vs. this branch
in both UIs, two rounds alternated base/desktop/terminal on one machine; medians
of the 6 samples per metric:

| metric | base | desktop | terminal UI |
|---|---:|---:|---:|
| boot.cold.first_prompt | 192 ms | 209 ms (+9%) | 196 ms |
| boot.warm.first_prompt | 99 ms | 109 ms (+10%) | 97 ms |
| boot.cold.long_tasks | 1 | 0 | 1 |
| boot.cold.requests | 5 | 12 | 5 |
| boot.cold.transfer | 1370 KiB | 1550 KiB | 1389 KiB |
| boot.mem.js_heap | 3.7 MiB | 3.8 MiB | 3.7 MiB |
| boot.mem.renderer_rss | 206 MiB | 228 MiB | 206 MiB |
| boot.mem.dom_nodes | 258 | 355 | 258 |

Desktop requests: the desktop chunk and its CSS, Inter and JetBrains Mono
(woff2, latin, 88 KiB together, `font-display: swap`, not render-blocking), and
three `data:` SVGs (traffic-light glyphs) that CDP counts. The +22 MiB RSS is
composited layers (blurred menu bar and dock, full-screen wallpaper) and fonts,
a few MiB each. The terminal UI's +19 KiB is /dom, the sign-in hook and the
other integration changes since db9f698, not desktop code.

### unix/shell-stdio 3 — fd copies keep their stream; programs inherit fds 3-9

`node bench/ab.mjs origin/unix/integration HEAD --suites shell,kernel --quick`
(b8834c7 → 501fe88, 3 rounds × 5 runs, alpha 0.01): no regression. 22
metrics unchanged; shell.echo improved (0.12 → 0.074 ms, every round);
shell.redirect_append_100 moved −29% but not in every round (inconsistent).

### unix/shell-stdio 2 — POSIX shell fixes (smoosh suite)

Signals to the shell, $$/$PPID/$!, exported vs unexported variables,
subshell EXIT traps, set -u, bracket expressions and the other fixes found by
the smoosh POSIX suite (docs/CONFORMANCE.md). Quick shell suite, isolated,
base unix/integration c14344d vs. 3107d0c, three runs of each alternating
(medians per run, ms):

| metric | base | new |
|---|---|---|
| shell.true | 0.075 / 0.080 / 0.080 | 0.068 / 0.090 / 0.072 |
| shell.cmd_subst | 0.268 / 0.205 / 0.170 | 0.205 / 0.194 / 0.223 |
| shell.loop_1000 | 86.7 / 96.3 / 93.7 | 110.2 / 86.7 / 98.2 |
| shell.for_seq_1000 | 36.5 / 35.8 / 39.1 | 36.3 / 38.6 / 38.2 |
| shell.pipeline_seq_grep_wc | 31.7 / 33.4 / 38.1 | 54.3 / 41.3 / 38.0 |
| shell.redirect_append_100 | 6.26 / 6.46 / 7.65 | 6.92 / 7.41 / 7.42 |

compare.mjs flagged loop_1000, pipeline_seq_grep_wc and redirect_append_100
on the first pair; the runs overlap after that. A CPU profile of
pipeline_seq_grep_wc on both builds has the same top functions (seq's number
formatting, wc's count, grep), none of them changed here, so the difference
is taken as noise. Worth re-measuring on a quieter host.

### unix/shell-stdio — a shell run as a kernel process uses its fds

`sh -c SCRIPT` spawned by a program (and scripts run through `runViaShell`)
now uses the process's fds as its stdio (`src/shell-stdio.ts`), and builtins
run as kernel processes read fd 0 only if they look at `ctx.stdin`. Quick
suite, `--suites shell,kernel`, base 2455c97 vs. 5627dae, two runs of each
(medians of both runs pooled):

| metric | base | new | change |
|---|---:|---:|---:|
| isolated:shell.true | 0.073 ms | 0.096 ms | noise: 0.053 → 0.055 ms over 15 runs each |
| isolated:shell.echo | 0.081 ms | 0.085 ms | +5% |
| isolated:shell.cmd_subst | 0.185 ms | 0.191 ms | +3% |
| isolated:shell.loop_1000 | 105.5 ms | 84.2 ms | −20% |
| isolated:shell.pipeline_seq_grep_wc | 68.5 ms | 49.7 ms | −27% |
| isolated:shell.redirect_append_100 | 7.93 ms | 8.47 ms | +7% |
| isolated:kernel.spawn_wait.builtin | 0.445 ms | 0.39 ms | −12% |
| isolated:kernel.spawn_throughput.builtin | 4958 proc/s | 5165 proc/s | +4% |
| nonisolated:kernel.spawn_wait.builtin | 0.3 ms | 0.3 ms | 0% |
| nonisolated:kernel.spawn_throughput.builtin | 8197 proc/s | 8264 proc/s | +1% |
| nonisolated:kernel.spawn_throughput.wasm | 1351 proc/s | 938 proc/s | noise, see below |

The shell metrics run in-page (no kernel process), where the change only adds
a `liveStdin()` check per segment. `spawn_throughput.wasm` doesn't reach the
changed code (the WASM loader answers before the builtin loader) and its
samples are bimodal at the nonisolated timer's resolution (≈1000 or ≈1900
proc/s within one run); two further 15-run passes on the new code gave
medians 1240 and 1215 proc/s, base 1200. One of those passes stalled at
≈10 proc/s for its last 11 samples and did not recur in two more; worth
watching if it shows up on other branches.

### unix/perf-blink 3 — mul/div/bit ops inline, decode cache, a fusion fix

Patch 0012 now translates what `gh --version` still sent to Blink's handlers
(BLINK_WJIT_DEBUG=2 counts executed fallbacks: ~3M before, a few thousand
after): mul, imul and div/idiv with one operand (128-bit products from 32-bit
halves; a dividend that doesn't fit, a zero divisor or an overflow calls
Blink's handler from inside the region), neg/not, adc/sbb, bt/bts/btr/btc,
bsf/bsr/tzcnt/lzcnt and the 16-bit ALU, mov and cmov forms. Patch 0022: a
4096-entry decoded-instruction cache (was 512; `gh` decodes 3.2M → 1.4M),
and two interpreter fixes found by running the new fuzz groups natively
(`lzcnt` returned `bsr`'s index; 32-bit one-operand `imul` sign-extended
into the top of `%rdx`). Correctness fix: a cmp/test fused with its jcc,
setcc or cmov keeps the flags in wasm locals, and an instruction in between
that leaves the region part way (page-crossing or faulting memory access)
handed the interpreter stale flags; fusion now stops at such instructions
(`jitfuzz.c` `cmpcross` failed on the old build, matches native now).

Base = the previous engine re-run in the same session
(`perf-blink-5-base-x86.json`); new = two runs (`perf-blink-5a-x86.json`,
`perf-blink-5b-x86.json`), x86 suite, isolated, 5 samples each:

| metric (isolated) | base | new (a) | new (b) |
|---|---:|---:|---:|
| x86.blink.gh_version | 2620 ms | 2473 ms | 2338 ms |
| x86.blink.go_cpuloop_5m | 193.5 ms | 194.8 ms | 204.4 ms |
| x86.blink.go_hello | 203.2 ms | 212 ms | 213.8 ms |
| x86.blink.go_nethttp | 395.1 ms | 358.8 ms | 381.4 ms |
| x86.blink.hello_musl | 89.7 ms | 94.1 ms | 97.8 ms |
| x86.blink.hello_glibc | 99.9 ms | 117.6 ms | 113.7 ms |
| x86.blink.peak_rss.gh_version | 153.5 MiB | 156 MiB | 156.3 MiB |
| x86.blink.peak_rss.go_nethttp | 16.5 MiB | 24.2 MiB | 28.1 MiB |

Against the committed `perf-blink-4-x86.json` (earlier the same day) every
blink timing is 10–20% better, but so is the unchanged base re-run, so the
suite only shows `gh` (−6 to −11%). The small programs are within noise
(hello_glibc's base samples 92–108 ms, new 98–125 ms). Peak RSS is renderer
RSS and swings 2x within a run (hello_musl samples 7–21 MiB, net/http base
14–25, new 16–31); Blink's wasm heap is unchanged (64 MB for the small
programs, 117 MB for `gh`) and the decode cache adds 160 KB per guest
thread. Where it shows is code built from those ops: `vendor/blink/bench/arith.c`
(10M iterations of div, mul, btc, tzcnt and 16-bit math) takes 173–190 ms
instead of 2.5–2.8 s in the X86_ENGINES table driver (native 40 ms), and the
table's Go loop 50M went 362 → 253 ms back to back. In Node, `gh --version`
is 3.2–3.3 s against 3.4–3.5 s for the previous build.

Full suite: 2735 passed, 1 failed: `kernel-wasi.test.ts` "reuses guest
Workers" (`expected 4 to be ≤ 3` spare Workers) under full-suite load; it
passes 3/3 alone and doesn't involve Blink.

### unix/perf-blink 2 — smaller generated code, forward branches, SSE moves

`perf-blink-after-x86.json` → `perf-blink-2-x86.json` (x86 suite, isolated, 3 runs):

- A memory access that misses the JIT's translation cache calls a helper that
  refills it and never faults; on a fault or a page-crossing access the
  region exits *before* the instruction (every translator resolves its memory
  operands before changing state) and the interpreter runs it. All exits
  share one epilogue. Generated code for `gh --version` went from 17.2 MB to
  9.8 MB of wasm.
- Blocks are laid out by address: fallthroughs are free and forward branches
  are direct `br`s; only backward branches go through the dispatch loop and
  its budget/signal check.
- movups/movupd/movdqu/movsd loads and stores, register movaps/movdqa,
  pxor/xorps are inline (v128 loads/stores); Go's memmove/memclr use them.

| metric (isolated) | JIT v1 | JIT v2 | change | vs. no JIT |
|---|---:|---:|---:|---:|
| x86.blink.gh_version | 5153 ms | 3231 ms | −37% | 31974 ms (9.9×) |
| x86.blink.go_cpuloop_5m | 267 ms | 227 ms | −15% | 2001 ms |
| x86.blink.go_hello | 266 ms | 215 ms | −19% | 220 ms |
| x86.blink.go_nethttp | 601 ms | 487 ms | −19% | 459 ms |
| x86.blink.hello_musl | 140 ms | 115 ms | −18% | 92.5 ms |
| x86.blink.peak_rss.go_nethttp | 22.1 MiB | 25.6 MiB | +16% (noise range) | 34.1 MiB |

The suite's medians exclude the first run, and for `gh` that matters: V8
caches compiled wasm by module bytes for the whole renderer process, so the
first `gh --version` in a page is 6.3–6.9 s and later ones ~3.2 s (also for
a second copy of the binary). Without the JIT the first run is no slower.

Quick suite against the integration baseline
(`integration-d286c5e-quick.json` → `perf-blink-3-quick.json`): x86.blink.go_hello
267 → 217 ms, go_nethttp 498 → 424 ms, hello_musl 115 → 93 ms. Flagged
elsewhere (kernel.spawn_throughput.builtin, syscall_inpage, shell redirects,
sqlite CTE, file_read): code this branch doesn't touch, within the run-to-run
swing noted at the top of this log.

Bug found on the way: `cp` copied files as UTF-8 text, so a copied ELF
binary grew (50 → 67 MB for `gh`) and didn't run; it now copies bytes and
the mode bits (`commands.test.ts`).

### unix/perf-blink 1 — wasm JIT for Blink (x86-64 → WebAssembly)

Vendor patch 0012 (`blink/wjit.c`, see `X86_ENGINES.md` "The wasm JIT"):
hot x86-64 regions are compiled to WebAssembly modules that share Blink's
memory, keep guest registers in wasm locals, inline integer ops, memory
accesses and fused compare+branch, and call Blink's op handlers for the rest.

Full x86 suite, isolated, 3 runs, original build →
`bench/results/perf-blink-before-x86.json` vs JIT build →
`bench/results/perf-blink-after-x86.json` (same machine, same tree):

| metric (isolated) | base | new | change |
|---|---:|---:|---:|
| x86.blink.gh_version | 31974 ms | 5153 ms | −84% (6.2×) |
| x86.blink.go_cpuloop_5m (wall; in-guest loop 26 ms) | 2001 ms | 267 ms | −87% (7.5×) |
| x86.blink.peak_rss.go_nethttp | 34.1 MiB | 22.1 MiB | −35% |
| x86.blink.peak_rss.gh_version | 159.5 MiB | 159.9 MiB | same |
| x86.blink.go_hello | 220 ms | 266 ms | +21% (see below) |
| x86.blink.go_nethttp | 459 ms | 601 ms | +31% (see below) |
| x86.blink.hello_musl | 92.5 ms | 140 ms | +51% (see below) |

The short-program flags are mostly noise between runs: re-run 6× each
after merging unix/integration d286c5e (`--only`, both builds back to back)
they were hello_musl 105 → 120 ms, hello_glibc 128 → 155–193 ms, go_hello
289 → 297 ms, nethttp 540 → 555 ms, and with `BLINK_WJIT=0` vs the JIT on the
same build hello_glibc was 166 vs 155 ms and hello_musl 122 vs 114 ms — the
JIT itself costs nothing there; what remains is the 90 KB larger module and
one more compare per interpreted instruction. `vendor/blink/bench/chromium.mjs`
(X86_ENGINES.md table, one page, back to back): `gh --version` 26.6 s → 4.05 s,
Go loop 50M 14.4 s → 0.46 s, C loop 5M 1.41 s → 0.13 s, Go TLS 1.0 s → 0.82 s,
Go hello 237–245 → 231–234 ms.

### unix/perf-fs-shell 1 — write-behind filesystem, debounced history

Baseline `bench/results/integration-970831e-quick-local.json` (unix/integration
970831e + unix/bench, this container) → `bench/results/perf-fs-shell-1-quick.json`.

- `FileSystem` (src/filesystem.ts) is write-behind: a mutation updates the
  in-memory cache and resolves; the IndexedDB writes are queued per path
  (latest wins) and committed in one readwrite transaction per flush, a
  MessageChannel macrotask after the first dirty write. One flush is in
  flight at a time. The key index (`getAllKeys`) is kept current instead of
  being re-read after every write, and a path missing from it needs no
  IndexedDB read (creating a file used to cost a `get` for the "existing"
  check). Appends coalesce: 100 `echo >> f` in a loop are one put.
- Crash safety: a write is durable when its flush commits, normally within
  one event-loop turn. `fs.sync()` (new `sync` command, kernel `fsync`)
  waits for that with strict durability and reports a failed background
  flush once; the page flushes on `visibilitychange`→hidden, `pagehide` and
  `freeze`, and `beforeunload` still warns while `pendingWrites > 0`. A flush
  is one transaction, so a crash keeps all of it or none of it. Tests:
  `fs-write-behind.test.ts`.
- Shell history is written after 500 ms of quiet (and on pagehide/hidden)
  instead of a full `~/.bash_history` rewrite per command, and loop,
  function, `if`, `eval`, `time` and trap bodies no longer add entries (bash
  records only the typed line).
- The kernel inode's flush waits for `fs.flushed()`, so a file written by a
  WASM program is still snapshotted once per IndexedDB commit rather than
  once per syscall task.
- Fixed on the way: node scripts could hang until the test timeout when a
  sync fs call queued work after the exit drain (`binary-files.test.ts`
  exposed it once writes got fast); `appendFile` through a symlink replaced
  the link with a regular file.

| metric (isolated) | base | new | change |
|---|---:|---:|---:|
| shell.loop_1000 | 114.3 ms | 16.5 ms | −86% (6.9×) |
| shell.for_seq_1000 | 118.2 ms | 25.0 ms | −79% (4.7×) |
| shell.redirect_append_100 | 108 ms | 7.7 ms | −93% |
| shell.fs_write_after_burst | 38.1 ms | 0.04 ms | −99.9% |
| shell.cmd_subst | 0.40 ms | 0.07 ms | −82% |
| wasm.tree_create (until writes resolve) | 636 ms | 9.6 ms | −98.5% |
| 2000-file tree until `fs.sync()` returns (`bench/try.mjs`, 2 runs) | 658–679 ms | 87–93 ms | ≈7× |
| npm.install_small | 55.0 ms | 18.3 ms | −67% |
| wasm.builtin_grep_r.tree | 23.9 ms | 18.1 ms | −24% |
| boot.cold.first_prompt | 209 ms | 169 ms | −19% |

Against the committed host baseline the loops are 324 → 16.5 ms (20×) and
342 → 25 ms (14×). Flagged by compare and re-run: `kernel.file_write`
(isolated 26–27 vs 27–30 MB/s over 3 runs each), `kernel.spawn_throughput.*`,
`kernel.syscall_inpage`, `kernel.file_read`, `shell.pipeline_seq_grep_wc`,
`boot.warm.first_command`: overlapping ranges, noise.

### unix/perf-fs-shell 2 — no dynamic import per command

`perf-fs-shell-1-quick.json` → `perf-fs-shell-2-quick.json`. `tryKernelRun`
(called for every simple command) did `await import('./shell-kernel')`, which
in the build goes through Vite's `__vitePreload` helper each time (≈20% of
`for_seq_1000`'s profile). The module is now loaded once and then used
synchronously.

| metric (isolated) | before | after | vs same-machine baseline |
|---|---:|---:|---:|
| shell.for_seq_1000 | 25.0 ms | 11.4 ms | 118 → 11.4 ms (10×) |
| shell.redirect_append_100 | 7.7 ms | 3.1 ms | 108 → 3.1 ms (35×) |
| shell.true (focused run) | 0.08 ms | 0.034 ms | 0.12 → 0.034 ms |

Flagged and judged noise (in-page kernel lab, no shell involved; within the
ranges of the 3× re-runs above): `kernel.syscall_inpage`,
`kernel.epoll_wakeup`, `kernel.pipe_throughput_512b`,
`kernel.spawn_throughput.wasm` (nonisolated); `wasm.startup.lua` 9.2 → 10.5 ms
(baseline 10.5).

### unix/perf-fs-shell 3 — closed panes are released

`perf-fs-shell-2-quick.json` → `perf-fs-shell-3-quick.json`. Every closed
pane stayed alive: the kernel's device table kept the pane's `/dev/pts/N`
opener, the pty kept its output callback, and that held the `ShiroTerminal`,
its `Shell`, xterm and the pane's DOM (`Runtime.queryObjects`: +10 terminals
and +10 shells per round of 10). Closing the pty master now unregisters its
device node in every kernel and drops the output callback
(`pane-teardown.test.ts`). Two xterm 5.5 problems on the same path:
`CoreBrowserService` never disposes its `ScreenDprMonitor`, so a window
`resize` listener survived each pane (disposed by hand now), and the
Viewport's `setTimeout(syncScrollArea)` queued at `open()` threw
`Cannot read properties of undefined (reading 'dimensions')` when a pane
closed right away (`term.dispose()` now runs one task later).

| metric (isolated) | before | after |
|---|---:|---:|
| hygiene.panes10.dom_nodes_delta | 169.5 | 1.5 |
| hygiene.panes10.listeners_delta | 115 | 5 |
| hygiene.panes10.js_heap_delta | 1.42 MiB | 0.60 MiB |
| hygiene.panes10.total_heap_growth | 2.84 MiB | 1.21 MiB |
| live ShiroTerminal / Shell after 3 rounds (probe) | 31 / 31 | 1 / 1 |

The remaining heap delta is the first round's one-off growth: in a 7-round
probe the heap stays within ±0.1 MiB from round 2 on. Flagged and judged
noise: kernel-lab metrics as before, `boot.warm.first_command` 5.9 → 6.6 ms
(baseline 6.0), `wasm.tree_create` 8 → 15 ms (one sample).

### unix/perf-fs-shell 4 — git and reload load on first use

`perf-fs-shell-3-quick.json` → `perf-fs-shell-4-quick.json`. A source-map
breakdown of the entry chunk (1.70 MB) put isomorphic-git (148 KiB),
esbuild-wasm's JS API (68 KiB) and pako (48 KiB) in it, all only reachable
from the `git` and `reload` commands, which were registered eagerly. Both are
`lazyCommand`s now, and the `~/.gitconfig` helpers that `gh auth` uses moved
to `src/commands/git-config.ts` so they don't pull in git. Entry chunk:
1.70 → 1.28 MB.

| metric (isolated) | before | after | same-machine baseline |
|---|---:|---:|---:|
| boot.cold.transfer | 1687 KiB | 1277 KiB | 1683 KiB |
| boot.cold.first_prompt | 167.7 ms | 149.4 ms (re-runs 136, 149) | 209 ms |
| boot.mem.uasm | 7.16 MiB | 5.90 MiB | 7.14 MiB |
| boot.mem.js_heap | 3.83 MiB | 3.39 MiB | — |
| boot.settled.js_heap | 3.87 MiB | 3.43 MiB | — |
| claude.version | — | 686 ms | 761 ms |

`boot.mem.renderer_rss` stays ~207 MiB: that is Chromium's renderer
baseline plus the kernel and xterm, not the entry chunk. The background
Claude Code install (19 MiB, `boot.settled.*`) already waits 3 s after boot
and is what keeps `claude` startup at ~0.7 s, so it stays. Flagged and
re-run: `shell.pipeline_seq_grep_wc` (9-run medians, 3× alternating: base
14.1–15.7 ms, new 14.9–17.0 ms), `boot.warm.first_command` (re-runs 5.9,
6.2 ms vs 6.6), x86/kernel metrics: noise.

### unix/perf-kernel, round 1: syscall transport, Worker leak and pool, file flush

`bench/results/perf-kernel-r1-quick.json`, compared with `integration-970831e-quick.json` ("baseline") and with that commit (`cc8539e`) built in a worktree and run on this machine in the same session ("base here"). Changes:

- **SAB channel transport** (`src/kernel/channel.ts`). The kernel watches each
  guest's state word with `Atomics.waitAsync` instead of a `'sys'`
  postMessage per call; guests spin ~0.1 ms before sleeping and mark that in
  the state word (`STATE_REQUEST_SPIN`), so replies to a spinning guest need
  no `Atomics.notify` (it cost ~10–25 µs on the page). While guests make
  calls back to back, one page-side pump polls every hot channel for 30 µs
  after each reply (bounded to 4 ms per task, then it yields), so their next
  request is served without an event-loop round trip.
- **Sync fast path**: `kernel.syscallSync` answers ids, fstat, lseek, fcntl
  get/setfd and read/write that need no waiting (new optional
  `OpenFile.tryRead/tryWrite/statSync`: pipes, regular files, /dev/null)
  with no microtask hops; JSPI guests skip suspension for them. A blocked
  pipe read/write waits on `onReady` and is answered inside the call that
  makes it ready.
- **Worker leak**: Chromium can't terminate a Worker parked in
  `Atomics.wait`, and every exited WASM process left its guest parked there
  (60 Workers, ~70 MiB RSS per round of 100 processes). The kernel now closes
  the channel (`STATE_DEAD` + notify), the guest throws `ChannelClosed`,
  unwinds to its event loop, and the Worker is reused or terminated.
- **Worker pool** (`src/wasi/worker-pool.ts`): an unwound guest Worker
  reports `wasi-idle` and runs the next WASM process; up to 8 wait during
  bursts, 2 after 10 s without spawns, one is pre-started after each spawn.
- **Kernel file write-back** (`Inode` in `fd.ts`): flushed once writes pause
  for 25 ms (at most every 1 s), not on a 0 ms timer after every write; each
  flush stores the whole file, so a 4 MiB file written in 64 KiB pieces was
  stored 64 times.

| metric (isolated unless noted) | unit | baseline | base here | round 1 |
|---|---|---|---|---|
| kernel.syscall_rtt.sab | µs | 155 | 92.6 | **3.72** |
| kernel.syscall_rtt.jspi (non-isolated) | µs | 10.8 | 8.00 | 5.48 |
| kernel.pipe_throughput_512b | MB/s | 6.62 | 11.4 | **69.7** |
| kernel.pipe_throughput_512b (non-isolated) | MB/s | 56.3 | 61.0 | 127 |
| kernel.pipe_throughput (64 KiB) | MB/s | 355 | 495 | 759 |
| kernel.file_write | MB/s | 14.2 | 21.6 | **236** |
| kernel.file_read | MB/s | 496 | 757 | 2213 |
| kernel.spawn_wait.wasm | ms | 14.5 | 8.76 | **0.53** |
| kernel.spawn_throughput.wasm | proc/s | 128 | 198 | 364 |
| kernel.epoll_wakeup | µs | 54.1 | 28.9 | 29.4 |
| hygiene.procs100.workers_left | count | 60 | 88 | **2** (the idle pool) |
| hygiene.procs100.rss_delta | MiB/round | 69.8 | 87.0 | **6.06** |
| wasm.ripgrep.tree | ms | 1137 | 681 | **189** |
| wasm.startup.lua / sqlite3 / ripgrep | ms | 22 / 27 / 26 | 15 / 19 / 16 | 4.8 / 6.7 / 6.1 |
| wasm.sqlite.recursive_cte | ms | 153 | 107 | 97.9 |

`compare.mjs` against the baseline: 54 improved, 5 flagged. The flagged ones
are machine drift or noise: `wasm.cpu_loop.{native,node,shiro}` +13–18%
(native included), `x86.blink.peak_rss.go_nethttp` +20% (Blink does not use
the changed channel code), and non-isolated `kernel.spawn_wait.wasm`
0.5 → 1.5 ms, which is 0.9–1.15 ms for the base commit here too (first
samples of the metric vary 0.3–9 ms). Three interleaved A/B kernel runs had
one real regression, isolated `spawn_throughput.builtin` −40%: the pool
terminated surplus Workers in the middle of the benchmark's builtin rounds;
keeping 8 idle during bursts and trimming later fixed it (7837/6620 vs base
4941/8323 proc/s). Boot/shell/x86 A/B: no difference beyond noise.

Still open: 512-byte pipe I/O is ~70 MB/s isolated (target >100); each call
is now ~2–3 µs, near the cost of the cross-thread handoff itself.

### unix/perf-kernel, round 2: per-file cost (rg over 2000 files)

`bench/results/perf-kernel-r2-quick.json` vs `integration-d286c5e-quick.json`
(after merging unix/integration; `perf-kernel-r1m-quick.json` is round 1 on
top of that merge). Profile of `rg -l` over 2000 files: ~11k syscalls
(5800 read, 2100 openat, 2100 close, 627 newfstatat, 202 getdents64), and
`FileSystem.readdir` scanning every key in the store (the Claude Code
install included) once per directory.

- `FileSystem.readdir` uses a parent → children index built from the key
  set on first use and updated with it (no scan of every key).
- `kernel.syscallSync` also answers `openat` of a cached file or directory
  (no O_CREAT/O_TRUNC), `close` when nothing needs writing back
  (`OpenFile.closeSync`), and stat/lstat/newfstatat from
  `FileSystem.lookupCached`; getdents64 types entries from the same cache
  instead of an awaited stat per entry. A registered handler can let these
  through with `handler.passSync` (host.ts's `/bin/<command>` stat does).

| metric (isolated) | unit | d286c5e | round 1 merged | round 2 |
|---|---|---|---|---|
| wasm.ripgrep.tree | ms | 1196 | 306 | **204** |
| wasm.builtin_grep_r.tree | ms | 72.6 | 58.4 | **19.8** |
| kernel.syscall_rtt.sab | µs | 149 | 4.61 | 8.30 |
| kernel.pipe_throughput_512b | MB/s | 6.75 | 50.3 | 40.4 |
| kernel.spawn_wait.wasm | ms | 15.6 | 0.77 | 1.18 |
| hygiene.procs100.workers_left | count | 54 | 3 | 3 |
| hygiene.procs100.rss_delta | MiB | 64.9 | 6.0 | 6.6 |

The machine was markedly slower during the round 2 run (the same channel
code measured 3.7 µs RTT earlier). `compare.mjs` flags against d286c5e
(boot, shell, net, x86, non-isolated kernel throughput) did not hold up in
interleaved A/B runs against d286c5e built here: e.g. non-isolated
`spawn_throughput.builtin` came out −40%, then −9% and +22% when re-run
with different preceding metrics, on a ~10 ms measurement with 100 µs
timer resolution. In-page rg runs measure 170–230 ms; the first run in a
page is slower (the pool starts Workers for rg's threads).

### unix/perf-kernel, round 3: WASI read/write fast path, epoll timeouts

`bench/results/perf-kernel-r3-quick.json`. A plain JS guest (GuestSys, no
WASI layer) already did 1.5 µs RTT and 114–135 MB/s of 512-byte pipe I/O in
the browser, so the rest of the gap was the WASI guest's per-call work: a
new DataView per access, iovec arrays, a gather copy, three generators and
request/reply objects per `fd_write`.

- `fd_read`/`fd_write` in Worker guests go straight to the channel
  (`WasiGuest.direct`): iovecs are gathered into / scattered from the data
  area, one call, no generators. Memory views are cached per buffer.
- poll/epoll/select timeouts share one timer; a wait that ends on readiness
  only marks its deadline dead (no setTimeout/clearTimeout per call).

| metric | unit | d286c5e | round 2 | round 3 |
|---|---|---|---|---|
| kernel.syscall_rtt.sab | µs | 149 | 8.30 | **5.62** |
| kernel.syscall_rtt.jspi (non-isolated) | µs | 10.2 | 3.98 | 3.74 |
| kernel.pipe_throughput_512b | MB/s | 6.75 | 40.4 | 76.5 (112, 115 in two kernel+wasm runs) |
| kernel.pipe_throughput_512b (non-isolated) | MB/s | 45.7 | 64.3 | 80.7 |
| kernel.pipe_throughput (64 KiB) | MB/s | 334 | 333 | 740 |
| kernel.file_write | MB/s | 18.2 | 105 | 156 |
| kernel.spawn_wait.wasm | ms | 15.6 | 1.18 | 0.85 |
| kernel.spawn_throughput.wasm | proc/s | 128 | 313 | 303 |
| kernel.epoll_wakeup | µs | 79.8 | 71.8 | 57.5 |
| hygiene.procs100.workers_left | count | 54 | 3 | 3 |
| hygiene.procs100.rss_delta | MiB | 64.9 | 6.6 | 6.5 |
| wasm.ripgrep.tree | ms | 1196 | 204 | 169 |
| wasm.builtin_grep_r.tree | ms | 72.6 | 19.8 | 20.6 |

512-byte pipe I/O depends on how warm the guest Workers are: eight runs in
one page measured 57, 48, 81, 55, 90, 116, 164, 119 MB/s (pooled Workers
keep the guest's JIT-compiled code; the quick bench takes 3 samples).
`epoll_wakeup` is mostly the benchmark's own timer turn: the in-page
wait + write + read cycle measures ~17 µs (~13 µs without a timeout).

RSS over many rounds (500 kbench.wasm spawns in rounds of 50, renderer RSS
and live Workers after each round): d286c5e 316 → 376 MiB with 50–54
Workers; this branch 234–237 MiB with 3 Workers throughout.

Flags against the d286c5e file that A/B runs here did not confirm: boot,
shell, net, x86 and non-isolated kernel throughput (e.g. non-isolated
`file_read` −35% in this run, +25% in the interleaved A/B), and isolated
`spawn_throughput.builtin` (−37% here; 3718 vs 4065 proc/s with the pool's
trim disabled vs enabled, and 4850 → 5508 under the profiler). It is
100 spawns in ~20 ms and swings ±40% between identical runs.

### unix/perf-kernel, round 4: link() and the integration/compat-dev merge

Merged unix/integration (bd9fd87+) and unix/compat-dev (67bf3c1).
`link`/`linkat` now return EPERM instead of copying the file: the copy had
its own inode, so `git clone /local/repo` (git 2.47.1 package) died with
"fatal: hardlink different from source"; with EPERM git copies the objects
itself and the clone works (checked in the built app, isolated, both ways).
Not a hot path; a kernel quick run after the merge is in line with round 3
(isolated: syscall_rtt.sab 5.8 µs, pipe_throughput_512b 87 MB/s,
file_write 173 MB/s, spawn_wait.wasm 1.07 ms).

### unix/perf-kernel, round 5: pool spare cap under load

`kernel-wasi.test.ts` "reuses guest Workers" failed under full-suite load
(4 Workers started where ≤ 3 are allowed): a spawn that came while the
previous process's Worker was still unwinding (its `wasi-idle` not yet
received) started a new Worker, and so could the pre-start timer. Returning
Workers now count as available: a spawn that finds none idle waits for one
(at most 250 ms, then starts a new one), and no spare is pre-started while
one is on its way back. Under 4 busy CPU-burning processes the test failed
1 of 4 runs before and passed 12 of 12 after; the full suite passed 3 times.

A/B, 3 runs each (isolated): `spawn_wait.wasm` 1.45 → 1.57 ms (noise),
`spawn_throughput.wasm` (10 in flight) **349 → 831 proc/s**: taking a
returning Worker is faster than starting one. RSS over 500 spawns stays
231–234 MiB with 2 Workers.

### unix/perf-kernel, round 6: after compat-tools' kernel additions

Merged unix/integration c5603db (compat-tools: procfs, AF_UNIX sockets,
syscall time accounting, symlinks followed in every path component). Its
quick run vs bd9fd87 showed `wasm.ripgrep.tree` 124 → 166 ms and slower
kernel paths. Profile of rg after the merge: `_getCached` + `lookupCached`
+ the kernel's `normalize` ≈ 20 ms per run. Every lookup now walked each
path component, building and hashing a string per step. Also,
`kernel.syscall` gained an `async` wrapper (one more await per call).

- `FileSystem.lookupCached` memoizes each directory's canonical path, so a
  lookup costs one map hit plus the last component. The memo is cleared when
  a symlink is written or anything is deleted or renamed (the only changes
  that can move a canonical path), and a test covers retargeting a symlinked
  directory.
- The kernel's `normalize` returns already-normal paths as they are.
- `kernel.syscall` keeps the accounting (`inSyscall`, `kernelMs`) but
  returns the inner promise, so the bookkeeping adds no hop.
- The pool fix from round 5 (not in c5603db) brings `workers_left` back to 2.

Interleaved A/B against c5603db built here, 3 runs each (medians of all
samples): `wasm.ripgrep.tree` 263 → 231 ms, `syscall_inpage` 1.20 → 0.96 µs
(isolated) and 1.02 → 0.92 µs (non-isolated), `epoll_wakeup` 56 → 50 µs,
`file_read` 1678 → 2102 MB/s, `pipe_throughput` 753 → 1137 MB/s,
`spawn_throughput.wasm` 345 → 745 proc/s (round 5). rg in one page, 12 runs,
median of the last 8: base 206 and 163 ms, this branch 159 and 154 ms.
Mixed within noise: `pipe_throughput_512b` 109 → 81 MB/s (base runs
84–125, new 72–107), non-isolated `file_write` 148 → 121 MB/s (base 145–160,
new 107–160).

`perf-kernel-r6-quick.json` was recorded while the container was slow
(untouched metrics: `shell.loop_1000` +92%, x86 +50%, boot +40% against
c5603db's file), so its absolute numbers are not comparable with the
committed integration runs. Use the A/B above.
### unix/perf-fs-shell 5 — boot bundle and ls after the c5603db merges

Base: `bench/results/integration-c5603db-quick-local.json` (origin/unix/integration
483306b, recorded on this machine) → `perf-fs-shell-5-quick.json`. On the
coordinator's host `integration-bd9fd87 → c5603db` had grown the boot transfer
1390 → 1658 KiB and `shell.ls_la_1000` 2.6 → 3.8 ms.

- Boot bundle (source-map attribution of the entry chunk, 1.67 MB): the new
  `utils/tar.ts` (65 KiB, eager through `pkg-manager.ts`), the awk rewrite
  (~58 KiB over six files), larger `find`, `date`, `od`, `patch`, `tar`, and
  node-compat (~150 KiB, eager through the `node` command). These now load on
  first use: `awk date find od patch tar` are `lazyCommand`s in
  `commands/unix.ts`, `pkg-manager` imports `readTarball` dynamically, and
  `node` is lazy in `main.ts`. node-compat captured the page's
  `fetch`/timers at module load; that capture moved to
  `node-compat/page-globals.ts`, imported eagerly, so a late first load
  (after `serve` patched `fetch`) still gets the originals. Entry chunk
  1.67 → 1.34 MB.
- `ls -la` on 1000 files: profiled in Node, the time was in the filesystem,
  not ls: `_canon` (symlink-aware path walk, new in conformance) awaited a
  `_get` per path component. It now walks the in-memory cache synchronously
  and only falls back to the async walk when a component needs IndexedDB
  (same results); `stat`/`lstat` answer from memory the same way;
  `_getCached` does one Map lookup instead of two. ls sorts with a cached
  `Intl.Collator().compare` (same order as `localeCompare()` with default
  arguments). ls output is unchanged: the conformance suite gives identical
  results on base and new.
- The faster `stat` made `kernel.spawn_throughput.builtin` drop ~20%
  (isolated): the WASM loader (`wasi/host.ts` `findWasm`) probes six PATH
  candidates per spawn with `stat`, and an ENOENT thrown synchronously deep
  in the spawn call chain costs more than one thrown after an await. Paths
  known to be missing (`fs.lookupCached` → null) are skipped without
  `stat`.

| metric (isolated unless noted) | base | new |
|---|---:|---:|
| boot.cold.transfer | 1659 KiB | 1336 KiB (−19.5%) |
| boot.cold.first_prompt | 162.7 ms | 144.3 ms |
| boot.warm.first_prompt | 86.8 ms | 75.8 ms |
| boot.mem.uasm | 6.99 MiB | 6.27 MiB |
| claude.version | 1010 ms | 704 ms |
| shell.ls_la_1000 | 2.96 ms | 2.47 / 3.00 ms (two full runs; 3×7-run re-runs base 2.9–3.3, new 3.0–3.1) |
| kernel.spawn_throughput.builtin (nonisolated, 3 re-runs) | 11.2–16.1k/s | 18.5–21.3k/s |
| ls -la 1000 files, Node microbench | 2.0–2.2 ms | 1.7 ms |

`ls_la_1000` on this machine was already ~3 ms on the base, so most of the
2.6 → 3.8 ms reported from the other host is not reproducible here; the
remaining in-page cost is the shell plus 1000 `lstat`s. Flagged by compare
and re-run 3× alternating (7 runs each): `kernel.pipe_throughput*`,
`kernel.syscall_inpage`, `kernel.spawn_throughput.*` (isolated),
`shell.pipeline_seq_grep_wc`, `wasm.startup.*`: overlapping ranges, noise.
`boot.settled.time` 6.3 s on the other host is 3.9 s here on both.

### A/B tooling: `bench/ab.mjs` (no product change)

`node bench/ab.mjs <base> [<new>]` builds each ref once in its own worktree,
interleaves base/new runs over several rounds and flags a metric only when a
Mann–Whitney test, a minimum shift and every round's direction agree (see
bench/README.md "A/B"). First use: the suspected 68dbbbc → 1d9582a
regression (`--suites shell,wasm --only 'shell.loop_1000|wasm.startup|wasm.peak_rss'`,
3 rounds × 7 runs, isolated). All 15 metrics: **same**. `peak_rss.quickjs_ng`
2.06 → 1.74 MiB, p = 0.90, rounds `-+-`; `shell.loop_1000` 95 → 99 ms,
p = 0.60, rounds `++-`; `startup.lua` 7.6 → 6.6 ms, `startup.sqlite3`
9.8 → 8.6 ms (both p > 0.01, split rounds).

### Cold boot to first prompt: where the time goes (investigation, no product change)

Integration 045feaa (desktop UI, isolated, this container; cold first prompt
~255–275 ms here). Timeline from a CPU profile plus `performance.mark`s in
`main()`, in ms from navigation:

| step | ms |
|---|---:|
| entry `index-*.js` requested (HTML parse and the harness's request routing) | 79 |
| entry downloaded | 104 |
| `main()` starts: entry compile and top-level evaluation (27 ms, of which xterm's module wrapper is 14.5 ms) | 177 |
| `fs.init` (IndexedDB open) | 178–189 |
| desktop built | 197–205 |
| `new ShiroTerminal`: xterm `open()`, whose first forced layouts are `_measure` 42 ms and Viewport `_innerRefresh` 25 ms in the profile | 205–260 |
| `terminal.start()`, first prompt in the buffer | 261–300 |

Moving the Debian rootfs boot / PATH shims, X display :0 and the Blink
loader behind the first prompt (they are fire-and-forget imports that load
at 194–211 ms) made no measurable difference:
`ab.mjs HEAD --suites boot`, 4 rounds × 5 runs: cold first prompt
270.8 → 275.5 ms, p = 0.97, so it was not committed. Loading
`pkg-index.json` as text instead of JSON saves only a ~1 ms
`JSON.parse` (Vite already emits large JSON as `JSON.parse`) and adds
22 KiB, also not committed. The remaining levers are the entry's size
(compile) and the cost of the desktop's first layout, which xterm forces.

### unix/perf-fs-shell 6 — npm, upload/download/shiro, hc, remote, cw and the template palette load on first use

Entry chunk 1405 → 1291 KB. `ab.mjs HEAD --suites boot`, 6 rounds × 5 runs,
isolated, against integration 045feaa:

| metric | base | new | |
|---|---:|---:|---|
| boot.cold.transfer | 1576 KiB | 1464 KiB | −7.1% (exact) |
| boot.mem.uasm | 6.83 MiB | 6.51 MiB | −4.7%, p = 3e-11, all rounds |
| boot.mem.js_heap | 3.9 MiB | 3.8 MiB | −2.6%, p = 7e-12 (under the 3% bar) |
| boot.cold.first_prompt | 270.6 ms | 262.0 ms | −3.6%, p = 0.15: not significant |
| boot.settled.requests | 12 | 13 | the split-out chunk fetched once used |

The remote-session auto-reconnect reads its localStorage key directly and
loads `commands/remote` only when there is a session to resume.

### unix/perf-kernel, round 7: named pipes (cost check)

Named pipes added a FIFO check to every shell file redirection. The first
version did an async `stat` plus a dynamic import per redirect:
`shell.redirect_append_100` went 7.2 → 16.4 ms in an A/B against the commit
before. The check now answers from `FileSystem.lookupCached` (async stat
only on a cache miss) with a static import. A/B, 3 runs each against the
commit before: no shell metric is outside noise (`redirect_append_100`
within 8%; `pipeline_seq_grep_wc` 41 → 32 ms and `ls_la_1000` 4.0 → 4.8 ms
have overlapping runs).

### unix/perf-fs-shell 7 — 1d9582a → bb39a38 regressions: shell-stdio's per-command pass; ab.mjs decides on rounds

The coordinator's `ab.mjs 1d9582a bb39a38 --suites boot,kernel,shell,wasm
--rounds 3` flagged `wasm.startup.sqlite3` +31% (p = 0.0002),
`wasm.startup.coreutils` +14% and `shell.echo` +26%, each consistent over all
3 rounds. Re-checked here:

- The same pair, shell+wasm, 5 rounds × 5 runs: none of the three moved
  (sqlite3 9.23 → 9.02 ms, coreutils 13.3 → 12.9, echo 0.083 → 0.078;
  quickjs and ripgrep startup *improved* 14–20%). The coordinator's exact
  command (3 rounds) flagged a different set: `shell.echo`,
  `shell.for_seq_1000`, `wasm.startup.quickjs`. An A/A run (bb39a38 in a
  worktree vs the same commit built in place) flagged nothing, so the build
  location isn't biased; the pooled Mann–Whitney p was overstating
  significance (samples within a run are not independent). `ab.mjs` now
  decides on a round-level hierarchical bootstrap interval of the median
  shift; with it the coordinator's configuration reports no regressions,
  only the boot improvements (transfer −6%, 5 fewer requests, 65 fewer DOM
  nodes).
- The one real effect is small: unix/shell-stdio (merge b8834c7, commit
  de6165f "ordered prefix assignments") runs `expandPrefixAssignments` on
  every single-segment command: a full `splitAssignWords` tokenizer pass plus
  an await, for `a=1 b=$a cmd`. Node microbenchmark (`createTestShell`, 7×
  medians, alternated), dcdab97 → b8834c7: `true` 0.027 → 0.030 ms,
  `x=$(echo hi)` 0.093 → 0.105 ms, `loop_1000` 72–76 → 79–81 ms. A regex
  pre-check (the line starts with `NAME=` and has another `NAME=` later; a
  superset, so a false hit just takes the full pass) skips it otherwise:

| Node microbench, merged integration ecd719e | without fix (2 runs) | with fix (2 runs) |
|---|---:|---:|
| `while` loop 1000 | 77.3 / 75.9 ms | 73.9 / 71.0 ms |
| `for i in $(seq 1000)` | 31.5 / 32.1 ms | 28.8 / 25.8 ms |
| `true` | 0.033 / 0.033 ms | 0.030 / 0.026 ms |
| `x=$(echo hi)` | 0.121 / 0.119 ms | 0.114 / 0.095 ms |

Browser A/B (`ab.mjs origin/unix/integration --suites shell`, 5 rounds × 7):
`shell.echo` 0.066 → 0.054 ms (all 5 rounds faster), `loop_1000` 96.8 →
94.5 ms, others within noise; none significant at the bootstrap level, as
expected for a shift this size. Full suite and conformance (shell-spec,
busybox) green.

## Results

<!-- bench:table:begin -->
Generated by `npm run bench` from `bench/results/2026-10-08-69296a9.json` on 2026-10-08 at 69296a9 (unix/bench).
Environment: 4× Intel(R) Xeon(R) Processor @ 2.10GHz, 15.7 GiB, Linux 6.18.44-fc-v80 x64, Node v22.22.0, Chromium 141.0.7390.37 headless. 5 runs per metric unless *n* says otherwise; full mode, 445 s total.

### Cross-origin isolated (SharedArrayBuffer, Blink, Worker processes)

| boot metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `boot.cold.first_prompt` | 280.9 | 305.7 | ms | 5 | navigation start → "$ " on the terminal |
| `boot.cold.tti` | 390.6 | 401.3 | ms | 5 | first prompt, then 1 s without a long task |
| `boot.cold.first_command` | 14.25 | 16.95 | ms | 5 | `true` right after boot (lazy loads land here) |
| `boot.cold.long_tasks` | 2 | 2 | count | 5 | long tasks (>50 ms) until TTI |
| `boot.cold.requests` | 5 | 5 | count | 5 | requests until TTI |
| `boot.cold.transfer` | 3316 | 3316 | KiB | 5 | bytes over the network until TTI (CDP encodedDataLength) |
| `boot.cold.decoded` | 3315 | 3315 | KiB | 5 | decoded body bytes until TTI (resource timing) |
| `boot.mem.js_heap` | 4.94 | 4.941 | MiB | 5 | main-thread JS heap after GC, at TTI (cold) |
| `boot.mem.renderer_rss` | 221.4 | 221.8 | MiB | 5 | renderer process RSS (page + workers), at TTI |
| `boot.mem.uasm` | 11.47 | 11.47 | MiB | 5 | performance.measureUserAgentSpecificMemory at TTI |
| `boot.mem.dom_nodes` | 257 | 257 | count | 5 | DOM nodes at TTI |
| `boot.settled.time` | 4230 | 4284 | ms | 3 | Claude Code background install done |
| `boot.settled.js_heap` | 4.985 | 4.985 | MiB | 3 | after GC, once the background install finished |
| `boot.settled.renderer_rss` | 236.4 | 237.8 | MiB | 3 | renderer RSS after the background install |
| `boot.settled.uasm` | 24.59 | 24.59 | MiB | 3 | measureUserAgentSpecificMemory after settle |
| `boot.settled.idb` | 5.979 | 5.979 | MiB | 3 | navigator.storage.estimate().usage (IndexedDB + cache) |
| `boot.settled.requests` | 6 | 6 | count | 3 | requests incl. the background install |
| `boot.settled.transfer` | 21.05 | 21.05 | MiB | 3 | bytes fetched incl. the background install |
| `boot.warm.first_prompt` | 169.2 | 258.7 | ms | 5 | navigation start → "$ " on the terminal |
| `boot.warm.tti` | 169.2 | 374.7 | ms | 5 | first prompt, then 1 s without a long task |
| `boot.warm.first_command` | 9.88 | 12.33 | ms | 5 | `true` right after boot (lazy loads land here) |
| `boot.warm.long_tasks` | 0 | 2 | count | 5 | long tasks (>50 ms) until TTI |
| `boot.warm.requests` | 5 | 5 | count | 5 | requests until TTI |
| `boot.warm.transfer` | 3316 | 3316 | KiB | 5 | bytes over the network until TTI (CDP encodedDataLength) |
| `boot.warm.decoded` | 3315 | 3315 | KiB | 5 | decoded body bytes until TTI (resource timing) |
| `boot.warm.js_heap` | 4.95 | 4.95 | MiB | 1 | one sample, after the last warm reload |

| shell metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `shell.true` | 0.218 | 0.439 | ms | 5 | per call, mean of 50 |
| `shell.echo` | 0.184 | 0.268 | ms | 5 | per call, mean of 50 |
| `shell.cmd_subst` | 0.427 | 0.466 | ms | 5 | `x=$(echo hi)` per call, mean of 50 |
| `shell.fs_write_after_burst` | 48.4 | 53.99 | ms | 5 | one fs.writeFile right after 200 `true` commands (each queues a full history-file write to IndexedDB) |
| `shell.loop_1000` | 136.1 | 170.5 | ms | 5 | `while [ $i -lt 1000 ]; do i=$((i+1)); done` |
| `shell.for_seq_1000` | 180.4 | 215.5 | ms | 5 | `for i in $(seq 1000); do true; done` |
| `shell.ls_la_1000` | 2.53 | 5.875 | ms | 5 | 1000-file directory, output captured |
| `shell.pipeline_seq_grep_wc` | 20.43 | 27.54 | ms | 5 | `seq 100000 \| grep 7 \| wc -l` (builtins) |
| `shell.redirect_append_100` | 161.9 | 167.3 | ms | 5 | 100 `echo >> file` (IndexedDB writes) |

| kernel metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `kernel.syscall_rtt.sab` | 93.43 | 97.76 | µs | 5 | fd_fdstat_get → fstat from a WASM process, 20000 calls (Worker, SAB channel) |
| `kernel.syscall_inpage` | 0.846 | 1.231 | µs | 5 | kernel.syscall(getpid) from page JS: dispatch floor, no channel |
| `kernel.pipe_throughput` | 442.8 | 472.9 | MB/s | 5 | 64 MiB, 64 KiB writes, WASM writer → kernel pipe → WASM reader (reader's clock) |
| `kernel.pipe_throughput_512b` | 10.68 | 11.41 | MB/s | 5 | 4 MiB in 512-byte writes/reads (syscall-bound) |
| `kernel.file_write` | 8.547 | 14.74 | MB/s | 5 | 16 MiB, 64 KiB writes, open→close (WASM → kernel → filesystem) |
| `kernel.file_read` | 807.6 | 863.5 | MB/s | 5 | 16 MiB, 64 KiB reads |
| `kernel.spawn_wait.wasm` | 8.722 | 9.615 | ms | 10 | kernel.spawn of kbench.wasm (cached module) → waitpid |
| `kernel.spawn_wait.builtin` | 0.285 | 0.755 | ms | 10 | kernel.spawn of the `true` builtin → waitpid |
| `kernel.spawn_throughput.builtin` | 8669 | 9474 | proc/s | 5 | 100 `true` spawns, 10 in flight |
| `kernel.spawn_throughput.wasm` | 169.3 | 211.8 | proc/s | 5 | 30 kbench.wasm spawns, 10 in flight |
| `kernel.epoll_wakeup` | 45.22 | 48.29 | µs | 5 | blocked epoll_wait → write to the pipe → wait returns (in-page, main thread) |
| `kernel.pty_echo.line_editor` | 0.085 | 0.125 | ms | 50 | xterm input → shell line editor echo → parsed into the terminal buffer (prompt, no kernel job) |
| `kernel.pty_echo.line_editor_frame` | 11.45 | 11.69 | ms | 50 | same, until the next rendered frame |
| `kernel.pty_echo.kernel` | 0.122 | 0.17 | ms | 50 | keystroke → kernel pty n_tty echo (WASM reader in the foreground) → parsed into the terminal buffer |
| `kernel.pty_echo.kernel_frame` | 11.4 | 11.65 | ms | 50 | same, until the next rendered frame |

| wasm metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `wasm.startup.lua` | 14.79 | 16.69 | ms | 5 | `lua -e "print(1)"` through the shell, module cached; first run 58 ms |
| `wasm.peak_rss.lua` | 1.887 | 3.891 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.startup.sqlite3` | 18.89 | 20.42 | ms | 5 | `sqlite3 :memory: "select 1"` through the shell, module cached; first run 45 ms |
| `wasm.peak_rss.sqlite3` | 3.883 | 6.273 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.startup.coreutils` | 21.55 | 31.67 | ms | 5 | `/usr/bin/base64 --version` through the shell, module cached; first run 44 ms |
| `wasm.peak_rss.coreutils` | 12.85 | 13.83 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.startup.quickjs` | 4.16 | 4.94 | ms | 5 | `qjs -e "print(1)"` through the shell, module cached; first run 37 ms |
| `wasm.peak_rss.quickjs` | 0.387 | 1.055 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.startup.grep` | 16.62 | 18.09 | ms | 5 | `/usr/bin/grep --version` through the shell, module cached; first run 21 ms |
| `wasm.peak_rss.grep` | 2.191 | 2.332 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.startup.ripgrep` | 18.32 | 23.53 | ms | 5 | `/usr/bin/rg --version` through the shell, module cached; first run 41 ms |
| `wasm.peak_rss.ripgrep` | 5.934 | 6.918 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.startup.quickjs_ng` | 21.97 | 29.3 | ms | 5 | `qjs-ng -e "print(1)"` through the shell, module cached; first run 63 ms |
| `wasm.peak_rss.quickjs_ng` | 4.355 | 8.711 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.sqlite.recursive_cte` | 91.33 | 165.4 | ms | 5 | 300k-row recursive CTE + aggregate, :memory: |
| `wasm.peak_rss.sqlite_cte` | 3.77 | 12.73 | MiB | 5 | renderer RSS peak during the CTE |
| `wasm.sqlite.insert_10k_file` | 121.9 | 128.1 | ms | 5 | 10k INSERTs in one transaction + LIKE scan, database file in /tmp (kernel file I/O) |
| `wasm.tree_create` | 4506 | 4506 | ms | 1 | 10000 files × ~160 B in 100 dirs via fs.writeFile (IndexedDB), one sample |
| `wasm.ripgrep.tree` | 3239 | 3519 | ms | 5 | `rg -l NEEDLE` over 10000 files (1000 match) |
| `wasm.peak_rss.ripgrep_tree` | 18.74 | 47.89 | MiB | 5 | renderer RSS peak during the search |
| `wasm.builtin_grep_r.tree` | 171.9 | 176.9 | ms | 5 | reference: Shiro's builtin `grep -rl` over the same 10000 files |
| `wasm.cpu_loop.shiro` | 372.1 | 390.1 | ms | 5 | kbench cpu 200M as a Shiro process (guest clock) |
| `wasm.cpu_loop.node` | 375 | 386.9 | ms | 5 | same .wasm instantiated in Node (V8), same loop |
| `wasm.cpu_loop.native` | 382.2 | 386.4 | ms | 5 | same C loop, gcc -O2, native |
| `wasm.cpu_loop.ratio_vs_node` | 0.992 | 0.992 | x | 1 | Shiro / Node median |

| x86 metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `x86.blink.hello_musl` | 87.08 | 104.9 | ms | 5 | `./hello-musl` wall time at the prompt; first run 203 ms |
| `x86.blink.peak_rss.hello_musl` | 14.37 | 21.96 | MiB | 5 | renderer RSS peak above the pre-run level |
| `x86.blink.hello_glibc` | 101 | 111 | ms | 5 | `./hello-glibc` wall time at the prompt; first run 109 ms |
| `x86.blink.peak_rss.hello_glibc` | 17.61 | 18.13 | MiB | 5 | renderer RSS peak above the pre-run level |
| `x86.blink.go_hello` | 173.1 | 183.1 | ms | 5 | `./hello-go a b` wall time at the prompt; first run 190 ms |
| `x86.blink.peak_rss.go_hello` | 22.65 | 22.82 | MiB | 5 | renderer RSS peak above the pre-run level |
| `x86.blink.go_cpuloop_5m` | 1207 | 1253 | ms | 5 | `./cpuloop 5000000` wall time at the prompt; first run 1229 ms; in-guest loop 1087 ms |
| `x86.blink.peak_rss.go_cpuloop_5m` | 14.04 | 15.16 | MiB | 5 | renderer RSS peak above the pre-run level |
| `x86.blink.go_nethttp` | 312.3 | 334 | ms | 5 | `./nethttp` wall time at the prompt; first run 297 ms |
| `x86.blink.peak_rss.go_nethttp` | 30.89 | 31.23 | MiB | 5 | renderer RSS peak above the pre-run level |
| `x86.blink.gh_version` | 17826 | 17972 | ms | 5 | `./gh --version` wall time at the prompt; first run 18087 ms |
| `x86.blink.peak_rss.gh_version` | 157.3 | 160.8 | MiB | 5 | renderer RSS peak above the pre-run level |
| `x86.x86.hello_musl` | 14.63 | 25.18 | ms | 5 | `SHIRO_X86_ENGINE=x86 ./hello-musl` wall time at the prompt; first run 31 ms |
| `x86.x86.peak_rss.hello_musl` | 2.379 | 4.602 | MiB | 5 | renderer RSS peak above the pre-run level |
| `x86.x86.hello_glibc` | — | — | ms | 0 | failed: exit 1: shiro: /home/user/x/hello-glibc: Unknown two-byte opcode: 0F 62 at 0x4031a3 |
| `x86.x86.go_hello` | — | — | ms | 0 | failed: exit 2: fatal error: float64nan |
| `x86.x86.go_cpuloop_5m` | — | — | ms | 0 | failed: exit 2: fatal error: float64nan |
| `x86.x86.go_nethttp` | — | — | ms | 0 | failed: exit 2: fatal error: float64nan |
| `x86.x86.gh_version` | — | — | ms | 0 | not attempted on src/x86 (Go) |

| net metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `net.relay_connect.first` | 17.67 | 17.67 | ms | 1 | first connect of the page: token POST + WebSocket + TCP connect (one sample) |
| `net.relay_connect` | 11.33 | 11.74 | ms | 20 | socket() + blocking connect() to the test server via the relay (token cached) |
| `net.echo_rtt` | 0.549 | 0.87 | ms | 5 | 1-byte write → echo → read through the relay, mean of 100 |
| `net.tcp_download` | 62.38 | 64.66 | MB/s | 5 | 64 MiB server → page (kernel socket reads of 256 KiB) |
| `net.tcp_upload` | 24.59 | 24.65 | MB/s | 5 | 64 MiB page → server in 64 KiB writes, until the server acks |
| `net.dns_lookup` | 11.04 | 11.76 | ms | 10 | netStack.resolve("example.com") via the relay's resolve op (server-side resolver; /etc/hosts here) |

| node metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `node.e1` | 108.4 | 109.5 | ms | 5 | `node -e 1`; first run 127 ms |
| `node.require_builtins` | 106 | 109.1 | ms | 5 | require fs/path/events/util/stream/crypto/http; first run 115 ms |
| `node.script_file` | 109.8 | 113.8 | ms | 5 | `node hello.js` (requires os); first run 112 ms |

| npm metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `npm.install_small` | 67.85 | 83.58 | ms | 5 | `npm install ms chalk@4 is-number` (8 packages) in a fresh dir, repeat installs; registry from the bench cache |
| `npm.install_small.first` | 118.6 | 118.6 | ms | 1 | the first install of the page (empty npm cache), one sample |

| claude metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `claude.version` | 858.2 | 1097 | ms | 5 | `claude --version` (loads the 2.1.112 cli.js bundle); first run 1977 ms |

| hygiene metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `hygiene.procs100.js_heap_delta` | 0.047 | 0.994 | MiB | 5 | per round of 50 shell pipelines + 50 kbench.wasm spawns, after GC |
| `hygiene.procs100.rss_delta` | 16.8 | 86.78 | MiB | 5 | renderer RSS change per round |
| `hygiene.procs100.workers_left` | 91 | 91 | count | 1 | live Workers added over 5 rounds (91 total now) |
| `hygiene.procs100.sabs_left` | 0 | 0 | count | 1 | SharedArrayBuffers still reachable after GC (0.0 MiB total) |
| `hygiene.procs100.shared_mem_left` | 0 | 0 | count | 1 | shared WebAssembly.Memory objects still reachable after GC |
| `hygiene.procs100.kernel_procs_left` | 1 | 1 | count | 1 | kernel process table growth (zombies now: 0) |
| `hygiene.procs100.fds_left` | 0 | 0 | count | 1 | open fds summed over all kernel processes, growth |
| `hygiene.procs100.total_heap_growth` | 1.16 | 1.16 | MiB | 1 | JS heap growth over 500 processes |
| `hygiene.panes10.js_heap_delta` | 0.905 | 2.217 | MiB | 5 | per round of 10 pane splits + closes, after GC |
| `hygiene.panes10.dom_nodes_delta` | 162 | 163 | count | 5 | DOM nodes left per round |
| `hygiene.panes10.listeners_delta` | 110 | 123 | count | 5 | JS event listeners left per round |
| `hygiene.panes10.terminals_left` | 0 | 0 | count | 1 | .xterm elements left after all rounds |
| `hygiene.panes10.total_heap_growth` | 5.49 | 5.49 | MiB | 1 | JS heap growth over 50 pane open/close cycles |

### Not isolated (fallbacks: JSPI / in-page runtimes, src/x86)

| boot metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `boot.cold.first_prompt` | 268.1 | 270.3 | ms | 5 | navigation start → "$ " on the terminal |
| `boot.cold.tti` | 371.9 | 410 | ms | 5 | first prompt, then 1 s without a long task |
| `boot.cold.first_command` | 13.1 | 15.3 | ms | 5 | `true` right after boot (lazy loads land here) |
| `boot.cold.long_tasks` | 2 | 2 | count | 5 | long tasks (>50 ms) until TTI |
| `boot.cold.requests` | 5 | 5 | count | 5 | requests until TTI |
| `boot.cold.transfer` | 3316 | 3316 | KiB | 5 | bytes over the network until TTI (CDP encodedDataLength) |
| `boot.cold.decoded` | 3315 | 3315 | KiB | 5 | decoded body bytes until TTI (resource timing) |
| `boot.mem.js_heap` | 4.941 | 4.941 | MiB | 5 | main-thread JS heap after GC, at TTI (cold) |
| `boot.mem.renderer_rss` | 220.3 | 220.3 | MiB | 5 | renderer process RSS (page + workers), at TTI |
| `boot.mem.dom_nodes` | 257 | 257 | count | 5 | DOM nodes at TTI |
| `boot.settled.time` | 4221 | 4315 | ms | 3 | Claude Code background install done |
| `boot.settled.js_heap` | 4.985 | 4.985 | MiB | 3 | after GC, once the background install finished |
| `boot.settled.renderer_rss` | 235.4 | 235.8 | MiB | 3 | renderer RSS after the background install |
| `boot.settled.idb` | 5.979 | 5.979 | MiB | 3 | navigator.storage.estimate().usage (IndexedDB + cache) |
| `boot.settled.requests` | 6 | 6 | count | 3 | requests incl. the background install |
| `boot.settled.transfer` | 21.05 | 21.05 | MiB | 3 | bytes fetched incl. the background install |
| `boot.warm.first_prompt` | 168 | 228.8 | ms | 5 | navigation start → "$ " on the terminal |
| `boot.warm.tti` | 168 | 331.5 | ms | 5 | first prompt, then 1 s without a long task |
| `boot.warm.first_command` | 9.1 | 14.8 | ms | 5 | `true` right after boot (lazy loads land here) |
| `boot.warm.long_tasks` | 0 | 2 | count | 5 | long tasks (>50 ms) until TTI |
| `boot.warm.requests` | 5 | 5 | count | 5 | requests until TTI |
| `boot.warm.transfer` | 3316 | 3316 | KiB | 5 | bytes over the network until TTI (CDP encodedDataLength) |
| `boot.warm.decoded` | 3315 | 3315 | KiB | 5 | decoded body bytes until TTI (resource timing) |
| `boot.warm.js_heap` | 4.949 | 4.949 | MiB | 1 | one sample, after the last warm reload |

| shell metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `shell.true` | 0.14 | 0.35 | ms | 5 | per call, mean of 50 |
| `shell.echo` | 0.164 | 0.184 | ms | 5 | per call, mean of 50 |
| `shell.cmd_subst` | 0.3 | 0.47 | ms | 5 | `x=$(echo hi)` per call, mean of 50 |
| `shell.fs_write_after_burst` | 55.6 | 72.7 | ms | 5 | one fs.writeFile right after 200 `true` commands (each queues a full history-file write to IndexedDB) |
| `shell.loop_1000` | 155.7 | 164.9 | ms | 5 | `while [ $i -lt 1000 ]; do i=$((i+1)); done` |
| `shell.for_seq_1000` | 163.4 | 203.9 | ms | 5 | `for i in $(seq 1000); do true; done` |
| `shell.ls_la_1000` | 2.5 | 5.7 | ms | 5 | 1000-file directory, output captured |
| `shell.pipeline_seq_grep_wc` | 21.5 | 27.6 | ms | 5 | `seq 100000 \| grep 7 \| wc -l` (builtins) |
| `shell.redirect_append_100` | 156 | 156.9 | ms | 5 | 100 `echo >> file` (IndexedDB writes) |

| kernel metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `kernel.syscall_rtt.jspi` | 5.85 | 6.795 | µs | 5 | fd_fdstat_get → fstat from a WASM process, 20000 calls (main thread, JSPI) |
| `kernel.syscall_inpage` | 0.88 | 0.94 | µs | 5 | kernel.syscall(getpid) from page JS: dispatch floor, no channel |
| `kernel.pipe_throughput` | 336.9 | 409.2 | MB/s | 5 | 64 MiB, 64 KiB writes, WASM writer → kernel pipe → WASM reader (reader's clock) |
| `kernel.pipe_throughput_512b` | 68.87 | 91.38 | MB/s | 5 | 4 MiB in 512-byte writes/reads (syscall-bound) |
| `kernel.file_write` | 205.4 | 241.1 | MB/s | 5 | 16 MiB, 64 KiB writes, open→close (WASM → kernel → filesystem) |
| `kernel.file_read` | 1434 | 1525 | MB/s | 5 | 16 MiB, 64 KiB reads |
| `kernel.spawn_wait.wasm` | 1.05 | 3.7 | ms | 10 | kernel.spawn of kbench.wasm (cached module) → waitpid |
| `kernel.spawn_wait.builtin` | 0.2 | 0.3 | ms | 10 | kernel.spawn of the `true` builtin → waitpid |
| `kernel.spawn_throughput.builtin` | 14085 | 16949 | proc/s | 5 | 100 `true` spawns, 10 in flight |
| `kernel.spawn_throughput.wasm` | 3093 | 5357 | proc/s | 5 | 30 kbench.wasm spawns, 10 in flight |
| `kernel.epoll_wakeup` | 37.6 | 41.2 | µs | 5 | blocked epoll_wait → write to the pipe → wait returns (in-page, main thread) |
| `kernel.pty_echo.line_editor` | 0.1 | 0.2 | ms | 50 | xterm input → shell line editor echo → parsed into the terminal buffer (prompt, no kernel job) |
| `kernel.pty_echo.line_editor_frame` | 11.4 | 11.6 | ms | 50 | same, until the next rendered frame |
| `kernel.pty_echo.kernel` | 0.1 | 0.2 | ms | 50 | keystroke → kernel pty n_tty echo (WASM reader in the foreground) → parsed into the terminal buffer |
| `kernel.pty_echo.kernel_frame` | 11.4 | 11.6 | ms | 50 | same, until the next rendered frame |

| wasm metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `wasm.startup.lua` | 4.5 | 6.1 | ms | 5 | `lua -e "print(1)"` through the shell, module cached; first run 36 ms |
| `wasm.peak_rss.lua` | 0.504 | 1.16 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.startup.sqlite3` | 8.4 | 13.3 | ms | 5 | `sqlite3 :memory: "select 1"` through the shell, module cached; first run 47 ms |
| `wasm.peak_rss.sqlite3` | 1.879 | 4.785 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.startup.coreutils` | 12.1 | 22 | ms | 5 | `/usr/bin/base64 --version` through the shell, module cached; first run 37 ms |
| `wasm.peak_rss.coreutils` | 10.92 | 11.02 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.startup.quickjs` | 3.9 | 5.3 | ms | 5 | `qjs -e "print(1)"` through the shell, module cached; first run 36 ms |
| `wasm.peak_rss.quickjs` | 0.332 | 0.652 | MiB | 5 | renderer RSS peak above the pre-run level (25 ms sampling) |
| `wasm.startup.grep` | — | — | ms | 0 | WASIX: needs threads (SharedArrayBuffer) |
| `wasm.startup.ripgrep` | — | — | ms | 0 | WASIX: needs threads (SharedArrayBuffer) |
| `wasm.startup.quickjs_ng` | — | — | ms | 0 | WASIX: needs threads (SharedArrayBuffer) |
| `wasm.sqlite.recursive_cte` | 79.1 | 159.9 | ms | 5 | 300k-row recursive CTE + aggregate, :memory: |
| `wasm.peak_rss.sqlite_cte` | 2.012 | 12.62 | MiB | 5 | renderer RSS peak during the CTE |
| `wasm.sqlite.insert_10k_file` | 40.4 | 59.2 | ms | 5 | 10k INSERTs in one transaction + LIKE scan, database file in /tmp (kernel file I/O) |
| `wasm.tree_create` | 4160 | 4160 | ms | 1 | 10000 files × ~160 B in 100 dirs via fs.writeFile (IndexedDB), one sample |
| `wasm.ripgrep.tree` | — | — | ms | 0 | WASIX: needs threads (SharedArrayBuffer) |
| `wasm.builtin_grep_r.tree` | 165.8 | 252.6 | ms | 5 | reference: Shiro's builtin `grep -rl` over the same 10000 files |
| `wasm.cpu_loop.shiro` | 380 | 383.9 | ms | 5 | kbench cpu 200M as a Shiro process (guest clock) |
| `wasm.cpu_loop.node` | 371.6 | 376.5 | ms | 5 | same .wasm instantiated in Node (V8), same loop |
| `wasm.cpu_loop.native` | 363.3 | 371.8 | ms | 5 | same C loop, gcc -O2, native |
| `wasm.cpu_loop.ratio_vs_node` | 1.023 | 1.023 | x | 1 | Shiro / Node median |

| x86 metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `x86.x86.hello_musl` | 13.7 | 24 | ms | 5 | `./hello-musl` wall time at the prompt; first run 75 ms |
| `x86.x86.peak_rss.hello_musl` | 1.957 | 3.395 | MiB | 5 | renderer RSS peak above the pre-run level |
| `x86.x86.hello_glibc` | — | — | ms | 0 | failed: exit 1: shiro: /home/user/x/hello-glibc: Unknown two-byte opcode: 0F 62 at 0x4031a3 |
| `x86.x86.go_hello` | — | — | ms | 0 | failed: exit 2: fatal error: float64nan |
| `x86.x86.go_cpuloop_5m` | — | — | ms | 0 | failed: exit 2: fatal error: float64nan |
| `x86.x86.go_nethttp` | — | — | ms | 0 | failed: exit 2: fatal error: float64nan |
| `x86.x86.gh_version` | — | — | ms | 0 | not attempted on src/x86 (Go) |

| hygiene metric | median | p90 | unit | n | notes |
|---|---:|---:|---|---:|---|
| `hygiene.procs100.js_heap_delta` | 0.033 | 1.004 | MiB | 5 | per round of 50 shell pipelines + 50 kbench.wasm spawns, after GC |
| `hygiene.procs100.rss_delta` | 0.129 | 4.68 | MiB | 5 | renderer RSS change per round |
| `hygiene.procs100.workers_left` | 0 | 0 | count | 1 | live Workers added over 5 rounds (0 total now) |
| `hygiene.procs100.sabs_left` | 0 | 0 | count | 1 | SharedArrayBuffers still reachable after GC (0.0 MiB total) |
| `hygiene.procs100.shared_mem_left` | 0 | 0 | count | 1 | shared WebAssembly.Memory objects still reachable after GC |
| `hygiene.procs100.kernel_procs_left` | 1 | 1 | count | 1 | kernel process table growth (zombies now: 0) |
| `hygiene.procs100.fds_left` | 0 | 0 | count | 1 | open fds summed over all kernel processes, growth |
| `hygiene.procs100.total_heap_growth` | 0.681 | 0.681 | MiB | 1 | JS heap growth over 500 processes |
| `hygiene.panes10.js_heap_delta` | 0.917 | 2.297 | MiB | 5 | per round of 10 pane splits + closes, after GC |
| `hygiene.panes10.dom_nodes_delta` | 162 | 164 | count | 5 | DOM nodes left per round |
| `hygiene.panes10.listeners_delta` | 110 | 123 | count | 5 | JS event listeners left per round |
| `hygiene.panes10.terminals_left` | 0 | 0 | count | 1 | .xterm elements left after all rounds |
| `hygiene.panes10.total_heap_growth` | 5.928 | 5.928 | MiB | 1 | JS heap growth over 50 pane open/close cycles |

<!-- bench:table:end -->
