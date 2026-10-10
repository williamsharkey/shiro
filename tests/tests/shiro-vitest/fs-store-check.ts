import { expect } from 'vitest';
import type { FileSystem } from '@shiro/filesystem';

/** Every record in the store, after a sync. */
export async function stored(fs: FileSystem): Promise<Map<string, any>> {
  await fs.sync();
  const db = (fs as any).db as IDBDatabase;
  const all = await new Promise<any[]>((r, j) => { const q = db.transaction('files').objectStore('files').getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  return new Map(all.map((n) => [n.path, n]));
}
/** Stubs, inode records and the link map agree; blocks belong to live owners. */
export function checkStore(recs: Map<string, any>): void {
  const map = new Map<string, number>(recs.get('\u0001links')?.links ?? []);
  for (const [p, n] of recs) {
    if (p.startsWith('\u0001i/')) {
      expect(n.names.length, `${p} has fewer than 2 names`).toBeGreaterThanOrEqual(2);
      for (const name of n.names) {
        expect(recs.get(name)?.link, `${name} of ${p} is not its stub`).toBe(n.ino);
        expect(map.get(name), `${name} missing from the link map`).toBe(n.ino);
      }
    } else if (!p.startsWith('\u0001') && n.link !== undefined) {
      expect(recs.get(`\u0001i/${n.link}`)?.names, `stub ${p} without its inode`).toContain(p);
    }
  }
  for (const [name, ino] of map) expect(recs.get(name)?.link, `link map entry ${name}`).toBe(ino);
  const blobs = new Map<string, string>(recs.get('\u0001blobs')?.blobs ?? []);
  const owners = new Map([...blobs].map(([p, id]) => [id, p]));
  for (const k of recs.keys()) {
    if (!k.startsWith('\u0001b/')) continue;
    const id = k.slice(3, k.lastIndexOf('/'));
    const owner = owners.get(id);
    expect(owner, `orphaned block ${k}`).toBeDefined();
    expect(recs.get(owner!)?.blob, `block ${k} of a blob its owner doesn't use`).toBe(id);
  }
}
