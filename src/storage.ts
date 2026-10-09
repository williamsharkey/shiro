/**
 * The browser storage the filesystem lives in (IndexedDB, under the origin's
 * quota): asking for persistence and reporting usage.
 *
 * Persistence (navigator.storage.persist()) keeps the browser from evicting
 * the filesystem under storage pressure. Firefox asks the user, so it is
 * requested when the machine starts holding a lot (`debian install`, a big
 * write), not on every page load.
 */

export interface StorageInfo {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

let requested: Promise<boolean> | null = null;

/** The page's filesystem (main.ts), for flushStorage. */
let activeFs: { flushAll(timeoutMs?: number): Promise<void> } | null = null;
export function setActiveFileSystem(fs: typeof activeFs): void { activeFs = fs; }

/** Commit everything written (open files too) before the page reloads or navigates away; bounded. */
export async function flushStorage(timeoutMs = 5000): Promise<void> {
  await activeFs?.flushAll(timeoutMs).catch(() => {});
}

/** location.reload() after flushStorage (Restart, switching the UI). */
export function reloadAfterFlush(go: () => void = () => location.reload()): void {
  void flushStorage().then(go, go);
}

/** Ask once per page load for persistent storage; resolves to whether it is granted. */
export function requestPersistentStorage(reason: string): Promise<boolean> {
  if (!requested) {
    const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    requested = (async () => {
      if (!s?.persist) return false;
      if (await s.persisted?.().catch(() => false)) return true;
      const granted = await s.persist().catch(() => false);
      console.log(`[tabcomputer] persistent storage ${granted ? 'granted' : 'not granted'} (${reason})`);
      return granted;
    })();
  }
  return requested;
}

export async function storageInfo(): Promise<StorageInfo> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  const [est, persisted] = await Promise.all([
    s?.estimate?.().catch(() => null) ?? null,
    s?.persisted?.().catch(() => null) ?? null,
  ]);
  return { usage: est?.usage ?? null, quota: est?.quota ?? null, persisted };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
