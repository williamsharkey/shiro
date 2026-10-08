/**
 * webc.ts — reader for Wasmer's WebC package containers (format v2 and v3)
 *
 * Layout (from the `webc` crate, src/v2 and src/v3):
 *   magic "\0webc" + version "002" | "003"
 *   sections: tag u8, [v3 non-index: sha256 32 bytes], length u64 LE, payload
 *     1 manifest  CBOR (package, commands, atoms, use)
 *     2 index     CBOR spans (skipped; we walk the sections in order)
 *     3 atoms     header (length-delimited) + data (length-delimited)
 *     4 volume    name + header + data (each length-delimited)
 *   volume/atoms header: tree of entries
 *     30 dir     u64 length, [v3: 3×u64 times + 32 hash], entries:
 *                u64 offset, [v3: 32 hash], u64 name_len, name
 *     31 file    u64 start, u64 end (into the data part), 32 sha256, [v3: 3×u64 times]
 *     32 symlink (v3) u64 len, target, 32 hash, 3×u64 times
 *
 * The old extractor scanned for "\0asm" and walked sections; it overran the
 * module end (trailing bytes look like section ids) and stopped at section
 * id 13 (exception tags), so most Wasmer modules failed to compile.
 */

export interface WebcFile {
  path: string;          // absolute inside the volume, e.g. "/lib/python3.12/os.py"
  data: Uint8Array;
}

export interface WebcVolume {
  name: string;
  files: WebcFile[];
  dirs: string[];
  symlinks: Array<{ path: string; target: string }>;
}

export interface WebcPackage {
  version: 2 | 3;
  manifest: any;
  atoms: Map<string, Uint8Array>;
  volumes: Map<string, WebcVolume>;
}

const TAG_MANIFEST = 1;
const TAG_INDEX = 2;
const TAG_ATOMS = 3;
const TAG_VOLUME = 4;
const TAG_DIR = 30;
const TAG_FILE = 31;
const TAG_SYMLINK = 32;

const utf8 = new TextDecoder();

function u64(b: Uint8Array, p: number): number {
  const dv = new DataView(b.buffer, b.byteOffset + p, 8);
  const lo = dv.getUint32(0, true);
  const hi = dv.getUint32(4, true);
  if (hi > 0x1fffff) throw new Error('webc: 64-bit value out of range');
  return hi * 0x1_0000_0000 + lo;
}

export function isWebc(b: Uint8Array): boolean {
  return b.length >= 8 && b[0] === 0 && b[1] === 0x77 && b[2] === 0x65 && b[3] === 0x62 && b[4] === 0x63;
}

