// Kernel: syscall round trip (SAB channel when isolated, JSPI otherwise),
// pipe throughput between two WASM processes, spawn+wait latency and
// throughput, file I/O through the kernel, epoll wakeup, pty echo.
// WASM work uses bench/fixtures/kbench.wasm, spawned with kernel.spawn
// (no shell in the path) unless the metric is about the shell/terminal.
export const name = 'kernel';

const KB = '/home/user/b/kbench.wasm';

export async function setupKbench(h) {
  await h.eval(async () => {
    await window.__bench.fetchInto('/__bench/kbench.wasm', '/home/user/b/kbench.wasm');
    await window.__bench.fetchInto('/__bench/cat.wasm', '/home/user/b/cat.wasm');
  });
}

/** Run kbench stages `n` times; returns parsed key=values of the last stage per run. */
async function kb(h, stages, n) {
  return h.eval(async ([stages, n]) => {
    const B = window.__bench, out = [];
    for (let i = 0; i < n; i++) {
      const r = await B.runProcs(stages);
      if (r.codes.some((c) => c !== 0)) throw new Error(`exit ${r.codes}: ${r.out.slice(0, 200)}`);
      out.push({ ...B.kv(r.out), wallMs: r.ms });
    }
    return out;
  }, [stages, n]);
}

