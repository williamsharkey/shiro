/**
 * browser-worker.ts — create guest Workers in the browser. Vite bundles the
 * worker inline (a blob URL), so it works in the single-file build too.
 * Kept free of imports from the main chunk: a lazy chunk that shares one
 * gets the main chunk's CSS preloaded first, and that file is inlined away.
 */
import GuestWorkerCtor from './guest-worker-entry?worker&inline';
import type { GuestWorker } from '../kernel/worker-host';

export function createGuestWorker(): GuestWorker {
  const w = new GuestWorkerCtor();
  return {
    postMessage: m => w.postMessage(m),
    terminate: () => w.terminate(),
    onMessage: cb => w.addEventListener('message', e => cb((e as MessageEvent).data)),
    onError: cb => w.addEventListener('error', e => { e.preventDefault?.(); cb((e as ErrorEvent).error ?? new Error((e as ErrorEvent).message)); }),
  };
}
