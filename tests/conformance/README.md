# Conformance suites

Real-world test suites run against Shiro end to end, scored in
[docs/CONFORMANCE.md](../../docs/CONFORMANCE.md). Run everything and
regenerate the scoreboard with:

```bash
npm run conformance            # from the repo root
```

That runs `tests/vitest.conformance.config.ts` (every `*.conf.ts` here, same
environment as the unit suite) and then `scripts/conformance/report.mjs`,
which turns `results/*.json` into the scoreboard. `results/before/` holds the
scores at the start of the conformance work (unix/integration fc0af54).
Fixes found through these suites get their own regression tests in
`tests/tests/shiro-vitest/` (e.g. `shell-conformance.test.ts`), so the
normal `npm run test:shiro` keeps them fixed.

## Shell: oils spec tests (`shell-spec.conf.ts`)

- Cases: `oils/spec/*.test.sh`, a vendored POSIX/bash subset of
  [oils-for-unix](https://github.com/oils-for-unix/oils) `spec/`
  (see `oils/README.md`, Apache-2.0).
- Each case runs in a fresh `Shell` (shared filesystem) as `bash CASE.sh` in an
  empty directory (the cases are judged against bash; run as `sh`, Shiro follows
  POSIX where bash and sh differ), with `$TMP`, `$SH` (= `bash`) and `$REPO_ROOT` set like the
  oils harness. The oils helpers `argv.py`, `printenv.py` and
  `stdout_stderr.py` are test-only builtins.
- Judged against **bash**: stdout and exit status must match the case's
  default expectation or its `OK`/`BUG`/`N-I bash` variant. stderr is not
  compared. Only cases that real bash passes under the same judge
  (`oils/bash-baseline.json`, from `scripts/conformance/oils-bash-baseline.mjs`)
  are scored.
- `shell-hangs.json` lists cases that hang Shiro synchronously (the event loop
  never comes back, so the per-case timeout can't fire); they count as
  failures. Find new ones with `SPEC_PROGRESS=/tmp/p.txt`, which logs each
  case before it runs. `SPEC_FILES=a,b` and `SPEC_CASES=3,4` narrow a run.

## Shell: smoosh POSIX tests (`smoosh-posix.conf.ts`)

- Cases: `smoosh/shell/*.test`, vendored from
  [smoosh](https://github.com/mgree/smoosh) `tests/shell` (MIT, commit
  cc67dbe), with the expected `NAME.out` and `NAME.ec` (default 0).
- Each case runs in a fresh `Shell` as `sh /smoosh/shell/NAME.test` in an
  empty directory with `$TEST_SHELL=sh`, as smoosh's `shell_tests.sh` does.
  `$TEST_UTIL`'s C helpers (`argv`, `getenv`, `readdir`) are shell scripts;
  cases that use `fds` (open fds via fcntl) are not scored.
- Judged on stdout and exit status. stderr isn't compared (the expected
  messages carry each shell's own prefix).
- Only cases host dash or `bash --posix` passes are scored
  (`smoosh/baseline.json`, from `scripts/conformance/smoosh-baseline.mjs`).
  A few kill/sleep timing cases can flip between baseline runs.
  `SMOOSH_CASES=a,b` narrows a run (written to `results/detail/`, not scored).

## Utilities: busybox testsuite (`utils-busybox.conf.ts`)

- Not vendored (GPL-2.0): `scripts/conformance/fetch.sh` clones busybox's
  `testsuite/` at a pinned commit into `tests/conformance/.cache/` (gitignored).
  Without it the suite is skipped.
- `NAME.tests` scripts (the `testing "name" "cmd" "expected" "input" "stdin"`
  form) run under Shiro's shell. `testing` is a harness builtin: it writes the
  `input` file, runs the command with `eval` semantics on the given stdin,
  and compares stdout. A call with other than 5 arguments (a shell parse
  error) fails, as upstream refuses it. Every optional feature is enabled.
- Old-style `APPLET/CASE` scripts run as `sh -e CASE` in an empty directory;
  exit status 0 passes. `busybox APPLET ARGS` runs Shiro's APPLET.
- Only cases the host's GNU tools pass (`busybox/gnu-baseline.json`, from
  `scripts/conformance/busybox-gnu-baseline.mjs`) are scored.
  `busybox/selection.json` lists the scripts and applets used;
  `busybox/hangs.json` lists cases not run because they hang Shiro.
- The "before" column overstates the old-style cases: the old shell ignored
  `sh -e` and returned the last command's status, so failing checks in the
  middle of a case went unnoticed.

## Syscalls: LTP under Blink (`syscalls-ltp.conf.ts`)

- Not vendored (GPL-2.0): `scripts/conformance/build-ltp.sh` clones the
  [Linux Test Project](https://github.com/linux-test-project/ltp) at a pinned
  commit and builds the syscall tests listed in `ltp/dirs.txt` as static
  x86-64 binaries into `tests/conformance/.cache/ltp-bin` (needs gcc, make,
  autoconf). Without them the suite is skipped.
- Each test runs through Shiro's shell (`/ltp/bin/NAME` in its own temp
  directory), so it executes under the Blink engine as a kernel process.
  It passes when it prints its `Summary:` with passed > 0 and no failed or
  broken results (`lib/ltp.mjs`); a test gets 60 s, and is stopped 1.5 s
  after its summary if it doesn't exit. Leftover processes are killed.
- Only tests that pass natively on the build host as uid 1000 (Shiro's
  processes are not root) are scored (`ltp/native-baseline.json`, from
  `scripts/conformance/ltp-native-baseline.mjs`; tests that need root don't
  count).
- A full run takes hours. Each finished test is journaled to
  `results/detail/syscalls-blink.jsonl` and its output saved under
  `results/detail/ltp/`; `LTP_RESUME=1` continues a run that died,
  `LTP_RESUME=1 LTP_RERUN_FAILED=1` runs only the previous failures again,
  `LTP_ONLY=read,write01` narrows a run, `LTP_ENV=BLINK_SAME_INSTANCE_FORK=1` adds to the tests' environment. `ltp/hangs.json` lists tests that
  crash the test worker; they count as failures.

## POSIX: Open POSIX Test Suite under Blink (`posix-openposix.conf.ts`)

- The suite ships in LTP (`testcases/open_posix_testsuite`, the same pinned
  checkout `build-ltp.sh` fetches); `scripts/conformance/build-openposix.sh`
  compiles every `conformance/interfaces/AREA/N-M.c` test with the suite's
  `lib/common.c` as a static x86-64 binary named `AREA_N-M` into
  `tests/conformance/.cache/openposix-bin` (about 1600; the few that don't
  build here are left out). Without them the suite is skipped.
- Each test runs through Shiro's shell in its own temp directory, under the
  Blink engine. It passes when it exits 0 (`PTS_PASS`); other statuses are
  reported by name (FAIL, UNRESOLVED, UNSUPPORTED, UNTESTED). A test gets
  20x its native time (8 to 30 s); leftover processes are killed.
- Only tests that pass natively on the build host as uid 1000 are scored
  (`openposix/native-baseline.json`, from
  `scripts/conformance/openposix-native-baseline.mjs`).
- Journaled to `results/detail/posix-openposix.jsonl`, output under
  `results/detail/openposix/`: `OPENPOSIX_RESUME=1` continues a run,
  `OPENPOSIX_RERUN_FAILED=1` (with it) reruns the failures,
  `OPENPOSIX_ONLY=sigaction,sem_post_1-1` narrows a run, and
  `openposix/hangs.json` lists tests that crash the worker.

## Shell in Chromium (`scripts/conformance/browser-oils.mjs`)

The oils spec cases again, in the real app: builds it (`--no-build` reuses
`dist/`), serves it with `server.mjs` (cross-origin isolated), loads it in the
pre-installed Chromium through playwright-core (never `playwright install`;
`CHROMIUM` overrides `/opt/pw-browsers/chromium`) and runs each scored case
through the page's shell the same way as the vitest harness. `--files a,b`
narrows a run (written as a `.partial.json`). Results:
`results/shell-oils-browser.json`. Not part of `npm run conformance` (it takes
a build and a browser); run it before updating the scoreboard.

## Syscalls: wasi-testsuite (`syscalls-wasi.conf.ts`)

- Not vendored: `scripts/conformance/fetch.sh` fetches
  [WebAssembly/wasi-testsuite](https://github.com/WebAssembly/wasi-testsuite)
  (Apache-2.0) at a pinned commit of its prebuilt `prod/testsuite-base`
  branch into `tests/conformance/.cache/wasi-testsuite`.
- Every wasm32-wasip1 module (C, Rust, AssemblyScript) runs as a tabcomputer WASI
  process (`runWasiProgram` → a kernel process in a Node Worker, the path a
  cross-origin isolated page takes; without the Worker factory Node would get
  the legacy runtime) the way the suite's wasmtime adapter runs it: only the
  test's args and env, a fresh copy of its `root` directory preopened as `/`
  (a `/` mount, see `openPreopens`) and nothing else (`bare`), judged on the
  exit code and, when given, stdout. Wasmtime passes all of them on Linux, so
  all are scored. `WASI_ONLY=name,rust` narrows a run; `WASI_LEGACY=1` runs
  the old in-page runtime (`src/wasi-runtime.ts`) instead, unscored.
- Known failure: `path_link` needs real hard links (same inode, shared data,
  nlink 2); the FileSystem has none, so `link()` copies.
