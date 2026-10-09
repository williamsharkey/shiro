// Injected into every benchmark page before Shiro's scripts run
// (context.addInitScript). Records boot milestones and long tasks, tracks
// SharedArrayBuffers/shared memories for the leak checks, and exposes
// helpers as window.__bench once Shiro is up. Plain browser JS, no imports.
(() => {
  if (window.__bench) return;
  const B = (window.__bench = { marks: {}, longTasks: [], sabs: [], memories: [] });
  try { performance.setResourceTimingBufferSize(100000); } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) B.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}

  // Leak tracking: weak references to every SharedArrayBuffer and shared WebAssembly.Memory
  if (typeof SharedArrayBuffer === 'function' && typeof WeakRef === 'function') {
    const SAB = SharedArrayBuffer;
    const P = new Proxy(SAB, { construct(t, args) { const b = new t(...args); B.sabs.push(new WeakRef(b)); return b; } });
    try { globalThis.SharedArrayBuffer = P; } catch {}
  }
  if (typeof WebAssembly === 'object' && typeof WeakRef === 'function') {
    const Mem = WebAssembly.Memory;
    const P = new Proxy(Mem, { construct(t, args) { const m = new t(...args); if (args[0] && args[0].shared) B.memories.push(new WeakRef(m)); return m; } });
    try { WebAssembly.Memory = P; } catch {}
  }
  B.liveShared = () => {
    let sabs = 0, sabBytes = 0, mems = 0, memBytes = 0;
    for (const r of B.sabs) { const b = r.deref(); if (b) { sabs++; sabBytes += b.byteLength; } }
    for (const r of B.memories) { const m = r.deref(); if (m) { mems++; memBytes += m.buffer.byteLength; } }
    return { sabs, sabBytes, sharedMemories: mems, sharedMemoryBytes: memBytes };
  };

  // First prompt: the terminal's cursor line ends in "$ " after boot
  const poll = setInterval(() => {
    const t = window.__tabcomputer && window.__tabcomputer.terminal;
    if (!t || !t.term) return;
    if (!B.marks.shiroReady) B.marks.shiroReady = performance.now();
    const buf = t.term.buffer.active;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    const text = line ? line.translateToString(false).slice(0, buf.cursorX) : '';
    if (/\$ $/.test(text)) {
      B.marks.firstPrompt = performance.now();
      clearInterval(poll);
    }
  }, 2);

  const enc = new TextEncoder();
  /** Run a command line in the page shell; output captured. */
  B.sh = async (cmd, opts = {}) => {
    const shell = opts.shell || window.__tabcomputer.shell;
    let out = '', err = '';
    const t0 = performance.now();
    // Kernel programs write a terminal's tty directly unless it asks for their
    // stdout (as $(...) does); without this `vim --version | wc -l` prints on the screen
    const t = shell.terminal;
    const term = t && new Proxy(t, { get: (o, k) => (k === 'captureStdout' ? true : typeof o[k] === 'function' ? o[k].bind(o) : o[k]) });
    const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; }, false, term);
    const ms = performance.now() - t0;
    return { code, ms, out: opts.full ? out : out.slice(-4000), err: err.slice(-4000) };
  };
  /** sh() with a deadline: on timeout, SIGKILL every kernel process started since the call. */
  B.shLimit = async (cmd, ms) => {
    const k = window.__tabcomputer.kernel;
    const before = new Set(k.procs.keys());
    let timedOut = false;
    const run = B.sh(cmd);
    const timer = new Promise((res) => setTimeout(() => res('timeout'), ms));
    const first = await Promise.race([run, timer]);
    if (first !== 'timeout') return first;
    timedOut = true;
    for (const [pid, p] of k.procs) if (!before.has(pid) && p.state !== 'zombie') k.kill(pid, 9);
    const r = await Promise.race([run, new Promise((res) => setTimeout(() => res(null), 5000))]);
    return { ...(r || { out: '', err: '' }), code: 124, ms, timedOut };
  };
  /** Time `n` runs of `cmd`; returns ms per run. Fails fast on a non-zero exit. */
  B.shTimes = async (cmd, n, expectCode = 0) => {
    const times = [];
    for (let i = 0; i < n; i++) {
      const r = await B.sh(cmd);
      if (expectCode !== null && r.code !== expectCode) throw new Error(`${cmd}: exit ${r.code}: ${(r.err || r.out).slice(-300)}`);
      times.push(r.ms);
    }
    return times;
  };
  B.kv = (text) => {
    const o = {};
    for (const m of String(text).matchAll(/^(\w+)=(\S+)$/gm)) o[m[1]] = isNaN(+m[2]) ? m[2] : +m[2];
    return o;
  };
  B.writeFile = (path, data, mode) => window.__tabcomputer.fs.writeFile(path, typeof data === 'string' ? enc.encode(data) : data, mode ? { mode } : undefined);
  /** Copy a file the bench server publishes under /__bench/ into Shiro's filesystem. */
  B.fetchInto = async (url, path, mode = 0o755) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    await window.__tabcomputer.fs.mkdir(dir, { recursive: true }).catch(() => {});
    await window.__tabcomputer.fs.writeFile(path, bytes, { mode });
    return bytes.length;
  };
  B.resources = () => {
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');
    const all = nav ? [nav, ...res] : res;
    let transfer = 0, decoded = 0;
    for (const e of all) { transfer += e.transferSize || 0; decoded += e.decodedBodySize || 0; }
    return { count: all.length, transferBytes: transfer, decodedBytes: decoded };
  };
  // ── Kernel lab: a helper process whose fd table holds the benchmark's pipes ──
  const SYS = { read: 0, write: 1, close: 3, getpid: 39, pipe2: 293, epoll_create1: 291, epoll_ctl: 233, epoll_wait: 232 };
  B.SYS = SYS;
  B.lab = () => {
    if (B._lab && B._lab.state !== 'zombie') return B._lab;
    const k = window.__tabcomputer.kernel;
    B._lab = k.spawn({ path: 'bench-lab', argv: ['bench-lab'], fds: {}, run: () => new Promise((r) => { B._labExit = r; }) });
    return B._lab;
  };
  B.sys = (nr, args = [], data = new Uint8Array(0)) => window.__tabcomputer.kernel.syscall(B.lab(), nr, args, data);
  B.pipe = async () => {
    const d = new Uint8Array(8);
    const r = await B.sys(SYS.pipe2, [0], d);
    if (r < 0) throw new Error('pipe2: ' + r);
    const dv = new DataView(d.buffer);
    const rfd = dv.getInt32(0, true), wfd = dv.getInt32(4, true);
    const lab = B.lab();
    return { rfd, wfd, r: lab.fds.get(rfd), w: lab.fds.get(wfd) };
  };
  B.readAllFd = async (fd) => {
    const chunks = []; let total = 0;
    for (;;) {
      const buf = new Uint8Array(65536);
      const n = await B.sys(SYS.read, [fd, buf.length], buf);
      if (n <= 0) break;
      chunks.push(buf.subarray(0, n)); total += n;
    }
    const out = new Uint8Array(total); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return new TextDecoder().decode(out);
  };
  B.devnull = async () => {
    const f = await window.__tabcomputer.kernel.open(B.lab(), '/dev/null', 2);
    if (typeof f === 'number') throw new Error('open /dev/null: ' + f);
    return f;
  };
  /**
   * Spawn a pipeline of kernel processes (stdin of the first is /dev/null,
   * stages joined by kernel pipes); returns stdout+stderr of the last stage,
   * exit codes and wall time from spawn to the last wait.
   */
  B.runProcs = async (stages, { cwd = '/home/user' } = {}) => {
    const k = window.__tabcomputer.kernel, lab = B.lab();
    const out = await B.pipe();
    const nul = await B.devnull();
    const links = [];
    for (let i = 0; i < stages.length - 1; i++) links.push(await B.pipe());
    const t0 = performance.now();
    const procs = stages.map((argv, i) => k.spawn({
      path: argv[0], argv, parent: lab, cwd,
      fds: { 0: i ? links[i - 1].r : nul, 1: i < stages.length - 1 ? links[i].w : out.w, 2: out.w },
    }));
    for (const l of links) { await B.sys(SYS.close, [l.rfd]); await B.sys(SYS.close, [l.wfd]); }
    await B.sys(SYS.close, [out.wfd]);
    const text = await B.readAllFd(out.rfd);
    const codes = [];
    for (const p of procs) { const w = await k.waitpid(p.pid, 0, lab); codes.push((w.status >> 8) & 0xff | (w.status & 0x7f ? 128 + (w.status & 0x7f) : 0)); }
    const ms = performance.now() - t0;
    await B.sys(SYS.close, [out.rfd]);
    return { ms, out: text, codes };
  };

  /** Keystroke → echo latency on the main terminal: until parsed into the buffer, and until the next frame. */
  B.echoLatency = async (count) => {
    const t = window.__tabcomputer.terminal.term;
    const parsed = [], frame = [];
    for (let i = 0; i < count; i++) {
      const ch = String.fromCharCode(97 + (i % 26));
      let tp = 0;
      const p1 = new Promise((res) => { const d = t.onWriteParsed(() => { d.dispose(); tp = performance.now(); res(); }); });
      const p2 = new Promise((res) => { const d = t.onRender(() => { d.dispose(); res(performance.now()); }); });
      const s = performance.now();
      t.input(ch, true);
      await p1;
      const tf = await p2;
      parsed.push(tp - s); frame.push(tf - s);
      await new Promise((r) => setTimeout(r, 5));
    }
    return { parsed, frame };
  };

  B.kernelStats = () => {
    const k = window.__tabcomputer.kernel;
    let fds = 0, zombies = 0, live = 0;
    for (const p of k.procs.values()) {
      if (p.state === 'zombie') zombies++; else live++;
      try { fds += p.fds.size ?? [...p.fds.entries?.() ?? []].length; } catch {}
    }
    return { procs: k.procs.size, live, zombies, fds, initFds: k.init.fds.size ?? null };
  };
})();
