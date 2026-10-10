/**
 * node as a kernel guest (by default; TABCOMPUTER_NODE_WORKER=0 opts out): this runs in a
 * Worker. It turns the kernel's start message into the CommandContext
 * node-compat expects (files through SyscallFs, children through real
 * processes, fds 0/1/2 for stdio and the terminal), runs the `node`
 * command with argv, writes what it printed and exits with its status.
 */
import * as A from '../kernel/abi';
import { connectGuest, isStartMessage, ChannelClosed, type GuestStartMessage, type GuestSys } from '../kernel/channel';
import { decodeTermios, encodeTermios, decodeWinsize, makeRaw, TCSETS, TERMIOS_SIZE, WINSIZE_SIZE } from '../kernel/pty';
import { SyscallFs } from './sys-fs';
import { setShiroOrigin } from '../utils/shiro-origin';
import { runChild, runChildSync } from './child';
import { GuestNetStack, installGuestPorts } from './net';
import { GuestTtyStdin } from './tty';
import type { GuestIpc, NodeGuestHooks, ThreadEvents } from './hooks';

const dec = new TextDecoder();

/** ioctl(fd, req) with `arg` in and out of the data area; the result, or -errno */
function ioctl(sys: GuestSys, fd: number, req: number, arg: Uint8Array): number {
  sys.ch.data.set(arg);
  const r = sys.ch.call(A.SYS_ioctl, fd, req, arg.length);
  if (r >= 0) arg.set(sys.ch.data.subarray(0, arg.length));
  return r;
}

const isatty = (sys: GuestSys, fd: number) => ioctl(sys, fd, A.TCGETS, new Uint8Array(TERMIOS_SIZE)) >= 0;

/** node-compat's view of the terminal, over fds 0 and 1 and their pty */
function terminalFacade(sys: GuestSys, stdinTTY: boolean) {
  let saved: Uint8Array | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const buf = new Uint8Array(4096);
  return {
    tty: true,
    // node-compat writes a terminal's newlines as \r\n; the pty's line discipline (ONLCR) does that here
    writeOutput: (s: string) => { sys.write(1, s.replace(/\r\n/g, '\n')); },
    getSize: () => {
      const w = new Uint8Array(WINSIZE_SIZE);
      if (ioctl(sys, 1, A.TIOCGWINSZ, w) < 0) return { cols: 80, rows: 24 };
      const ws = decodeWinsize(w);
      return { cols: ws.cols || 80, rows: ws.rows || 24 };
    },
    onResize: (_cb: (cols: number, rows: number) => void) => () => {},
    /** Raw keys from fd 0 to `onData` (polled: the worker can't block while the program's event loop runs) */
    enterStdinPassthrough: (onData: (d: string) => void, _onForceExit?: () => void) => {
      if (!stdinTTY || timer) return;
      const t = new Uint8Array(TERMIOS_SIZE);
      if (ioctl(sys, 0, A.TCGETS, t) >= 0) {
        saved = t.slice();
        ioctl(sys, 0, TCSETS, encodeTermios(makeRaw(decodeTermios(t))));
      }
      let idle = 0;
      const tick = () => {
        timer = null;
        const { ready } = sys.poll([{ fd: 0, events: A.POLLIN }], 0);
        if (ready > 0) {
          const n = sys.read(0, buf);
          if (n > 0) { idle = 0; onData(dec.decode(buf.subarray(0, n))); }
        } else idle = Math.min(16, idle + 1);
        timer = setTimeout(tick, idle);
      };
      timer = setTimeout(tick, 0);
    },
    exitStdinPassthrough: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (saved) { ioctl(sys, 0, TCSETS, saved); saved = null; }
    },
  };
}

