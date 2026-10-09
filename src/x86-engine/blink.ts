/**
 * Page side of the Blink x86-64 engine (jart/blink compiled to WebAssembly,
 * see docs/X86_ENGINES.md and vendor/blink/).
 *
 * A Blink guest is a kernel process (src/kernel): its Worker runs
 * public/engines/blink/host.mjs, which loads blink.mjs/blink.wasm and makes
 * every file and stdio request as a kernel syscall over the SAB channel
 * (docs/KERNEL_ABI.md). Guest threads are emscripten pthreads, so the engine
 * needs SharedArrayBuffer: a cross-origin isolated page, or Node. Callers
 * fall back to src/x86 otherwise.
 *
 * - registerBlinkLoader(kernel): kernel.spawn() of an ELF runs it in Blink.
 * - runElfWithBlink(): the shell's `./binary` path; spawns the process with
 *   the command's stdin and streams its stdout/stderr back.
 */

import type { Shell } from '../shell';
import type { FileSystem } from '../filesystem';
import { Kernel, getKernel, type Runner } from '../kernel/kernel';
import { installNet } from '../kernel/net';
import { workerRunner, webWorker, type GuestWorker } from '../kernel/worker-host';
import { BufferFile, DevNull } from '../kernel/fd';
import { type KStat, S_IFIFO, shellExitCode, SIGKILL, CH_DATA, CH_STATE, CH_SYSNO, CH_ARGS, CH_NARGS, CH_RESULT, CH_SIGNAL, STATE_REQUEST, STATE_REPLY, ESRCH } from '../kernel/abi';
import { createChannelBuffer } from '../kernel/channel';
import type { Process } from '../kernel/process';

export interface BlinkRunOptions {
  fs: FileSystem;
  cwd: string;
  env: Record<string, string>;
  stdin?: string | Uint8Array;
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  /** Kill the guest (SIGKILL); resolves with 128+9. */
  signal?: AbortSignal;
  /** The shell builtins run in when the guest execs them (sh, cat, ...) */
  shell?: Shell;
}

let assetBase: string | null = null;

/** Node's process object when running under Node (vitest), else undefined. */
const nodeProcess = (): any => (globalThis as any).process;

/** Where host.mjs/blink.mjs/blink.wasm are served from (a directory URL). */
export function setBlinkAssetBase(url: string | null): void {
  assetBase = url && !url.endsWith('/') ? url + '/' : url;
}

function isNode(): boolean {
  // Real Node (vitest), even when a DOM shim defines window; the browser's
  // process polyfill has no getBuiltinModule.
  return typeof nodeProcess()?.getBuiltinModule === 'function';
}

/** URL of one of the engine's files (blink.wasm, host.mjs) */
export function blinkAssetUrl(name: string): string {
  return new URL(name, defaultAssetBase()).href;
}

function defaultAssetBase(): string {
  if (assetBase) return assetBase;
  if (isNode()) {
    // vitest/Node: the repo's public/ dir, found from the working directory.
    const p = nodeProcess();
    const nodeFs = p.getBuiltinModule('fs');
    const nodePath = p.getBuiltinModule('path');
    const nodeUrl = p.getBuiltinModule('url');
    const candidates = [p.env?.TABCOMPUTER_BLINK_ASSETS, 'public/engines/blink', '../public/engines/blink'].filter(Boolean);
    for (const c of candidates) {
      const dir = nodePath.resolve(p.cwd(), c);
      if (nodeFs.existsSync(nodePath.join(dir, 'host.mjs'))) return nodeUrl.pathToFileURL(dir).href + '/';
    }
  }
  const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : (globalThis as any).location?.href;
  return new URL('engines/blink/', base || 'http://localhost/').href;
}

/** True when this environment can run the Blink engine at all. */
export function blinkSupported(): boolean {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') return false;
  if (isNode()) return true;
  return typeof Worker !== 'undefined' && (globalThis as any).crossOriginIsolated === true;
}

async function workerFactory(): Promise<() => GuestWorker> {
  const url = defaultAssetBase() + 'host.mjs';
  if (isNode()) {
    const wtName = 'node:worker_threads';
    const wt: any = await import(/* @vite-ignore */ wtName);
    return () => {
      const w = new wt.Worker(new URL(url));
      return {
        postMessage: (m: unknown) => w.postMessage(m),
        terminate: () => w.terminate(),
        onMessage: (cb: (m: unknown) => void) => w.on('message', cb),
        onError: (cb: (e: unknown) => void) => w.on('error', cb),
      };
    };
  }
  return () => webWorker(new Worker(url, { type: 'module', name: 'blink' }));
}

/** Socket syscalls for a kernel nothing gave them to (main.ts does for the page kernel). */
function ensureNet(kernel: Kernel): void {
  const table = (kernel as any).syscallTable as Map<number, unknown> | undefined;
  if (table && !table.has(41 /* SYS_socket */)) installNet(kernel);
}

/**
 * Channels per Blink process for the guest's own syscalls (host.mjs `pool`)
 * at the start and at most (host.mjs asks for more while all are busy), and
 * their data area.
 */
