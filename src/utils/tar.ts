/**
 * Reading tar archives (ustar, GNU long names, pax path/linkpath), plain or
 * gzipped, for package downloads that come as tarballs (npm, release assets).
 */

export interface TarEntry {
  name: string;
  /** '0' file, '2' symlink, '5' directory (others are skipped by callers) */
  type: string;
  mode: number;
  linkname: string;
  data: Uint8Array;
}

const dec = new TextDecoder();

export const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

export async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const out = new Response(new Blob([b as BlobPart]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

function cstr(b: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && b[end] !== 0) end++;
  return dec.decode(b.subarray(off, end));
}

function octal(b: Uint8Array, off: number, len: number): number {
  // GNU base-256 for large sizes
  if (b[off] & 0x80) {
    let n = 0;
    for (let i = off + 1; i < off + len; i++) n = n * 256 + b[i];
    return n;
  }
  const s = cstr(b, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function paxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = dec.decode(data);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!len) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Entries of a tar archive (not gzipped; see readTarball). Names lose a leading "./". */
export function parseTar(b: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null, longLink: string | null = null;
  let pax: Record<string, string> = {};
  while (off + 512 <= b.length) {
    const h = b.subarray(off, off + 512);
    if (h.every(x => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    // A copy: storing a view in IndexedDB would clone the whole archive buffer
    const data = b.slice(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    if (type === 'K') { longLink = cstr(data, 0, data.length); continue; }
    if (type === 'x') { pax = paxRecords(data); continue; }
    if (type === 'g') continue;
    let name = cstr(h, 0, 100);
    const magic = cstr(h, 257, 6);
    if (magic.startsWith('ustar')) {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    name = pax.path ?? longName ?? name;
    const linkname = pax.linkpath ?? longLink ?? cstr(h, 157, 100);
    longName = longLink = null;
    pax = {};
    out.push({ name: name.replace(/^\.\//, ''), type: type === '\0' ? '0' : type, mode: octal(h, 100, 8), linkname, data });
  }
  return out;
}

/** A tarball's entries, gunzipping first when it is gzipped. */
export async function readTarball(b: Uint8Array): Promise<TarEntry[]> {
  return parseTar(isGzip(b) ? await gunzip(b) : b);
}
