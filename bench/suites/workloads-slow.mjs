// Real workloads, the slow ones (minutes; opt-in with --suites workloads-slow):
// `debian install` to the first Debian prompt, apt-get update and installs of
// cowsay and python3, python3 cold and warm, `git clone` of a small repo over
// the TCP relay from a git:// server this harness runs (lib/gitserver.mjs),
// and the native Claude Code binary's `--version` when it is cached in
// bench/.cache/fixtures (never downloaded here). Time and renderer RSS peak
// for each. apt's packages come from server.mjs's Debian mirror disk cache
// (.debian-build/mirror-cache) after the first run, so later runs measure
// the machine, not deb.debian.org.
import { MB } from '../lib/harness.mjs';

export const name = 'workloads-slow';
export const ownPages = true;

async function timed(h, cmd, limitS = 600, check) {
  const r = await h.withPeakRss(() => h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [`${cmd} > /tmp/wl.out 2>&1`, limitS * 1000]));
  const out = (await h.sh('cat /tmp/wl.out')).out;
  if (r.result.code !== 0 || (check && !check.test(out))) {
    throw new Error(`${cmd}: ${r.result.code === 124 ? `timed out after ${limitS} s` : `exit ${r.result.code}`}: ${out.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`);
  }
  return { ms: r.result.ms, peak: r.peakDelta / MB };
}

const storage = (h) => h.eval(async () => (await navigator.storage.estimate()).usage);