/** Parse a WebC v2/v3 container. Throws on anything malformed. */
export function parseWebc(bytes: Uint8Array): WebcPackage {
  if (!isWebc(bytes)) throw new Error('webc: bad magic');
  const ver = utf8.decode(bytes.subarray(5, 8));
  if (ver !== '002' && ver !== '003') throw new Error(`webc: unsupported version ${ver}`);
  const v3 = ver === '003';
  const pkg: WebcPackage = { version: v3 ? 3 : 2, manifest: {}, atoms: new Map(), volumes: new Map() };

  let p = 8;
  while (p < bytes.length) {
    const tag = bytes[p];
    if (tag === 0) break; // trailing padding
    let hdr = 1;
    if (v3 && tag !== TAG_INDEX) hdr += 32;
    const len = u64(bytes, p + hdr);
    const start = p + hdr + 8;
    const end = start + len;
    if (end > bytes.length) throw new Error(`webc: section ${tag} overruns file`);
    const sec = bytes.subarray(start, end);
    if (tag === TAG_MANIFEST) {
      pkg.manifest = decodeCbor(sec);
    } else if (tag === TAG_ATOMS) {
      const [header, rest] = lengthDelimited(sec);
      const [data] = lengthDelimited(rest);
      const vol = readVolume('atoms', header, data, v3);
      for (const f of vol.files) pkg.atoms.set(f.path.replace(/^\//, ''), f.data);
    } else if (tag === TAG_VOLUME) {
      const [nameBytes, r1] = lengthDelimited(sec);
      const [header, r2] = lengthDelimited(r1);
      const [data] = lengthDelimited(r2);
      const name = utf8.decode(nameBytes);
      pkg.volumes.set(name, readVolume(name, header, data, v3));
    } else if (tag !== TAG_INDEX) {
      throw new Error(`webc: unknown section tag ${tag}`);
    }
    p = end;
  }
  return pkg;
}

function lengthDelimited(b: Uint8Array): [Uint8Array, Uint8Array] {
  const n = u64(b, 0);
  if (8 + n > b.length) throw new Error('webc: length-delimited field overruns section');
  return [b.subarray(8, 8 + n), b.subarray(8 + n)];
}

function readVolume(name: string, header: Uint8Array, data: Uint8Array, v3: boolean): WebcVolume {
  const vol: WebcVolume = { name, files: [], dirs: [], symlinks: [] };
  const visit = (off: number, path: string, depth: number) => {
    if (depth > 256) throw new Error('webc: volume too deep');
    const tag = header[off];
    if (tag === TAG_DIR) {
      if (path) vol.dirs.push(path);
      const len = u64(header, off + 1);
      let q = off + 9;
      const stop = q + len;
      if (v3) q += 24 + 32;
      while (q < stop) {
        const child = u64(header, q); q += 8;
        if (v3) q += 32;
        const nlen = u64(header, q); q += 8;
        const childName = utf8.decode(header.subarray(q, q + nlen)); q += nlen;
        if (!childName || childName === '.' || childName === '..' || childName.includes('/')) {
          throw new Error(`webc: bad entry name ${JSON.stringify(childName)}`);
        }
        visit(child, `${path}/${childName}`, depth + 1);
      }
    } else if (tag === TAG_FILE) {
      const s = u64(header, off + 1);
      const e = u64(header, off + 9);
      if (s > e || e > data.length) throw new Error(`webc: file ${path} out of bounds`);
      vol.files.push({ path, data: data.subarray(s, e) });
    } else if (tag === TAG_SYMLINK) {
      const tlen = u64(header, off + 1);
      vol.symlinks.push({ path, target: utf8.decode(header.subarray(off + 9, off + 9 + tlen)) });
    } else {
      throw new Error(`webc: unknown header entry tag ${tag}`);
    }
  };
  visit(0, '', 0);
  return vol;
}

/**
 * Commands declared by the manifest: name → atom (plus the atom's main_args).
 * Wasmer puts the atom under annotations.wasi.atom; old packages omit it and
 * mean the atom with the command's name (or the only atom).
 */
export function webcCommands(pkg: WebcPackage): Array<{ name: string; atom: string; mainArgs?: string[] }> {
  const out: Array<{ name: string; atom: string; mainArgs?: string[] }> = [];
  const cmds = pkg.manifest?.commands || {};
  const atomNames = [...pkg.atoms.keys()];
  for (const [name, cmd] of Object.entries<any>(cmds)) {
    const wasi = cmd?.annotations?.wasi || {};
    let atom: string | undefined = typeof wasi.atom === 'string' ? wasi.atom : undefined;
    if (atom && !pkg.atoms.has(atom)) atom = atom.split(':').pop();
    if (!atom || !pkg.atoms.has(atom)) atom = pkg.atoms.has(name) ? name : atomNames.length === 1 ? atomNames[0] : undefined;
    if (!atom) continue;
    const mainArgs = Array.isArray(wasi.main_args) ? wasi.main_args.map(String) : undefined;
    out.push({ name, atom, mainArgs });
  }
  return out;
}

/**
 * Volume mounts from the manifest's package.fs annotation: either
 * [{ volume_name, mount_path, original_path? }] or the older { "/guest": "volume-path" }.
 */
export function webcMounts(pkg: WebcPackage): Array<{ guest: string; volume: string; path: string }> {
  const fs = pkg.manifest?.package?.fs;
  if (Array.isArray(fs)) {
    return fs
      .filter((m: any) => typeof m?.mount_path === 'string' && typeof m?.volume_name === 'string')
      .map((m: any) => ({ guest: m.mount_path, volume: m.volume_name, path: m.original_path || '/' }));
  }
  if (!fs || typeof fs !== 'object') return [];
  return Object.entries<any>(fs)
    .filter(([, v]) => typeof v === 'string')
    .map(([guest, v]) => ({ guest, volume: v, path: '/' }));
}

// ── Minimal CBOR decoder (RFC 8949: the subset WebC manifests use) ──

export function decodeCbor(b: Uint8Array): any {
  let p = 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const arg = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return b[p++];
    if (info === 25) { const v = dv.getUint16(p); p += 2; return v; }
    if (info === 26) { const v = dv.getUint32(p); p += 4; return v; }
    if (info === 27) { const v = Number(dv.getBigUint64(p)); p += 8; return v; }
    if (info === 31) return -1; // indefinite length
    throw new Error(`cbor: bad additional info ${info}`);
  };
  const BREAK = Symbol('break');
  const item = (): any => {
    if (p >= b.length) throw new Error('cbor: unexpected end');
    const ib = b[p++];
    const major = ib >> 5;
    const info = ib & 31;
    switch (major) {
      case 0: return arg(info);
      case 1: return -1 - arg(info);
      case 2:
      case 3: {
        const n = arg(info);
        let bytes: Uint8Array;
        if (n < 0) {
          const parts: Uint8Array[] = [];
          for (let x = item(); x !== BREAK; x = item()) parts.push(typeof x === 'string' ? new TextEncoder().encode(x) : x);
          const total = parts.reduce((s, q) => s + q.length, 0);
          bytes = new Uint8Array(total);
          let o = 0;
          for (const q of parts) { bytes.set(q, o); o += q.length; }
        } else {
          bytes = b.subarray(p, p + n); p += n;
        }
        return major === 3 ? utf8.decode(bytes) : bytes;
      }
      case 4: {
        const n = arg(info);
        const arr: any[] = [];
        if (n < 0) { for (let x = item(); x !== BREAK; x = item()) arr.push(x); }
        else for (let i = 0; i < n; i++) arr.push(item());
        return arr;
      }
      case 5: {
        const n = arg(info);
        const obj: Record<string, any> = {};
        const put = () => { const k = item(); if (k === BREAK) return false; obj[String(k)] = item(); return true; };
        if (n < 0) { while (put()) { /* until break */ } }
        else for (let i = 0; i < n; i++) put();
        return obj;
      }
      case 6: arg(info); return item(); // tags: ignore, keep the value
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { const v = getFloat16(dv.getUint16(p)); p += 2; return v; }
        if (info === 26) { const v = dv.getFloat32(p); p += 4; return v; }
        if (info === 27) { const v = dv.getFloat64(p); p += 8; return v; }
        if (info === 31) return BREAK;
        return arg(info);
    }
    throw new Error('cbor: unreachable');
  };
  return item();
}

function getFloat16(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
