/**
 * pkg-tar.ts — read tar archives (ustar, GNU long names, pax paths) and
 * gunzip, for packages that ship a directory tree as one .tar.gz
 * (pkg-manager.ts, `"unpack": "tar.gz"`).
 */

export interface TarEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  data: Uint8Array;
  linkname: string;
}

const dec = new TextDecoder();

function str(b: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && b[end]) end++;
  return dec.decode(b.subarray(off, end));
}

function octal(b: Uint8Array, off: number, len: number): number {
  const s = str(b, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

/** Entries of an uncompressed tar archive, in order. Hard links come back as copies. */
export function untar(bytes: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  const byPath = new Map<string, TarEntry>();
  let longName: string | null = null;
  let longLink: string | null = null;
  let paxPath: string | null = null;
  let paxLink: string | null = null;
  for (let off = 0; off + 512 <= bytes.length;) {
    const h = bytes.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const typeflag = String.fromCharCode(h[156] || 0x30);
    const body = bytes.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (typeflag === 'L') { longName = str(body, 0, body.length); continue; }
    if (typeflag === 'K') { longLink = str(body, 0, body.length); continue; }
    if (typeflag === 'x' || typeflag === 'g') {
      for (const rec of dec.decode(body).split('\n')) {
        const m = rec.match(/^\d+ (path|linkpath)=(.*)$/);
        if (m && typeflag === 'x') { if (m[1] === 'path') paxPath = m[2]; else paxLink = m[2]; }
      }
      continue;
    }
    const prefix = str(h, 345, 155);
    let path = paxPath ?? longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    const linkname = paxLink ?? longLink ?? str(h, 157, 100);
    longName = longLink = paxPath = paxLink = null;
    path = path.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!path || path === '.') continue;
    const mode = octal(h, 100, 8) & 0o7777;
    let e: TarEntry | null = null;
    if (typeflag === '5') e = { path, type: 'dir', mode, data: new Uint8Array(0), linkname: '' };
    else if (typeflag === '2') e = { path, type: 'symlink', mode, data: new Uint8Array(0), linkname };
    else if (typeflag === '1') {
      const target = byPath.get(linkname.replace(/^\.\//, ''));
      if (target) e = { path, type: 'file', mode: target.mode, data: target.data, linkname: '' };
    } else if (typeflag === '0' || typeflag === '7' || typeflag === '\0') {
      e = { path, type: 'file', mode, data: body.slice(), linkname: '' };
    }
    if (e) { out.push(e); byPath.set(path, e); }
  }
  return out;
}

/** gunzip through the platform's DecompressionStream. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
