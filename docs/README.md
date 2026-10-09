# tabcomputer docs

Start with the [README](../README.md). Contributors and coding agents: [AGENTS.md](../AGENTS.md).

## Using it

| Doc | What it covers |
| --- | --- |
| [DESKTOP.md](DESKTOP.md) | The desktop: windows, dock, keyboard, phone layout, the window manager API, `/dom` |
| [PACKAGES.md](PACKAGES.md) | `pkg`/`apt` before Debian mode: tabcomputer's 72 prebuilt WASM and static x86-64 programs (full list in the README's appendix) |
| [DEBIAN.md](DEBIAN.md) | Debian mode: the streamed root filesystem, apt and dpkg in Blink, the overlay of builtins |
| [GUI.md](GUI.md) | Linux GUI apps over X11: the X server in the page, `gui`, what runs and how fast |
| [NETWORKING.md](NETWORKING.md) | Kernel sockets, the WebSocket-to-TCP relay, its security model and how to run it |
| [BROWSER.md](BROWSER.md) | The Browser app (research spike): browse origins, the broker, TLS in the page |
| [PROFILES.md](PROFILES.md) | Product profiles (`tabcomputer`, `shiro`), the engine/product boundary, the rename |

## Scoreboards (measured)

These record measurements. Each says how it was produced; rerun the tool to update it.

| Doc | Measures | Produced by |
| --- | --- | --- |
| [DEBIAN_SCORE.md](DEBIAN_SCORE.md) | Debian popcon top 500: install + smoke test | `npm run debian-score` |
| [CONFORMANCE.md](CONFORMANCE.md) | Shell specs, busybox, LTP under Blink, wasi-testsuite | `npm run conformance` |
| [COMPAT.md](COMPAT.md) | Popular tools, languages, agent CLIs, GUI apps, developer workflows | per-section smoke tests in `tests/` |
| [WEB_SCORE.md](WEB_SCORE.md) | The Browser app against real sites | `tests/browser/web-score.mjs` |
| [BENCHMARKS.md](BENCHMARKS.md) | Speed and memory baselines, round by round | `npm run bench` ([bench/README.md](../bench/README.md)) |

## Internals

| Doc | What it covers |
| --- | --- |
| [KERNEL_ABI.md](KERNEL_ABI.md) | The kernel's syscall contract, with a changelog |
| [X86_ENGINES.md](X86_ENGINES.md) | Why Blink, its patches (fork, signals, the wasm JIT, SSE4, `/proc/self/maps`), speed |
| [UNIX_COMPAT.md](UNIX_COMPAT.md) | The plan toward full Unix compatibility, phase by phase (written 2026-10-07) |
| [DOM-RENDERING.md](DOM-RENDERING.md) | Design note: X11 and GTK text as DOM text |

## Research and drafts

- [research/AGENT-EXPERIMENTS.md](research/AGENT-EXPERIMENTS.md): coding-agent workflows inside tabcomputer, and the limits they hit (2026-10-09).
- [upstream/vim-inchar-negative-wait.md](upstream/vim-inchar-negative-wait.md): a vim fix drafted for upstream.