/** Run node for one start message; exits the process (does not return normally). */
export async function runNodeGuest(start: GuestStartMessage, post: (m: unknown) => void): Promise<void> {
  const sys = connectGuest(start, post);
  const prof = start.env.TABCOMPUTER_NODE_SYSPROF ? sysProfile(sys) : null;
  // (a pooled worker runs one guest after another: nothing of the last one's carries over)
  exitRequested = false;
  fsEvents = null;
  parentMessages = null;
  earlyMessages.length = 0;
  threadEvents.clear();
  setShiroOrigin((start as any).pageOrigin ?? null); // (ANTHROPIC_BASE_URL and the like: the page's origin, not the Worker's)
  try {
    const fs = new SyscallFs(sys);
    // fs.watch: the page sends its filesystem's changes once asked (host.ts)
    fs.requestChanges = () => post({ type: 'node-guest-watch' });
    fsEvents = (m) => fs.changed(m.event, m.path, m.newPath);
    const stdinTTY = isatty(sys, 0);
    const stdoutTTY = isatty(sys, 1);
    // Networking over socket syscalls; servers listen on kernel ports (the page previews them)
    const net = new GuestNetStack(sys);
    const { iframeServer } = await import('../iframe-server');
    installGuestPorts(iframeServer as any, net, (port) => { if (stdoutTTY) post({ type: 'node-guest-listen', port }); });
    rejection = null;
    installWorkerHandlers();
    // A worker_threads thread of a node process (host.ts started it with attachThread)
    const nodeThread = (start as any).nodeThread as { file: string; eval?: boolean; workerData?: unknown; argv?: string[]; threadId: number } | undefined;
    const hooks: NodeGuestHooks = {
      readText(path) {
        const b = fs.readRaw(path);
        if (typeof b === 'number') return undefined;
        try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return undefined; }
      },
      // a child may change the tree: fs forgets the directories it knew
      runChildSync: (cmd, opts) => { try { return runChildSync(sys, cmd, opts); } finally { fs.invalidate(); } },
      runChild: (cmd, opts) => runChild(sys, cmd, opts).finally(() => fs.invalidate()),
      writeOut: (fd, s) => { sys.write(fd, s); },
      netStack: net,
      busy: () => net.busy,
      ids: { pid: sys.getpid(), ppid: sys.getppid() },
      kill: (pid, sig) => sys.kill(pid, sig),
      ...(ipcFd(sys, start.env) >= 0 ? { ipc: guestIpc(sys, ipcFd(sys, start.env)) } : {}),
      onUnhandledRejection: (fn) => { rejection = fn; },
      page: {
        clipboard: (text) => post({ type: 'node-guest-clipboard', text }),
        preview: (port) => { if (stdoutTTY) post({ type: 'node-guest-listen', port }); },
      },
      ...(stdinTTY ? { ttyStdin: (on: ConstructorParameters<typeof GuestTtyStdin>[1]) => new GuestTtyStdin(sys, on) } : {}),
      // worker_threads: a thread of this process, a guest of its own; messages go by way of the page
      startThread(file, opts, events) {
        const id = ++lastThread;
        threadEvents.set(id, events);
        post({ type: 'node-guest-thread', id, file, eval: !!opts.eval, workerData: opts.workerData, argv: opts.argv ?? [], env: opts.env, threadId: opts.threadId });
        return {
          post: (value) => post({ type: 'node-guest-thread-post', id, value }),
          terminate: () => post({ type: 'node-guest-thread-kill', id }),
        };
      },
      ...(nodeThread ? {
        thread: {
          threadId: nodeThread.threadId,
          workerData: nodeThread.workerData,
          post: (value: unknown) => post({ type: 'node-thread-out', kind: 'message', value }),
          onMessage: (fn: (value: unknown) => void) => {
            parentMessages = fn;
            for (const v of earlyMessages.splice(0)) fn(v);
          },
        },
      } : {}),
    };
    const env = { ...start.env };
    // (node takes its channel's variables out of process.env: its own children aren't forked)
    if (hooks.ipc) { delete env.NODE_CHANNEL_FD; delete env.NODE_CHANNEL_SERIALIZATION_MODE; }
    const shell: any = { cwd: start.cwd, env, abortController: null, fork() { throw new Error('no shell in a node guest'); } };
    const ctx: any = {
      args: nodeThread ? (nodeThread.eval ? ['-e', nodeThread.file] : [nodeThread.file, ...(nodeThread.argv ?? [])]) : start.argv.slice(1),
      fs,
      cwd: start.cwd,
      env,
      stdin: '',
      stdout: '',
      stderr: '',
      shell,
      stdoutIsTTY: stdoutTTY,
      stdinIsTTY: stdinTTY,
      terminal: stdoutTTY ? terminalFacade(sys, stdinTTY) : undefined,
      // Not a terminal: fds 1 and 2 take what's written as written (bytes stay bytes: esbuild's protocol)
      ...(stdoutTTY ? {} : { stdoutBytes: (b: Uint8Array) => { sys.write(1, b); }, stderrBytes: (b: Uint8Array) => { sys.write(2, b); } }),
      nodeGuest: hooks,
    };
    // stdin: read when the program asks for it (a pipe until its end); a thread's is the main thread's
    if (!stdinTTY && !nodeThread) {
      ctx.readStdin = async () => {
        const r = sys.readAll(0);
        return typeof r === 'number' ? '' : dec.decode(r);
      };
      // `node < script.js` / `cat x.js | node`: the program comes from stdin
      const code = start.argv.slice(1).some((a) => !a.startsWith('-') || a === '-e' || a === '--eval' || a === '-p' || a === '--print');
      if (!code) ctx.stdin = await ctx.readStdin();
      // else bytes as they arrive (a parent that talks to this node while it runs: esbuild's service)
      else ctx.stdinStream = pipeStdin(sys);
    }
    const { runNode } = await import('../commands/jseval/node-run');
    let status: number;
    try {
      status = await runNode(ctx);
    } catch (e: any) {
      if (e instanceof ChannelClosed) throw e;
      ctx.stderr += `node: ${e?.stack ?? e}\n`;
      status = 1;
    }
    if (ctx.stdout) sys.write(1, ctx.stdout);
    if (nodeThread) {
      // A thread's uncaught error is its Worker's 'error' event; its exit ends only the thread
      if (status !== 0 && ctx.stderr) post({ type: 'node-thread-out', kind: 'error', value: { message: ctx.stderr.trim() } });
      else if (ctx.stderr) sys.write(2, ctx.stderr);
      post({ type: 'node-thread-out', kind: 'exit', value: status }); // after its messages (the kernel's exit can overtake them)
      sys.exitThread(status);
    }
    if (ctx.stderr) sys.write(2, ctx.stderr);
    if (prof) sys.write(2, prof());
    exitRequested = true; // a clean end: the worker can run another guest (host.ts's pool)
    // Said in the channel's memory, which the page reads when the process ends (a message would come too late)
    if (!nodeThread) { const w = new Int32Array(sys.ch.sab); Atomics.store(w, w.length - 1, EXITING_MARK); }
    sys.exit(status);
  } catch (e) {
    if (e instanceof ChannelClosed) return; // killed: the kernel is done with us
    try { sys.write(2, `node: ${(e as any)?.stack ?? e}\n`); sys.exit(1); } catch { /* channel gone */ }
  }
}

