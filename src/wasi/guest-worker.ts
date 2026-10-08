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
import type { SysReply, SysRequest } from './abi';
import { ProcExit, WasiGuest, buildImports, runSync, type Preopen } from './wasi-guest';
import { ARG_REPLY_LEN } from './kernel-channel';

export interface WasiStartData {
  module: WebAssembly.Module;
  preopens: Preopen[];
  memory?: WebAssembly.Memory;
  memoryImport?: { module: string; name: string };
  /** Int32[0]: next thread id, shared by every thread of the process. */
  tids?: SharedArrayBuffer;
  /** Set for wasi-threads threads: run wasi_thread_start(tid, startArg). */
  thread?: { tid: number; startArg: number };
}

export type WasiStartMessage = GuestStartMessage & { wasi: WasiStartData };

/** Messages besides SYS_MESSAGE that a guest posts to the host. */
export type WasiGuestMessage =
  | { type: 'wasi-thread-spawn'; tid: number; startArg: number }
  | { type: 'wasi-thread-exit'; tid: number }
  | { type: 'wasi-error'; message: string };

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
    // Request and reply sizes ride in spare arg slots (see kernel-channel.ts)
    const args = req.args.slice(0, ARG_REPLY_LEN);
    while (args.length < ARG_REPLY_LEN) args.push(0);
    args.push(Math.min(req.out ?? 0, channel.data.length), req.data?.length ?? 0);
    const lo = channel.call(req.nr, ...args);
    return { ret: channel.result64(lo), data: channel.data };
  };
  const tids = w.tids ? new Int32Array(w.tids) : null;
  const guest = new WasiGuest({
    args: msg.argv, env: msg.env, preopens: w.preopens,
    dataSize: channel.data.length, tid: w.thread?.tid ?? 0,
    threadSpawn: tids ? (startArg) => {
      const tid = Atomics.add(tids, 0, 1);
      if (tid >= 1 << 29) return -A.EAGAIN;
      port.postMessage({ type: 'wasi-thread-spawn', tid, startArg } satisfies WasiGuestMessage);
      return tid;
    } : undefined,
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
      exp.wasi_thread_start(w.thread.tid, w.thread.startArg);
      port.postMessage({ type: 'wasi-thread-exit', tid: w.thread.tid } satisfies WasiGuestMessage);
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
