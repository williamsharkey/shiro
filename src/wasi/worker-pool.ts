/**
 * worker-pool.ts — reuse guest Workers across WASM processes.
 *
 * Starting a Worker (loading and compiling the guest bundle in a new
 * isolate) is most of what spawning a WASM process costs in a cross-origin
 * isolated page. A guest Worker returns to its event loop when its program
 * ends (its channel closes, ./guest-worker.ts posts `wasi-idle`), and can
 * run the next program: guest-worker.ts keeps no state between runs.
 *
 * `pooled(factory)` wraps a GuestWorkerFactory. Each process gets a lease:
 * a GuestWorker whose listeners belong to that process only. `terminate()`
 * on a lease hands the Worker back; the pool keeps it once it reports idle
 * (a guest killed while computing never does, and is really terminated
 * after IDLE_TIMEOUT_MS). Up to MAX_IDLE Workers wait in the pool while
 * processes are being spawned, and one is started ahead of time after each
 * lease so the next spawn finds one. A Worker whose process just ended
 * counts as available while it unwinds: a spawn that finds none idle waits
 * for it (up to RETURN_WAIT_MS) rather than starting another, and no spare is
 * started meanwhile. TRIM_AFTER_MS after the last spawn the
 * pool keeps only KEEP_WARM (terminating Workers is work too, so it happens
 * when nothing is spawning).
 */

import type { Process } from '../kernel/process';
import type { GuestWorker } from '../kernel/worker-host';

/** Posted by a guest Worker when the program it ran has ended and it can take another start message. */
export const IDLE_MESSAGE = 'wasi-idle';

const MAX_IDLE = 8;
const KEEP_WARM = 2;
const TRIM_AFTER_MS = 10_000;
const IDLE_TIMEOUT_MS = 1000;
/** How long a spawn waits for a returning Worker before starting a new one. */
const RETURN_WAIT_MS = 250;

interface Slot {
  w: GuestWorker;
  lease: Lease | null;
  /** Ran a program and reported idle since (or never ran one). */
  idle: boolean;
  dead: boolean;
  /** Waiting for the idle report after a lease ended. */
  onIdle: (() => void) | null;
}

