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
import { type KStat, S_IFIFO, shellExitCode, SIGKILL, CH_DATA, CH_STATE, CH_SYSNO, CH_ARGS, CH_NARGS, CH_RESULT, CH_SIGNAL, STATE_REQUEST, STATE_REPLY, STATE_DEAD, ESRCH } from '../kernel/abi';
import { createChannelBuffer, KernelChannel, canWatch as canWatchChannels } from '../kernel/channel';
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

/**
 * URL of blink.wasm: its content-hashed copy from engines/manifest.json when
 * the build has one (cached for good: a new build is a new URL), else the
 * plain name. Looked up once per page.
 */
let wasmUrl: Promise<string | undefined> | null = null;
let wasmModule: Promise<WebAssembly.Module | undefined> | null = null;
function blinkWasmUrl(): Promise<string | undefined> {
  if (isNode()) return Promise.resolve(undefined);
  return (wasmUrl ??= (async () => {
    try {
      const r = await fetch(new URL('../manifest.json', defaultAssetBase()).href, { cache: 'no-cache' });
      const hashed = r.ok ? (await r.json())['blink/blink.wasm'] : undefined;
      return typeof hashed === 'string' ? new URL('../' + hashed, defaultAssetBase()).href : undefined;
    } catch {
      return undefined;
    }
  })());
}

/**
 * blink.wasm compiled once for the page and handed to every Blink worker.
 * Holding the Module keeps V8's optimized code: without it, each time the
 * last Blink worker ended the code went too, and the next process compiled
 * blink.wasm again and started on Liftoff's (go_hello 163 -> 235 ms in
 * Chromium once workers ended promptly, Blink patch 0053).
 */
function blinkWasmModule(url: string | undefined): Promise<WebAssembly.Module | undefined> {
  return (wasmModule ??= (async () => {
    try {
      if (isNode()) {
        const p = nodeProcess();
        const file = p.getBuiltinModule('url').fileURLToPath(defaultAssetBase() + 'blink.wasm');
        return await WebAssembly.compile(p.getBuiltinModule('fs').readFileSync(file));
      }
      const r = await fetch(url ?? defaultAssetBase() + 'blink.wasm');
      if (!r.ok) return undefined;
      return await WebAssembly.compile(await r.arrayBuffer());
    } catch {
      return undefined;
    }
  })());
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
 * After a pool channel's data area: the kernel pid the request is for (host.mjs
 * `as`), so a watched channel needs no message (blink-sys's `as`).
 */
const POOL_AS_BYTES = 4;
const poolBuffer = () => createChannelBuffer(POOL_DATA + POOL_AS_BYTES);

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
    const pool = Array.from({ length: POOL_CHANNELS }, poolBuffer);
    const wasm = await blinkWasmUrl();
    const wasmModule = proc.env?.TABCOMPUTER_BLINK_SHARED_MODULE === '0' ? undefined : await blinkWasmModule(wasm);
    const runner = workerRunner((p) => {
      const w = create();
      wireWorker(p, w, kernel, pool);
      return w;
    }, {
      // TABCOMPUTER_BLINK_DEBUG=1: the worker logs kernel syscalls and Blink's own messages to the console
      // poolWake 'atomics': the page watches the pool channels' state words, so
      // host.mjs posts no blink-sys and waits for no blink-done (as WASI guests)
      startData: {
        path, moduleUrl: defaultAssetBase() + 'blink.mjs', wasmUrl: wasm, wasmModule, mounts, pool, poolAsBytes: POOL_AS_BYTES,
        // Opt-in (TABCOMPUTER_BLINK_POOL_WAKE=atomics): no measurable gain on
        // bash/dpkg in a 6-round A/B (docs/BENCHMARKS.md, perf-kernel round 10)
        poolWake: canWatchChannels() && proc.env?.TABCOMPUTER_BLINK_POOL_WAKE === 'atomics' ? 'atomics' : 'message',
        restore, debug: proc.env?.TABCOMPUTER_BLINK_DEBUG === '1',
      },
    });
    return runner(proc, kernel);
  };
}

