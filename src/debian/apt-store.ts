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
 */
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import { MessageReader, hashFields } from './apt-method';

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
      let out: Uint8Array;
      if (compressMode && inExt !== outExt) { await fail(`shiro-apt-store: compressing to ${dest} is not supported`); continue; }
      if (outExt) {
        // GzipIndexes-style: the list stays compressed; only a same-format copy is supported
        if (outExt !== inExt) { await fail(`shiro-apt-store: recompressing ${src} to ${dest} is not supported`); continue; }
        out = raw;
      } else {
        out = inExt ? await decode(inExt, raw) : raw;
      }
      await fs.writeFile(dest, out);
      await write(`201 URI Done\nURI: ${uri}\nFilename: ${dest}\nSize: ${out.length}\n${await hashFields(out)}\n`);
    } catch (e: any) {
      await fail(`${src}: ${e?.message ?? e}`);
    }
  }
  await fs.flushed();
  return 0;
}
