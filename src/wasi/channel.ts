/**
 * channel.ts — SharedArrayBuffer syscall channel between a guest Worker and
 * the kernel, plus the transport check.
 *
 * TEMPORARY SHIM for src/kernel/channel.ts (unix/kernel). The layout is the
 * one in docs/KERNEL_ABI.md; constants live in ./abi.ts.
 */

import {
  CH_ARGS, CH_DATA, CH_DEFAULT_DATA, CH_NARGS, CH_NR, CH_REPLY_LEN, CH_REQ_LEN, CH_RESULT,
  CH_STATE, EIO, STATE_IDLE, STATE_REPLY, STATE_REQUEST, SysReply, SysRequest,
} from './abi';

/** How a guest can block on a syscall here: SAB+Atomics.wait, JSPI, or not at all. */
export function canBlock(): 'sab' | 'jspi' | 'none' {
  const g = globalThis as any;
  if (typeof SharedArrayBuffer === 'function' && g.crossOriginIsolated !== false && typeof Worker === 'function') {
    return 'sab';
  }
  if (jspiAvailable()) return 'jspi';
  return 'none';
}

/** True when this engine can suspend WASM on a JS promise (JSPI). */
export function jspiAvailable(): boolean {
  const W = WebAssembly as any;
  return typeof W.Suspending === 'function' && typeof W.promising === 'function';
}

export function createChannelBuffer(dataSize = CH_DEFAULT_DATA): SharedArrayBuffer {
  return new SharedArrayBuffer(CH_DATA + dataSize);
}

/**
 * Guest side: synchronous calls over the channel. `notify` tells the kernel a
 * request is posted (postMessage('sys') for a main-thread kernel).
 */
export class GuestChannel {
  readonly i32: Int32Array;
  readonly bytes: Uint8Array;
  readonly dataSize: number;

  /**
   * The kernel watches the state word with Atomics.waitAsync (see
   * watchChannel), so a request needs no postMessage.
   */
  notifyByAtomics = false;

  constructor(readonly sab: SharedArrayBuffer, private notify: () => void) {
    this.i32 = new Int32Array(sab, 0, CH_DATA / 4);
    this.bytes = new Uint8Array(sab);
    this.dataSize = sab.byteLength - CH_DATA;
  }

  /** One round trip. `req.data` must fit the data area (callers split). */
  call(req: SysRequest): SysReply {
    const { i32, bytes } = this;
    if (req.args.length > CH_NARGS) throw new Error(`syscall ${req.nr}: too many args`);
    i32[CH_NR] = req.nr;
    for (let i = 0; i < CH_NARGS; i++) i32[CH_ARGS + i] = req.args[i] ?? 0;
    const reqLen = req.data ? req.data.length : 0;
    if (req.data) {
      if (reqLen > this.dataSize) throw new Error(`syscall ${req.nr}: ${reqLen} bytes exceed the channel`);
      bytes.set(req.data, CH_DATA);
    }
    i32[CH_REQ_LEN] = reqLen;
    Atomics.store(i32, CH_STATE, STATE_REQUEST);
    if (this.notifyByAtomics) Atomics.notify(i32, CH_STATE);
    else this.notify();
    while (Atomics.load(i32, CH_STATE) === STATE_REQUEST) {
      Atomics.wait(i32, CH_STATE, STATE_REQUEST);
    }
    const ret = i32[CH_RESULT];
    const len = i32[CH_REPLY_LEN];
    const out = len > 0 ? bytes.slice(CH_DATA, CH_DATA + len) : undefined;
    Atomics.store(i32, CH_STATE, STATE_IDLE);
    return { ret, out };
  }
}

/**
 * Kernel side: service one posted request with `handler` and wake the guest.
 * Call it when the guest's 'sys' message arrives.
 */
export async function serviceRequest(
  sab: SharedArrayBuffer,
  handler: (req: SysRequest, dataSize: number) => Promise<SysReply>,
): Promise<void> {
  const i32 = new Int32Array(sab, 0, CH_DATA / 4);
  if (Atomics.load(i32, CH_STATE) !== STATE_REQUEST) return;
  const bytes = new Uint8Array(sab);
  const dataSize = sab.byteLength - CH_DATA;
  const nr = i32[CH_NR];
  const args: number[] = [];
  for (let i = 0; i < CH_NARGS; i++) args.push(i32[CH_ARGS + i]);
  const reqLen = Math.max(0, Math.min(i32[CH_REQ_LEN], dataSize));
  const data = bytes.slice(CH_DATA, CH_DATA + reqLen);
  let reply: SysReply;
  try {
    reply = await handler({ nr, args, data }, dataSize);
  } catch (e) {
    console.error('[wasi] syscall', nr, 'failed:', e);
    reply = { ret: -EIO };
  }
  let len = 0;
  if (reply.out && reply.out.length) {
    len = Math.min(reply.out.length, dataSize);
    bytes.set(reply.out.subarray(0, len), CH_DATA);
  }
  i32[CH_RESULT] = reply.ret;
  i32[CH_REPLY_LEN] = len;
  Atomics.store(i32, CH_STATE, STATE_REPLY);
  Atomics.notify(i32, CH_STATE);
}

/** True when this side can watch a channel with Atomics.waitAsync. */
export function canWatchChannel(): boolean {
  return typeof (Atomics as any).waitAsync === 'function';
}

/**
 * Kernel side without postMessage: wait for requests on the state word with
 * Atomics.waitAsync and service each. Returns a stop function.
 */
export function watchChannel(
  sab: SharedArrayBuffer,
  handler: (req: SysRequest, dataSize: number) => Promise<SysReply>,
): () => void {
  const i32 = new Int32Array(sab, 0, CH_DATA / 4);
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const state = Atomics.load(i32, CH_STATE);
      if (state === STATE_REQUEST) { await serviceRequest(sab, handler); continue; }
      const w = (Atomics as any).waitAsync(i32, CH_STATE, state);
      if (w.async) await w.value;
    }
  })();
  return () => { stopped = true; Atomics.notify(i32, CH_STATE); };
}
