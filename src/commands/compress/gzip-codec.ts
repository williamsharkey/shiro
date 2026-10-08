/**
 * gzip decoding (RFC 1951 inflate + RFC 1952 members), pure TypeScript and
 * synchronous. Unlike the browser's DecompressionStream it accepts several
 * concatenated members (`cat a.gz b.gz`, pigz/bgzip output), reports where
 * the data ends, and tells trailing zeros from trailing garbage, like gzip.
 */

import { crc32 } from './crc32';

export type GzipErrorKind = 'format' | 'corrupt' | 'crc' | 'eof' | 'flags';

export class GzipError extends Error {
  constructor(public kind: GzipErrorKind, message: string) {
    super(message);
    this.name = 'GzipError';
  }
}

const eof = () => new GzipError('eof', 'unexpected end of file');
const bad = (why: string) => new GzipError('corrupt', `invalid compressed data--format violated (${why})`);

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Lookup table indexed by the next `bits` input bits (LSB first): (symbol << 4) | length, 0 = invalid */
interface Huff { table: Int32Array; bits: number }

function buildHuff(lens: Uint8Array, n: number): Huff {
  const count = new Int32Array(16);
  let maxLen = 0;
  for (let i = 0; i < n; i++) { count[lens[i]]++; if (lens[i] > maxLen) maxLen = lens[i]; }
  count[0] = 0;
  let left = 1;
  for (let l = 1; l <= 15; l++) {
    left = (left << 1) - count[l];
    if (left < 0) throw bad('over-subscribed code');
  }
  const next = new Int32Array(16);
  for (let l = 1, code = 0; l <= 15; l++) { code = (code + count[l - 1]) << 1; next[l] = code; }
  const bits = Math.max(maxLen, 1);
  const size = 1 << bits;
  const table = new Int32Array(size);
  for (let s = 0; s < n; s++) {
    const l = lens[s];
    if (!l) continue;
    let code = next[l]++;
    let rev = 0;
    for (let k = 0; k < l; k++) { rev = (rev << 1) | (code & 1); code >>= 1; }
    const entry = (s << 4) | l;
    for (let i = rev; i < size; i += 1 << l) table[i] = entry;
  }
  return { table, bits };
}

let fixedTables: { lit: Huff; dist: Huff } | null = null;
function fixed(): { lit: Huff; dist: Huff } {
  if (fixedTables) return fixedTables;
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  const d = new Uint8Array(30).fill(5);
  return (fixedTables = { lit: buildHuff(l, 288), dist: buildHuff(d, 30) });
}

class Inflater {
  buf: Uint8Array;
  out = 0;
  private bitbuf = 0;
  private bitcnt = 0;
  constructor(private inp: Uint8Array, public pos: number, cap: number) {
    this.buf = new Uint8Array(Math.max(cap, 1024));
  }