/**
 * Blink's compiled code (its wasm JIT) as WebAssembly.Modules, kept for the
 * page: V8 caches a module by its bytes while one is alive, and Blink
 * generates the same bytes for the same code, so the next process running
 * the same program (or library code it shares) gets its modules without
 * compiling them. A Blink process is its own worker, so without this its
 * modules die with it. Least recently compiled go first past
 * keepBudget() bytes of modules (TABCOMPUTER_BLINK_WJ_KEEP=0: none), and
 * all go when the page has been hidden for a while. In Chromium a module
 * costs ~5.7x its bytes in renderer memory (its compiled code): vim's
 * startup leaves 320 modules, 2.4 MiB of bytes, +13.6 MiB RSS, and its next
 * start takes 0.81 s instead of 1.24 s (docs/BENCHMARKS.md).
 */
const MIB = 1 << 20;
const WJ_HIDDEN_DROP_MS = 5 * 60_000;
let keepBudgetBytes = 0;
/** 6 MiB of module bytes with 8 GB of memory or more, 2 MiB with 4 GB or less (or on a phone or tablet), else 4 MiB */
function keepBudget(): number {
  if (keepBudgetBytes) return keepBudgetBytes;
  const nav = (globalThis as { navigator?: { deviceMemory?: number; userAgent?: string } }).navigator;
  const mem = nav?.deviceMemory;
  const mobile = /Mobi|Android|iPad|iPhone|Tablet/i.test(nav?.userAgent ?? '');
  keepBudgetBytes = mobile || (mem !== undefined && mem <= 4) ? 2 * MIB : mem !== undefined && mem >= 8 ? 6 * MIB : 4 * MIB;
  // a page hidden for a while lets them go (the next launch compiles again)
  const doc = (globalThis as { document?: Document }).document;
  if (doc?.addEventListener) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    doc.addEventListener('visibilitychange', () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (doc.visibilityState === 'hidden') timer = setTimeout(() => { keptModules.clear(); keptBytes = 0; }, WJ_HIDDEN_DROP_MS);
    });
  }
  return keepBudgetBytes;
}
const keptModules = new Map<string, { module: unknown; size: number }>();
let keptBytes = 0;
/** (tests) how many compiled modules the page keeps, and their bytes */
export function keptCompiledModules(): { count: number; bytes: number } {
  return { count: keptModules.size, bytes: keptBytes };
}
function keepCompiledModule(key: unknown, module: unknown, size: number): void {
  const budget = keepBudget();
  if (typeof key !== 'string' || !module || size <= 0 || size > budget / 4) return;
  const old = keptModules.get(key);
  if (old) { keptModules.delete(key); keptBytes -= old.size; }
  keptModules.set(key, { module, size });
  keptBytes += size;
  for (const [k, v] of keptModules) {
    if (keptBytes <= budget) break;
    keptModules.delete(k);
    keptBytes -= v.size;
  }
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
    const data = new Uint8Array(sab, CH_DATA, sab.byteLength - CH_DATA - POOL_AS_BYTES);
    const nr = i32[CH_SYSNO];
    const args = Array.from(i32.subarray(CH_ARGS, CH_ARGS + CH_NARGS));
    const target = as ? kernel.procs.get(as) : proc;
    // A call the kernel can answer from memory (stat, fstat, getpid, pipe and
    // file I/O that needn't wait) skips the async path, as WASI guests' do
    const fast = target ? kernel.syscallSync(target, nr, args, data) : undefined;
    let result = fast !== undefined ? fast : target ? await kernel.syscall(target, nr, args, data) : -ESRCH;
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
 * (Exported for tests.)
 */
export function wireWorker(proc: Process, w: GuestWorker, kernel: Kernel, pool: SharedArrayBuffer[]): void {
  const busy = new Set<SharedArrayBuffer>();
  const direct: KernelChannel[] = [];
  // a blink-kick that found no call of this process in the kernel
  let kickPending = false;
  // Same-instance fork children (Blink): kernel processes this worker runs
  // too. The worker outlives its own process until the last of them ends.
  const hosted = new Set<number>();
  // Direct channels' views keep Blink's whole wasm memory alive: let go of
  // them when this worker ends (an exec's new worker brings its own) or the process does
  const stopDirect = () => { for (const ch of direct) ch.stop(); direct.length = 0; };
  // Pool channels watched by their state words (start data poolWake 'atomics'):
  // a request is served when host.mjs sets it, with no message either way
  const watching = new Set<SharedArrayBuffer>();
  let watchStopped = false;
  const watchPool = (sab: SharedArrayBuffer) => {
    if (watchStopped || watching.has(sab) || !canWatchChannels() || proc.env?.TABCOMPUTER_BLINK_POOL_WAKE !== 'atomics') return;
    watching.add(sab);
    void (async () => {
      const i32 = new Int32Array(sab, 0, CH_DATA / 4);
      const asWord = new Int32Array(sab, sab.byteLength - POOL_AS_BYTES, 1);
      const waitAsync = (Atomics as any).waitAsync as (a: Int32Array, i: number, v: number) => { async: boolean; value: any };
      while (!watchStopped) {
        const s = Atomics.load(i32, CH_STATE);
        if (s === STATE_DEAD) break;
        // (as -1: host.mjs asked with a blink-sys message instead)
        if (s === STATE_REQUEST && !busy.has(sab) && asWord[0] !== -1) {
          const answered = await servePoolChannel(kernel, proc, sab, asWord[0], busy);
          // A request left unanswered (its process is exiting) is served once,
          // as a blink-sys message was: wait for the state to move on. (After
          // an answer, REQUEST again is host.mjs's next call: serve it.)
          if (!answered && Atomics.load(i32, CH_STATE) === STATE_REQUEST) {
            const w = waitAsync(i32, CH_STATE, STATE_REQUEST);
            if (w.async) await w.value;
          }
          continue;
        }
        const w = waitAsync(i32, CH_STATE, s);
        if (w.async) await w.value;
      }
      watching.delete(sab);
    })();
  };
  // The watchers' pending waits hold the channels: wake them to end
  const stopPool = () => {
    watchStopped = true;
    for (const sab of watching) {
      const i32 = new Int32Array(sab, 0, CH_DATA / 4);
      Atomics.store(i32, CH_STATE, STATE_DEAD);
      Atomics.notify(i32, CH_STATE);
    }
  };
  for (const sab of pool) watchPool(sab);
  // Shared objects (docs/research/SHARED_MAPPINGS.md): this worker is one
  // engine instance; the kernel's blink-shmobj / blink-publish go to it
  const instance = kernel.registerEngineInstance((m) => w.postMessage(m));
  proc.data.engineInstance = instance;
  const end = w.terminate.bind(w);
  // Fork children this engine never got to start (it aborted mid-fork, or
  // between vfork and exec) can't run any more; they would hold the parent's
  // fds open for good (apt waited forever on dpkg's --status-fd pipe), so they
  // die as killed. A blink-fork already queued is handled first.
  const sweep = () => setTimeout(() => {
    for (const c of kernel.procs.values()) {
      if (c.data.embryo && c.data.forkParent === proc.pid && !c.exiting) void kernel.exit(c, SIGKILL);
    }
  }, 1000);
  const terminate = () => { stopDirect(); stopPool(); void kernel.engineInstanceGone(instance); end(); sweep(); };
  // The engine crashed (an abort or a wasm trap ends the whole instance): the
  // children it hosted died with it.
  let crashed = false;
  const crash = () => {
    if (crashed) return;
    crashed = true;
    for (const pid of [...hosted]) {
      const c = kernel.procs.get(pid);
      if (c && !c.exiting) void kernel.exit(c, SIGKILL);
    }
    sweep();
  };
  w.onError(() => crash());
  let ownGone = false;
  // The guest exited on its own (blink-exiting): its exit_group reaches the
  // kernel at once, while Blink's other threads are still on their way out.
  // Chromium takes seconds to terminate a Worker whose threads are parked in
  // a wait, so the termination waits for blink-quiet (up to 0.5 s).
  let exiting = false, quiet = false, quietTimer: ReturnType<typeof setTimeout> | undefined;
  const terminateWhenQuiet = () => {
    if (!exiting || quiet) return terminate();
    quietTimer ??= setTimeout(() => { quiet = true; terminate(); }, 500);
  };
  w.terminate = () => {
    ownGone = true;
    if (!hosted.size) return terminateWhenQuiet();
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
      if (sab) {
        const served = servePoolChannel(kernel, proc, sab, m.as | 0, busy);
        // a kick that came first ends the call once it waits (twice: the
        // kernel may await before it starts waiting); an extra EINTR is
        // only a call again for Blink
        if (kickPending) {
          kickPending = false;
          const kick = () => { if (busy.has(sab)) proc.interruptSyscalls(); };
          setTimeout(kick, 0);
          setTimeout(kick, 5);
        }
        void served.then((ok) => { if (ok) w.postMessage({ type: 'blink-done', ch: m.ch }); });
      }
    } else if (m?.type === 'blink-direct') {
      // Channels in Blink's wasm memory that its threads use themselves
      // (Blink patch 0065): served here by watching their state words, with
      // no message through host.mjs either way
      if (!canWatchChannels()) return;
      for (let i = 0; i < m.n; i++) {
        const ch = new KernelChannel(m.buffer, kernel, proc, { offset: m.base + i * m.stride, size: m.size, listen: false });
        direct.push(ch);
        void ch.watch();
      }
    } else if (m?.type === 'blink-wjmod') {
      if (proc.env?.TABCOMPUTER_BLINK_WJ_KEEP !== '0') keepCompiledModule(m.key, m.module, m.size | 0);
    } else if (m?.type === 'blink-kick') {
      // A guest thread is in a kernel call with a signal to take (it came
      // between the call's start and the kernel's interrupt, or another
      // thread's tkill queued it in Blink): end the process's blocking calls
      // with EINTR, as a signal would; the threads it wasn't for call again.
      // A kick before its call reaches us (host.mjs posts both, in order)
      // interrupts that call once it has started (Linux's pending signal)
      if (busy.size || direct.some(ch => ch.pending)) proc.interruptSyscalls();
      else kickPending = true;
    } else if (m?.type === 'blink-grow') {
      // every channel is busy (blocked calls): one more, shared by this
      // process's workers like the rest (indices match host.mjs's order)
      const sab = pool.length < POOL_MAX ? poolBuffer() : null;
      if (sab) { pool.push(sab); watchPool(sab); }
      w.postMessage({ type: 'blink-channel', sab });
    } else if (m?.type === 'blink-fork') {
      // fork(): the child (made by SYS_shiro_vfork) runs the snapshot in its own worker
      const child = kernel.procs.get(m.pid);
      if (child) kernel.startForkChild(proc, m.pid, blinkRunner(child.path, m.snapshot));
    } else if (m?.type === 'blink-hosted') {
      const child = kernel.procs.get(m.pid);
      if (!child || hosted.has(m.pid)) return;
      hosted.add(m.pid);
      child.data.engineInstance = instance; // same wasm memory: same instance
      const off = child.addSignalListener((sig: number) => { if (sig > 0) w.postMessage({ type: 'blink-signal', sig, pid: m.pid }); });
      child.onTerminate(() => {
        off();
        hosted.delete(m.pid);
        w.postMessage({ type: 'blink-reap', pid: m.pid });
        if (ownGone && !hosted.size) terminateWhenQuiet();
      });
    } else if (m?.type === 'blink-exiting') {
      exiting = true;
    } else if (m?.type === 'blink-quiet') {
      if (exiting && !quiet) {
        quiet = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (ownGone && !hosted.size) terminate();
      }
    } else if (m?.type === 'blink-abort') {
      kernel.reportFatal(proc, `blink ${String(m.text)}`);
      crash();
    } else if (m?.type === 'blink-watch') watch(m.fd);
    else if (m?.type === 'blink-unwatch') { subs.get(m.fd)?.(); subs.delete(m.fd); }
  });
  const unlisten = proc.addSignalListener((sig: number) => { if (sig > 0) w.postMessage({ type: 'blink-signal', sig }); });
  proc.onTerminate(() => {
    unlisten();
    for (const off of subs.values()) off();
    subs.clear();
    stopDirect();
  });
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
    return this.tryWrite(buf);
  }
  // The synchronous path (KernelChannel.serveSync) too: DevNull's discards
  tryWrite(buf: Uint8Array): number {
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
