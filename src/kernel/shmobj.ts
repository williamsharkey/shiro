/**
 * Shared objects between Blink instances (docs/research/SHARED_MAPPINGS.md):
 * the kernel half. A shareable object (a /dev/shm file, a SysV shm segment)
 * mapped by one instance is that instance's business: Blink maps it fast,
 * in its own wasm memory. When a second instance maps it, the object becomes
 * *remote* for everyone: its bytes move into one SharedArrayBuffer the kernel
 * owns, every instance that had it mapped fast is asked to publish its pages
 * into that buffer and switch its mapping to remote pages (Blink's slow path:
 * loads, stores and atomics on the buffer), and only then does the new mapping
 * complete. It stays remote until no instance maps it; then a file's bytes are
 * written back to the file.
 *
 * Instances are opaque ids (blink.ts: one per worker). The kernel talks to
 * them through `send` (the page delivers {type: 'blink-shmobj', id, sab} and
 * {type: 'blink-publish', id}); Blink answers a publish request with
 * SYS_shiro_shmobj_published.
 *
 * ABI (data area as in kernel.ts):
 *   shiro_shmobj_map       1020 (fd | shmid, kind, lenLo, lenHi) → object id (> 0);
 *                               data = i32 1 when the mapping is remote (the
 *                               buffer comes by message before the reply), 0 fast.
 *                               kind 0: fd of a /dev/shm (or /run/shm) file
 *                               or a memfd, 1: a SysV shmid; | 0x100: remote
 *                               from the first map (no publish round). The
 *                               buffer is the bytes rounded up to pages, then
 *                               a page of control words (CONTROL_BYTES).
 *   shiro_shmobj_unmap     1021 (id)                             → 0
 *   shiro_shmobj_published 1022 (id)                             → 0
 */

/** One instance's view of a message the page should post to its worker. */
export type ShmObjMessage =
  | { type: 'blink-shmobj'; id: number; sab: SharedArrayBuffer }
  | { type: 'blink-publish'; id: number };

interface SharedObject {
  id: number;
  key: string;
  size: number;
  /** Set once the object is remote */
  sab: SharedArrayBuffer | null;
  /** instance → mapping count */
  mappers: Map<number, number>;
  /** Instances asked to publish that haven't yet: their answers resolve these */
  publishing: Map<number, () => void>;
  /** Instances that have the buffer (sent once each) */
  hasSab: Set<number>;
  /** A file object's bytes go back here when the last mapping goes */
  writeBack?: (bytes: Uint8Array) => void | Promise<void>;
  /** Told the buffer when the object turns remote (a memfd reads and writes through it from then on) */
  onRemote?: (sab: SharedArrayBuffer) => void;
}

export interface MapOptions {
  /**
   * Remote from the first map (the kind | 0x100 flag): no publish round is
   * ever needed, at the price of the slow path for a single instance too.
   * (A holder parked in a blocking call can't publish until it returns.)
   */
  eager?: boolean;
  onRemote?: SharedObject['onRemote'];
}

/**
 * A buffer holds the object's bytes rounded up to whole pages, then one page
 * of control words that Blink uses (word 0: the object's lock, 1: threads
 * waiting for it; vendor/blink/shiro-kernel.js).
 */
export const CONTROL_BYTES = 4096;
export const objectBytes = (size: number): number => Math.ceil(size / 4096) * 4096;

/** Paths whose files are shareable objects (POSIX shm and named semaphores live there). */
export function isShareablePath(path: string): boolean {
  return path.startsWith('/dev/shm/') || path.startsWith('/run/shm/');
}

export class SharedObjects {
  private byKey = new Map<string, SharedObject>();
  private byId = new Map<number, SharedObject>();
  private nextId = 1;
  /** How long a mapping waits for holders to publish before giving up (a crashed instance) */
  publishTimeoutMs = 5000;

  constructor(private send: (instance: number, msg: ShmObjMessage) => void) {}