interface Lease {
  /** null until a Worker is bound (the lease waits for a returning one). */
  slot: Slot | null;
  /** Messages posted before the Worker was bound. */
  queued: unknown[];
  msgs: ((m: unknown) => void)[];
  errs: ((e: unknown) => void)[];
  exits: ((code: number) => void)[];
  ended: boolean;
  proc: Process;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface WorkerPool {
  acquire(proc: Process): GuestWorker;
  /** Workers alive (leased or idle); for tests and diagnostics. */
  readonly size: number;
  readonly idleCount: number;
  /** Terminate idle Workers. */
  drain(): void;
}

export function createWorkerPool(factory: (proc: Process) => GuestWorker): WorkerPool {
  const slots = new Set<Slot>();
  const idle: Slot[] = [];

  const kill = (s: Slot) => {
    if (s.dead) return;
    s.dead = true;
    slots.delete(s);
    const i = idle.indexOf(s);
    if (i >= 0) idle.splice(i, 1);
    try { void s.w.terminate(); } catch { /* already gone */ }
  };

  const create = (proc: Process): Slot => {
    const s: Slot = { w: factory(proc), lease: null, idle: true, dead: false, onIdle: null };
    slots.add(s);
    s.w.onMessage((m) => {
      if (m === IDLE_MESSAGE) {
        s.idle = true;
        s.onIdle?.();
        return;
      }
      if (s.lease && !s.lease.ended) for (const cb of s.lease.msgs) cb(m);
    });
    s.w.onError((e) => {
      const lease = s.lease;
      if (lease && !lease.ended) for (const cb of lease.errs) cb(e);
      // An uncaught error leaves the worker in an unknown state: never reuse it
      kill(s);
    });
    s.w.onExit?.((code) => {
      const lease = s.lease;
      s.dead = true;
      slots.delete(s);
      const i = idle.indexOf(s);
      if (i >= 0) idle.splice(i, 1);
      if (lease && !lease.ended) for (const cb of lease.exits) cb(code);
    });
    return s;
  };

  /** Released Workers that haven't reported idle yet. */
  let returning = 0;
  /** Leases waiting for a returning Worker. */
  const waiting: Lease[] = [];

  const bind = (lease: Lease, s: Slot) => {
    lease.slot = s;
    s.lease = lease;
    s.idle = false;
    for (const m of lease.queued.splice(0)) s.w.postMessage(m);
  };

  /** A Worker for the oldest waiting lease (a returning one came back, or one was lost). */
  const serveWaiting = (s: Slot | null, proc?: Process) => {
    while (waiting.length && waiting[0].ended) waiting.shift();
    const lease = waiting.shift();
    if (!lease) return false;
    clearTimeout(lease.timer);
    bind(lease, s ?? create(proc ?? lease.proc));
    return true;
  };

  const release = (s: Slot) => {
    s.lease = null;
    if (s.dead) return;
    let counted = false;
    const keep = () => {
      s.onIdle = null;
      clearTimeout(timer);
      if (counted) { counted = false; returning--; }
      if (s.dead || s.lease) return;
      if (serveWaiting(s)) return;
      if (idle.length >= MAX_IDLE) kill(s);
      else idle.push(s);
    };
    // The guest unwinds when its channel closes; one still computing never reports idle
    const timer = setTimeout(() => {
      if (s.idle) return;
      s.onIdle = null;
      if (counted) { counted = false; returning--; }
      kill(s);
      // A spawn was counting on this one
      if (waiting.length > returning) serveWaiting(null);
    }, IDLE_TIMEOUT_MS);
    (timer as any)?.unref?.();
    if (s.idle) keep();
    else { counted = true; returning++; s.onIdle = keep; }
  };

  let trimTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleTrim = () => {
    if (trimTimer) clearTimeout(trimTimer);
    trimTimer = setTimeout(() => {
      trimTimer = null;
      while (idle.length > KEEP_WARM) kill(idle[0]);
    }, TRIM_AFTER_MS);
    (trimTimer as any)?.unref?.();
  };

  /** Start a Worker now so the next spawn doesn't wait for one (unless one is on its way back). */
  let prewarming = false;
  const prewarm = (proc: Process) => {
    if (prewarming || idle.length > 0 || returning > waiting.length || slots.size >= MAX_IDLE * 2) return;
    prewarming = true;
    const t = setTimeout(() => {
      prewarming = false;
      if (idle.length === 0 && returning <= waiting.length) idle.push(create(proc));
    }, 0);
    (t as any)?.unref?.();
  };

  return {
    acquire(proc: Process): GuestWorker {
      let s = idle.pop();
      while (s && s.dead) s = idle.pop();
      const lease: Lease = { slot: null, queued: [], msgs: [], errs: [], exits: [], ended: false, proc, timer: undefined };
      if (s) bind(lease, s);
      else if (returning > waiting.length) {
        // A Worker is unwinding from the process that just ended: take it rather than start another
        waiting.push(lease);
        lease.timer = setTimeout(() => {
          const i = waiting.indexOf(lease);
          if (i >= 0 && !lease.ended) { waiting.splice(i, 1); bind(lease, create(proc)); }
        }, RETURN_WAIT_MS);
        (lease.timer as any)?.unref?.();
      } else bind(lease, create(proc));
      prewarm(proc);
      scheduleTrim();
      return {
        postMessage: (m) => {
          if (lease.ended) return;
          if (lease.slot) lease.slot.w.postMessage(m);
          else lease.queued.push(m);
        },
        terminate: () => {
          if (lease.ended) return;
          lease.ended = true;
          clearTimeout(lease.timer);
          if (lease.slot) release(lease.slot);
        },
        onMessage: (cb) => { lease.msgs.push(cb); },
        onError: (cb) => { lease.errs.push(cb); },
        onExit: (cb) => { lease.exits.push(cb); },
      };
    },
    get size() { return slots.size; },
    get idleCount() { return idle.length; },
    drain() {
      if (trimTimer) { clearTimeout(trimTimer); trimTimer = null; }
      for (const l of waiting.splice(0)) { clearTimeout(l.timer); if (!l.ended) bind(l, create(l.proc)); }
      for (const s of [...idle]) kill(s);
    },
  };
}
