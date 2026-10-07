/**
 * host.ts — run WASM programs as kernel processes.
 *
 * With SharedArrayBuffer (canBlock() === 'sab') each WASM thread runs in its
 * own Worker and makes blocking syscalls over a channel (./guest-worker.ts).
 * Without SAB but with JSPI, the program runs on the main thread and its
 * imports suspend on kernel promises. With neither, callers keep using the
 * old in-page runtime (src/wasi-runtime.ts).
 *
 * Registers itself as the kernel's binfmt for "\0asm", so a WASM process
 * that spawns another .wasm file (or a shell that runs one) gets a real
 * child process too.
 */

import { canBlock, canWatchChannel, createChannelBuffer, serviceRequest, watchChannel } from './channel';
import { exitStatus, signalStatus, SIGABRT, CH_DEFAULT_DATA, EAGAIN, ENOSYS, SysReply, SysRequest } from './abi';
import { FsDir, Kernel, Process } from './kernel';
import { dispatch, SysContext } from './syscalls';
import { ProcExit, WasiGuest, buildImports, runSync, type Preopen } from './wasi-guest';
import { findMemoryImport } from './wasm-imports';
import type { GuestMessage, GuestStart } from './guest-worker';

// ── Worker plumbing ──────────────────────────────────────────────────

export interface WorkerLike {
  postMessage(msg: any): void;
  onmessage: ((ev: { data: any }) => void) | null;
  onerror: ((ev: any) => void) | null;
  terminate(): void;
}
export type WorkerFactory = () => WorkerLike;

let workerFactory: WorkerFactory | null = null;

/** Override how guest Workers are created (tests use Node worker_threads). */
export function setGuestWorkerFactory(f: WorkerFactory | null): void { workerFactory = f; }

async function getWorkerFactory(): Promise<WorkerFactory> {
  if (!workerFactory) {
    const m = await import('./browser-worker');
    workerFactory = m.createGuestWorker;
  }
  return workerFactory;
}

export type RunMode = 'sab' | 'jspi';

/** Which mode new WASM processes use here, or 'none' (use the old runtime). */
export function wasmProcessMode(): RunMode | 'none' {
  if (forcedMode) return forcedMode;
  const m = canBlock();
  return m;
}
let forcedMode: RunMode | null = null;
/** Tests: force a mode (e.g. 'sab' under Node, which has no global Worker). */
export function forceWasmProcessMode(m: RunMode | null): void { forcedMode = m; }

// ── binfmt ───────────────────────────────────────────────────────────

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

/** Make `kernel` run "\0asm" files as WASM processes. */
export function installWasmBinfmt(kernel: Kernel): void {
  kernel.registerBinfmt({
    name: 'wasm',
    test: isWasm,
    load: async (k, proc, image, path) => {
      const module = await compileCached(path, image);
      await startWasmProcess(k, proc, module, image);
    },
  });
}

// ── Processes ────────────────────────────────────────────────────────

/**
 * Run `module` as `proc` (whose argv/env/cwd/fds are already set). Returns
 * once the program is started; `proc.wait()` resolves with its status.
 */
export async function startWasmProcess(
  kernel: Kernel, proc: Process, module: WebAssembly.Module, image?: Uint8Array,
): Promise<void> {
  const mode = wasmProcessMode();
  if (mode === 'none') throw new Error('WASM processes need SharedArrayBuffer or JSPI');
  if (!proc.env.PWD) proc.env.PWD = proc.cwd;
  const preopens = openPreopens(kernel, proc);
  if (mode === 'jspi') return startJspi(kernel, proc, module, preopens);
  return startWorkers(kernel, proc, module, image, preopens);
}

/** "/" and "." as WASI preopens, close-on-exec so children get their own. */
function openPreopens(kernel: Kernel, proc: Process): Preopen[] {
  const root = proc.fds.alloc(new FsDir(kernel.fs, '/', 0), 3, true);
  const cwd = proc.fds.alloc(new FsDir(kernel.fs, proc.cwd, 0), 3, true);
  return [{ fd: root, name: '/' }, { fd: cwd, name: '.' }];
}

