/**
 * guest-worker.ts — body of the Worker that runs one WASM thread of a process.
 *
 * The host (./host.ts) posts a 'start' message with the compiled module, a
 * syscall channel and, for threaded modules, the shared memory. Every WASI
 * call then blocks on the channel; the worker never touches the filesystem
 * or the terminal itself.
 */

import { GuestChannel } from './channel';
import { ProcExit, WasiGuest, buildImports, runSync, type Preopen } from './wasi-guest';

export interface GuestStart {
  type: 'start';
  module: WebAssembly.Module;
  channel: SharedArrayBuffer;
  memory?: WebAssembly.Memory;
  memoryImport?: { module: string; name: string };
  args: string[];
  env: Record<string, string>;
  preopens: Preopen[];
  /** The kernel watches the channel with Atomics.waitAsync: don't post 'sys'. */
  notifyByAtomics?: boolean;
  /** Present for wasi-threads threads: run wasi_thread_start(tid, startArg). */
  thread?: { tid: number; startArg: number };
}

export type GuestMessage =
  | { type: 'sys' }
  | { type: 'done' }
  | { type: 'thread-exit'; tid: number }
  | { type: 'error'; message: string };

export interface Port {
  postMessage(msg: GuestMessage): void;
  onmessage: ((ev: { data: any }) => void) | null;
}

export function guestMain(port: Port): void {
  port.onmessage = (ev) => {
    const msg = ev.data as GuestStart;
    if (msg?.type === 'start') run(port, msg);
  };
}

function run(port: Port, msg: GuestStart): void {
  const channel = new GuestChannel(msg.channel, () => port.postMessage({ type: 'sys' }));
  channel.notifyByAtomics = !!msg.notifyByAtomics;
  const call = (req: any) => channel.call(req);
  const guest = new WasiGuest({
    args: msg.args, env: msg.env, preopens: msg.preopens,
    dataSize: channel.dataSize, tid: msg.thread?.tid ?? 0,
  });
  const extra: Record<string, Record<string, any>> = {};
  if (msg.memory && msg.memoryImport) extra[msg.memoryImport.module] = { [msg.memoryImport.name]: msg.memory };

  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(msg.module, buildImports(guest, msg.module, 'sync', call, extra));
  } catch (e: any) {
    port.postMessage({ type: 'error', message: e?.message ?? String(e) });
    return;
  }
  const exp = instance.exports as Record<string, any>;
  guest.memory = msg.memory ?? exp.memory;

  try {
    if (msg.thread) {
      exp.wasi_thread_start(msg.thread.tid, msg.thread.startArg);
      port.postMessage({ type: 'thread-exit', tid: msg.thread.tid });
      return;
    }
    if (typeof exp._start === 'function') exp._start();
    else if (typeof exp._initialize === 'function') exp._initialize();
    runSync(guest.exit(0), call);
  } catch (e) {
    if (!(e instanceof ProcExit)) {
      try { runSync(guest.trap(e), call); } catch { /* ProcExit */ }
    }
  }
  port.postMessage({ type: 'done' });
}
