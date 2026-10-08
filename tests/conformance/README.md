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
- Each case runs in a fresh `Shell` (shared filesystem) as `sh CASE.sh` in an
  empty directory, with `$TMP`, `$SH` (= `sh`) and `$REPO_ROOT` set like the
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
