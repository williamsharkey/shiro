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
import { SYS_MESSAGE, canBlock, createChannelBuffer } from '../kernel/channel';
import type { Kernel, Runner } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import type { GuestWorker } from '../kernel/worker-host';
import type { SysReply, SysRequest } from './abi';
import type { WasiGuestMessage, WasiStartMessage } from './guest-worker';
import { ProcExit, WasiGuest, buildImports, type Preopen } from './wasi-guest';
import { findMemoryImport } from './wasm-imports';
import { CopyingKernelChannel } from './kernel-channel';

// ── Workers and mode ─────────────────────────────────────────────────

export type GuestWorkerFactory = (proc: Process) => GuestWorker;

let workerFactory: GuestWorkerFactory | null = null;

/** Override how guest Workers are created (tests use Node worker_threads). */
export function setGuestWorkerFactory(f: GuestWorkerFactory | null): void { workerFactory = f; }

async function getWorkerFactory(): Promise<GuestWorkerFactory> {
  if (!workerFactory) workerFactory = (await import('./browser-worker')).createGuestWorker;
  return workerFactory;
}

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
  kernel.addLoader(async (path, proc, k) => {
    if (wasmProcessMode() === 'none') return null;
    const found = await findWasm(k, proc, path);
    if (!found) return null;
    return async (p, kk) => {
      const module = await compileCached(found.path, found.image);
      return wasmRunner(module, found.image)(p, kk);
    };
  });
}

// ── Runners ──────────────────────────────────────────────────────────

/** A Runner for `module`. `image` (the bytes) lets threaded modules get their shared memory. */
export function wasmRunner(module: WebAssembly.Module, image?: Uint8Array): Runner {
  return async (proc, kernel) => {
    const mode = wasmProcessMode();
    if (mode === 'none') throw new Error('WASM processes need SharedArrayBuffer or JSPI');
    if (!proc.env.PWD) proc.env.PWD = proc.cwd;
    const preopens = await openPreopens(kernel, proc);
    if (typeof preopens === 'number') throw new Error(`cannot open preopened directories (errno ${-preopens})`);
    return mode === 'jspi' ? runJspi(kernel, proc, module, preopens) : runWorkers(kernel, proc, module, image, preopens);
  };
}

/** "/" and "." (the cwd) as WASI preopens, close-on-exec so children get their own. */
async function openPreopens(kernel: Kernel, proc: Process): Promise<Preopen[] | number> {
  const out: Preopen[] = [];
  for (const [name, path] of [['/', '/'], ['.', proc.cwd]]) {
    const f = await kernel.open(proc, path, A.O_RDONLY | A.O_DIRECTORY);
    if (typeof f === 'number') return f;
    const fd = proc.fds.alloc(f, 3, true);
    if (fd < 0) { await f.close(); return fd; }
    out.push({ fd, name, path });
  }
  return out;
}

function runWorkers(
  kernel: Kernel, proc: Process, module: WebAssembly.Module, image: Uint8Array | undefined, preopens: Preopen[],
): Promise<number | void> {
  return getWorkerFactory().then(factory => new Promise<number | void>((resolve) => {
    const memImport = image ? findMemoryImport(image) : null;
    const memory = memImport?.shared
      ? new WebAssembly.Memory({ initial: memImport.initial, maximum: memImport.maximum ?? memImport.initial, shared: true } as WebAssembly.MemoryDescriptor)
      : undefined;
    const tids = memory ? new SharedArrayBuffer(4) : undefined;
    if (tids) new Int32Array(tids)[0] = 1;
    const workers = new Map<GuestWorker, CopyingKernelChannel>();
    const stop = (w: GuestWorker) => {
      workers.get(w)?.stop();
      workers.delete(w);
      try { void w.terminate(); } catch { /* already gone */ }
    };
    proc.onTerminate(() => { for (const w of [...workers.keys()]) stop(w); resolve(); });
    const fail = (text: string, status: number) => {
      void kernel.writeAll(proc, 2, new TextEncoder().encode(text)).finally(() => {
        if (A.WIFSIGNALED(status)) void kernel.exit(proc, status);
        else resolve(A.WEXITSTATUS(status));
      });
    };

    const launch = (thread?: { tid: number; startArg: number }) => {
      const w = factory(proc);
      const sab = createChannelBuffer();
      const channel = new CopyingKernelChannel(sab, kernel, proc);
      workers.set(w, channel);
      w.onMessage((m) => {
        if (m === SYS_MESSAGE) { void channel.handle(); return; }
        const msg = m as WasiGuestMessage;
        if (msg?.type === 'wasi-thread-spawn') { if (!proc.exiting) launch({ tid: msg.tid, startArg: msg.startArg }); }
        else if (msg?.type === 'wasi-thread-exit') stop(w);
        else if (msg?.type === 'wasi-error') fail(`${proc.comm}: ${msg.message}\n`, thread ? A.W_TERMSIG(A.SIGABRT) : A.W_EXITCODE(126));
      });
      w.onError((err) => {
        if (proc.exiting) return;
        fail(`${proc.comm}: ${(err as Error)?.message ?? err}\n`, A.W_TERMSIG(A.SIGABRT));
      });
      const start: WasiStartMessage = {
        type: 'shiro-start', sab, pid: proc.pid, argv: proc.argv, env: proc.env, cwd: proc.cwd,
        wasi: {
          module, preopens, memory, tids, thread,
          memoryImport: memImport ? { module: memImport.module, name: memImport.name } : undefined,
        },
      };
      w.postMessage(start);
    };
    launch();
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

  const call = async (req: SysRequest): Promise<SysReply> => {
    const data = new Uint8Array(Math.max(req.data?.length ?? 0, req.out ?? 0, 64));
    if (req.data) data.set(req.data);
    const ret = await Promise.race([kernel.syscall(proc, req.nr, req.args, data), killedP]);
    if (proc.exiting) throw new ProcExit(proc.exitStatus ?? 0);
    return { ret, data };
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
