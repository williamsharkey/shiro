/**
 * The machine's memory and storage, one source for every reporter: free,
 * /proc/meminfo, sysinfo(2) and df agree because they all ask here.
 *
 * Memory is the JS heap the page may grow to (performance.memory where the
 * browser has it, else a 256 MB stand-in); storage is the origin's
 * navigator.storage.estimate(), the same numbers `doctor` prints.
 */

export interface MemoryInfo { total: number; used: number; free: number; available: number }

const FALLBACK_TOTAL = 256 * 1024 * 1024;
const FALLBACK_USED = 64 * 1024 * 1024;

/** Bytes of memory: total, used, free and available (free, as nothing is cached) */
export function memoryInfo(): MemoryInfo {
  const mem = (globalThis as { performance?: { memory?: { jsHeapSizeLimit?: number; usedJSHeapSize?: number } } }).performance?.memory;
  const total = mem?.jsHeapSizeLimit || FALLBACK_TOTAL;
  const used = Math.min(total, mem?.usedJSHeapSize || FALLBACK_USED);
  return { total, used, free: total - used, available: total - used };
}

export interface StorageInfo { size: number; used: number; avail: number }

const FALLBACK_QUOTA = 10 * 1024 * 1024 * 1024;

/** Bytes of storage for this origin (quota, usage, the rest) */
export async function storageInfo(): Promise<StorageInfo> {
  let quota = 0, usage = 0;
  try {
    const est = await (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> } } }).navigator?.storage?.estimate?.();
    quota = est?.quota ?? 0;
    usage = est?.usage ?? 0;
  } catch { /* no StorageManager: the fallback below */ }
  if (!quota) quota = FALLBACK_QUOTA;
  usage = Math.min(usage, quota);
  return { size: quota, used: usage, avail: quota - usage };
}
