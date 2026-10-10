/**
 * The GL wire format between libGLX_tabcomputer (scripts/gl/) and glshiro
 * (docs/research/GL.md, "Wire format"). Little endian, 4-byte words.
 *
 * Guest → page: batches `u32 magic "TCGL", u32 context id, u32 bytes`, then
 * commands. A command is `u32 op | words << 16` (words counts the header)
 * and its arguments; words 0 means a second u32 holds the word count (the
 * header's two words included). Arguments follow the op's spec in
 * gen/ops.ts:
 *   i u f   int32, uint32, float32 (one word)
 *   d q     float64, int64 (two words; q is read as a Number)
 *   A?      an array: u32 byte length, the bytes, padding to 4. Length
 *           0xffffffff is NULL; 0xfffffffe is a buffer offset (an int64
 *           follows) for an image read from the bound unpack buffer.
 *           ? is the element type: f i u (32-bit), s S (int16/uint16),
 *           c b (int8/uint8), d (float64), q (int64).
 *   Z       a NUL-terminated string as an array of bytes
 *   >       (last) the guest waits for a reply
 *
 * Page → guest: messages `u32 kind, u32 bytes`, payload. Kinds: 1 reply,
 * 2 frame presented (u32 frame number), 3 GL error (u32 context, u32 error).
 */
import { OPS, PROTOCOL } from './gen/ops';

export { OPS, PROTOCOL };
export const BATCH_MAGIC = 0x4c474354;
export const MSG_REPLY = 1;
export const MSG_FRAME = 2;
export const MSG_ERROR = 3;

/** An image argument read from the bound PIXEL_UNPACK_BUFFER at this offset. */
export class BufferOffset {
  constructor(readonly offset: number) {}
}
export type Arg = number | string | ArrayBufferView | BufferOffset | null;

interface CompiledSpec { codes: string[]; reply: boolean }
const compiled: (CompiledSpec | undefined)[] = [];
export function specOf(op: number): CompiledSpec | undefined {
  let c = compiled[op];
  if (c) return c;
  const e = OPS[op];
  if (!e) return undefined;
  const s = e[1];
  const codes: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '>') continue;
    if (ch === 'A') { codes.push(s.slice(i, i + 2)); i++; } else codes.push(ch);
  }
  c = { codes, reply: s.endsWith('>') };
  compiled[op] = c;
  return c;
}

const ELEM: Record<string, [number, (b: ArrayBuffer, o: number, n: number) => ArrayBufferView]> = {
  Af: [4, (b, o, n) => new Float32Array(b, o, n)],
  Ai: [4, (b, o, n) => new Int32Array(b, o, n)],
  Au: [4, (b, o, n) => new Uint32Array(b, o, n)],
  As: [2, (b, o, n) => new Int16Array(b, o, n)],
  AS: [2, (b, o, n) => new Uint16Array(b, o, n)],
  Ac: [1, (b, o, n) => new Int8Array(b, o, n)],
  Ab: [1, (b, o, n) => new Uint8Array(b, o, n)],
  Ad: [8, (b, o, n) => new Float64Array(b.slice(o, o + n * 8))],
  Aq: [8, (b, o, n) => new BigInt64Array(b.slice(o, o + n * 8))],
};
const utf8 = new TextDecoder();

/**
 * Decodes the commands of one batch. `each(op, args)` is called per command;
 * array arguments are views on `buf` (copy them to keep them).
 */
export function decodeBatch(buf: ArrayBuffer, each: (ctx: number, op: number, args: Arg[]) => void): void {
  const dv = new DataView(buf);
  let off = 0;
  while (off + 12 <= buf.byteLength) {
    if (dv.getUint32(off, true) !== BATCH_MAGIC) throw new Error(`glshiro: bad batch magic at ${off}`);
    const ctx = dv.getUint32(off + 4, true);
    const bytes = dv.getUint32(off + 8, true);
    const end = off + bytes;
    if (bytes < 12 || end > buf.byteLength) throw new Error(`glshiro: bad batch length ${bytes}`);
    let p = off + 12;
    while (p < end) {
      const h = dv.getUint32(p, true);
      const op = h & 0xffff;
      let words = h >>> 16;
      let a = p + 4;
      if (words === 0) { words = dv.getUint32(p + 4, true); a += 4; }
      const next = p + words * 4;
      if (words < 1 || next > end) throw new Error(`glshiro: bad command length (op ${op}, ${words} words)`);
      const spec = specOf(op);
      if (!spec) throw new Error(`glshiro: unknown op ${op}`);
      const args: Arg[] = [];
      for (const code of spec.codes) {
        switch (code) {
          case 'i': args.push(dv.getInt32(a, true)); a += 4; break;
          case 'u': args.push(dv.getUint32(a, true)); a += 4; break;
          case 'f': args.push(dv.getFloat32(a, true)); a += 4; break;
          case 'd': args.push(dv.getFloat64(a, true)); a += 8; break;
          case 'q': args.push(Number(dv.getBigInt64(a, true))); a += 8; break;
          default: {
            const n = dv.getUint32(a, true);
            a += 4;
            if (n === 0xffffffff) { args.push(null); break; }
            if (n === 0xfffffffe) { args.push(new BufferOffset(Number(dv.getBigInt64(a, true)))); a += 8; break; }
            if (a + n > next) throw new Error(`glshiro: array past its command (op ${op})`);
            if (code === 'Z') {
              const s = new Uint8Array(buf, a, n);
              const z = s.indexOf(0);
              args.push(utf8.decode(z >= 0 ? s.subarray(0, z) : s));
            } else {
              const [size, make] = ELEM[code];
              args.push(make(buf, a, Math.floor(n / size)));
            }
            a += (n + 3) & ~3;
          }
        }
      }
      each(ctx, op, args);
      p = next;
    }
    off = end;
  }
}

/** A growable little-endian writer for replies. */
export class ReplyWriter {
  private buf = new ArrayBuffer(256);
  private dv = new DataView(this.buf);
  private n = 0;
  private room(k: number) {
    if (this.n + k <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.n + k) size *= 2;
    const nb = new ArrayBuffer(size);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.n));
    this.buf = nb; this.dv = new DataView(nb);
  }
  u32(v: number): this { this.room(4); this.dv.setUint32(this.n, v >>> 0, true); this.n += 4; return this; }
  i32(v: number): this { this.room(4); this.dv.setInt32(this.n, v | 0, true); this.n += 4; return this; }
  f64(v: number): this { this.room(8); this.dv.setFloat64(this.n, v, true); this.n += 8; return this; }
  bytes(b: Uint8Array): this { this.room(b.length + 3); new Uint8Array(this.buf, this.n, b.length).set(b); this.n += (b.length + 3) & ~3; return this; }
  /** u32 length + bytes, padded */
  str(s: string): this { const b = new TextEncoder().encode(s); this.u32(b.length); return this.bytes(b); }
  finish(): Uint8Array { return new Uint8Array(this.buf, 0, this.n); }
}

/** One page → guest message. */
export function message(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, kind, true);
  dv.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}
export function f64s(values: ArrayLike<number>): Uint8Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Number(values[i]);
  return new Uint8Array(out.buffer);
}
export function u32s(...values: number[]): Uint8Array {
  return new Uint8Array(new Uint32Array(values.map((v) => v >>> 0)).buffer);
}
