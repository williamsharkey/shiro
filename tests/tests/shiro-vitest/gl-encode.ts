/**
 * A TypeScript encoder for the GL wire format (src/gl/wire.ts), the same
 * bytes libGLX_tabcomputer sends, so tests can drive glshiro's decoder,
 * executor and socket server without a guest.
 */
import { OPS, BATCH_MAGIC, BufferOffset, specOf, type Arg } from '@shiro/gl/wire';

const opByName = new Map<string, number>();
OPS.forEach(([name], i) => { if (name) opByName.set(name, i); });
export function opOf(name: string): number {
  const op = opByName.get(name);
  if (op === undefined) throw new Error(`no op ${name}`);
  return op;
}

const ELEM_SIZE: Record<string, number> = { Af: 4, Ai: 4, Au: 4, As: 2, AS: 2, Ac: 1, Ab: 1, Ad: 8, Aq: 8 };

/** One command's bytes (header included). `long` forces the two-word header. */
export function command(name: string, args: Arg[], long = false): Uint8Array {
  const op = opOf(name);
  const spec = specOf(op)!;
  if (spec.codes.length !== args.length) throw new Error(`${name}: ${spec.codes.length} args, got ${args.length}`);
  const parts: Uint8Array[] = [];
  const word = (fn: (dv: DataView) => void, n = 4) => { const b = new Uint8Array(n); fn(new DataView(b.buffer)); parts.push(b); };
  spec.codes.forEach((code, i) => {
    const a = args[i];
    switch (code) {
      case 'i': word((dv) => dv.setInt32(0, a as number, true)); break;
      case 'u': word((dv) => dv.setUint32(0, (a as number) >>> 0, true)); break;
      case 'f': word((dv) => dv.setFloat32(0, a as number, true)); break;
      case 'd': word((dv) => dv.setFloat64(0, a as number, true), 8); break;
      case 'q': word((dv) => dv.setBigInt64(0, BigInt(a as number), true), 8); break;
      default: {
        if (a === null) { word((dv) => dv.setUint32(0, 0xffffffff, true)); break; }
        if (a instanceof BufferOffset) { word((dv) => { dv.setUint32(0, 0xfffffffe, true); dv.setBigInt64(4, BigInt(a.offset), true); }, 12); break; }
        let bytes: Uint8Array;
        if (code === 'Z') bytes = new TextEncoder().encode(`${a as string}\0`);
        else if (typeof a === 'string') throw new Error(`${name}: string for ${code}`);
        else {
          const v = a as ArrayBufferView;
          if (ELEM_SIZE[code] === undefined) throw new Error(`code ${code}`);
          bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        }
        const padded = new Uint8Array(4 + ((bytes.length + 3) & ~3));
        new DataView(padded.buffer).setUint32(0, bytes.length, true);
        padded.set(bytes, 4);
        parts.push(padded);
      }
    }
  });
  const body = parts.reduce((n, p) => n + p.length, 0);
  const headWords = long || body / 4 + 1 >= 0xffff ? 2 : 1;
  const words = headWords + body / 4;
  const out = new Uint8Array(words * 4);
  const dv = new DataView(out.buffer);
  if (headWords === 1) dv.setUint32(0, (op | (words << 16)) >>> 0, true);
  else { dv.setUint32(0, op, true); dv.setUint32(4, words, true); }
  let o = headWords * 4;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A batch: the header and commands for one context. */
export function batch(ctx: number, cmds: (Uint8Array | [string, ...Arg[]])[]): Uint8Array {
  const bodies = cmds.map((c) => (c instanceof Uint8Array ? c : command(c[0], c.slice(1) as Arg[])));
  const len = 12 + bodies.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, BATCH_MAGIC, true);
  dv.setUint32(4, ctx, true);
  dv.setUint32(8, len, true);
  let o = 12;
  for (const b of bodies) { out.set(b, o); o += b.length; }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const ab = (u8: Uint8Array): ArrayBuffer => u8.slice().buffer;

/** Splits page → guest bytes into messages. */
export function messages(chunks: Uint8Array[]): { kind: number; payload: Uint8Array }[] {
  const all = concat(...chunks);
  const dv = new DataView(all.buffer);
  const out: { kind: number; payload: Uint8Array }[] = [];
  for (let o = 0; o + 8 <= all.length;) {
    const kind = dv.getUint32(o, true), n = dv.getUint32(o + 4, true);
    out.push({ kind, payload: all.slice(o + 8, o + 8 + n) });
    o += 8 + n;
  }
  return out;
}
