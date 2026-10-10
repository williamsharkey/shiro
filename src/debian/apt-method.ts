/**
 * apt's http/https transport, run by Shiro (docs/DEBIAN.md "Package mirror").
 *
 * A browser can't open TCP connections, so Debian's own
 * /usr/lib/apt/methods/http (diverted to http.debian) would need the TCP
 * relay. Instead its place holds a `#!/usr/bin/shiro-apt-method` stub, and
 * this program speaks apt's method protocol (apt-pkg/acquire-method.cc) on
 * fds 0/1: each `600 URI Acquire` for http://HOST/PATH is fetched from the
 * page's same-origin mirror, MIRROR/HOST/PATH (MIRROR defaults to
 * /debian/mirror/, set with `Acquire::Shiro::Mirror` in apt.conf or
 * $TABCOMPUTER_DEBIAN_MIRROR), written to the file apt names and reported with its
 * hashes. apt still checks every index against the signed InRelease and
 * every .deb against the index, so the mirror is untrusted like any other.
 */
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import { md5Hex } from '../commands/checksum';
import type { FileSystem, FileWriter } from '../filesystem';
import { AptHashes } from '../utils/stream-hash';

const enc = new TextEncoder();

type Message = { code: number; fields: Map<string, string> };

/** Read apt's messages (a status line, header fields, a blank line) from fd 0. */
export class MessageReader {
  private buf = '';
  private eof = false;
  private readonly chunk = new Uint8Array(16384);
  private readonly decoder = new TextDecoder();
  constructor(private proc: Process) {}

  async next(): Promise<Message | null> {
    for (;;) {
      const end = this.buf.indexOf('\n\n');
      if (end >= 0) {
        const block = this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 2);
        const lines = block.split('\n').filter((l) => l.length);
        if (!lines.length) continue;
        const code = parseInt(lines[0], 10);
        const fields = new Map<string, string>();
        for (const l of lines.slice(1)) {
          const i = l.indexOf(':');
          if (i <= 0) continue;
          const k = l.slice(0, i);
          const v = l.slice(i + 1).trim();
          // Config-Item repeats; keep them all
          fields.set(fields.has(k) ? `${k}\u0000${fields.size}` : k, v);
        }
        return { code, fields };
      }
      if (this.eof) return null;
      const f = this.proc.fds.get(0);
      if (!f) return null;
      let n = f.tryRead?.(this.chunk);
      if (n === undefined) n = await f.read(this.chunk, this.proc.syscallSignal);
      if (n <= 0) { this.eof = true; this.buf += '\n\n'; continue; }
      this.buf += this.decoder.decode(this.chunk.subarray(0, n), { stream: true });
    }
  }
}

async function digestHex(alg: string, data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest(alg, data as BufferSource));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

export async function hashFields(data: Uint8Array): Promise<string> {
  const [sha1, sha256, sha512] = await Promise.all([digestHex('SHA-1', data), digestHex('SHA-256', data), digestHex('SHA-512', data)]);
  const md5 = md5Hex(data);
  return `MD5-Hash: ${md5}\nMD5Sum-Hash: ${md5}\nSHA1-Hash: ${sha1}\nSHA256-Hash: ${sha256}\nSHA512-Hash: ${sha512}\n`;
}

/** Size and hash fields of a file; a big one is read a block at a time. */
export async function hashFile(fs: FileSystem, path: string): Promise<{ size: number; fields: string }> {
  const real = await fs.realpath(path);
  const st = await fs.stat(real);
  const blob = fs.blobOf(real);
  if (!blob) {
    const data = await fs.readFile(real) as Uint8Array;
    return { size: data.length, fields: await hashFields(data) };
  }
  const h = new AptHashes();
  for (let i = 0, off = 0; off < st.size; i++, off += fs.blockSize) {
    const b = await fs.readBlock(blob, i, false);
    h.update(b.subarray(0, Math.min(b.length, st.size - off)));
    // A missing or short block inside the file reads as zeros
    if (b.length < Math.min(fs.blockSize, st.size - off)) h.update(new Uint8Array(Math.min(fs.blockSize, st.size - off) - b.length));
  }
  return { size: st.size, fields: h.fields() };
}

/** The mirror URL for an archive URL, or null when it isn't one the mirror serves. */
export function mirrorUrl(uri: string, mirror: string): string | null {
  const m = /^(?:https?|shiro):\/\/([^/]+)(\/.*)$/.exec(uri);
  if (!m) return null;
  const base = mirror.endsWith('/') ? mirror : mirror + '/';
  return base + m[1] + m[2];
}

function pageBase(): string {
  const loc = (globalThis as any).location?.href;
  return typeof document !== 'undefined' && document.baseURI ? document.baseURI : loc || 'http://localhost/';
}

/** The mirror's base URL from apt's configuration, the environment, or the default. */
export function mirrorBase(config: Map<string, string>, env: Record<string, string>): string {
  const configured = config.get('acquire::shiro::mirror') || env?.TABCOMPUTER_DEBIAN_MIRROR || (globalThis as any).process?.env?.TABCOMPUTER_DEBIAN_MIRROR || '/debian/mirror/';
  return new URL(configured, pageBase()).href;
}

