/**
 * .xz and .lzma decoding (pure TypeScript), compatible with XZ Utils.
 *
 * .xz: stream header/footer, concatenated streams and stream padding, block
 * headers (with CRC32), LZMA2 (plus the Delta and x86 BCJ filters), block
 * padding, CRC32/CRC64/SHA-256 checks, and the index.
 * .lzma (LZMA_Alone): 13-byte header, LZMA with known size or end marker.
 */

import { crc32 } from './crc32';

export type XzErrorKind = 'format' | 'corrupt' | 'eof' | 'options';

export class XzError extends Error {
  constructor(public kind: XzErrorKind, message: string) {
    super(message);
    this.name = 'XzError';
  }
}

const corrupt = (why: string) => new XzError('corrupt', `Compressed data is corrupt (${why})`);
const eof = () => new XzError('eof', 'Unexpected end of input');

// ── Checks ────────────────────────────────────────────────────────────

// CRC64 (ECMA-182, reflected) in two 32-bit halves
const CRC64_LO = new Int32Array(256), CRC64_HI = new Int32Array(256);
(() => {
  const pLo = 0xd7870f42 | 0, pHi = 0xc96c5795 | 0;
  for (let i = 0; i < 256; i++) {
    let lo = i, hi = 0;
    for (let k = 0; k < 8; k++) {
      const bit = lo & 1;
      lo = (lo >>> 1) | (hi << 31);
      hi = hi >>> 1;
      if (bit) { lo ^= pLo; hi ^= pHi; }
    }
    CRC64_LO[i] = lo;
    CRC64_HI[i] = hi;
  }
})();

function crc64(b: Uint8Array, start: number, end: number): Uint8Array {
  let lo = -1, hi = -1;
  for (let i = start; i < end; i++) {
    const idx = (lo ^ b[i]) & 0xff;
    lo = ((lo >>> 8) | (hi << 24)) ^ CRC64_LO[idx];
    hi = (hi >>> 8) ^ CRC64_HI[idx];
  }
  lo = ~lo; hi = ~hi;
  return new Uint8Array([lo, lo >>> 8, lo >>> 16, lo >>> 24, hi, hi >>> 8, hi >>> 16, hi >>> 24]);
}

const SHA256_K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(b: Uint8Array, start: number, end: number): Uint8Array {
  const len = end - start;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(b.subarray(start, end));
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(padded.length - 4, bits >>> 0);
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Int32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setInt32(i * 4, h[i]);
  return out;
}

// ── Output buffer (it is also the LZ dictionary) ──────────────────────

class Out {
  buf: Uint8Array;
  pos = 0;
  constructor(cap: number) { this.buf = new Uint8Array(Math.max(cap, 1024)); }
  ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }
}

// ── LZMA ──────────────────────────────────────────────────────────────

const PROB_INIT = 1024;
// Offsets of the probability arrays inside one Uint16Array
const IS_MATCH = 0;            // 12 states << 4 pos states
const IS_REP = 192;
const IS_REP_G0 = 204;
const IS_REP_G1 = 216;
const IS_REP_G2 = 228;
const IS_REP0_LONG = 240;      // 192
const POS_SLOT = 432;          // 4 << 6
const SPEC_POS = 688;          // 115 (index 1-based like the reference: base + m)
const ALIGN = 803;             // 16
const LEN_CODER = 819;         // choice, choice2, low 16<<3, mid 16<<3, high 256
const REP_LEN_CODER = LEN_CODER + 514;
const LITERAL = REP_LEN_CODER + 514;
const LEN_LOW = 2, LEN_MID = 2 + 128, LEN_HIGH = 2 + 256;

class LzmaDecoder {
  probs: Uint16Array = new Uint16Array(LITERAL + 0x300);
  lc = 0; lp = 0; pb = 0;
  state = 0; rep0 = 0; rep1 = 0; rep2 = 0; rep3 = 0;
  // range coder
  private inp!: Uint8Array;
  private ip = 0;
  private range = 0;
  private code = 0;

