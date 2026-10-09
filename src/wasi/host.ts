/**
 * host.ts — run WASM programs as kernel processes (src/kernel).
 *
 * With SharedArrayBuffer each WASM thread runs in its own Worker with its
 * own kernel channel to the same Process (./guest-worker.ts), and makes
 * blocking syscalls. Without SAB but with JSPI, the program runs on the
 * main thread and its imports suspend on Kernel.syscall. With neither
 * (canBlock() === 'none') the loader declines and callers keep the old
 * in-page runtime (src/wasi-runtime.ts).
 *
 * installWasmLoader() teaches a kernel to run "\0asm" files, so a WASM
 * process that spawns another .wasm program (or a shell that runs one)
 * gets a real child process.
 */

import * as A from '../kernel/abi';
import { KernelChannel, SYS_MESSAGE, canBlock, createChannelBuffer } from '../kernel/channel';
import type { Kernel, Runner } from '../kernel/kernel';
import { Process } from '../kernel/process';
import { attachThread, serve, type GuestWorker } from '../kernel/worker-host';
import {
  SYS_wasi_thread_spawn, SYS_wasix_exec, SYS_wasix_fork, SYS_wasix_resolve, SYS_wasix_signal,
  WASIX_HANDLER, WASIX_SIG_CATCH, WASIX_SIG_DEFAULT, WASIX_SIG_IGNORED, type SysReply, type SysRequest,
} from './abi';
import type { WasiGuestMessage, WasiStartMessage, WasixForkState } from './guest-worker';
import { ProcExit, WasiGuest, buildImports, type Preopen } from './wasi-guest';
import { findMemoryImport } from './wasm-imports';
import { createWorkerPool, type WorkerPool } from './worker-pool';
import { dylinkLayout, readDylink } from './dylink';
import { readFuncSigs, type FuncSigs } from './dyncall';

// ── Workers and mode ─────────────────────────────────────────────────

export type GuestWorkerFactory = (proc: Process) => GuestWorker;

let workerFactory: GuestWorkerFactory | null = null;
let pool: WorkerPool | null = null;

/** Override how guest Workers are created (tests use Node worker_threads). */
export function setGuestWorkerFactory(f: GuestWorkerFactory | null): void {
  pool?.drain();
  pool = null;
  workerFactory = f;
}

/** Guest Workers come from a pool (./worker-pool.ts): a process's Worker runs the next process after it. */
async function getWorkerFactory(): Promise<GuestWorkerFactory> {
  if (!workerFactory) workerFactory = (await import('./browser-worker')).createGuestWorker;
  pool ??= createWorkerPool(workerFactory);
  const p = pool;
  return (proc) => p.acquire(proc);
}

/** The guest Worker pool, once a WASM process has run (tests, diagnostics). */
export function guestWorkerPool(): WorkerPool | null { return pool; }

export type RunMode = 'sab' | 'jspi';
let forcedMode: RunMode | null = null;

/** Tests: force a mode (Node has SAB but no global Worker). */
export function forceWasmProcessMode(m: RunMode | null): void { forcedMode = m; }

/** How new WASM processes run here, or 'none' (use the old runtime). */
export function wasmProcessMode(): RunMode | 'none' {
  if (forcedMode) return forcedMode;
  const m = canBlock();
  if (m === 'sab' && typeof Worker !== 'function') return typeof (WebAssembly as any).Suspending === 'function' ? 'jspi' : 'none';
  return m;
}

// ── Loader ───────────────────────────────────────────────────────────

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
export const isWasm = (b: Uint8Array) => b.length >= 4 && WASM_MAGIC.every((x, i) => b[i] === x);

const moduleCache = new Map<string, { size: number; sum: number; module: WebAssembly.Module }>();
function checksum(b: Uint8Array): number {
  let h = 0;
  const step = Math.max(1, Math.floor(b.length / 4096));
  for (let i = 0; i < b.length; i += step) h = (Math.imul(h, 31) + b[i]) | 0;
  return h;
}