const workerTimeout = globalThis.setTimeout.bind(globalThis);

/** NODE_CHANNEL_FD, when it names an open fd (a forked node's channel) */
function ipcFd(sys: GuestSys, env: Record<string, string>): number {
  const fd = /^\d+$/.test(env.NODE_CHANNEL_FD ?? '') ? Number(env.NODE_CHANNEL_FD) : -1;
  return fd >= 0 && sys.fcntl(fd, A.F_GETFD, 0) >= 0 ? fd : -1;
}

/** A forked node's channel to its parent (hooks.ts GuestIpc), read from the Worker's timers */
function guestIpc(sys: GuestSys, fd: number): GuestIpc {
  const enc = new TextEncoder();
  let open = true;
  sys.fcntl(fd, A.F_SETFD, A.FD_CLOEXEC); // (not its children's)
  const close = () => { if (open) { open = false; sys.close(fd); } };
  return {
    send(text) {
      if (!open) return false;
      let b = enc.encode(text);
      while (b.length) {
        const n = sys.write(fd, b);
        if (n === -A.EINTR || n === -A.EAGAIN) continue;
        if (n <= 0) { close(); return false; }
        b = b.subarray(n);
      }
      return true;
    },
    onData(fn) {
      const buf = new Uint8Array(65536);
      let idle = 0;
      const tick = () => {
        if (!open) return;
        const { ready } = sys.poll([{ fd, events: A.POLLIN }], 0);
        if (ready > 0) {
          const n = sys.read(fd, buf);
          if (n > 0) { idle = 0; fn(buf.slice(0, n)); }
          else if (n !== -A.EAGAIN && n !== -A.EINTR) { close(); fn(null); return; }
        } else idle = Math.min(20, idle + 1);
        workerTimeout(tick, idle);
      };
      tick();
    },
    close,
  };
}

/** fd 0 (a pipe or a file) as node-compat's live stdin: read when poll says so, from timers */
function pipeStdin(sys: GuestSys): { read(): Promise<Uint8Array | null> } {
  const buf = new Uint8Array(65536);
  return {
    read: () => new Promise((resolve) => {
      let idle = 0;
      const tick = () => {
        const { ready } = sys.poll([{ fd: 0, events: A.POLLIN }], 0);
        if (ready > 0) {
          const n = sys.read(0, buf);
          if (n !== -A.EAGAIN && n !== -A.EINTR) { resolve(n > 0 ? buf.slice(0, n) : null); return; }
        }
        // nothing yet: back off (0, 1, 2 ... 20 ms; the Worker's timer, not the program's)
        idle = Math.min(20, idle + 1);
        workerTimeout(tick, idle);
      };
      tick();
    }),
  };
}

/**
 * TABCOMPUTER_NODE_SYSPROF=1: time every syscall; the returned function is the
 * table node prints to stderr at its end (where a guest's time went: blocked in
 * the kernel, by syscall, against the rest: its own JS and its event loop's waits).
 */