export async function run(h) {
  if (!h.isolated) { h.skip('workload.slow.suite', '', 'Debian and x86 need a cross-origin isolated page (Blink)'); return; }
  const n = h.quick ? 1 : Math.min(h.runs, 3);
  const apt = 'sudo DEBIAN_FRONTEND=noninteractive apt-get';
  const R = {};
  const add = (k, v) => (R[k] ??= []).push(v);

  if (h.wants('workload.debian') || h.wants('workload.apt') || h.wants('workload.python3')) {
    for (let i = 0; i < n; i++) {
      await h.page?.context().close().catch(() => {});
      await h.boot({ path: '/?ui=terminal' });
      try {
        const inst = await timed(h, 'debian install', 300);
        const bash = await timed(h, '/usr/bin/bash -c true', 300);
        add('install', inst.ms); add('first_bash', bash.ms); add('to_prompt', inst.ms + bash.ms); add('to_prompt_peak', Math.max(inst.peak, bash.peak));
        const up = await timed(h, `${apt} update`, 1800);
        add('update', up.ms); add('update_peak', up.peak);
        const cow = await timed(h, `${apt} install -y cowsay`, 1800);
        add('cowsay', cow.ms); add('cowsay_peak', cow.peak);
        const cowRun = await timed(h, '/usr/games/cowsay moo', 300, /moo/);
        add('cowsay_run', cowRun.ms);
        const py = await timed(h, `${apt} install -y python3`, 1800);
        add('python3', py.ms); add('python3_peak', py.peak);
        const cold = await timed(h, "python3 -c 'print(1)'", 300, /^1\s*$/m);
        add('py_cold', cold.ms); add('py_cold_peak', cold.peak);
        for (let j = 0; j < 3; j++) { const w = await timed(h, "python3 -c 'print(1)'", 300, /^1\s*$/m); add('py_warm', w.ms); add('py_warm_peak', w.peak); }
        add('storage', (await storage(h)) / MB);
      } catch (e) {
        h.skip('workload.debian.round', '', `round ${i + 1} failed: ${String(e.message).slice(0, 200)}`);
      }
    }
    const S = (name, key, unit, notes, extra = {}) => { if (R[key]?.length) h.sample(name, R[key], unit, { notes, ...extra }); };
    S('workload.debian.install_to_prompt', 'to_prompt', 'ms', '`debian install` + the first `/usr/bin/bash -c true` (Debian\'s bash, its chunks fetched on first use), fresh profile');
    S('workload.debian.install', 'install', 'ms', '`debian install` alone (manifest, index, placeholders)');
    S('workload.debian.first_bash', 'first_bash', 'ms', 'the first Debian bash after install');
    S('workload.peak_rss.debian_install', 'to_prompt_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    S('workload.apt.update', 'update', 'ms', '`apt-get update` (trixie + updates + security, ~10 MB of indexes) from the mirror cache');
    S('workload.peak_rss.apt_update', 'update_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    S('workload.apt.install_cowsay', 'cowsay', 'ms', '`apt-get install -y cowsay` (pulls perl), dpkg in Blink');
    S('workload.peak_rss.apt_cowsay', 'cowsay_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    S('workload.apt.cowsay_run', 'cowsay_run', 'ms', 'first `/usr/games/cowsay moo` after install (perl in Blink)');
    S('workload.apt.install_python3', 'python3', 'ms', '`apt-get install -y python3` (after cowsay, so perl is already there)');
    S('workload.peak_rss.apt_python3', 'python3_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    S('workload.python3.cold', 'py_cold', 'ms', "first `python3 -c 'print(1)'` after the install (Debian's CPython in Blink)");
    S('workload.python3.warm', 'py_warm', 'ms', 'the next three runs', { cache: 'warm' });
    S('workload.peak_rss.python3_cold', 'py_cold_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    S('workload.peak_rss.python3_warm', 'py_warm_peak', 'MiB', 'same, warm runs');
    S('workload.debian.storage', 'storage', 'MiB', 'navigator.storage.estimate().usage after install + update + cowsay + python3');
  }

  await h.try('workload.git.clone_relay', 'ms', async () => {
    const g = h.gitServer;
    if (!g) throw new Error('no git:// server (git missing on this machine)');
    await h.page?.context().close().catch(() => {});
    await h.boot({ path: '/?ui=terminal' });
    const inst = await timed(h, 'pkg install git', 300, /Setting up git|already installed/);
    const url = `git://${g.host}:${g.port}/${g.repo}`;
    const ms = [], peak = [];
    const runs = h.quick ? 3 : h.runs;
    for (let i = 0; i <= runs; i++) {
      const r = await timed(h, `cd /tmp && rm -rf clone-${i} && git clone ${url} clone-${i} && test -f clone-${i}/src/data.txt`, 300);
      if (i === 0) { h.sample('workload.git.clone_relay.first', [r.ms], 'ms', { notes: 'first clone of the page (git binary not yet compiled/cached), one sample' }); continue; }
      ms.push(r.ms); peak.push(r.peak);
    }
    h.sample('workload.git.clone_relay', ms, 'ms', { notes: `\`git clone ${'git://<host>:<port>/small.git'}\` (pkg git in Blink; 41 files, 5 commits) through server.mjs's TCP relay to a local git daemon; pkg install git took ${Math.round(inst.ms)} ms` });
    h.sample('workload.peak_rss.git_clone', peak, 'MiB', { notes: 'renderer RSS peak above the pre-run level' });
  });

  await h.try('workload.claude_native', 'ms', async () => {
    if (!h.fixtures['claude-native'] || !h.fixtures['ld-musl-x86_64.so.1']) {
      h.skip('workload.claude_native.version', 'ms', 'native Claude Code not cached: put the linux-x64-musl binary at bench/.cache/fixtures/claude-native and musl\'s loader at bench/.cache/fixtures/ld-musl-x86_64.so.1 (bench/README.md); never downloaded by the bench');
      return;
    }
    await h.page?.context().close().catch(() => {});
    await h.boot({ path: '/?ui=terminal' });
    await h.eval(async () => {
      await window.__bench.fetchInto('/__bench/claude-native', '/home/user/.local/bin/claude');
      await window.__bench.fetchInto('/__bench/ld-musl-x86_64.so.1', '/lib/ld-musl-x86_64.so.1');
    });
    const first = await timed(h, 'claude --native --version', 600, /\d+\.\d+\.\d+/);
    const ms = [], peak = [];
    for (let i = 0; i < Math.min(h.runs, 3); i++) { const r = await timed(h, 'claude --native --version', 600, /\d+\.\d+\.\d+/); ms.push(r.ms); peak.push(r.peak); }
    h.sample('workload.claude_native.version_first', [first.ms], 'ms', { notes: '`claude --native --version`, first run (linux-x64-musl build in Blink), one sample' });
    h.sample('workload.claude_native.version', ms, 'ms', { notes: 'warm runs' });
    h.sample('workload.peak_rss.claude_native', [first.peak, ...peak], 'MiB', { notes: 'renderer RSS peak above the pre-run level' });
  });
}