async function compileCached(path: string, image: Uint8Array): Promise<WebAssembly.Module> {
  const sum = checksum(image);
  const hit = moduleCache.get(path);
  if (hit && hit.size === image.length && hit.sum === sum) return hit.module;
  const module = await WebAssembly.compile(image as BufferSource);
  moduleCache.set(path, { size: image.length, sum, module });
  return module;
}

/**
 * Find a WASM program: a path (relative to the cwd), or a name on PATH.
 * Shiro keeps WASM binaries as NAME.wasm, so a PATH search tries that too.
 */
async function findWasm(kernel: Kernel, proc: Process, path: string): Promise<{ path: string; image: Uint8Array } | null> {
  const fs = kernel.fs;
  if (!fs) return null;
  const candidates: string[] = [];
  if (path.includes('/')) candidates.push(fs.resolvePath(path, proc.cwd));
  else {
    for (const dir of (proc.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')) {
      if (dir) candidates.push(fs.resolvePath(`${dir}/${path}`, proc.cwd), fs.resolvePath(`${dir}/${path}.wasm`, proc.cwd));
    }
  }
  for (const p of candidates) {
    // A path known to be missing: skip it without stat()'s ENOENT (an Error
    // per PATH entry made every builtin spawn pay for six exceptions)
    if (fs.lookupCached?.(p) === null) continue;
    let image: Uint8Array;
    try {
      const st = await fs.stat(p);
      if (st.type === 'dir') continue;
      const d = await fs.readFile(p);
      image = typeof d === 'string' ? new TextEncoder().encode(d) : d;
    } catch { continue; }
    if (isWasm(image)) return { path: p, image };
    if (path.includes('/')) return null; // an explicit path to something else
  }
  return null;
}

const installed = new WeakSet<Kernel>();

/** Make `kernel` run WASM files (by path or on PATH) as WASM processes. */
export function installWasmLoader(kernel: Kernel): void {
  if (installed.has(kernel)) return;
  installed.add(kernel);
  installWasiSyscalls(kernel);
  kernel.addLoader(async (path, proc, k) => {
    if (wasmProcessMode() === 'none') return null;
    const found = await findWasm(k, proc, path);
    if (!found) return null;
    return async (p, kk) => {
      const module = await compileCached(found.path, found.image);
      // A package's program keeps its mounts when started by path (clang's driver running wasm-ld)
      let mounts: Record<string, string> | undefined;
      if (kk.fs) {
        try { mounts = await (await import('../pkg-manager')).packageMountsForPath(kk.fs, found.path); } catch { /* none */ }
      }
      return wasmRunner(module, found.image, await childPreopens(kk, module), mounts)(p, kk);
    };
  });
}

/** The WASIX calls Shiro's process shim for wasi-libc programs uses (scripts/pkgbuild/compat/wasi-proc.c). */
const SHIM_WASIX = new Set(['proc_spawn3', 'proc_join', 'fd_pipe', 'fd_dup', 'getcwd']);

/**
 * "/usr", "/home", ...: preopened by name for a spawned WASM program, as
 * runPackageBinary does at the prompt, because some wasi-libc builds never
 * match a "/" preopen against "/usr/...". Not for WASIX-libc programs (their
 * libc matches "/", and dash's strips the wrong prefix when several match);
 * wasi-libc programs that only use the process shim's calls still get them.
 */
async function childPreopens(kernel: Kernel, module: WebAssembly.Module): Promise<string[]> {
  const wasixLibc = WebAssembly.Module.imports(module).some(i => i.module === 'wasix_32v1' && !SHIM_WASIX.has(i.name));
  const fs = kernel.fs;
  if (wasixLibc || !fs) return [];
  const out: string[] = [];
  try {
    for (const name of await fs.readdir('/')) {
      try { if ((await fs.stat(`/${name}`)).type === 'dir') out.push(`/${name}`); } catch { /* skip */ }
    }
  } catch { /* none */ }
  return out;
}

const syscallsInstalled = new WeakSet<Kernel>();

/**
 * Shiro syscalls for WASM processes (src/wasi/abi.ts): wasi-threads spawn,
 * WASIX fork and exec (answered by the running process's runner, which
 * installs proc.data hooks), and WASIX signal bookkeeping.
 */
function installWasiSyscalls(kernel: Kernel): void {
  if (syscallsInstalled.has(kernel)) return;
  syscallsInstalled.add(kernel);
  kernel.registerSyscalls([SYS_wasi_thread_spawn], (proc, _nr, args) => {
    const spawn = proc.data.wasiThreadSpawn as ((startArg: number) => number) | undefined;
    return spawn ? spawn(args[0]) : -A.ENOSYS;
  });
  kernel.registerSyscalls([SYS_wasix_fork], (proc) => {
    const fork = proc.data.wasixFork as (() => number | Promise<number>) | undefined;
    return fork ? fork() : -A.ENOSYS;
  });
  kernel.registerSyscalls([SYS_wasix_exec], (proc, _nr, args, data) => {
    const exec = proc.data.wasixExec as ((req: ExecRequest) => Promise<number>) | undefined;
    if (!exec) return -A.ENOSYS;
    let req: ExecRequest;
    try { req = JSON.parse(A.decodeText(data.subarray(0, args[0]))); } catch { return -A.EINVAL; }
    if (typeof req?.path !== 'string' || !Array.isArray(req.argv)) return -A.EINVAL;
    return exec(req);
  });
  kernel.registerSyscalls([SYS_wasix_signal], (proc, _nr, args, _data, k) => wasixSignal(k, proc, args[0], args[1]));
  kernel.registerSyscalls([SYS_wasix_resolve], async (_proc, _nr, args, data, k) => {
    const host = A.decodeText(data.subarray(0, Math.min(args[0], data.length)));
    const stack = (await import('../kernel/net')).netStackOf(k);
    if (!stack) return -A.ENOSYS;
    const r = await stack.resolve(host);
    if (typeof r === 'number') return r;
    const text = new TextEncoder().encode([...r].sort((a, b) => a.family - b.family).map(a => a.address).join('\n'));
    if (text.length > data.length) return -A.ENOBUFS;
    data.set(text);
    return text.length;
  });
  kernel.registerSyscalls([A.SYS_stat, A.SYS_lstat, A.SYS_newfstatat, A.SYS_access, A.SYS_faccessat], Object.assign(binCommandStat, { passSync: binCommandPasses }));
}

const BIN_DIR = /^\/(?:usr\/)?(?:local\/)?s?bin\/([^/]+)$/;

/** binCommandStat will pass the call on: it isn't about a Shiro command's /bin path (kernel.syscallSync may answer it). */
function binCommandPasses(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array, kernel: Kernel): boolean {
  const at = nr === A.SYS_newfstatat || nr === A.SYS_faccessat;
  if (nr === A.SYS_newfstatat && args[1] === 0) return true;
  const len = at ? args[1] : args[0];
  if (len <= 0 || len > data.length) return true;
  const p = kernel.resolvePath(proc, A.decodeText(data.subarray(0, len)), at ? args[0] : A.AT_FDCWD);
  const m = typeof p === 'string' ? BIN_DIR.exec(p) : null;
  return !m || !kernel.shell?.commands.get(m[1]);
}

/**
 * Shiro's commands are executables in /bin, /usr/bin, ... even without a
 * file there (the kernel's builtin loader runs them by those paths), so
 * shells that stat each PATH entry (dash, bash) find `ls`, `cat`, ...: a
 * stat or access of a missing file named after a command reports an empty
 * executable file.
 */
async function binCommandStat(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array, kernel: Kernel): Promise<number | undefined> {
  const at = nr === A.SYS_newfstatat || nr === A.SYS_faccessat;
  if (nr === A.SYS_newfstatat && args[1] === 0) return undefined; // fstat of the dirfd itself
  const len = at ? args[1] : args[0];
  if (len <= 0 || len > data.length) return undefined;
  const p = kernel.resolvePath(proc, A.decodeText(data.subarray(0, len)), at ? args[0] : A.AT_FDCWD);
  const m = typeof p === 'string' ? BIN_DIR.exec(p) : null;
  if (!m || !kernel.shell?.commands.get(m[1])) return undefined;
  if ((await kernel.statPath(proc, p as string, false)) !== -A.ENOENT) return undefined;
  if (nr === A.SYS_access || nr === A.SYS_faccessat) return 0;
  const now = Date.now();
  A.encodeStat({
    dev: 1, ino: 0x5000000 + m[1].length * 7919 + m[1].charCodeAt(0), mode: A.S_IFREG | 0o755, nlink: 1, uid: 0, gid: 0, rdev: 0,
    size: 0, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
  }, data);
  return 0;
}

interface ExecRequest { path: string; argv: string[]; env?: Record<string, string> }

/** Signals a WASIX guest can't catch, or that only matter to the kernel. */
const UNCATCHABLE = new Set([A.SIGKILL, A.SIGSTOP, A.SIGURG]);

async function wasixSignal(kernel: Kernel, proc: Process, op: number, sig: number): Promise<number> {
  switch (op) {
    case WASIX_SIG_CATCH:
      // WASIX libc keeps its handler table to itself and runs default actions in
      // its callback, so everything it doesn't ignore goes to the guest
      for (let s = 1; s < 32; s++) {
        if (!UNCATCHABLE.has(s) && proc.dispositions.get(s) !== 'ignore') proc.dispositions.set(s, WASIX_HANDLER);
      }
      return 0;
    case WASIX_SIG_DEFAULT: {
      if (sig <= 0 || sig >= A.NSIG) return -A.EINVAL;
      const disp = proc.dispositions.get(sig);
      const masked = proc.sigmask.has(sig);
      proc.dispositions.delete(sig);
      proc.sigmask.delete(sig);
      kernel.deliver(proc, sig);
      if (proc.state === 'stopped') await proc.waitWhileStopped();
      if (!proc.exiting) {
        if (disp !== undefined && !proc.dispositions.has(sig)) proc.dispositions.set(sig, disp);
        if (masked) proc.sigmask.add(sig);
      }
      return 0;
    }
    case WASIX_SIG_IGNORED: {
      let mask = 0;
      for (const [s, d] of proc.dispositions) if (d === 'ignore' && s < 32) mask |= 1 << s;
      return mask;
    }
    default:
      return -A.EINVAL;
  }
}

// ── Runners ──────────────────────────────────────────────────────────

/** A Runner for `module`. `image` (the bytes) lets threaded modules get their shared memory. */
/**
 * `extraPreopens`: more absolute directories to preopen under their own
 * names. Some wasi-libc builds never match a "/" preopen against "/usr/...",
 * so programs built with them only reach directories preopened by name.
 */
/**
 * `mounts`: guest path → absolute directory, preopened under the guest path
 * (a per-process view, like a mount namespace: WASI libcs resolve an absolute
 * path through the longest matching preopen).
 */
export function wasmRunner(
  module: WebAssembly.Module, image?: Uint8Array, extraPreopens: string[] = [], mounts?: Record<string, string>,
  /** The program's own path (/proc/self/exe, an empty-name exec); default: `proc.path` found on PATH */
  exe?: string,
): Runner {
  return async (proc, kernel) => {
    const mode = wasmProcessMode();
    if (mode === 'none') throw new Error('WASM processes need SharedArrayBuffer or JSPI');
    if (exe) proc.data.exe = exe; // /proc/PID/exe (procfs), however the guest spells the path
    if (!proc.env.PWD) proc.env.PWD = proc.cwd;
    installWasiSyscalls(kernel);
    const preopens = await openPreopens(kernel, proc, extraPreopens, mounts);
    if (typeof preopens === 'number') throw new Error(`cannot open preopened directories (errno ${-preopens})`);
    if (mode === 'jspi') return runJspi(kernel, proc, module, preopens);
    const self = exe ?? (await findWasm(kernel, proc, proc.path).catch(() => null))?.path;
    return runWorkers(kernel, proc, module, image, preopens, undefined, self);
  };
}

/** "/", any extra directories, and "." (the cwd) as WASI preopens, close-on-exec so children get their own. */
async function openPreopens(kernel: Kernel, proc: Process, extra: string[] = [], mounts: Record<string, string> = {}): Promise<Preopen[] | number> {
  const out: Preopen[] = [];
  const mountList = Object.entries(mounts).filter(([guest]) => guest !== '/' && !extra.includes(guest));
  for (const [name, path] of [['/', '/'], ...extra.map(d => [d, d]), ...mountList, ['.', proc.cwd]]) {
    const f = await kernel.open(proc, path, A.O_RDONLY | A.O_DIRECTORY);
    if (typeof f === 'number') {
      if (mounts[name] === path) continue; // a mount whose directory is missing: leave the path as it is
      return f;
    }
    const fd = proc.fds.alloc(f, 3, true);
    if (fd < 0) { await f.close(); return fd; }
    out.push({ fd, name, path });
  }
  return out;
}

const sigCache = new WeakMap<WebAssembly.Module, FuncSigs | undefined>();
const DYNCALL_IMPORTS = new Set(['call_dynamic', 'reflect_signature', 'closure_prepare']);

/** Function signatures, for modules that make WASIX dynamic calls (once per module). */
function moduleFuncSigs(module: WebAssembly.Module, image: Uint8Array): FuncSigs | undefined {
  if (sigCache.has(module)) return sigCache.get(module);
  const uses = WebAssembly.Module.imports(module).some(i => i.module === 'wasix_32v1' && DYNCALL_IMPORTS.has(i.name));
  const sigs = uses ? readFuncSigs(image) ?? undefined : undefined;
  sigCache.set(module, sigs);
  return sigs;
}

/** A forked child's start: a copy of the parent's memory and the guest state to resume from. */
interface ForkResume { memory: WebAssembly.Memory; state: WasixForkState }

function runWorkers(
  kernel: Kernel, proc: Process, module: WebAssembly.Module, image: Uint8Array | undefined, preopens: Preopen[],
  resume?: ForkResume, exe?: string,
): Promise<number | void> {
  return getWorkerFactory().then(factory => new Promise<number | void>((resolve) => {
    const memImport = image ? findMemoryImport(image) : null;
    // Position-independent modules get their data, stack and table placed here (./dylink.ts)
    const dyInfo = readDylink(module);
    const dylink = dyInfo ? dylinkLayout(dyInfo) : undefined;
    const initial = Math.max(memImport?.initial ?? 0, dylink?.minPages ?? 0);
    const memory = resume?.memory ?? (memImport?.shared
      ? new WebAssembly.Memory({ initial, maximum: Math.max(initial, memImport.maximum ?? memImport.initial), shared: true } as WebAssembly.MemoryDescriptor)
      : undefined);
    const funcSigs = image ? moduleFuncSigs(module, image) : undefined;
    const wasi = (thread?: { startArg: number }) => ({
      module, preopens, memory, thread, dylink, funcSigs, exe,
      memoryImport: memImport ? { module: memImport.module, name: memImport.name } : undefined,
    });
    const onGuestMessage = (m: unknown, isThread: boolean) => {
      const msg = m as WasiGuestMessage;
      if (msg?.type === 'wasix-fork') {
        proc.data.wasixForkState = msg.state;
        forkStateArrived?.();
        return;
      }
      if (msg?.type === 'wasix-signals') { signalInfo = msg.callback ? { callback: msg.callback, tlsBase: msg.tlsBase } : null; return; }
      if (msg?.type !== 'wasi-error' || proc.exiting) return;
      // Could not instantiate: 126 like an exec failure, or abort if a thread failed
      void kernel.writeAll(proc, 2, new TextEncoder().encode(`${proc.comm}: ${msg.message}\n`)).finally(() => {
        if (isThread) void kernel.exit(proc, A.W_TERMSIG(A.SIGABRT));
        else resolve(126);
      });
    };

    // wasi-threads: each thread is a Worker attached to this process (own channel and tid)
    if (memory) {
      proc.data.wasiThreadSpawn = (startArg: number) => {
        if (proc.exiting) return -A.EAGAIN;
        const t = attachThread(kernel, proc, (p) => {
          const w = factory(p);
          w.onMessage((m) => { if (m !== SYS_MESSAGE) onGuestMessage(m, true); });
          return w;
        }, { startData: { wasi: wasi({ startArg }) } });
        return t.tid;
      };
    }

    let forkStateArrived: (() => void) | null = null;
    const w = factory(proc);
    const sab = createChannelBuffer();
    const channel = new KernelChannel(sab, kernel, proc);
    let replaced = false;

    // WASIX libc's sigsuspend returns at once, so a program waiting for SIGCHLD
    // (dash's `wait`) spins in WASM without syscalls and never sees the signal
    // its channel holds. After a moment, run such a signal (one that is ignored
    // by default, whose handlers just record it) on a signal thread: same memory
    // and TLS, its own stack in a page grown for it.
    let signalInfo: { callback: string; tlsBase: number } | null = null;
    let signalStack = 0;
    const runStuckSignal = () => {
      if (replaced || proc.exiting || !signalInfo || !memory) return;
      if (Atomics.load(channel.i32, A.CH_STATE) !== A.STATE_IDLE) return; // in a syscall: the reply delivers it
      const sig = Atomics.load(channel.i32, A.CH_SIGNAL);
      if (!sig || A.defaultSignalAction(sig) !== 'ignore') return;
      if (Atomics.compareExchange(channel.i32, A.CH_SIGNAL, sig, 0) !== sig) return;
      if (!signalStack) signalStack = (memory.grow(2) + 2) * 65536 - 16;
      const info = signalInfo;
      attachThread(kernel, proc, (p) => {
        const t = factory(p);
        t.onMessage((m) => { if (m !== SYS_MESSAGE) onGuestMessage(m, true); });
        return t;
      }, { startData: { wasi: { ...wasi(), signal: { sig, callback: info.callback, tlsBase: info.tlsBase, stackTop: signalStack } } } });
    };
    const offStuck = proc.addSignalListener(() => { setTimeout(runStuckSignal, 50); });
    proc.onTerminate(() => {
      offStuck();
      channel.stop();
      try { void w.terminate(); } catch { /* already gone */ }
      if (!replaced) resolve();
    });

    // WASIX fork: a new process with a copy of this one's memory, fds and
    // signal state, resuming from the stack the guest captured (proc_fork)
    proc.data.wasixFork = async (): Promise<number> => {
      // The guest posts its stack before the syscall; a kernel watching the
      // channel (not waiting for messages) can see the syscall first
      if (!proc.data.wasixForkState && !replaced && !proc.exiting) {
        await new Promise<void>(r => {
          const t = setTimeout(r, 5000);
          forkStateArrived = () => { clearTimeout(t); r(); };
        });
        forkStateArrived = null;
      }
      const state = proc.data.wasixForkState as WasixForkState | undefined;
      delete proc.data.wasixForkState;
      if (!state || !memory || replaced) return -A.ENOSYS;
      const src = new Uint8Array(memory.buffer);
      const pages = src.byteLength / 65536;
      const copy = new WebAssembly.Memory({ initial: pages, maximum: Math.max(pages, memImport?.maximum ?? pages), shared: true } as WebAssembly.MemoryDescriptor);
      new Uint8Array(copy.buffer).set(src);
      const child = kernel.spawn({
        path: proc.path, argv: [...proc.argv], env: { ...proc.env }, cwd: proc.cwd, parent: proc, fds: {},
        run: (p, k) => runWorkers(k, p, module, image, preopens, { memory: copy, state }, exe),
      });
      // fork(2) keeps every fd (close-on-exec ones too) and the signal state; the program starts after a microtask
      void child.fds.closeAll();
      child.fds = proc.fds.fork();
      child.umask = proc.umask;
      for (const [s, d] of proc.dispositions) child.dispositions.set(s, d);
      for (const [s, a] of proc.sigactions) child.sigactions.set(s, { ...a, mask: new Set(a.mask) });
      for (const s of proc.sigmask) child.sigmask.add(s);
      return child.pid;
    };

    // WASIX exec: replace this program, keeping the process (pid, fds without close-on-exec, ignored signals)
    proc.data.wasixExec = async (req: ExecRequest): Promise<number> => {
      if (replaced || proc.exiting) return -A.EINTR;
      const probe = new Process({ pid: -1, ppid: proc.pid, path: req.path, argv: req.argv, env: req.env ?? proc.env, cwd: proc.cwd });
      const runner = await kernel.findProgram(req.path, probe);
      if (!runner) return -A.ENOENT;
      if (proc.exiting) return -A.EINTR;
      replaced = true;
      offStuck();
      channel.stop();
      try { void w.terminate(); } catch { /* already gone */ }
      for (const k of ['wasiThreadSpawn', 'wasixFork', 'wasixExec', 'wasixForkState']) delete proc.data[k];
      proc.path = req.path;
      proc.argv = req.argv;
      if (req.env) proc.env = { ...req.env };
      await proc.fds.closeOnExec();
      for (const [s, d] of [...proc.dispositions]) if (d !== 'ignore') proc.dispositions.delete(s);
      proc.sigactions.clear();
      proc.pendingSignals.clear();
      resolve((async () => runner(proc, kernel))());
      return 0; // never reaches the guest: its channel is stopped
    };
    const wake = serve(channel, w);
    w.onMessage((m) => { if (m !== SYS_MESSAGE) onGuestMessage(m, false); });
    w.onError((err) => {
      if (proc.exiting) return;
      void kernel.writeAll(proc, 2, new TextEncoder().encode(`${proc.comm}: ${(err as Error)?.message ?? err}\n`))
        .finally(() => kernel.exit(proc, A.W_TERMSIG(A.SIGABRT)));
    });
    const start: WasiStartMessage = {
      type: 'shiro-start', sab, pid: proc.pid, argv: proc.argv, env: proc.env, cwd: proc.cwd, wake,
      wasi: { ...wasi(), ...(resume ? { resume: resume.state } : {}) },
    };
    w.postMessage(start);
  }));
}

/** Main-thread run with JSPI: imports suspend on Kernel.syscall. */
async function runJspi(kernel: Kernel, proc: Process, module: WebAssembly.Module, preopens: Preopen[]): Promise<number | void> {
  const W = WebAssembly as any;
  if (WebAssembly.Module.imports(module).some(i => i.kind === 'memory')) {
    // An imported memory means wasi-threads: shared memory needs SharedArrayBuffer
    throw new Error('this program uses threads, which need a cross-origin isolated page (SharedArrayBuffer)');
  }
  let killed!: (e: unknown) => void;
  const killedP = new Promise<never>((_, rej) => { killed = rej; });
  killedP.catch(() => { /* observed through the race below */ });
  proc.onTerminate(() => killed(new ProcExit(proc.exitStatus ?? 0)));

  const call = (req: SysRequest): SysReply | Promise<SysReply> => {
    const data = new Uint8Array(Math.max(req.data?.length ?? 0, req.out ?? 0, 64));
    if (req.data) data.set(req.data);
    // Answered at once (ids, fstat, pipe I/O with data or room): no suspension
    const fast = kernel.syscallSync(proc, req.nr, req.args, data);
    if (fast !== undefined) return { ret: fast, data };
    return Promise.race([kernel.syscall(proc, req.nr, req.args, data), killedP]).then(ret => {
      if (proc.exiting) throw new ProcExit(proc.exitStatus ?? 0);
      return { ret, data };
    });
  };
  const guest = new WasiGuest({ args: proc.argv, env: proc.env, preopens, dataSize: 4 << 20 });
  const instance = await WebAssembly.instantiate(module, buildImports(guest, module, 'jspi', call));
  const exp = instance.exports as Record<string, any>;
  guest.memory = exp.memory;
  const entry = typeof exp._start === 'function' ? exp._start : exp._initialize;
  try {
    if (entry) await W.promising(entry)();
    return 0;
  } catch (e) {
    if (e instanceof ProcExit || proc.exiting) return;
    const msg = e instanceof Error ? e.message : String(e);
    await kernel.writeAll(proc, 2, new TextEncoder().encode(`wasm trap: ${msg}\n`));
    await kernel.exit(proc, A.W_TERMSIG(A.SIGABRT));
  }
}