  private need(n: number): void {
    while (this.bitcnt < n) {
      if (this.pos >= this.inp.length) throw eof();
      this.bitbuf |= this.inp[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
  }
  private bits(n: number): number {
    if (n === 0) return 0;
    this.need(n);
    const v = this.bitbuf & ((1 << n) - 1);
    this.bitbuf >>>= n;
    this.bitcnt -= n;
    return v;
  }
  private sym(h: Huff): number {
    // Fill up to h.bits; near the end of input there may be fewer bits, which is fine if the code is shorter
    while (this.bitcnt < h.bits && this.pos < this.inp.length) {
      this.bitbuf |= this.inp[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
    const e = h.table[this.bitbuf & ((1 << h.bits) - 1)];
    const len = e & 15;
    if (len === 0) throw bad('invalid code');
    if (len > this.bitcnt) throw eof();
    this.bitbuf >>>= len;
    this.bitcnt -= len;
    return e >> 4;
  }
  private ensure(extra: number): void {
    const need = this.out + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.out));
    this.buf = nb;
  }

  /** Inflate one raw deflate stream; output goes to buf[start..out) */
  inflate(): void {
    const start = this.out;
    let final = 0;
    do {
      final = this.bits(1);
      const type = this.bits(2);
      if (type === 0) {
        // stored: drop to a byte boundary (whole bytes in bitbuf are given back)
        this.bitbuf = 0;
        this.pos -= this.bitcnt >> 3;
        this.bitcnt = 0;
        if (this.pos + 4 > this.inp.length) throw eof();
        const len = this.inp[this.pos] | (this.inp[this.pos + 1] << 8);
        const nlen = this.inp[this.pos + 2] | (this.inp[this.pos + 3] << 8);
        if ((len ^ 0xffff) !== nlen) throw bad('stored block length');
        this.pos += 4;
        if (this.pos + len > this.inp.length) throw eof();
        this.ensure(len);
        this.buf.set(this.inp.subarray(this.pos, this.pos + len), this.out);
        this.out += len;
        this.pos += len;
        continue;
      }
      let lit: Huff, dist: Huff;
      if (type === 1) ({ lit, dist } = fixed());
      else if (type === 2) {
        const hlit = this.bits(5) + 257, hdist = this.bits(5) + 1, hclen = this.bits(4) + 4;
        if (hlit > 286 || hdist > 30) throw bad('too many length or distance symbols');
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = this.bits(3);
        const clh = buildHuff(cl, 19);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const s = this.sym(clh);
          if (s < 16) { lens[i++] = s; continue; }
          let rep: number, val = 0;
          if (s === 16) {
            if (i === 0) throw bad('repeat with no first length');
            val = lens[i - 1];
            rep = 3 + this.bits(2);
          } else if (s === 17) rep = 3 + this.bits(3);
          else rep = 11 + this.bits(7);
          if (i + rep > hlit + hdist) throw bad('too many lengths');
          lens.fill(val, i, i + rep);
          i += rep;
        }
        if (lens[256] === 0) throw bad('missing end-of-block code');
        lit = buildHuff(lens.subarray(0, hlit), hlit);
        dist = buildHuff(lens.subarray(hlit), hdist);
      } else throw bad('invalid block type');

      for (;;) {
        const s = this.sym(lit);
        if (s < 256) {
          if (this.out >= this.buf.length) this.ensure(1);
          this.buf[this.out++] = s;
        } else if (s === 256) break;
        else {
          const li = s - 257;
          if (li >= 29) throw bad('invalid length code');
          const len = LEN_BASE[li] + this.bits(LEN_EXTRA[li]);
          const di = this.sym(dist);
          if (di >= 30) throw bad('invalid distance code');
          const d = DIST_BASE[di] + this.bits(DIST_EXTRA[di]);
          if (d > this.out - start) throw bad('distance too far back');
          this.ensure(len);
          const buf = this.buf;
          let src = this.out - d, o = this.out;
          for (let k = 0; k < len; k++) buf[o++] = buf[src++];
          this.out = o;
        }
      }
    } while (!final);
    // Give back whole unused bytes
    this.pos -= this.bitcnt >> 3;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
}

export interface GunzipResult {
  data: Uint8Array;
  /** Non-zero bytes after the last member (gzip warns: "trailing garbage ignored") */
  trailingGarbage: boolean;
}

export function isGzip(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/** Decompress every gzip member in the input */
export function gunzipDetailed(inp: Uint8Array): GunzipResult {
  if (!isGzip(inp)) throw new GzipError('format', 'not in gzip format');
  const inf = new Inflater(inp, 0, inp.length * 4);
  let pos = 0;
  let trailingGarbage = false;
  for (;;) {
    // Member header
    if (pos + 10 > inp.length) throw eof();
    if (inp[pos + 2] !== 8) throw new GzipError('format', `unknown method ${inp[pos + 2]} -- not supported`);
    const flg = inp[pos + 3];
    if (flg & 0xe0) throw new GzipError('flags', `has flags 0x${flg.toString(16)} -- not supported`);
    let p = pos + 10;
    if (flg & 4) {
      if (p + 2 > inp.length) throw eof();
      p += 2 + (inp[p] | (inp[p + 1] << 8));
    }
    if (flg & 8) { while (p < inp.length && inp[p] !== 0) p++; p++; }
    if (flg & 16) { while (p < inp.length && inp[p] !== 0) p++; p++; }
    if (flg & 2) p += 2;
    if (p > inp.length) throw eof();
    const start = inf.out;
    inf.pos = p;
    inf.inflate();
    p = inf.pos;
    if (p + 8 > inp.length) throw eof();
    const crc = (inp[p] | (inp[p + 1] << 8) | (inp[p + 2] << 16) | (inp[p + 3] << 24)) >>> 0;
    const isize = (inp[p + 4] | (inp[p + 5] << 8) | (inp[p + 6] << 16) | (inp[p + 7] << 24)) >>> 0;
    if (crc !== crc32(inf.buf, start, inf.out)) throw new GzipError('crc', 'invalid compressed data--crc error');
    if (isize !== (inf.out - start) >>> 0) throw new GzipError('crc', 'invalid compressed data--length error');
    pos = p + 8;
    if (pos >= inp.length) break;
    if (inp[pos] === 0x1f && inp[pos + 1] === 0x8b) continue;
    // Trailing bytes: zeros (tape padding) are ignored silently
    for (let i = pos; i < inp.length; i++) if (inp[i] !== 0) { trailingGarbage = true; break; }
    break;
  }
  return { data: inf.buf.slice(0, inf.out), trailingGarbage };
}

export function gunzip(inp: Uint8Array): Uint8Array {
  return gunzipDetailed(inp).data;
}

/** Raw deflate (RFC 1951) decoding, for callers that parse their own container (zip) */
export function inflateRaw(inp: Uint8Array, start = 0): { data: Uint8Array; end: number } {
  const inf = new Inflater(inp, start, (inp.length - start) * 4);
  inf.inflate();
  return { data: inf.buf.slice(0, inf.out), end: inf.pos };
}