async function startWorkers(
  kernel: Kernel, proc: Process, module: WebAssembly.Module, image: Uint8Array | undefined, preopens: Preopen[],
): Promise<void> {
  const factory = await getWorkerFactory();
  const memImport = image ? findMemoryImport(image) : null;
  const memory = memImport?.shared
    ? new WebAssembly.Memory({ initial: memImport.initial, maximum: memImport.maximum ?? memImport.initial, shared: true })
    : undefined;
  const workers = new Set<WorkerLike>();
  const unwatch = new Map<WorkerLike, () => void>();
  const byAtomics = canWatchChannel();
  let nextTid = 1;
  let ended = false;

  const terminateAll = () => {
    ended = true;
    for (const w of workers) stop(w);
  };
  proc.killHooks.push(terminateAll);

  const ctx: SysContext = {
    kernel, proc, dataSize: CH_DEFAULT_DATA,
    exit: async (status) => { terminateAll(); await proc.exit(status); },
    threadSpawn: memory ? (startArg) => {
      if (ended) return -EAGAIN;
      const tid = nextTid++;
      if (tid >= 1 << 29) return -EAGAIN;
      launch({ tid, startArg });
      return tid;
    } : undefined,
  };

  const stop = (w: WorkerLike) => {
    workers.delete(w);
    unwatch.get(w)?.();
    unwatch.delete(w);
    try { w.terminate(); } catch { /* already gone */ }
  };

  const launch = (thread?: { tid: number; startArg: number }) => {
    const w = factory();
    const channel = createChannelBuffer(CH_DEFAULT_DATA);
    workers.add(w);
    const handler = (req: SysRequest) => dispatch(ctx, req);
    if (byAtomics) unwatch.set(w, watchChannel(channel, handler));
    w.onmessage = (ev) => {
      const msg = ev.data as GuestMessage;
      if (msg.type === 'sys') void serviceRequest(channel, handler);
      else if (msg.type === 'thread-exit') stop(w);
      else if (msg.type === 'error') {
        void writeErr(proc, `${proc.argv[0]}: ${msg.message}\n`).then(() => ctx.exit(exitStatus(thread ? 134 : 126)));
      } else if (msg.type === 'done') {
        // exit_group already ended the process; the worker is idle now
        stop(w);
      }
    };
    w.onerror = (ev: any) => {
      if (ended) return;
      void writeErr(proc, `${proc.argv[0]}: worker error: ${ev?.message ?? ev}\n`).then(() => ctx.exit(signalStatus(SIGABRT)));
    };
    const start: GuestStart = {
      type: 'start', module, channel, args: proc.argv, env: proc.env, preopens,
      memory, memoryImport: memImport ? { module: memImport.module, name: memImport.name } : undefined,
      thread, notifyByAtomics: byAtomics,
    };
    w.postMessage(start);
  };
  launch();
}

async function writeErr(proc: Process, text: string): Promise<void> {
  const f = proc.fds.get(2);
  if (f) await f.write(new TextEncoder().encode(text));
}

/** Main-thread run with JSPI: imports suspend on kernel promises. */
async function startJspi(kernel: Kernel, proc: Process, module: WebAssembly.Module, preopens: Preopen[]): Promise<void> {
  const W = WebAssembly as any;
  if (WebAssembly.Module.imports(module).some(i => i.kind === 'memory')) {
    // Imported memory means wasi-threads: shared memory needs SharedArrayBuffer
    throw new Error('this program uses threads, which need a cross-origin isolated page (SharedArrayBuffer)');
  }
  let killed: ((e: unknown) => void) | null = null;
  const killedP = new Promise<never>((_, rej) => { killed = rej; });
  killedP.catch(() => { /* observed via race */ });
  proc.killHooks.push((sig) => killed?.(new ProcExit(signalStatus(sig))));
  const ctx: SysContext = {
    kernel, proc, dataSize: 4 * CH_DEFAULT_DATA,
    exit: (status) => proc.exit(status),
  };
  const call = (req: SysRequest): Promise<SysReply> => {
    if (proc.exited) return Promise.reject(new ProcExit(proc.exitStatus!));
    return Promise.race([dispatch(ctx, req), killedP]);
  };
  const guest = new WasiGuest({ args: proc.argv, env: proc.env, preopens, dataSize: ctx.dataSize });
  const imports = buildImports(guest, module, 'jspi', call);
  // wasi-threads needs Workers; JSPI mode runs single-threaded
  if (imports.wasi?.['thread-spawn']) imports.wasi['thread-spawn'] = () => -ENOSYS;
  const instance = await WebAssembly.instantiate(module, imports);
  const exp = instance.exports as Record<string, any>;
  guest.memory = exp.memory;
  const entry = typeof exp._start === 'function' ? exp._start : exp._initialize;
  void (async () => {
    try {
      if (entry) await W.promising(entry)();
      await proc.exit(exitStatus(0));
    } catch (e) {
      if (e instanceof ProcExit || proc.exited) return;
      const msg = e instanceof Error ? e.message : String(e);
      await writeErr(proc, `wasm trap: ${msg}\n`);
      await proc.exit(signalStatus(SIGABRT));
    }
  })();
}

export { runSync, WasiGuest };
