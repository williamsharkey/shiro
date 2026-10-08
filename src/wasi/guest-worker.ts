/**
 * guest-worker.ts — body of the Worker that runs one WASM thread of a process.
 *
 * The host (./host.ts) posts the kernel's 'shiro-start' message with a
 * `wasi` field: the compiled module, the preopens and, for threaded modules,
 * the shared memory and the thread to run. Every WASI call then blocks on
 * the kernel channel (src/kernel/channel.ts); the worker never touches the
 * filesystem or the terminal itself.
 */

import { GuestChannel, SYS_MESSAGE, isStartMessage, type GuestStartMessage } from '../kernel/channel';
import * as A from '../kernel/abi';
import { SYS_wasi_thread_spawn, type SysReply, type SysRequest } from './abi';
import { ProcExit, WasiGuest, buildImports, runSync, type Preopen } from './wasi-guest';

export interface WasiStartData {
  module: WebAssembly.Module;
  preopens: Preopen[];
  memory?: WebAssembly.Memory;
  memoryImport?: { module: string; name: string };
  /** Set for wasi-threads threads: run wasi_thread_start(tid, startArg); tid is the message's. */
  thread?: { startArg: number };
}

export type WasiStartMessage = GuestStartMessage & { tid?: number; wasi: WasiStartData };

/** Messages besides SYS_MESSAGE that a guest posts to the host. */
export type WasiGuestMessage = { type: 'wasi-error'; message: string };

export interface Port {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: any }) => void) | null;
}

export function guestMain(port: Port): void {
  port.onmessage = (ev) => {
    const msg = ev.data;
    if (isStartMessage(msg) && (msg as WasiStartMessage).wasi) run(port, msg as WasiStartMessage);
  };
}

function run(port: Port, msg: WasiStartMessage): void {
  const w = msg.wasi;
  const channel = new GuestChannel(msg.sab, () => port.postMessage(SYS_MESSAGE));
  const call = (req: SysRequest): SysReply => {
    if (req.data) channel.data.set(req.data);
    const lo = channel.call(req.nr, ...req.args);
    return { ret: channel.result64(lo), data: channel.data };
  };
  const tid = msg.tid ?? msg.pid;
  const guest = new WasiGuest({
    args: msg.argv, env: msg.env, preopens: w.preopens,
    dataSize: channel.data.length, tid,
    // Threads need the shared memory; the host answers with attachThread
    threadSpawn: w.memory ? (startArg) => call({ nr: SYS_wasi_thread_spawn, args: [startArg] }).ret : undefined,
  });
  const extra: Record<string, Record<string, any>> = {};
  if (w.memory && w.memoryImport) extra[w.memoryImport.module] = { [w.memoryImport.name]: w.memory };

  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(w.module, buildImports(guest, w.module, 'sync', call, extra));
  } catch (e: any) {
    port.postMessage({ type: 'wasi-error', message: e?.message ?? String(e) } satisfies WasiGuestMessage);
    return;
  }
  const exp = instance.exports as Record<string, any>;
  guest.memory = w.memory ?? exp.memory;

  try {
    if (w.thread) {
      exp.wasi_thread_start(tid, w.thread.startArg);
      call({ nr: A.SYS_exit, args: [0] }); // ends this thread only; the kernel stops the worker
      return;
    }
    if (typeof exp._start === 'function') exp._start();
    else if (typeof exp._initialize === 'function') exp._initialize();
    runSync(guest.exit(0), call);
  } catch (e) {
    if (e instanceof ProcExit) return;
    try { runSync(guest.trap(e), call); } catch { /* ProcExit */ }
  }
}
