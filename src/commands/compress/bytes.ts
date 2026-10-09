/**
 * Binary data in Shiro's string pipes. Output is byte-exact text
 * (src/utils/byte-text.ts: invalid UTF-8 bytes as U+DC80-U+DCFF), which
 * redirections and pipes write back as the same bytes. Input may also be an
 * older-style byte string (one char per byte, U+0000-U+00FF) from commands
 * that still produce those (printf '\xff', xxd -r).
 */
import { decodeBytes, encodeText } from '../../utils/byte-text';

/** Bytes to text for stdout: byte-exact */
export function latin1(b: Uint8Array): string {
  return decodeBytes(b);
}

export function isByteString(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false;
  return true;
}

export function byteStringToBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/** Binary formats other commands write to a pipe as byte strings */
export function looksBinary(b: Uint8Array): boolean {
  if (b[0] === 0x1f && b[1] === 0x8b) return true; // gzip
  if (b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68) return true; // bzip2
  if (b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a && b[3] === 0x58) return true; // xz
  if (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return true; // zstd
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return true; // zip
  if (b.length >= 512 && b[257] === 0x75 && b[258] === 0x73 && b[259] === 0x74 && b[260] === 0x61 && b[261] === 0x72) return true; // tar
  return false;
}

/**
 * Stdin as bytes. Compressed input is always a byte string when it can be one;
 * data to compress is UTF-8 text unless it is a byte string of a binary format.
 */
export function stdinBytes(s: string, compressed: boolean): Uint8Array {
  if (isByteString(s)) {
    const b = byteStringToBytes(s);
    if (compressed || looksBinary(b)) return b;
  }
  return encodeText(s);
}

/** Decompressed output for stdout: byte-exact, so `bunzip2 -c x.tar.bz2 | tar xf -` gets exact bytes. */
export function outputString(b: Uint8Array): string {
  return decodeBytes(b);
}

/**
 * A file the shell wrote from a byte string (`gzip -c f > f.gz`) holds that
 * string UTF-8 encoded; returns the original bytes, or null if it isn't one.
 */
export function unmangle(b: Uint8Array): Uint8Array | null {
  let high = false;
  for (let i = 0; i < b.length && !high; i++) if (b[i] >= 0x80) high = true;
  if (!high) return null;
  let s: string;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return null; }
  return isByteString(s) ? byteStringToBytes(s) : null;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
