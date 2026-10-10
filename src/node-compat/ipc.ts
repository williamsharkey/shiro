/**
 * node's IPC channel ('json' serialization: one JSON text per line), for
 * fork() and stdio 'ipc' between kernel guests (src/node-worker/child.ts
 * makes the socketpair; the child finds it as NODE_CHANNEL_FD).
 */
import type { GuestIpc } from '../node-worker/hooks';

// (the Worker's own timer, captured before a script's globals stand in: no program activity)
const later = globalThis.setTimeout.bind(globalThis);

/** One message's bytes on the channel */
export const ipcLine = (m: unknown): string => JSON.stringify(m) + '\n';

/** Bytes in, whole messages out (node's own NODE_* messages are not the program's) */
export function ipcReader(onMessage: (m: unknown) => void): (b: Uint8Array) => void {
  const dec = new TextDecoder();
  let buf = '';
  return (b) => {
    buf += dec.decode(b, { stream: true });
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      if (m && typeof m === 'object' && typeof m.cmd === 'string' && m.cmd.startsWith('NODE_')) continue;
      onMessage(m);
    }
  };
}

/** send()'s optional arguments: (message, [sendHandle], [options], [callback]) */
const callbackOf = (rest: unknown[]): ((e: Error | null) => void) | undefined => rest.find((a) => typeof a === 'function') as any;

const closedError = () => Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });

/**
 * A forked node's side: process.send, process.on('message'), connected,
 * disconnect() and channel.ref()/unref(). Returns whether the channel keeps
 * the process alive (connected, ref()'d, and something listens), as in node.
 */
export function attachProcessIpc(proc: any, ipc: GuestIpc, events: Record<string, Function[]>): () => boolean {
  let refd = true;
  const disconnected = () => {
    if (!proc.connected) return;
    proc.connected = false;
    queueMicrotask(() => proc.emit('disconnect'));
  };
  proc.connected = true;
  proc.channel = { ref() { refd = true; }, unref() { refd = false; } };
  proc.send = (message: unknown, ...rest: unknown[]) => {
    const cb = callbackOf(rest);
    if (!proc.connected) {
      const e = closedError();
      queueMicrotask(() => (cb ? cb(e) : proc.emit('error', e)));
      return false;
    }
    if (message === undefined) throw Object.assign(new TypeError('The "message" argument must be specified'), { code: 'ERR_MISSING_ARGS' });
    const ok = ipc.send(ipcLine(message));
    if (!ok) disconnected();
    if (cb) queueMicrotask(() => cb(ok ? null : closedError()));
    return ok;
  };
  proc.disconnect = () => {
    if (!proc.connected) return;
    ipc.close();
    disconnected();
  };
  // Messages that came before anything listens wait for a listener (the parent may send
  // before the child's script has run: jest-worker's first message), then go in order
  const pending: unknown[] = [];
  let waiting = false;
  const flush = () => {
    waiting = false;
    if (!(events['message']?.length)) { if (pending.length && proc.connected) { waiting = true; later(flush, 5); } return; }
    for (const m of pending.splice(0)) proc.emit('message', m, undefined);
  };
  const read = ipcReader((m) => { pending.push(m); if (!waiting) flush(); });
  ipc.onData((b) => { if (b) read(b); else disconnected(); });
  return () => proc.connected && refd && ((events['message']?.length ?? 0) + (events['disconnect']?.length ?? 0)) > 0;
}
