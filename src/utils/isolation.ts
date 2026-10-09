/**
 * Cross-origin isolation status.
 *
 * shiro.computer serves COOP same-origin + COEP credentialless (server.mjs,
 * SHIRO_ISOLATION=0 turns it off), which makes the page crossOriginIsolated and
 * enables SharedArrayBuffer + Atomics.wait for blocking syscalls from worker
 * processes. Pages that can't be isolated (seed blob inside a host page, the
 * public docs pages, file://) should fall back to JSPI / async paths.
 */
export function isIsolated(): boolean {
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
    && typeof SharedArrayBuffer !== 'undefined';
}

/** One boot-time console line saying whether blocking syscalls are available. */
export function logIsolationStatus(): void {
  if (isIsolated()) {
    console.log('[tabcomputer] Cross-origin isolated: SharedArrayBuffer and Atomics.wait available');
  } else {
    console.log('[tabcomputer] Not cross-origin isolated (no COOP/COEP): SharedArrayBuffer unavailable, worker syscalls use the async fallback');
  }
}
