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
import { SYS_wasi_thread_spawn, SYS_wasix_fork, type SysReply, type SysRequest } from './abi';
import { Asyncify, type StackCapture } from './asyncify';
import { dylinkImports, type DylinkLayout } from './dylink';
import { DynCalls, type FuncSigs } from './dyncall';
import { ProcExit, WasiGuest, buildImports, runSync, type GuestForkState, type Preopen, type StackAction } from './wasi-guest';

export interface WasiStartData {
  module: WebAssembly.Module;
  preopens: Preopen[];
  memory?: WebAssembly.Memory;
  memoryImport?: { module: string; name: string };
  /** Set for wasi-threads threads: run wasi_thread_start(tid, startArg); tid is the message's. */
  thread?: { startArg: number };
  /** Set in a forked child: `memory` is a copy of the parent's; rewind `cap` so proc_fork returns 0. */
  resume?: WasixForkState;
  /** Absolute path of the program (GuestOptions.exe). */
  exe?: string;
  /** Function signatures for WASIX dynamic calls, when the module imports them (./dyncall.ts). */
  funcSigs?: FuncSigs;
  /** A position-independent (dylink.0) module: where its data, stack and table go (./dylink.ts). */
  dylink?: DylinkLayout;
  /** Set for a signal thread: run the WASIX signal callback on an alternate stack, then end. */
  signal?: { sig: number; callback: string; tlsBase: number; stackTop: number };
}

/** What a forking guest sends the host (posted as a `wasix-fork` message just before SYS_wasix_fork). */
export interface WasixForkState {
  cap: StackCapture;
  guest: GuestForkState;
}

export type WasiStartMessage = GuestStartMessage & { tid?: number; wasi: WasiStartData };

