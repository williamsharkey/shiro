/**
 * child_process for node as a kernel guest: `sh -c CMD` as a real child
 * process (SYS_spawn) on pipes for fds 0/1/2, its input written and its
 * output read with poll() so neither side can fill a pipe and wait on the
 * other, then wait4. runChildSync blocks the guest (execSync, spawnSync,
 * execFileSync: their result is there when they return); runChild does the
 * same from timers, so the program's event loop keeps running.
 */
import * as A from '../kernel/abi';
import type { GuestSys } from '../kernel/channel';

export interface ChildOptions {
  input?: string | Uint8Array;
  env?: Record<string, string>;
  cwd?: string;
  /** Called with output as it arrives (streams for spawn()) */
  onStdout?: (b: Uint8Array) => void;
  onStderr?: (b: Uint8Array) => void;
}

export interface ChildResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  /** Exit code, or null when a signal ended it */
  status: number | null;
  signal: number | null;
  pid: number;
}

const enc = new TextEncoder();

/** The pieces of one running child: its pid and our ends of its pipes */
interface Running {
  pid: number;
  inW: number;
  outR: number;
  errR: number;
  input: Uint8Array;
  inOff: number;
  out: Uint8Array[];
  err: Uint8Array[];
  opts: ChildOptions;
}

function start(sys: GuestSys, cmd: string, opts: ChildOptions): Running | number {
  const pin = sys.pipe(), pout = sys.pipe(), perr = sys.pipe();
  for (const p of [pin, pout, perr]) if (typeof p === 'number') return p;
  const [inR, inW] = pin as [number, number], [outR, outW] = pout as [number, number], [errR, errW] = perr as [number, number];
  // our ends aren't the child's; writes to its stdin never block us
  for (const fd of [inW, outR, errR]) sys.fcntl(fd, A.F_SETFD, A.FD_CLOEXEC);
  sys.fcntl(inW, A.F_SETFL, A.O_NONBLOCK);
  const pid = sys.spawn('sh', ['sh', '-c', cmd], {
    fds: [[0, inR], [1, outW], [2, errW]],
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  for (const fd of [inR, outW, errW]) sys.close(fd);
  if (pid < 0) { for (const fd of [inW, outR, errR]) sys.close(fd); return pid; }
  const input = opts.input === undefined ? new Uint8Array(0) : typeof opts.input === 'string' ? enc.encode(opts.input) : opts.input;
  const r: Running = { pid, inW, outR, errR, input, inOff: 0, out: [], err: [], opts };
  if (!input.length) { sys.close(inW); r.inW = -1; }
  return r;
}

/** One poll round: move what's ready. Returns true when both outputs are at EOF. */
function pump(sys: GuestSys, r: Running, timeoutMs: number): boolean {
  const want: { fd: number; events: number }[] = [];
  if (r.inW >= 0) want.push({ fd: r.inW, events: A.POLLOUT });
  if (r.outR >= 0) want.push({ fd: r.outR, events: A.POLLIN });
  if (r.errR >= 0) want.push({ fd: r.errR, events: A.POLLIN });
  if (!want.length) return true;
  const { ready, revents } = sys.poll(want, timeoutMs);
  if (ready <= 0) return false;
  const buf = new Uint8Array(65536);
  want.forEach((w, i) => {
    const ev = revents[i];
    if (!ev) return;
    if (w.fd === r.inW) {
      if (ev & (A.POLLERR | A.POLLHUP)) { sys.close(r.inW); r.inW = -1; return; }
      const n = sys.write(r.inW, r.input.subarray(r.inOff, r.inOff + 65536));
      if (n > 0) r.inOff += n;
      if (n < 0 && n !== -A.EAGAIN) r.inOff = r.input.length; // the child closed it: drop the rest
      if (r.inOff >= r.input.length) { sys.close(r.inW); r.inW = -1; }
      return;
    }
    const n = sys.read(w.fd, buf);
    if (n > 0) {
      const chunk = buf.slice(0, n);
      if (w.fd === r.outR) { r.out.push(chunk); r.opts.onStdout?.(chunk); }
      else { r.err.push(chunk); r.opts.onStderr?.(chunk); }
    } else if (n === 0 || (n < 0 && n !== -A.EAGAIN && n !== -A.EINTR)) {
      sys.close(w.fd);
      if (w.fd === r.outR) r.outR = -1; else r.errR = -1;
    }
  });
  return r.outR < 0 && r.errR < 0;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function finish(r: Running, status: number): ChildResult {
  const signaled = A.WIFSIGNALED(status);
  return {
    stdout: concat(r.out), stderr: concat(r.err), pid: r.pid,
    status: signaled ? null : A.WEXITSTATUS(status),
    signal: signaled ? A.WTERMSIG(status) : null,
  };
}

/** Run CMD to the end, blocking this worker meanwhile */
export function runChildSync(sys: GuestSys, cmd: string, opts: ChildOptions = {}): ChildResult {
  const r = start(sys, cmd, opts);
  if (typeof r === 'number') return { stdout: new Uint8Array(0), stderr: enc.encode(`spawn sh: errno ${-r}\n`), status: 127, signal: null, pid: 0 };
  while (!pump(sys, r, -1)) { /* until both outputs end */ }
  if (r.inW >= 0) { sys.close(r.inW); r.inW = -1; }
  const w = sys.waitpid(r.pid, 0);
  return finish(r, w.status);
}

/** Run CMD; the guest's event loop keeps going (polled from timers) */
export function runChild(sys: GuestSys, cmd: string, opts: ChildOptions = {}): Promise<ChildResult> {
  const r = start(sys, cmd, opts);
  if (typeof r === 'number') return Promise.resolve({ stdout: new Uint8Array(0), stderr: enc.encode(`spawn sh: errno ${-r}\n`), status: 127, signal: null, pid: 0 });
  return new Promise((resolve) => {
    let idle = 0;
    const tick = () => {
      // poll without waiting; back off while nothing happens (0, 1, 2 ... 20 ms)
      const before = r.out.length + r.err.length + r.inOff;
      const done = pump(sys, r, 0);
      idle = r.out.length + r.err.length + r.inOff === before ? Math.min(20, idle + 1) : 0;
      if (!done) { setTimeout(tick, idle); return; }
      if (r.inW >= 0) { sys.close(r.inW); r.inW = -1; }
      const reap = () => {
        const w = sys.waitpid(r.pid, A.WNOHANG);
        if (w.pid === 0) { setTimeout(reap, 2); return; }
        resolve(finish(r, w.status));
      };
      reap();
    };
    tick();
  });
}