/** Runner for `shiro-apt-method` (registered as a kernel program command). */
export async function aptMethodProgram(proc: Process, kernel: Kernel): Promise<number> {
  const fs = kernel.fs;
  if (!fs) return 100;
  const write = (s: string) => kernel.writeAll(proc, 1, enc.encode(s));
  await write('100 Capabilities\nVersion: 1.2\nPipeline: true\nSend-Config: true\n\n');
  const reader = new MessageReader(proc);
  const config = new Map<string, string>();
  let mirror = mirrorBase(config, proc.env);
  // Requests are served concurrently, in the order apt sent them (apt pipelines)
  const pending: Promise<void>[] = [];
  let order = Promise.resolve();
  for (;;) {
    const msg = await reader.next();
    if (!msg) break;
    if (msg.code === 601) {
      for (const [k, v] of msg.fields) {
        if (!k.startsWith('Config-Item')) continue;
        const eq = v.indexOf('=');
        if (eq > 0) config.set(v.slice(0, eq).toLowerCase(), decodeURIComponent(v.slice(eq + 1)));
      }
      mirror = mirrorBase(config, proc.env);
      continue;
    }
    if (msg.code !== 600) continue;
    const uri = msg.fields.get('URI') ?? '';
    const filename = msg.fields.get('Filename') ?? '';
    const lastModified = msg.fields.get('Last-Modified');
    const fetched = fetchOne(uri, mirror, lastModified, fs, filename);
    const report = order.then(async () => {
      const r = await fetched;
      if (r.kind === 'fail') {
        await write(`400 URI Failure\nURI: ${uri}\nMessage: ${r.message}\nFailReason: ${r.reason}\n${r.transient ? 'Transient-Failure: true\n' : ''}\n`);
        return;
      }
      if (r.kind === 'ims') {
        let h = { size: 0, fields: await hashFields(new Uint8Array(0)) };
        try { h = await hashFile(fs, filename); } catch { /* apt checks */ }
        await write(`201 URI Done\nURI: ${uri}\nFilename: ${filename}\nSize: ${h.size}\nIMS-Hit: true\n${lastModified ? `Last-Modified: ${lastModified}\n` : ''}${h.fields}\n`);
        return;
      }
      await write(`200 URI Start\nURI: ${uri}\nSize: ${r.size}\n${r.lastModified ? `Last-Modified: ${r.lastModified}\n` : ''}\n`);
      await write(`201 URI Done\nURI: ${uri}\nFilename: ${filename}\nSize: ${r.size}\n${r.lastModified ? `Last-Modified: ${r.lastModified}\n` : ''}${r.fields}\n`);
    });
    order = report.catch(() => {});
    pending.push(report);
  }
  await Promise.allSettled(pending);
  await fs.flushed().catch(() => {}); // storage full: the writes above already reported ENOSPC
  return 0;
}

type Fetched =
  | { kind: 'ok'; size: number; fields: string; lastModified?: string }
  | { kind: 'ims' }
  | { kind: 'fail'; message: string; reason: string; transient?: boolean };

/**
 * Fetch `uri` from the mirror into `filename`: the body streams through a
 * FileSystem writer and the hashes as it arrives (a .deb or an index is never
 * in memory whole).
 */
async function fetchOne(uri: string, mirror: string, ims: string | undefined, fs: FileSystem, filename: string): Promise<Fetched> {
  const url = mirrorUrl(uri, mirror);
  if (!url) return { kind: 'fail', message: `Unsupported URI ${uri}`, reason: 'ConnectionRefused' };
  const headers: Record<string, string> = {};
  if (ims) headers['if-modified-since'] = ims;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers, cache: 'no-store' });
    } catch (e: any) {
      if (attempt < 2) continue;
      return { kind: 'fail', message: `Could not connect to the package mirror (${e?.message ?? e})`, reason: 'ConnectionRefused', transient: true };
    }
    if (res.status === 304) return { kind: 'ims' };
    if (!res.ok) {
      if (res.status >= 500 && attempt < 2) continue;
      return { kind: 'fail', message: `${res.status}  ${res.statusText || 'Error'}`, reason: `HttpError${res.status}`, transient: res.status >= 500 };
    }
    let w: FileWriter;
    try { w = await fs.createWriter(filename); } catch (e: any) {
      return { kind: 'fail', message: `Could not write ${filename}: ${e?.message ?? e}`, reason: 'WriteError' };
    }
    const hashes = new AptHashes();
    try {
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          hashes.update(r.value);
          await w.write(r.value);
        }
      }
      await w.close();
    } catch (e: any) {
      w.abort();
      if ((e as { code?: string })?.code) return { kind: 'fail', message: `Could not write ${filename}: ${e?.message ?? e}`, reason: 'WriteError' };
      if (attempt < 2) continue;
      return { kind: 'fail', message: `Connection to the package mirror failed (${e?.message ?? e})`, reason: 'ConnectionFailed', transient: true };
    }
    return { kind: 'ok', size: hashes.size, fields: hashes.fields(), lastModified: res.headers.get('last-modified') ?? undefined };
  }
}

/** The stub that takes the place of a diverted apt method. */
export const APT_METHOD_STUB = '#!/usr/bin/shiro-apt-method\n';
