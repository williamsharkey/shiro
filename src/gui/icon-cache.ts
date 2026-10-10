/**
 * GTK's icon-theme.cache (what gtk-update-icon-cache writes, Debian's trigger
 * when a package adds icons to a theme), built by the installer in the page.
 * Without one GTK stats every directory of the theme at each start: ~1.8 s of
 * every GTK app's launch in Blink for hicolor, whose index lists hundreds.
 * GTK trusts a cache newer than the theme directory, so it is rewritten after
 * every install that put icons there.
 *
 * Format (gtk/gtkiconcache.c; big-endian): header {u16 major=1, u16 minor=0,
 * u32 hash offset, u32 directory list offset}; directory list {u32 n, u32
 * string offsets}; hash {u32 n_buckets, u32 icon offsets (0xffffffff: none)};
 * icon {u32 next in chain, u32 name offset, u32 image list offset}; image list
 * {u32 n, images {u16 directory index, u16 suffix flags, u32 data offset (0)}}.
 */
import type { FileSystem } from '../filesystem';

const SUFFIX: Record<string, number> = { xpm: 1, svg: 2, png: 4, icon: 8 };
const NONE = 0xffffffff;

/** GTK's icon_name_hash (signed chars) */
export function iconNameHash(name: string): number {
  const b = new TextEncoder().encode(name);
  if (!b.length) return 0;
  let h = (b[0] << 24) >> 24;
  for (let i = 1; i < b.length; i++) h = (Math.imul(h, 31) + ((b[i] << 24) >> 24)) | 0;
  return h >>> 0;
}

/** The cache for icons found as `files` (paths relative to the theme directory) */
export function buildIconCache(files: string[]): Uint8Array {
  const dirs: string[] = [];
  const dirIndex = new Map<string, number>();
  const icons = new Map<string, Map<number, number>>(); // name → directory → flags
  for (const f of files) {
    const slash = f.lastIndexOf('/');
    if (slash < 0) continue; // the theme's own files (index.theme)
    const dir = f.slice(0, slash), base = f.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    const flag = dot > 0 ? SUFFIX[base.slice(dot + 1).toLowerCase()] : undefined;
    if (!flag) continue;
    if (!dirIndex.has(dir)) { dirIndex.set(dir, dirs.length); dirs.push(dir); }
    const name = base.slice(0, dot);
    const per = icons.get(name) ?? new Map<number, number>();
    const d = dirIndex.get(dir)!;
    per.set(d, (per.get(d) ?? 0) | flag);
    icons.set(name, per);
  }
  const enc = new TextEncoder();
  const names = [...icons.keys()];
  const nBuckets = Math.max(1, Math.ceil(names.length / 2) | 1);
  // layout: header, directory list, hash, icons, image lists, strings
  const align = (n: number) => (n + 3) & ~3;
  let off = 12;
  const dirListOff = off; off += 4 + 4 * dirs.length;
  const hashOff = off; off += 4 + 4 * nBuckets;
  const iconOff = new Map<string, number>();
  for (const n of names) { iconOff.set(n, off); off += 12; }
  const listOff = new Map<string, number>();
  for (const n of names) { listOff.set(n, off); off += 4 + 8 * icons.get(n)!.size; }
  const strOff = new Map<string, number>();
  const strBytes = new Map<string, Uint8Array>();
  for (const str of [...dirs, ...names]) {
    if (strOff.has(str)) continue;
    const b = enc.encode(str + '\0');
    strOff.set(str, off); strBytes.set(str, b); off = align(off + b.length);
  }
  const out = new Uint8Array(off);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 1); dv.setUint16(2, 0); dv.setUint32(4, hashOff); dv.setUint32(8, dirListOff);
  dv.setUint32(dirListOff, dirs.length);
  dirs.forEach((d, i) => dv.setUint32(dirListOff + 4 + 4 * i, strOff.get(d)!));
  dv.setUint32(hashOff, nBuckets);
  const heads = new Array<number>(nBuckets).fill(NONE);
  // chains: each icon points at the previous head of its bucket
  for (const n of names) {
    const b = iconNameHash(n) % nBuckets;
    const at = iconOff.get(n)!;
    dv.setUint32(at, heads[b]); dv.setUint32(at + 4, strOff.get(n)!); dv.setUint32(at + 8, listOff.get(n)!);
    heads[b] = at;
  }
  heads.forEach((h, i) => dv.setUint32(hashOff + 4 + 4 * i, h));
  for (const n of names) {
    const at = listOff.get(n)!, per = icons.get(n)!;
    dv.setUint32(at, per.size);
    let i = 0;
    for (const [d, flags] of per) { dv.setUint16(at + 4 + 8 * i, d); dv.setUint16(at + 6 + 8 * i, flags); dv.setUint32(at + 8 + 8 * i, 0); i++; }
  }
  for (const [str, b] of strBytes) out.set(b, strOff.get(str)!);
  return out;
}

/** Look an icon up in a cache the way GTK does: the directories it is in, with their suffix flags */
export function lookupIcon(cache: Uint8Array, name: string): { dir: string; flags: number }[] {
  const dv = new DataView(cache.buffer, cache.byteOffset, cache.byteLength);
  const str = (o: number) => { let e = o; while (cache[e]) e++; return new TextDecoder().decode(cache.subarray(o, e)); };
  const hashOff = dv.getUint32(4), dirListOff = dv.getUint32(8);
  const n = dv.getUint32(hashOff);
  for (let at = dv.getUint32(hashOff + 4 + 4 * (iconNameHash(name) % n)); at !== NONE; at = dv.getUint32(at)) {
    if (str(dv.getUint32(at + 4)) !== name) continue;
    const list = dv.getUint32(at + 8), count = dv.getUint32(list);
    return Array.from({ length: count }, (_, i) => ({
      dir: str(dv.getUint32(dirListOff + 4 + 4 * dv.getUint16(list + 4 + 8 * i))),
      flags: dv.getUint16(list + 6 + 8 * i),
    }));
  }
  return [];
}

/** Rewrite `theme`/icon-theme.cache from the files under it */
export async function updateIconCache(fs: FileSystem, theme: string): Promise<number> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const names = await fs.readdir(rel ? `${theme}/${rel}` : theme).catch(() => [] as string[]);
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      const st = await fs.stat(`${theme}/${r}`).catch(() => null);
      if (st?.isDirectory()) await walk(r);
      else if (st) files.push(r);
    }
  };
  await walk('');
  const cache = buildIconCache(files);
  await fs.writeFile(`${theme}/icon-theme.cache`, cache);
  return files.length;
}