function sysProfile(sys: GuestSys): () => string {
  const names = new Map<number, string>();
  for (const [k, v] of Object.entries(A)) if (k.startsWith('SYS_') && typeof v === 'number' && !names.has(v)) names.set(v, k.slice(4));
  const by = new Map<number, { n: number; ms: number }>();
  const call = sys.ch.call.bind(sys.ch);
  const t0 = performance.now();
  sys.ch.call = (nr: number, ...args: number[]) => {
    const t = performance.now();
    try { return call(nr, ...args); } finally {
      const e = by.get(nr) ?? { n: 0, ms: 0 };
      e.n++; e.ms += performance.now() - t;
      by.set(nr, e);
    }
  };
  return () => {
    const wall = performance.now() - t0;
    const rows = [...by].sort((a, b) => b[1].ms - a[1].ms);
    const inSys = rows.reduce((s, [, e]) => s + e.ms, 0);
    const n = rows.reduce((s, [, e]) => s + e.n, 0);
    const f = (ms: number) => ms.toFixed(1).padStart(9);
    let out = `\n[sysprof] ${wall.toFixed(0)} ms: ${inSys.toFixed(0)} ms in ${n} syscalls, ${(wall - inSys).toFixed(0)} ms elsewhere\n`;
    for (const [nr, e] of rows.slice(0, 20)) out += `[sysprof] ${(names.get(nr) ?? String(nr)).padEnd(16)}${String(e.n).padStart(7)}${f(e.ms)} ms${f((e.ms * 1000) / e.n)} us/call\n`;
    return out;
  };
}

/** In the last word of the channel's buffer before exit_group: this guest ends itself (host.ts) */
export const EXITING_MARK = 0x45584954;

/** The guest ended itself (exit_group), so this worker may run another */
let exitRequested = false;
/** Who hears unhandled rejections now (node-compat's handler for the running guest) */
let rejection: ((reason: unknown, promise: Promise<unknown>) => void) | null = null;
let handlersInstalled = false;

/**
 * The worker's own handlers, once: unhandled rejections go to the running
 * guest's node-compat, and a ChannelClosed from a finished guest's leftover
 * callbacks (its channel is gone) is not an error of the next one.
 */
function installWorkerHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const g: any = globalThis;
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('unhandledrejection', (e: any) => {
      if (e.reason instanceof ChannelClosed) { e.preventDefault(); return; }
      if (rejection) { e.preventDefault(); rejection(e.reason, e.promise); }
    });
    g.addEventListener('error', (e: any) => { if (e.error instanceof ChannelClosed) e.preventDefault(); });
  } else if (typeof g.process?.on === 'function' && g.process.versions?.node) {
    g.process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
      if (reason instanceof ChannelClosed) return;
      rejection?.(reason, promise);
    });
    // (a finished guest's timer calling into its closed channel; anything else still ends the worker)
    g.process.on('uncaughtException', (e: unknown) => { if (!(e instanceof ChannelClosed)) throw e; });
  }
}

/** Where the page's filesystem changes go (the running guest's SyscallFs) */
let fsEvents: ((m: { event: string; path: string; newPath?: string }) => void) | null = null;
/** worker_threads: this guest's threads' events by id, and (in a thread) its parent's messages */
let lastThread = 0;
const threadEvents = new Map<number, ThreadEvents>();
let parentMessages: ((value: unknown) => void) | null = null;
/** The parent's messages that came before the thread's script was listening */
const earlyMessages: unknown[] = [];

/** The worker's message handler: the first start message runs node; then filesystem changes */
export function nodeGuestMain(on: (handler: (m: unknown) => void) => void, post: (m: unknown) => void): void {
  let started = false;
  /** The next guest's start, come while this one finishes its exit (host.ts lends the worker then) */
  let queued: GuestStartMessage | null = null;
  const start = (m: GuestStartMessage) => {
    started = true;
    // After a clean exit the worker takes another start message (host.ts pools it); a thread doesn't
    void runNodeGuest(m, post).then(() => {
      if (!exitRequested || (m as any).nodeThread) return;
      started = false;
      const next = queued;
      queued = null;
      if (next) start(next); else post({ type: 'node-guest-idle' });
    });
  };
  on((m) => {
    const t = (m as any)?.type;
    if (started && t === 'node-guest-fs') { fsEvents?.(m as any); return; }
    if (started && t === 'node-guest-parent-msg') { if (parentMessages) parentMessages((m as any).value); else earlyMessages.push((m as any).value); return; }
    if (started && t === 'node-guest-thread-ev') {
      const { id, kind, value } = m as any;
      const ev = threadEvents.get(id);
      if (!ev) return;
      if (kind === 'exit') threadEvents.delete(id);
      (ev as any)[kind]?.(value);
      return;
    }
    if (!isStartMessage(m)) return;
    if (started) { queued = m; return; }
    start(m);
  });
}
