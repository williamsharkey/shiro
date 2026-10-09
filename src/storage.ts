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

/** Ask once per page load for persistent storage; resolves to whether it is granted. */
export function requestPersistentStorage(reason: string): Promise<boolean> {
  if (!requested) {
    const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    requested = (async () => {
      if (!s?.persist) return false;
      if (await s.persisted?.().catch(() => false)) return true;
      const granted = await s.persist().catch(() => false);
      console.log(`[shiro] persistent storage ${granted ? 'granted' : 'not granted'} (${reason})`);
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
