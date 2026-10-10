/**
 * apt's `store` method, natively: apt runs /usr/lib/apt/methods/store to
 * decompress each downloaded index (Packages.xz → Packages) and hash the
 * result. Under the x86 engine that took ~33 s of trixie's ~72 s
 * `apt-get update` (9.7 MB of xz → 56 MB). Here the same work runs in the
 * page: the codecs from src/commands/compress and crypto.subtle hashes.
 *
 * Protocol (apt's methods/store.cc): one `600 URI Acquire` per file with
 * `URI: store:/path/to/file.EXT` and `Filename: /dest`; the source is
 * decoded by its extension and written to Filename (which apt names without a
 * compression suffix unless Acquire::GzipIndexes keeps indexes compressed:
 * then a same-format source is copied as is). `201 URI Done` carries the
 * output's size and hashes, which apt checks against the Release file.
 *
 * The decoded file streams: .xz and .gz are decoded a piece at a time,
 * hashed as they go and written through FileSystem.createWriter, so a 39 MB
 * Packages file is never in memory whole (it was three or four times over).
 */
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import type { FileSystem } from '../filesystem';
import { MessageReader, hashFields } from './apt-method';
import { AptHashes } from '../utils/stream-hash';

const enc = new TextEncoder();
const EXTS = ['xz', 'lzma', 'gz', 'bz2', 'zst'] as const;
type Ext = typeof EXTS[number];

function extOf(path: string): Ext | null {
  const m = /\.([a-z0-9]+)$/.exec(path);
  return m && (EXTS as readonly string[]).includes(m[1]) ? (m[1] as Ext) : null;
}

async function decode(ext: Ext, data: Uint8Array): Promise<Uint8Array> {
  if (ext === 'gz') {
    const body = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(body).arrayBuffer());
  }
  if (ext === 'xz') return (await import('../commands/compress/xz-codec')).xzDecompressDetailed(data).data;
  if (ext === 'lzma') return (await import('../commands/compress/xz-codec')).lzmaAloneDecompress(data);
  if (ext === 'bz2') return (await import('../commands/compress/bzip2-codec')).bzip2Decompress(data);
  return (await import('../commands/compress/zstd-codec')).zstdDecodeAll(data);
}

/**
 * Decode `data` (compressed as `ext`) into `dest`, hashing what is written:
 * its size and hash fields. A piece at a time for xz and gzip; whole for the
 * rest (and for an .xz using filters or a SHA-256 check).
 */
export async function decodeToFile(fs: FileSystem, ext: Ext, data: Uint8Array, dest: string): Promise<{ size: number; fields: string }> {
  if (ext === 'xz') {
    const { xzDecompressTo, XZ_NOT_STREAMABLE } = await import('../commands/compress/xz-codec');
    try {
      return await toFile(fs, dest, async (put) => { await xzDecompressTo(data, put); });
    } catch (e: any) {
      if (e?.message !== XZ_NOT_STREAMABLE) throw e;
    }
  } else if (ext === 'gz') {
    return toFile(fs, dest, async (put) => {
      const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      for (;;) { const r = await reader.read(); if (r.done) break; await put(r.value); }
    });
  }
  const out = await decode(ext, data);
  return toFile(fs, dest, (put) => put(out));
}

/** Write what `produce` puts into `dest` through a FileSystem writer, hashing it. */
async function toFile(fs: FileSystem, dest: string, produce: (put: (b: Uint8Array) => Promise<void>) => Promise<void>): Promise<{ size: number; fields: string }> {
  const hashes = new AptHashes();
  const w = await fs.createWriter(dest);
  try {
    await produce((b) => { hashes.update(b); return w.write(b); });
    await w.close();
  } catch (e) {
    w.abort();
    throw e;
  }
  return { size: hashes.size, fields: hashes.fields() };
}

/** `store:/var/lib/apt/lists/partial/x%3a.xz` → the path (apt sends URIs percent-encoded) */
function uriPath(uri: string): string {
  const rest = uri.replace(/^store:(\/\/)?/, '');
  try { return decodeURIComponent(rest.startsWith('/') ? rest : '/' + rest); } catch { return rest; }
}

/** Runner for `shiro-apt-store` (registered as a kernel program command). */
export async function aptStoreProgram(proc: Process, kernel: Kernel): Promise<number> {
  const fs = kernel.fs;
  if (!fs) return 100;
  const write = (s: string) => kernel.writeAll(proc, 1, enc.encode(s));
  await write('100 Capabilities\nVersion: 1.2\nSingle-Instance: true\nSend-Config: true\nSend-URI-Encoded: true\n\n');
  const reader = new MessageReader(proc);
  let compressMode = false;
  for (;;) {
    const msg = await reader.next();
    if (!msg) break;
    if (msg.code === 601) {
      for (const [k, v] of msg.fields) {
        if (k.startsWith('Config-Item') && /^Method::Compress=(true|yes|1)$/i.test(v)) compressMode = true;
      }
      continue;
    }
    if (msg.code !== 600) continue;
    const uri = msg.fields.get('URI') ?? '';
    const dest = msg.fields.get('Filename') ?? '';
    const fail = (m: string) => write(`400 URI Failure\nURI: ${uri}\nMessage: ${m}\n\n`);
    const src = uriPath(uri);
    try {
      await write(`200 URI Start\nURI: ${uri}\n\n`);
      const raw = await fs.readFile(src) as Uint8Array;
      const inExt = extOf(src), outExt = extOf(dest);
      // A destination in a format this method can't write (GzipIndexes asks for .lz4): fail rather than store plain data under that name
      if (!outExt && /\.(lz4|lz|zstd|Z)$/.test(dest)) { await fail(`shiro-apt-store: compressing to ${dest} is not supported (Acquire::GzipIndexes)`); continue; }
      if (compressMode && inExt !== outExt) { await fail(`shiro-apt-store: compressing to ${dest} is not supported`); continue; }
      let done: { size: number; fields: string };
      if (outExt || !inExt) {
        // GzipIndexes-style: the list stays compressed; only a same-format copy is supported
        if (outExt && outExt !== inExt) { await fail(`shiro-apt-store: recompressing ${src} to ${dest} is not supported`); continue; }
        await fs.writeFile(dest, raw);
        done = { size: raw.length, fields: await hashFields(raw) };
      } else {
        done = await decodeToFile(fs, inExt, raw, dest);
      }
      await write(`201 URI Done\nURI: ${uri}\nFilename: ${dest}\nSize: ${done.size}\n${done.fields}\n`);
    } catch (e: any) {
      await fail(`${src}: ${e?.message ?? e}`);
    }
  }
  await fs.flushed().catch(() => {}); // storage full: the writes above already reported ENOSPC
  return 0;
}
