/**
 * browser-worker.ts — create guest Workers in the browser. Vite bundles the
 * worker inline (a blob URL), so it works in the single-file build too.
 */
import GuestWorker from './guest-worker-entry?worker&inline';
import type { WorkerLike } from './host';

export function createGuestWorker(): WorkerLike {
  return new GuestWorker() as unknown as WorkerLike;
}