const POOL_CHANNELS = 6;
const POOL_MAX = 64;
const POOL_DATA = 1 << 20;

/**
 * A kernel Runner that executes the ELF at absolute `path` in Blink. With
 * `restore`, the worker instead rebuilds a fork()ed process from its
 * parent's snapshot (Blink patch 0014); `path` is the parent's program.
 */
export function blinkRunner(path: string, restore?: ArrayBuffer): Runner {
  return async (proc: Process, kernel: Kernel) => {
    ensureNet(kernel);
    registerBlinkLoader(kernel); // ELF children of this guest run in Blink too
    const create = await workerFactory();
    const mounts = kernel.fs ? (await kernel.fs.readdir('/')).map((n) => '/' + n) : [];
    const pool = Array.from({ length: POOL_CHANNELS }, () => createChannelBuffer(POOL_DATA));
    const runner = workerRunner((p) => {
      const w = create();
      wireWorker(p, w, kernel, pool);
      return w;
    }, {
      // TABCOMPUTER_BLINK_DEBUG=1: the worker logs kernel syscalls and Blink's own messages to the console
      startData: { path, moduleUrl: defaultAssetBase() + 'blink.mjs', mounts, pool, restore, debug: proc.env?.TABCOMPUTER_BLINK_DEBUG === '1' },
    });
    return runner(proc, kernel);
  };
}

/**
 * Serve one request on a pool channel (blink-sys from host.mjs). `as` names
 * the process the call is for: the guest's vfork child runs on this
 * worker's thread until it execs (Blink patch 0011), 0 = the guest itself.
 */
async function servePoolChannel(kernel: Kernel, proc: Process, sab: SharedArrayBuffer, as: number, busy: Set<SharedArrayBuffer>): Promise<boolean> {
  const i32 = new Int32Array(sab, 0, CH_DATA / 4);
  if (busy.has(sab) || Atomics.load(i32, CH_STATE) !== STATE_REQUEST) return false;
  busy.add(sab);
  try {
    const data = new Uint8Array(sab, CH_DATA);
    const nr = i32[CH_SYSNO];
    const args = Array.from(i32.subarray(CH_ARGS, CH_ARGS + CH_NARGS));
    const target = as ? kernel.procs.get(as) : proc;
    let result = target ? await kernel.syscall(target, nr, args, data) : -ESRCH;
    if (!as && proc.exiting) return false;
    if (result > 0x7fffffff || result < -0x80000000) {
      i32[CH_ARGS] = Math.floor(result / 0x100000000);
      result >>>= 0;
    } else {
      i32[CH_ARGS] = result < 0 ? -1 : 0;
    }
    i32[CH_RESULT] = result | 0;
    if (Atomics.load(i32, CH_SIGNAL) === 0) {
      const sig = as ? (target ? kernel.takeSignal(target) : 0) : kernel.takeSignal(proc);
      if (sig) Atomics.store(i32, CH_SIGNAL, sig);
    }
    Atomics.store(i32, CH_STATE, STATE_REPLY);
    Atomics.notify(i32, CH_STATE);
    return true;
  } finally {
    busy.delete(sab);
  }
}

/**
 * Readiness pings and signals between the kernel and a Blink worker. The
 * worker asks to watch the kernel fds it polls (stdin, sockets); each
 * readiness change posts one coalesced `blink-ready`, so a guest parked in
 * poll()/epoll wakes at once. Signals the kernel delivers to the process
 * (the worker installs handlers for them) are posted as `blink-signal`.
 */
