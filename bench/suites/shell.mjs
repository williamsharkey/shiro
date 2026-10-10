// Shell: builtin latency, loops, ls on a big directory, builtin pipelines,
// command substitution. Commands run through window.__tabcomputer.shell.execute
// (no terminal), so terminal rendering is not included.
export const name = 'shell';

/** Mean ms per call of `cmd`, over `batch` calls, `runs` times. */
async function perCall(h, cmd, batch, runs) {
  return h.eval(async ([cmd, batch, runs]) => {
    await window.__bench.shTimes(cmd, 3); // warm up (lazy command loads)
    const out = [];
    for (let r = 0; r < runs; r++) {
      const t = await window.__bench.shTimes(cmd, batch);
      out.push(t.reduce((a, b) => a + b, 0) / t.length);
    }
    return out;
  }, [cmd, batch, runs]);
}

async function times(h, cmd, runs, check) {
  return h.eval(async ([cmd, runs, check]) => {
    const first = await window.__bench.sh(cmd);
    if (first.code !== 0) throw new Error(`exit ${first.code}: ${(first.err || first.out).slice(-200)}`);
    if (check && !new RegExp(check).test(first.out)) throw new Error(`unexpected output: ${first.out.slice(0, 200)}`);
    return window.__bench.shTimes(cmd, runs);
  }, [cmd, runs, check]);
}

/** Wait until a small fs write completes quickly (the IndexedDB queue drained). */
export async function drainFs(h) {
  return h.eval(async () => {
    const t0 = performance.now();
    for (;;) {
      const s = performance.now();
      await window.__tabcomputer.fs.writeFile('/tmp/.bench-drain', 'x');
      if (performance.now() - s < 20 || performance.now() - t0 > 120000) return performance.now() - t0;
    }
  });
}

export async function run(h) {
  const n = h.runs;
  const batch = h.quick ? 20 : 50;
  await h.try('shell.true', 'ms', async () => h.sample('shell.true', await perCall(h, 'true', batch, n), 'ms', { notes: `per call, mean of ${batch}` }));
  await h.try('shell.echo', 'ms', async () => h.sample('shell.echo', await perCall(h, 'echo hello', batch, n), 'ms', { notes: `per call, mean of ${batch}` }));
  // `> f` opens the file before the command runs: a file with data is truncated first
  await h.try('shell.redirect_overwrite', 'ms', async () => h.sample('shell.redirect_overwrite', await perCall(h, 'echo hello > /tmp/bench-redir', batch, n), 'ms', { notes: `\`echo hello > f\` over an existing f, per call, mean of ${batch}` }));
  await h.try('shell.redirect_new', 'ms', async () => h.sample('shell.redirect_new', await perCall(h, 'rm -f /tmp/bench-redir-new; echo hello > /tmp/bench-redir-new', batch, n), 'ms', { notes: `\`rm -f f; echo hello > f\` per call, mean of ${batch}` }));
  await h.try('shell.cmd_subst', 'ms', async () => h.sample('shell.cmd_subst', await perCall(h, 'x=$(echo hi)', batch, n), 'ms', { notes: `\`x=$(echo hi)\` per call, mean of ${batch}` }));
  await h.try('shell.fs_write_after_burst', 'ms', async () => {
    await drainFs(h);
    const r = await h.eval(async (n) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < 200; j++) await window.__bench.sh('true');
        const t0 = performance.now();
        await window.__tabcomputer.fs.writeFile('/tmp/bench-probe.txt', 'x');
        out.push(performance.now() - t0);
        // drain before the next round
        for (;;) { const s = performance.now(); await window.__tabcomputer.fs.writeFile('/tmp/.bench-drain', 'x'); if (performance.now() - s < 20) break; }
      }
      return out;
    }, n);
    h.sample('shell.fs_write_after_burst', r, 'ms', { notes: 'one fs.writeFile right after 200 `true` commands (each queues a full history-file write to IndexedDB)' });
  });
  await drainFs(h);
  await h.try('shell.loop_1000', 'ms', async () => h.sample('shell.loop_1000',
    await times(h, 'i=0; while [ $i -lt 1000 ]; do i=$((i+1)); done; echo $i', n, '^1000'), 'ms', { notes: '`while [ $i -lt 1000 ]; do i=$((i+1)); done`' }));
  await h.try('shell.for_seq_1000', 'ms', async () => h.sample('shell.for_seq_1000',
    await times(h, 'for i in $(seq 1000); do true; done', n), 'ms', { notes: '`for i in $(seq 1000); do true; done`' }));
  await h.try('shell.ls_la_1000', 'ms', async () => {
    await drainFs(h);
    const created = await h.eval(async () => {
      const t0 = performance.now();
      const fs = window.__tabcomputer.fs;
      await fs.mkdir('/tmp/bench-ls', { recursive: true }).catch(() => {});
      const names = await fs.readdir('/tmp/bench-ls').catch(() => []);
      if (names.length < 1000) {
        const ps = [];
        for (let i = 0; i < 1000; i++) ps.push(fs.writeFile(`/tmp/bench-ls/file-${String(i).padStart(4, '0')}.txt`, 'x'.repeat(i % 97)));
        await Promise.all(ps);
      }
      return performance.now() - t0;
    });
    if (process.env.BENCH_VERBOSE) h.log(`    created 1000 files in ${Math.round(created)} ms`);
    h.sample('shell.ls_la_1000', await times(h, 'ls -la /tmp/bench-ls', n, 'file-0999'), 'ms', { notes: '1000-file directory, output captured' });
  });
  await h.try('shell.pipeline_seq_grep_wc', 'ms', async () => h.sample('shell.pipeline_seq_grep_wc',
    await times(h, 'seq 100000 | grep 7 | wc -l', n, '40951'), 'ms', { notes: '`seq 100000 | grep 7 | wc -l` (builtins)' }));
  await h.try('shell.redirect_append_100', 'ms', async () => h.sample('shell.redirect_append_100',
    await times(h, 'rm -f /tmp/bench-app.txt; for i in $(seq 100); do echo line $i >> /tmp/bench-app.txt; done; wc -l < /tmp/bench-app.txt', n, '100'), 'ms', { notes: '100 `echo >> file` (IndexedDB writes)' }));
}