  setProps(props: number): void {
    if (props >= 225) throw corrupt('bad LZMA properties');
    this.lc = props % 9;
    props = Math.floor(props / 9);
    this.lp = props % 5;
    this.pb = Math.floor(props / 5);
    const size = LITERAL + (0x300 << (this.lc + this.lp));
    if (this.probs.length !== size) this.probs = new Uint16Array(size);
  }

  resetState(): void {
    this.probs.fill(PROB_INIT);
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }

  initRange(inp: Uint8Array, pos: number, end: number): void {
    if (end - pos < 5) throw eof();
    if (inp[pos] !== 0) throw corrupt('bad range coder start');
    this.inp = inp;
    this.code = ((inp[pos + 1] << 24) | (inp[pos + 2] << 16) | (inp[pos + 3] << 8) | inp[pos + 4]) >>> 0;
    this.range = 0xffffffff;
    this.ip = pos + 5;
  }

  get inPos(): number { return this.ip; }
  get finished(): boolean { return this.code === 0; }

  private bit(i: number): number {
    const p = this.probs[i];
    const bound = (this.range >>> 11) * p;
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      this.probs[i] = p + ((2048 - p) >> 5);
      b = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      this.probs[i] = p - (p >> 5);
      b = 1;
    }
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.inp[this.ip++]) >>> 0;
    }
    return b;
  }

  private direct(n: number): number {
    let res = 0;
    for (; n > 0; n--) {
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) { this.code -= this.range; b = 1; }
      res = ((res << 1) | b) >>> 0;
      if (this.range < 0x1000000) {
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | this.inp[this.ip++]) >>> 0;
      }
    }
    return res;
  }

  private tree(base: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(base + m);
    return m - (1 << bits);
  }

  private reverse(base: number, bits: number): number {
    let m = 1, sym = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(base + m);
      m = (m << 1) | b;
      sym |= b << i;
    }
    return sym;
  }

  private len(base: number, posState: number): number {
    if (!this.bit(base)) return this.tree(base + LEN_LOW + (posState << 3), 3);
    if (!this.bit(base + 1)) return 8 + this.tree(base + LEN_MID + (posState << 3), 3);
    return 16 + this.tree(base + LEN_HIGH, 8);
  }

  /** Match bytes still to copy when a match ran past the previous call's outEnd */
  pending = 0;

  /**
   * Decode until `outEnd` bytes are in `out` (whose buffer must hold outEnd + 273),
   * or to the end marker when one is allowed; returns true at the end marker.
   * `dictStart` is where the dictionary begins in `out`; reading input past
   * `inEnd` means the data is truncated or corrupt.
   */
  decode(out: Out, outEnd: number, dictStart: number, inEnd: number, allowEndMarker: boolean): boolean {
    const buf = out.buf;
    let pos = out.pos;
    const pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1, lc = this.lc;
    let state = this.state, rep0 = this.rep0, rep1 = this.rep1, rep2 = this.rep2, rep3 = this.rep3;
    let ended = false;
    if (this.pending) {
      const n = Math.min(this.pending, outEnd - pos);
      let src = pos - rep0 - 1;
      for (let k = 0; k < n; k++) buf[pos++] = buf[src++];
      this.pending -= n;
    }
    while (pos < outEnd) {
      if (this.ip > inEnd) break;
      const posState = pos & pbMask;
      if (!this.bit(IS_MATCH + (state << 4) + posState)) {
        const prev = pos > dictStart ? buf[pos - 1] : 0;
        const base = LITERAL + 0x300 * (((pos & lpMask) << lc) + (prev >> (8 - lc)));
        let sym = 1;
        if (state >= 7) {
          let matchByte = buf[pos - rep0 - 1];
          do {
            const mb = (matchByte >> 7) & 1;
            matchByte <<= 1;
            const b = this.bit(base + ((1 + mb) << 8) + sym);
            sym = (sym << 1) | b;
            if (mb !== b) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | this.bit(base + sym);
        buf[pos++] = sym;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len: number;
      if (this.bit(IS_REP + state)) {
        if (pos === dictStart) throw corrupt('rep match before any data');
        if (!this.bit(IS_REP_G0 + state)) {
          if (!this.bit(IS_REP0_LONG + (state << 4) + posState)) {
            state = state < 7 ? 9 : 11;
            buf[pos] = buf[pos - rep0 - 1];
            pos++;
            continue;
          }
        } else {
          let dist: number;
          if (!this.bit(IS_REP_G1 + state)) dist = rep1;
          else {
            if (!this.bit(IS_REP_G2 + state)) dist = rep2;
            else { dist = rep3; rep3 = rep2; }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        len = this.len(REP_LEN_CODER, posState);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2; rep2 = rep1; rep1 = rep0;
        len = this.len(LEN_CODER, posState);
        state = state < 7 ? 7 : 10;
        const lenState = len < 3 ? len : 3;
        const slot = this.tree(POS_SLOT + (lenState << 6), 6);
        if (slot < 4) rep0 = slot;
        else {
          const nd = (slot >> 1) - 1;
          let dist = ((2 | (slot & 1)) << nd) >>> 0;
          if (slot < 14) dist += this.reverse(SPEC_POS + dist - slot, nd);
          else {
            dist = (dist + ((this.direct(nd - 4) << 4) >>> 0)) >>> 0;
            dist = (dist + this.reverse(ALIGN, 4)) >>> 0;
          }
          rep0 = dist;
        }
        if (rep0 === 0xffffffff) {
          if (!allowEndMarker) throw corrupt('unexpected end marker');
          ended = true;
          break;
        }
        if (rep0 >= pos - dictStart) throw corrupt('distance too far back');
      }
      len += 2;
      const n = Math.min(len, outEnd - pos);
      this.pending = len - n;
      let src = pos - rep0 - 1;
      for (let k = 0; k < n; k++) buf[pos++] = buf[src++];
    }
    if (this.ip > inEnd) throw this.ip > this.inp.length ? eof() : corrupt('input overrun');
    out.pos = pos;
    this.state = state; this.rep0 = rep0; this.rep1 = rep1; this.rep2 = rep2; this.rep3 = rep3;
    return ended;
  }
}

/** Decode an LZMA2 stream starting at `pos`; returns the position after its end byte */
function decodeLzma2(inp: Uint8Array, pos: number, out: Out): number {
  const lz = new LzmaDecoder();
  let dictStart = out.pos;
  let needDictReset = true, needProps = true;
  for (;;) {
    if (pos >= inp.length) throw eof();
    const control = inp[pos++];
    if (control === 0) return pos;
    if (control === 1 || control === 2) {
      if (pos + 2 > inp.length) throw eof();
      const size = ((inp[pos] << 8) | inp[pos + 1]) + 1;
      pos += 2;
      if (control === 1) { dictStart = out.pos; needDictReset = false; }
      else if (needDictReset) throw corrupt('missing dictionary reset');
      if (pos + size > inp.length) throw eof();
      out.ensure(size);
      out.buf.set(inp.subarray(pos, pos + size), out.pos);
      out.pos += size;
      pos += size;
      continue;
    }
    if (control < 0x80) throw corrupt('bad LZMA2 control byte');
    if (pos + 4 > inp.length) throw eof();
    const unpacked = ((control & 0x1f) << 16) + (inp[pos] << 8) + inp[pos + 1] + 1;
    const packed = (inp[pos + 2] << 8) + inp[pos + 3] + 1;
    pos += 4;
    const reset = (control >> 5) & 3;
    if (reset === 3) { dictStart = out.pos; needDictReset = false; }
    else if (needDictReset) throw corrupt('missing dictionary reset');
    if (reset >= 2) {
      if (pos >= inp.length) throw eof();
      lz.setProps(inp[pos++]);
      if (lz.lc + lz.lp > 4) throw corrupt('bad LZMA2 properties');
      needProps = false;
    } else if (needProps) throw corrupt('missing LZMA properties');
    if (reset >= 1) lz.resetState();
    const end = pos + packed;
    if (end > inp.length) throw eof();
    out.ensure(unpacked + 274);
    lz.initRange(inp, pos, end);
    lz.decode(out, out.pos + unpacked, dictStart, end, false);
    if (lz.inPos !== end || !lz.finished || lz.pending) throw corrupt('LZMA2 chunk size mismatch');
    pos = end;
  }
}

// ── Filters that run after LZMA2 ──────────────────────────────────────

function undoDelta(b: Uint8Array, start: number, end: number, distance: number): void {
  for (let i = start + distance; i < end; i++) b[i] = (b[i] + b[i - distance]) & 0xff;
}

/** x86 BCJ decoder (XZ Utils simple/x86.c), start offset 0 */
function undoX86(buf: Uint8Array, start: number, end: number): void {
  const MASK_TO_ALLOWED = [true, true, true, false, true, false, false, false];
  const MASK_TO_BIT = [0, 1, 2, 2, 3, 3, 3, 3];
  const test = (b: number) => b === 0 || b === 0xff;
  const size = end - start;
  if (size < 5) return;
  let prevMask = 0;
  let prevPos = -5;
  const limit = size - 5;
  let i = 0;
  for (; i <= limit; i++) {
    let b = buf[start + i];
    if (b !== 0xe8 && b !== 0xe9) continue;
    const off = i - prevPos;
    prevPos = i;
    if (off > 5) prevMask = 0;
    else for (let k = 0; k < off; k++) { prevMask &= 0x77; prevMask <<= 1; }
    b = buf[start + i + 4];
    if (test(b) && MASK_TO_ALLOWED[(prevMask >>> 1) & 0x7] && (prevMask >>> 1) < 0x10) {
      let src = (b << 24 | buf[start + i + 3] << 16 | buf[start + i + 2] << 8 | buf[start + i + 1]) >>> 0;
      let dest: number;
      for (;;) {
        dest = (src - (i + 5)) >>> 0;
        if (prevMask === 0) break;
        const k = MASK_TO_BIT[prevMask >>> 1];
        b = (dest >>> (24 - k * 8)) & 0xff;
        if (!test(b)) break;
        src = (dest ^ ((1 << (32 - k * 8)) - 1)) >>> 0;
      }
      dest = (dest & 0x01ffffff) >>> 0;
      dest = (dest | (0 - (dest & 0x01000000))) >>> 0;
      buf[start + i + 1] = dest;
      buf[start + i + 2] = dest >>> 8;
      buf[start + i + 3] = dest >>> 16;
      buf[start + i + 4] = dest >>> 24;
      i += 4;
      prevMask = 0;
    } else {
      prevMask |= 1;
      if (test(b)) prevMask |= 0x10;
    }
  }
}

// ── .xz container ─────────────────────────────────────────────────────

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

function readVarint(b: Uint8Array, p: { pos: number }, end: number): number {
  let v = 0;
  for (let i = 0; i < 9; i++) {
    if (p.pos >= end) throw end === b.length ? eof() : corrupt('truncated integer');
    const byte = b[p.pos++];
    v += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) {
      if (i > 0 && byte === 0) throw corrupt('bad integer');
      return v;
    }
  }
  throw corrupt('bad integer');
}

const le32 = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

export interface XzDecodeResult {
  data: Uint8Array;
  /** set when the stream uses a check type this decoder cannot verify (xz warns, exit 2) */
  unsupportedCheck?: number;
}

function decodeXzStream(inp: Uint8Array, pos: number, out: Out, res: XzDecodeResult): number {
  if (inp.length - pos < 12) throw eof();
  for (let i = 0; i < 6; i++) if (inp[pos + i] !== XZ_MAGIC[i]) throw new XzError('format', 'File format not recognized');
  if (crc32(inp, pos + 6, pos + 8) !== le32(inp, pos + 8)) throw corrupt('stream header CRC');
  if (inp[pos + 6] !== 0 || (inp[pos + 7] & 0xf0)) throw new XzError('options', 'Unsupported options');
  const flags = inp[pos + 7];
  const checkType = flags & 0xf;
  const checkSize = CHECK_SIZES[checkType];
  if (checkType !== 0 && checkType !== 1 && checkType !== 4 && checkType !== 10) res.unsupportedCheck = checkType;
  pos += 12;

  const records: [number, number][] = [];
  for (;;) {
    if (pos >= inp.length) throw eof();
    if (inp[pos] === 0) break; // index indicator
    // Block header
    const hsize = (inp[pos] + 1) * 4;
    if (pos + hsize > inp.length) throw eof();
    const hstart = pos;
    if (crc32(inp, hstart, hstart + hsize - 4) !== le32(inp, hstart + hsize - 4)) throw corrupt('block header CRC');
    const bflags = inp[pos + 1];
    if (bflags & 0x3c) throw new XzError('options', 'Unsupported options');
    const p = { pos: pos + 2 };
    const hend = hstart + hsize - 4;
    const compSize = bflags & 0x40 ? readVarint(inp, p, hend) : -1;
    const uncompSize = bflags & 0x80 ? readVarint(inp, p, hend) : -1;
    const nFilters = (bflags & 3) + 1;
    const filters: { id: number; props: Uint8Array }[] = [];
    for (let f = 0; f < nFilters; f++) {
      const id = readVarint(inp, p, hend);
      const psize = readVarint(inp, p, hend);
      if (p.pos + psize > hend) throw corrupt('filter properties');
      filters.push({ id, props: inp.subarray(p.pos, p.pos + psize) });
      p.pos += psize;
    }
    for (let i = p.pos; i < hend; i++) if (inp[i] !== 0) throw corrupt('block header padding');
    const last = filters[filters.length - 1];
    if (last.id !== 0x21 || last.props.length !== 1 || last.props[0] > 40) {
      throw new XzError('options', 'Unsupported filter chain or filter options');
    }
    for (let f = 0; f < filters.length - 1; f++) {
      const { id, props } = filters[f];
      const ok = (id === 0x03 && props.length === 1) || (id === 0x04 && (props.length === 0 || (props.length === 4 && le32(props, 0) === 0)));
      if (!ok) throw new XzError('options', 'Unsupported filter chain or filter options');
    }

    pos = hstart + hsize;
    const dataStart = pos;
    const outStart = out.pos;
    pos = decodeLzma2(inp, pos, out);
    if (compSize >= 0 && pos - dataStart !== compSize) throw corrupt('block size');
    if (uncompSize >= 0 && out.pos - outStart !== uncompSize) throw corrupt('block uncompressed size');
    // Non-last filters, applied in reverse order
    for (let f = filters.length - 2; f >= 0; f--) {
      if (filters[f].id === 0x03) undoDelta(out.buf, outStart, out.pos, filters[f].props[0] + 1);
      else undoX86(out.buf, outStart, out.pos);
    }
    const unpadded = pos - hstart;
    while ((pos - hstart) & 3) {
      if (pos >= inp.length) throw eof();
      if (inp[pos++] !== 0) throw corrupt('block padding');
    }
    if (pos + checkSize > inp.length) throw eof();
    const stored = inp.subarray(pos, pos + checkSize);
    let actual: Uint8Array | null = null;
    if (checkType === 1) { const c = crc32(out.buf, outStart, out.pos); actual = new Uint8Array([c, c >>> 8, c >>> 16, c >>> 24]); }
    else if (checkType === 4) actual = crc64(out.buf, outStart, out.pos);
    else if (checkType === 10) actual = sha256(out.buf, outStart, out.pos);
    if (actual) for (let i = 0; i < checkSize; i++) if (actual[i] !== stored[i]) throw new XzError('corrupt', 'Compressed data is corrupt');
    pos += checkSize;
    records.push([unpadded + checkSize, out.pos - outStart]);
  }

  // Index
  const istart = pos;
  const p = { pos: pos + 1 };
  const n = readVarint(inp, p, inp.length);
  if (n !== records.length) throw corrupt('index record count');
  for (let i = 0; i < n; i++) {
    const u = readVarint(inp, p, inp.length), s = readVarint(inp, p, inp.length);
    if (u !== records[i][0] || s !== records[i][1]) throw corrupt('index records');
  }
  while ((p.pos - istart) & 3) {
    if (p.pos >= inp.length) throw eof();
    if (inp[p.pos++] !== 0) throw corrupt('index padding');
  }
  if (p.pos + 4 > inp.length) throw eof();
  if (crc32(inp, istart, p.pos) !== le32(inp, p.pos)) throw corrupt('index CRC');
  pos = p.pos + 4;

  // Footer
  if (pos + 12 > inp.length) throw eof();
  if (crc32(inp, pos + 4, pos + 10) !== le32(inp, pos)) throw corrupt('stream footer CRC');
  if ((le32(inp, pos + 4) + 1) * 4 !== pos - istart) throw corrupt('backward size');
  if (inp[pos + 8] !== 0 || inp[pos + 9] !== flags || inp[pos + 10] !== 0x59 || inp[pos + 11] !== 0x5a) throw corrupt('stream footer');
  return pos + 12;
}

/** Decode a .xz file (one or more streams, with stream padding) */
export function xzDecompressDetailed(inp: Uint8Array): XzDecodeResult {
  const res: XzDecodeResult = { data: new Uint8Array(0) };
  const out = new Out(inp.length * 4);
  let pos = decodeXzStream(inp, 0, out, res);
  for (;;) {
    // Stream padding: null bytes in multiples of four
    const padStart = pos;
    while (pos < inp.length && inp[pos] === 0) pos++;
    if (pos === inp.length) {
      if ((pos - padStart) & 3) throw corrupt('stream padding');
      break;
    }
    if ((pos - padStart) & 3) throw corrupt('stream padding');
    pos = decodeXzStream(inp, pos, out, res);
  }
  res.data = out.buf.slice(0, out.pos);
  return res;
}

// ── .lzma (LZMA_Alone) ────────────────────────────────────────────────

/** Whether the bytes look like an LZMA_Alone header, as xz's format auto-detection judges it */
export function isLzmaAlone(inp: Uint8Array): boolean {
  if (inp.length < 13 || inp[0] >= 225) return false;
  const dict = le32(inp, 1);
  // xz accepts 2^n and 2^n + 2^(n-1) dictionary sizes, or UINT32_MAX
  if (dict !== 0xffffffff) {
    let d = dict - 1;
    d |= d >>> 2; d |= d >>> 3; d |= d >>> 4; d |= d >>> 8; d |= d >>> 16;
    d = (d + 1) >>> 0;
    if (d !== dict) return false;
  }
  const sizeLo = le32(inp, 5), sizeHi = le32(inp, 9);
  // Unknown (all ones) or below 256 GiB, as xz requires
  return (sizeLo === 0xffffffff && sizeHi === 0xffffffff) || sizeHi < 0x40;
}

export function lzmaAloneDecompress(inp: Uint8Array): Uint8Array {
  if (!isLzmaAlone(inp)) throw new XzError('format', 'File format not recognized');
  const lz = new LzmaDecoder();
  lz.setProps(inp[0]);
  lz.resetState();
  const sizeLo = le32(inp, 5), sizeHi = le32(inp, 9);
  const known = !(sizeLo === 0xffffffff && sizeHi === 0xffffffff);
  const out = new Out(inp.length * 4);
  lz.initRange(inp, 13, inp.length);
  if (known) {
    const size = sizeHi * 2 ** 32 + sizeLo;
    if (size > 0x7fffffff) throw new XzError('options', 'Memory usage limit reached');
    out.ensure(size + 274);
    lz.decode(out, size, 0, inp.length, true);
    if (out.pos !== size || lz.pending) throw corrupt('size mismatch');
    // An end marker may follow the last byte
    if (!lz.finished && !lz.decode(out, size + 1, 0, inp.length, true)) throw corrupt('data past the end');
    if (out.pos !== size) throw corrupt('data past the end');
  } else {
    for (;;) {
      out.ensure((1 << 20) + 274);
      if (lz.decode(out, out.pos + (1 << 20), 0, inp.length, true)) break;
    }
  }
  return out.buf.slice(0, out.pos);
}