function wireWorker(proc: Process, w: GuestWorker, kernel: Kernel, pool: SharedArrayBuffer[]): void {
  const busy = new Set<SharedArrayBuffer>();
  // Same-instance fork children (Blink): kernel processes this worker runs
  // too. The worker outlives its own process until the last of them ends.
  const hosted = new Set<number>();
  const terminate = w.terminate.bind(w);
  let ownGone = false;
  w.terminate = () => {
    ownGone = true;
    if (!hosted.size) return terminate();
  };
  const subs = new Map<number, () => void>();
  const pending = new Set<number>();
  const ping = (fd: number) => {
    if (pending.has(fd)) return;
    pending.add(fd);
    queueMicrotask(() => {
      pending.delete(fd);
      w.postMessage({ type: 'blink-ready', fd });
    });
  };
  const watch = (fd: number) => {
    subs.get(fd)?.();
    const off = proc.fds.get(fd)?.onReady(() => ping(fd));
    if (off) subs.set(fd, off);
  };
  watch(0);
  w.onMessage((m: any) => {
    if (m?.type === 'blink-sys') {
      const sab = pool[m.ch];
      if (sab) void servePoolChannel(kernel, proc, sab, m.as | 0, busy).then((ok) => { if (ok) w.postMessage({ type: 'blink-done', ch: m.ch }); });
    } else if (m?.type === 'blink-grow') {
      // every channel is busy (blocked calls): one more, shared by this
      // process's workers like the rest (indices match host.mjs's order)
      const sab = pool.length < POOL_MAX ? createChannelBuffer(POOL_DATA) : null;
      if (sab) pool.push(sab);
      w.postMessage({ type: 'blink-channel', sab });
    } else if (m?.type === 'blink-fork') {
      // fork(): the child (made by SYS_shiro_vfork) runs the snapshot in its own worker
      const child = kernel.procs.get(m.pid);
      if (child) kernel.startForkChild(proc, m.pid, blinkRunner(child.path, m.snapshot));
    } else if (m?.type === 'blink-hosted') {
      const child = kernel.procs.get(m.pid);
      if (!child || hosted.has(m.pid)) return;
      hosted.add(m.pid);
      const off = child.addSignalListener((sig: number) => { if (sig > 0) w.postMessage({ type: 'blink-signal', sig, pid: m.pid }); });
      child.onTerminate(() => {
        off();
        hosted.delete(m.pid);
        w.postMessage({ type: 'blink-reap', pid: m.pid });
        if (ownGone && !hosted.size) terminate();
      });
    } else if (m?.type === 'blink-abort') {
      kernel.reportFatal(proc, `blink ${String(m.text)}`);
    } else if (m?.type === 'blink-watch') watch(m.fd);
    else if (m?.type === 'blink-unwatch') { subs.get(m.fd)?.(); subs.delete(m.fd); }
  });
  const unlisten = proc.addSignalListener((sig: number) => { if (sig > 0) w.postMessage({ type: 'blink-signal', sig }); });
  proc.onTerminate(() => { unlisten(); for (const off of subs.values()) off(); subs.clear(); });
}

/** True when the file at `path` starts with the ELF magic. */
async function isElf(fs: FileSystem, path: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path);
    return typeof raw !== 'string' && raw.length >= 4 && raw[0] === 0x7f && raw[1] === 0x45 && raw[2] === 0x4c && raw[3] === 0x46;
  } catch {
    return false;
  }
}

/** Run x86-64 ELF binaries that kernel.spawn() is asked to start in Blink. */
export function registerBlinkLoader(kernel: Kernel): void {
  kernel.addLoader(async (path, proc, k) => {
    if (!blinkSupported() || !k.fs) return null;
    let resolved: string | null = path;
    if (!path.includes('/')) resolved = (await k.shell?.findExecutableInPath(path)) ?? null;
    else if (!path.startsWith('/')) resolved = k.fs.resolvePath(path, proc.cwd);
    if (!resolved || !(await isElf(k.fs, resolved))) return null;
    return blinkRunner(resolved);
  });
}

const kernels = new WeakMap<FileSystem, Kernel>();

/** The page kernel when it serves `fs` (attaching it if nothing has), else a private one. */
function kernelFor(fs: FileSystem, shell?: Shell): Kernel {
  const k = getKernel();
  if (!k.fs) k.attach(fs);
  let own = k.fs === fs ? k : kernels.get(fs);
  if (!own) {
    own = new Kernel({ fs, registerWithProcessTable: false });
    kernels.set(fs, own);
  }
  // Without a shell the kernel can't run the builtins a guest execs (/bin/sh)
  if (!own.shell && shell) own.shell = shell;
  return own;
}

/** Writes go to a callback (a shell command's stdout/stderr); reads are EOF. */
class OutputSink extends DevNull {
  constructor(private sink: (data: Uint8Array) => void) { super(1); }
  async write(buf: Uint8Array): Promise<number> {
    this.sink(buf.slice());
    return buf.length;
  }
  // A pipe to the shell, not /dev/null: programs compare their stdout with
  // /dev/null (GNU grep then prints nothing)
  async stat(): Promise<KStat> {
    const now = Date.now();
    return { dev: 2, ino: 0, mode: S_IFIFO | 0o600, nlink: 1, uid: 1000, gid: 1000, rdev: 0, size: 0, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now };
  }
}

/**
 * Run an x86-64 Linux ELF in Blink as a kernel process. `path` is the Shiro
 * path of the binary (the guest sees the Shiro filesystem, so it loads from
 * there). Resolves with the shell exit code.
 */
export async function runElfWithBlink(path: string, args: string[], opts: BlinkRunOptions, argv0 = path): Promise<number> {
  const kernel = kernelFor(opts.fs, opts.shell);
  const decoder = (write: (s: string) => void) => {
    const d = new TextDecoder();
    return (bytes: Uint8Array) => { const s = d.decode(bytes, { stream: true }); if (s) write(s); };
  };
  const proc = kernel.spawn({
    path,
    argv: [argv0, ...args],
    env: opts.env,
    cwd: opts.cwd,
    fds: {
      0: new BufferFile(opts.stdin ?? '', 0),
      1: new OutputSink(decoder(opts.writeStdout)),
      2: new OutputSink(decoder(opts.writeStderr)),
    },
    run: blinkRunner(path),
  });
  const onAbort = () => kernel.kill(proc.pid, SIGKILL);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const status = await proc.wait();
    await kernel.waitpid(proc.pid, 0).catch(() => undefined);
    return shellExitCode(status);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