export async function run(h) {
  const n = h.runs;
  await setupKbench(h);
  const chan = h.isolated ? 'sab' : 'jspi';
  const procMode = await h.eval(() => (crossOriginIsolated ? 'sab' : typeof WebAssembly.Suspending === 'function' ? 'jspi' : 'none'));
  if (procMode === 'none') { h.skip('kernel.suite', '', 'no SAB and no JSPI: WASM processes unavailable'); return; }

  // Warm the module cache so later spawns measure the kernel, not compilation
  await kb(h, [[KB, 'nop']], 2);

  await h.try(`kernel.syscall_rtt.${chan}`, 'µs', async () => {
    const calls = h.quick ? 5000 : 20000;
    const r = await kb(h, [[KB, 'sys', String(calls)]], n);
    h.sample(`kernel.syscall_rtt.${chan}`, r.map((x) => x.ns / x.calls / 1000), 'µs',
      { notes: `fd_fdstat_get → fstat from a WASM process, ${calls} calls (${chan === 'sab' ? 'Worker, SAB channel' : 'main thread, JSPI'})` });
  });

  await h.try('kernel.syscall_inpage', 'µs', async () => {
    const r = await h.eval(async (n) => {
      const B = window.__bench, out = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        for (let j = 0; j < 10000; j++) await B.sys(B.SYS.getpid);
        out.push((performance.now() - t0) / 10000 * 1000);
      }
      return out;
    }, n);
    h.sample('kernel.syscall_inpage', r, 'µs', { notes: 'kernel.syscall(getpid) from page JS: dispatch floor, no channel' });
  });

  await h.try('kernel.pipe_throughput', 'MB/s', async () => {
    const mb = h.quick ? 16 : 64;
    const r = await kb(h, [[KB, 'write', String(mb)], [KB, 'read']], n);
    h.sample('kernel.pipe_throughput', r.map((x) => x.bytes / 1e6 / (x.ns / 1e9)), 'MB/s', { notes: `${mb} MiB, 64 KiB writes, WASM writer → kernel pipe → WASM reader (reader's clock)` });
    const small = await kb(h, [[KB, 'write', '4', '512'], [KB, 'read', '512']], n);
    h.sample('kernel.pipe_throughput_512b', small.map((x) => x.bytes / 1e6 / (x.ns / 1e9)), 'MB/s', { notes: '4 MiB in 512-byte writes/reads (syscall-bound)' });
  });

  await h.try('kernel.file_write', 'MB/s', async () => {
    const mb = h.quick ? 4 : 16;
    const w = await kb(h, [[KB, 'fwrite', '/tmp/kbench.bin', String(mb)]], n);
    h.sample('kernel.file_write', w.map((x) => x.bytes / 1e6 / (x.ns / 1e9)), 'MB/s', { notes: `${mb} MiB, 64 KiB writes, open→close (WASM → kernel → filesystem)` });
    const r = await kb(h, [[KB, 'fread', '/tmp/kbench.bin']], n);
    h.sample('kernel.file_read', r.map((x) => x.bytes / 1e6 / (x.ns / 1e9)), 'MB/s', { notes: `${mb} MiB, 64 KiB reads` });
  });

  await h.try('kernel.spawn_wait.wasm', 'ms', async () => {
    const r = await kb(h, [[KB, 'nop']], Math.max(n, 10));
    h.sample('kernel.spawn_wait.wasm', r.map((x) => x.wallMs), 'ms', { notes: 'kernel.spawn of kbench.wasm (cached module) → waitpid' });
  });
  await h.try('kernel.spawn_wait.builtin', 'ms', async () => {
    const r = await h.eval(async (n) => {
      const B = window.__bench, out = [];
      for (let i = 0; i < n; i++) out.push((await B.runProcs([['true']])).ms);
      return out;
    }, Math.max(n, 10));
    h.sample('kernel.spawn_wait.builtin', r, 'ms', { notes: 'kernel.spawn of the `true` builtin → waitpid' });
  });
  await h.try('kernel.spawn_throughput', 'proc/s', async () => {
    const r = await h.eval(async ([n, kb]) => {
      const B = window.__bench, k = window.__shiro.kernel, out = { builtin: [], wasm: [] };
      const nul = await B.devnull();
      for (const [kind, argv, count] of [['builtin', ['true'], 100], ['wasm', [kb, 'nop'], 30]]) {
        for (let i = 0; i < n; i++) {
          const t0 = performance.now();
          // 10 at a time in flight
          let left = count;
          const worker = async () => {
            while (left-- > 0) {
              const p = k.spawn({ path: argv[0], argv, parent: B.lab(), fds: { 0: nul, 1: nul, 2: nul } });
              await k.waitpid(p.pid, 0, B.lab());
            }
          };
          await Promise.all(Array.from({ length: 10 }, worker));
          out[kind].push(count / ((performance.now() - t0) / 1000));
        }
      }
      return out;
    }, [n, KB]);
    h.sample('kernel.spawn_throughput.builtin', r.builtin, 'proc/s', { notes: '100 `true` spawns, 10 in flight' });
    h.sample('kernel.spawn_throughput.wasm', r.wasm, 'proc/s', { notes: '30 kbench.wasm spawns, 10 in flight' });
  });


  await h.try('kernel.epoll_wakeup', 'µs', async () => {
    const r = await h.eval(async (n) => {
      const B = window.__bench, S = B.SYS;
      const p = await B.pipe();
      const ep = await B.sys(S.epoll_create1, [0]);
      if (ep < 0) throw new Error('epoll_create1 ' + ep);
      const rc = await B.sys(S.epoll_ctl, [ep, 1 /* ADD */, p.rfd, 1 /* EPOLLIN */, p.rfd, 0]);
      if (rc < 0) throw new Error('epoll_ctl ' + rc);
      const one = new Uint8Array([120]), ev = new Uint8Array(12 * 4), rb = new Uint8Array(16);
      const out = [];
      for (let i = 0; i < n; i++) {
        const iters = 500;
        let sum = 0;
        for (let j = 0; j < iters; j++) {
          const wait = B.sys(S.epoll_wait, [ep, 4, 1000], ev);
          await new Promise((r) => setTimeout(r, 0)); // let it block
          const t0 = performance.now();
          await B.sys(S.write, [p.wfd, 1], one);
          const got = await wait;
          sum += performance.now() - t0;
          if (got !== 1) throw new Error('epoll_wait returned ' + got);
          await B.sys(S.read, [p.rfd, 16], rb);
        }
        out.push(sum / iters * 1000);
      }
      await B.sys(S.close, [ep]); await B.sys(S.close, [p.rfd]); await B.sys(S.close, [p.wfd]);
      return out;
    }, n);
    h.sample('kernel.epoll_wakeup', r, 'µs', { notes: 'blocked epoll_wait → write to the pipe → wait returns (in-page, main thread)' });
  });

  await h.try('kernel.pty_echo.line_editor', 'ms', async () => {
    const r = await h.eval(async (n) => window.__bench.echoLatency(n * 10), n);
    h.sample('kernel.pty_echo.line_editor', r.parsed, 'ms', { notes: 'xterm input → shell line editor echo → parsed into the terminal buffer (prompt, no kernel job)' });
    h.sample('kernel.pty_echo.line_editor_frame', r.frame, 'ms', { notes: 'same, until the next rendered frame' });
    await h.eval(() => window.__shiro.terminal.term.input('\x15', true)); // ^U clears the line
  });

  await h.try('kernel.pty_echo.kernel', 'ms', async () => {
    const r = await h.eval(async (n) => {
      const term = window.__shiro.terminal;
      const t = term.term;
      t.input('/home/user/b/kbench.wasm read\r', true);
      const t0 = performance.now();
      while (!term.tty?.jobInForeground) {
        if (performance.now() - t0 > 15000) throw new Error('kbench.wasm read never took the foreground');
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 200));
      const out = await window.__bench.echoLatency(n * 10);
      t.input('\r\x04', true); // newline, then ^D ends the reader
      const t1 = performance.now();
      while (term.tty?.jobInForeground && performance.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 10));
      return out;
    }, n);
    h.sample('kernel.pty_echo.kernel', r.parsed, 'ms', { notes: 'keystroke → kernel pty n_tty echo (WASM reader in the foreground) → parsed into the terminal buffer' });
    h.sample('kernel.pty_echo.kernel_frame', r.frame, 'ms', { notes: 'same, until the next rendered frame' });
  });
}