/** Messages besides SYS_MESSAGE that a guest posts to the host. */
export type WasiGuestMessage =
  | { type: 'wasi-error'; message: string }
  | { type: 'wasix-fork'; state: WasixForkState }
  /** The main thread registered a WASIX signal callback (host.ts can then run it on a signal thread). */
  | { type: 'wasix-signals'; callback: string | null; tlsBase: number };

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
  let guest: WasiGuest | undefined;
  const call = (req: SysRequest): SysReply => {
    for (;;) {
      if (req.data) channel.data.set(req.data);
      const lo = channel.call(req.nr, ...req.args);
      // SA_RESTART-style: re-issue a call that only an ignored-by-default signal interrupted
      if (lo === -A.EINTR && guest?.takeRestart()) continue;
      guest?.takeRestart();
      return { ret: channel.result64(lo), data: channel.data };
    }
  };
  const tid = msg.tid ?? msg.pid;
  guest = new WasiGuest({
    args: msg.argv, env: msg.env, preopens: w.preopens,
    dataSize: channel.data.length, tid,
    // Threads need the shared memory; the host answers with attachThread
    threadSpawn: w.memory ? (startArg) => call({ nr: SYS_wasi_thread_spawn, args: [startArg] }).ret : undefined,
    exe: w.exe,
    onSignalCallback: w.thread || w.signal ? undefined : (callback) => {
      const tls = guest!.exports?.__tls_base;
      if (tls instanceof WebAssembly.Global) port.postMessage({ type: 'wasix-signals', callback, tlsBase: tls.value } satisfies WasiGuestMessage);
    },
  });
  const extra: Record<string, Record<string, any>> = {};
  const dylink = w.dylink ? dylinkImports(w.module, w.dylink) : null;
  if (dylink) for (const [mod, ns] of Object.entries(dylink.imports)) extra[mod] = { ...ns };
  if (w.memory && w.memoryImport) (extra[w.memoryImport.module] ??= {})[w.memoryImport.name] = w.memory;

  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(w.module, buildImports(guest, w.module, 'sync', call, extra));
  } catch (e: any) {
    port.postMessage({ type: 'wasi-error', message: e?.message ?? String(e) } satisfies WasiGuestMessage);
    return;
  }
  const exp = instance.exports as Record<string, any>;
  guest.memory = w.memory ?? exp.memory;
  guest.exports = exp;
  if (w.funcSigs) {
    const table = (dylink?.imports.env.__indirect_function_table ?? exp.__indirect_function_table) as WebAssembly.Table | undefined;
    const sp = (dylink?.imports.env.__stack_pointer ?? exp.__stack_pointer) as WebAssembly.Global | undefined;
    guest.dyncalls = new DynCalls(w.funcSigs, () => table, () => guest!.memory, () => sp);
  }
  if (dylink) {
    dylink.relocate(exp);
    // Relocations patch shared memory: once per process, by the main thread of a fresh one.
    // __wasm_init_memory set up the main thread's TLS block but left its relocations
    // (threads get theirs from __wasm_init_tls)
    if (!w.thread && !w.resume && !w.signal) {
      exp.__wasm_apply_data_relocs?.();
      exp.__wasm_apply_tls_relocs?.();
    }
  }
  // setjmp/longjmp and fork capture the main thread's stack (asyncified WASIX modules)
  if (!w.thread) guest.asyncify = Asyncify.attach(exp, () => guest.memory);
  channel.onSignal = (sig) => guest.deliverSignal(sig);

  try {
    if (w.signal) {
      // A signal thread (host.ts): the main thread is busy in WASM code, so run its handler here
      const sp = exp.__stack_pointer, tls = exp.__tls_base;
      if (sp instanceof WebAssembly.Global) sp.value = w.signal.stackTop;
      if (tls instanceof WebAssembly.Global) tls.value = w.signal.tlsBase;
      guest.sigCallback = w.signal.callback;
      try { guest.deliverSignal(w.signal.sig); }
      finally { call({ nr: A.SYS_rt_sigreturn, args: [] }); }
      call({ nr: A.SYS_exit, args: [0] });
      return;
    }
    if (w.thread) {
      exp.wasi_thread_start(tid, w.thread.startArg);
      call({ nr: A.SYS_exit, args: [0] }); // ends this thread only; the kernel stops the worker
      return;
    }
    const entry: (() => void) | undefined = typeof exp._start === 'function' ? exp._start
      : typeof exp._initialize === 'function' ? exp._initialize : undefined;
    if (w.resume) {
      // A forked child: same memory as the parent at the fork; rewind into proc_fork, which returns 0
      guest.adoptForkState(w.resume.guest);
      guest.asyncify!.startRewind(w.resume.cap, 0);
    }
    if (entry) runEntry(port, guest, entry, call);
    runSync(guest.exit(0), call);
  } catch (e) {
    if (e instanceof ProcExit) return;
    try { runSync(guest.trap(e), call); } catch { /* ProcExit */ }
  }
}

/**
 * Call the entry export until it really returns. When an import captured
 * the stack (asyncify unwind), the entry returns early: do what the import
 * asked (./wasi-guest.ts StackAction), arrange the rewind and call it again.
 */
function runEntry(port: Port, guest: WasiGuest, entry: () => void, call: (req: SysRequest) => SysReply): void {
  for (;;) {
    entry();
    const ax = guest.asyncify;
    if (!ax || !ax.unwinding) return;
    const action = ax.pending as StackAction;
    const cap = ax.stopUnwind();
    switch (action.op) {
      case 'checkpoint':
        guest.saveSnapshot(action.snapshot, cap);
        ax.startRewind(cap, 0n);
        break;
      case 'restore':
        ax.startRewind(action.cap, action.value);
        break;
      case 'fork': {
        const state: WasixForkState = { cap, guest: guest.forkState() };
        port.postMessage({ type: 'wasix-fork', state } satisfies WasiGuestMessage);
        ax.startRewind(cap, call({ nr: SYS_wasix_fork, args: [] }).ret);
        break;
      }
    }
  }
}
