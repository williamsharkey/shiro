/**
 * Unpacking .deb files (ar + data.tar.{xz,zst,gz}), and a pool of workers
 * that does it off the main thread: JavaScript xz runs at ~25 MB/s, and the
 * GTK apps' closures are 140-180 MB of tar.
 */
import { untar, gunzip, type TarEntry } from '../pkg-tar';

/** Members of an ar archive (.deb). */
export function arMembers(b: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (new TextDecoder().decode(b.subarray(0, 8)) !== '!<arch>\n') throw new Error('not a .deb (ar) file');
  let off = 8;
  const dec = new TextDecoder();
  while (off + 60 <= b.length) {
    const name = dec.decode(b.subarray(off, off + 16)).trim().replace(/\/$/, '');
    const size = parseInt(dec.decode(b.subarray(off + 48, off + 58)).trim(), 10);
    off += 60;
    out.set(name, b.subarray(off, off + size));
    off += size + (size & 1);
  }
  return out;
}

/** The data.tar entries of a .deb. */
export async function debEntries(deb: Uint8Array): Promise<TarEntry[]> {
  const m = arMembers(deb);
  for (const [name, data] of m) {
    if (!name.startsWith('data.tar')) continue;
    let tar: Uint8Array;
    if (name.endsWith('.xz')) tar = (await import('../commands/compress/xz-codec')).xzDecompressDetailed(data).data;
    else if (name.endsWith('.zst')) tar = (await import('../commands/compress/zstd-codec')).zstdDecodeAll(data);
    else if (name.endsWith('.gz')) tar = await gunzip(data);
    else if (name === 'data.tar') tar = data;
    else throw new Error(`unsupported ${name}`);
    return untar(tar);
  }
  throw new Error('.deb has no data.tar');
}

// ── worker pool ──

interface Job { deb: Uint8Array; resolve: (e: TarEntry[]) => void; reject: (e: Error) => void }
interface PoolWorker { w: Worker; job: Job | null }

let pool: PoolWorker[] | null = null;
const queue: Job[] = [];

function poolSize(): number {
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(4, cores));
}

function startPool(): PoolWorker[] | null {
  if (typeof Worker === 'undefined' || typeof document === 'undefined') return null;
  try {
    return Array.from({ length: poolSize() }, () => {
      const pw: PoolWorker = { w: new Worker(new URL('./deb-worker.ts', import.meta.url), { type: 'module', name: 'deb' }), job: null };
      pw.w.onmessage = (ev: MessageEvent<{ entries?: TarEntry[]; error?: string }>) => {
        const job = pw.job!;
        pw.job = null;
        if (ev.data.error !== undefined) job.reject(new Error(ev.data.error)); else job.resolve(ev.data.entries!);
        pump();
      };
      pw.w.onerror = (ev) => {
        const job = pw.job;
        pw.job = null;
        // this worker is broken: do its job (and later ones) on this thread
        pool = pool!.filter((x) => x !== pw);
        if (job) debEntries(job.deb).then(job.resolve, job.reject);
        void ev;
        pump();
      };
      return pw;
    });
  } catch { return null; }
}

function pump(): void {
  for (const pw of pool ?? []) {
    if (pw.job || !queue.length) continue;
    pw.job = queue.shift()!;
    const d = pw.job.deb;
    // a copy only when the .deb is a view of a bigger buffer
    const own = d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? d : d.slice();
    pw.w.postMessage({ deb: own }, [own.buffer as ArrayBuffer]);
  }
  if (pool && !pool.length) while (queue.length) { const j = queue.shift()!; debEntries(j.deb).then(j.resolve, j.reject); }
}

/** debEntries in a worker when there are workers (the page); `deb` is transferred (detached) then. */
export function debEntriesOffThread(deb: Uint8Array): Promise<TarEntry[]> {
  pool ??= startPool();
  if (!pool || !pool.length) return debEntries(deb);
  return new Promise((resolve, reject) => { queue.push({ deb, resolve, reject }); pump(); });
}