  /**
   * `instance` maps the object named `key` (size `size`). `initial` gives the
   * bytes a new buffer starts with (a file's contents) when the object turns
   * remote. Resolves with its id and whether the mapping is remote.
   */
  async map(instance: number, key: string, size: number, initial?: () => Uint8Array | Promise<Uint8Array>,
    writeBack?: SharedObject['writeBack'], opts: MapOptions = {}): Promise<{ id: number; remote: boolean } | number> {
    if (size <= 0) return -22; // EINVAL
    let o = this.byKey.get(key);
    if (!o) {
      o = { id: this.nextId++, key, size, sab: null, mappers: new Map(), publishing: new Map(), hasSab: new Set(), writeBack, onRemote: opts.onRemote };
      this.byKey.set(key, o);
      this.byId.set(o.id, o);
    }
    if (size > o.size && !o.sab) o.size = size;
    const others = [...o.mappers.keys()].filter((i) => i !== instance);
    if (!o.sab && others.length === 0 && !opts.eager) {
      o.mappers.set(instance, (o.mappers.get(instance) ?? 0) + 1);
      return { id: o.id, remote: false };
    }
    if (!o.sab) {
      // The second instance (or an eager first map): one buffer, seeded from
      // the file; the fast holders, if any, publish into it
      // (then a page of control words: Blink's lock for the object)
      const sab = new SharedArrayBuffer(objectBytes(o.size) + CONTROL_BYTES);
      if (initial) {
        const bytes = await initial();
        new Uint8Array(sab).set(bytes.subarray(0, o.size));
      }
      o.sab = sab;
      o.onRemote?.(sab);
      const waits = others.map((holder) => new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { o!.publishing.delete(holder); resolve(false); }, this.publishTimeoutMs);
        o!.publishing.set(holder, () => { clearTimeout(timer); resolve(true); });
        this.giveSab(o!, holder);
        this.send(holder, { type: 'blink-publish', id: o!.id });
      }));
      await Promise.all(waits);
    }
    this.giveSab(o, instance);
    o.mappers.set(instance, (o.mappers.get(instance) ?? 0) + 1);
    return { id: o.id, remote: true };
  }

  private giveSab(o: SharedObject, instance: number): void {
    if (!o.sab || o.hasSab.has(instance)) return;
    o.hasSab.add(instance);
    this.send(instance, { type: 'blink-shmobj', id: o.id, sab: o.sab });
  }

  /** A holder copied its pages into the buffer and switched to remote pages. */
  published(instance: number, id: number): number {
    const o = this.byId.get(id);
    const done = o?.publishing.get(instance);
    if (!o || !done) return -22;
    o.publishing.delete(instance);
    done();
    return 0;
  }

  async unmap(instance: number, id: number): Promise<number> {
    const o = this.byId.get(id);
    const n = o?.mappers.get(instance) ?? 0;
    if (!o || !n) return -22;
    if (n > 1) { o.mappers.set(instance, n - 1); return 0; }
    o.mappers.delete(instance);
    o.hasSab.delete(instance);
    o.publishing.get(instance)?.(); // it won't publish now
    if (o.mappers.size === 0) await this.drop(o);
    return 0;
  }

  /** An instance ended (worker gone): all its mappings go. */
  async instanceGone(instance: number): Promise<void> {
    for (const o of [...this.byId.values()]) {
      if (!o.mappers.has(instance) && !o.publishing.has(instance)) continue;
      o.mappers.delete(instance);
      o.hasSab.delete(instance);
      o.publishing.get(instance)?.();
      if (o.mappers.size === 0) await this.drop(o);
    }
  }

  private async drop(o: SharedObject): Promise<void> {
    this.byKey.delete(o.key);
    this.byId.delete(o.id);
    if (o.sab && o.writeBack) await o.writeBack(new Uint8Array(o.sab, 0, o.size).slice());
  }

  /** The live buffer of a remote object (read/write syscalls on its file go here), or null. */
  bufferFor(key: string): SharedArrayBuffer | null {
    return this.byKey.get(key)?.sab ?? null;
  }

  /** For tests and /proc: objects and their mappers. */
  list(): { id: number; key: string; size: number; remote: boolean; mappers: number[] }[] {
    return [...this.byId.values()].map((o) => ({ id: o.id, key: o.key, size: o.size, remote: !!o.sab, mappers: [...o.mappers.keys()] }));
  }
}
