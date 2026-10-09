/**
 * Zstandard decoding (RFC 8878), pure TypeScript.
 *
 * Frames (with window/dictionary-ID/content-size fields), skippable frames,
 * raw/RLE/compressed blocks, Huffman literals (1 or 4 streams, FSE-coded or
 * direct weights, treeless reuse), FSE sequences (predefined/RLE/FSE/repeat
 * tables), repeat offsets, and the XXH64 content checksum. Frames that need
 * an external dictionary are rejected.
 */

export type ZstdErrorKind = 'format' | 'corrupt' | 'eof' | 'dictionary' | 'checksum';

export class ZstdError extends Error {
  constructor(public kind: ZstdErrorKind, message: string) {
    super(message);
    this.name = 'ZstdError';
  }
}

const corrupt = (why: string) => new ZstdError('corrupt', `Corrupted block detected (${why})`);
const eof = () => new ZstdError('eof', 'Read error (39) : premature end');

// ── XXH64, in 32-bit halves ───────────────────────────────────────────

let rH = 0, rL = 0; // result registers for the 64-bit helpers

function mulhi32(a: number, b: number): number {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const t = a0 * b0;
  const m1 = a1 * b0 + (t >>> 16);
  const m2 = a0 * b1 + (m1 & 0xffff);
  return (a1 * b1 + Math.floor(m1 / 65536) + Math.floor(m2 / 65536)) >>> 0;
}
function mul64(aH: number, aL: number, bH: number, bL: number): void {
  rL = Math.imul(aL, bL) >>> 0;
  rH = (mulhi32(aL >>> 0, bL >>> 0) + Math.imul(aH, bL) + Math.imul(aL, bH)) >>> 0;
}
function add64(aH: number, aL: number, bH: number, bL: number): void {
  const l = (aL >>> 0) + (bL >>> 0);
  rL = l >>> 0;
  rH = (aH + bH + (l > 0xffffffff ? 1 : 0)) >>> 0;
}
function rotl64(h: number, l: number, n: number): void {
  if (n >= 32) { const t = h; h = l; l = t; n -= 32; }
  if (n === 0) { rH = h >>> 0; rL = l >>> 0; return; }
  rH = ((h << n) | (l >>> (32 - n))) >>> 0;
  rL = ((l << n) | (h >>> (32 - n))) >>> 0;
}

const P1H = 0x9e3779b1, P1L = 0x85ebca87;
const P2H = 0xc2b2ae3d, P2L = 0x27d4eb4f;
const P3H = 0x165667b1, P3L = 0x9e3779f9;
const P4H = 0x85ebca77, P4L = 0xc2b2ae63;
const P5H = 0x27d4eb2f, P5L = 0x165667c5;

const u32le = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

/** round(acc, lane) = rotl(acc + lane * P2, 31) * P1 */
function round64(accH: number, accL: number, inH: number, inL: number): void {
  mul64(inH, inL, P2H, P2L);
  add64(accH, accL, rH, rL);
  rotl64(rH, rL, 31);
  mul64(rH, rL, P1H, P1L);
}

/** Low 32 bits of XXH64(data, seed 0) */
export function xxh64Low32(b: Uint8Array, start: number, end: number): number {
  const len = end - start;
  let p = start;
  let hH: number, hL: number;
  if (len >= 32) {
    add64(P1H, P1L, P2H, P2L);
    let v1H = rH, v1L = rL;
    let v2H = P2H, v2L = P2L;
    let v3H = 0, v3L = 0;
    // -P1 mod 2^64
    let v4H = ~P1H >>> 0, v4L = (-P1L) >>> 0; // 0 - P1 (P1L is nonzero, so the high half borrows)
    const limit = end - 32;
    while (p <= limit) {
      round64(v1H, v1L, u32le(b, p + 4), u32le(b, p)); v1H = rH; v1L = rL;
      round64(v2H, v2L, u32le(b, p + 12), u32le(b, p + 8)); v2H = rH; v2L = rL;
      round64(v3H, v3L, u32le(b, p + 20), u32le(b, p + 16)); v3H = rH; v3L = rL;
      round64(v4H, v4L, u32le(b, p + 28), u32le(b, p + 24)); v4H = rH; v4L = rL;
      p += 32;
    }
    rotl64(v1H, v1L, 1); hH = rH; hL = rL;
    rotl64(v2H, v2L, 7); add64(hH, hL, rH, rL); hH = rH; hL = rL;
    rotl64(v3H, v3L, 12); add64(hH, hL, rH, rL); hH = rH; hL = rL;
    rotl64(v4H, v4L, 18); add64(hH, hL, rH, rL); hH = rH; hL = rL;
    for (const [vH, vL] of [[v1H, v1L], [v2H, v2L], [v3H, v3L], [v4H, v4L]]) {
      round64(0, 0, vH, vL);
      hH = (hH ^ rH) >>> 0; hL = (hL ^ rL) >>> 0;
      mul64(hH, hL, P1H, P1L);
      add64(rH, rL, P4H, P4L);
      hH = rH; hL = rL;
    }
  } else {
    hH = P5H; hL = P5L;
  }
  add64(hH, hL, Math.floor(len / 0x100000000), len >>> 0); hH = rH; hL = rL;
  while (p + 8 <= end) {
    round64(0, 0, u32le(b, p + 4), u32le(b, p));
    hH = (hH ^ rH) >>> 0; hL = (hL ^ rL) >>> 0;
    rotl64(hH, hL, 27);
    mul64(rH, rL, P1H, P1L);
    add64(rH, rL, P4H, P4L);
    hH = rH; hL = rL;
    p += 8;
  }
  if (p + 4 <= end) {
    mul64(0, u32le(b, p), P1H, P1L);
    hH = (hH ^ rH) >>> 0; hL = (hL ^ rL) >>> 0;
    rotl64(hH, hL, 23);
    mul64(rH, rL, P2H, P2L);
    add64(rH, rL, P3H, P3L);
    hH = rH; hL = rL;
    p += 4;
  }
  while (p < end) {
    mul64(0, b[p], P5H, P5L);
    hH = (hH ^ rH) >>> 0; hL = (hL ^ rL) >>> 0;
    rotl64(hH, hL, 11);
    mul64(rH, rL, P1H, P1L);
    hH = rH; hL = rL;
    p++;
  }
  // avalanche
  hL = (hL ^ (hH >>> 1)) >>> 0; // h ^= h >> 33
  mul64(hH, hL, P2H, P2L); hH = rH; hL = rL;
  hL = (hL ^ ((hL >>> 29) | (hH << 3))) >>> 0; // h ^= h >> 29
  hH = (hH ^ (hH >>> 29)) >>> 0;
  mul64(hH, hL, P3H, P3L); hH = rH; hL = rL;
  return (hL ^ hH) >>> 0; // low half of h ^ (h >> 32)
}

// ── Bit readers ───────────────────────────────────────────────────────

/** Forward little-endian bit reader (FSE table descriptions) */
class FwdBits {
  bitPos: number;
  constructor(private b: Uint8Array, start: number, private end: number) { this.bitPos = start * 8; }
  peek(n: number): number {
    const byte = this.bitPos >> 3, sh = this.bitPos & 7;
    const g = (i: number) => (byte + i < this.end ? this.b[byte + i] : 0);
    const v = (g(0) | (g(1) << 8) | (g(2) << 16) | (g(3) << 24)) >>> sh;
    return (v & ((1 << n) - 1)) >>> 0;
  }
  skip(n: number): void {
    this.bitPos += n;
    if (this.bitPos > this.end * 8) throw corrupt('table description overrun');
  }
}

/** Backward bit reader: zstd bitstreams start at their last byte's highest set bit */
class BackBits {
  pos: number; // bits still unread (bits [0, pos) of the stream)
  private b: Uint8Array;
  private start: number;
  constructor(b: Uint8Array, start: number, end: number) {
    if (end <= start) throw corrupt('empty bitstream');
    const last = b[end - 1];
    if (last === 0) throw corrupt('bitstream without end mark');
    this.b = b;
    this.start = start;
    this.pos = (end - 1 - start) * 8 + (31 - Math.clz32(last));
  }
  /** Bits [p, p + n), n <= 24, as little-endian; bits before the stream read as 0 */
  private field(p: number, n: number): number {
    if (n === 0) return 0;
    if (p < 0) {
      if (p + n <= 0) return 0;
      return this.field(0, n + p) << -p;
    }
    const byte = this.start + (p >> 3), sh = p & 7;
    const b = this.b;
    const v = (b[byte] | (b[byte + 1] << 8) | (b[byte + 2] << 16) | (b[byte + 3] << 24)) >>> sh;
    return (v & ((1 << n) - 1)) >>> 0;
  }
  read(n: number): number {
    if (n > 24) {
      const hi = this.read(n - 24);
      return hi * 0x1000000 + this.read(24);
    }
    this.pos -= n;
    return this.field(this.pos, n);
  }
  peek(n: number): number { return this.field(this.pos - n, n); }
  skip(n: number): void { this.pos -= n; }
}

// ── FSE ───────────────────────────────────────────────────────────────

interface FseTable { log: number; symbol: Uint8Array; nbBits: Uint8Array; base: Uint16Array }

function readFseDistribution(b: Uint8Array, start: number, end: number, maxSymbol: number, maxLog: number): { norm: Int16Array; log: number; size: number } {
  const br = new FwdBits(b, start, end);
  const log = br.peek(4) + 5;
  br.skip(4);
  if (log > maxLog) throw corrupt('FSE accuracy too high');
  const norm = new Int16Array(maxSymbol + 1);
  let remaining = (1 << log) + 1;
  let threshold = 1 << log;
  let nbBits = log + 1;
  let sym = 0;
  while (remaining > 1 && sym <= maxSymbol) {
    const max = 2 * threshold - 1 - remaining;
    let count: number;
    const low = br.peek(nbBits - 1);
    if (low < max) {
      count = low;
      br.skip(nbBits - 1);
    } else {
      count = br.peek(nbBits);
      if (count >= threshold) count -= max;
      br.skip(nbBits);
    }
    count--;
    remaining -= count < 0 ? -count : count;
    norm[sym++] = count;
    if (count === 0) {
      for (;;) {
        const rep = br.peek(2);
        br.skip(2);
        sym += rep;
        if (rep !== 3) break;
      }
    }
    while (remaining < threshold) { nbBits--; threshold >>= 1; }
  }
  if (remaining !== 1 || sym > maxSymbol + 1) throw corrupt('bad FSE distribution');
  return { norm, log, size: ((br.bitPos + 7) >> 3) - start };
}

function buildFse(norm: Int16Array | number[], log: number): FseTable {
  const size = 1 << log;
  const symbol = new Uint8Array(size), nbBits = new Uint8Array(size), base = new Uint16Array(size);
  const next = new Uint16Array(norm.length);
  let high = size - 1;
  for (let s = 0; s < norm.length; s++) {
    if (norm[s] === -1) { symbol[high--] = s; next[s] = 1; } else next[s] = Math.max(norm[s], 0);
  }
  const step = (size >> 1) + (size >> 3) + 3, mask = size - 1;
  let pos = 0;
  for (let s = 0; s < norm.length; s++) {
    for (let i = 0; i < norm[s]; i++) {
      symbol[pos] = s;
      do pos = (pos + step) & mask; while (pos > high);
    }
  }
  if (pos !== 0) throw corrupt('bad FSE table');
  for (let u = 0; u < size; u++) {
    const s = symbol[u];
    const ns = next[s]++;
    const nb = log - (31 - Math.clz32(ns));
    nbBits[u] = nb;
    base[u] = (ns << nb) - size;
  }
  return { log, symbol, nbBits, base };
}

function rleFse(sym: number): FseTable {
  return { log: 0, symbol: new Uint8Array([sym]), nbBits: new Uint8Array([0]), base: new Uint16Array([0]) };
}

// ── Huffman ───────────────────────────────────────────────────────────

interface HufTable { maxBits: number; symbol: Uint8Array; nbBits: Uint8Array }

/** Read a Huffman tree description; returns the table and bytes consumed */
function readHuffman(b: Uint8Array, start: number, end: number): { table: HufTable; size: number } {
  if (start >= end) throw eof();
  const header = b[start];
  const weights = new Uint8Array(256);
  let n = 0;
  let size: number;
  if (header >= 128) {
    n = header - 127;
    size = 1 + ((n + 1) >> 1);
    if (start + size > end) throw eof();
    for (let i = 0; i < n; i++) {
      const byte = b[start + 1 + (i >> 1)];
      weights[i] = i & 1 ? byte & 0xf : byte >> 4;
    }
  } else {
    size = 1 + header;
    if (start + size > end) throw eof();
    const dist = readFseDistribution(b, start + 1, start + size, 255, 6);
    const t = buildFse(dist.norm, dist.log);
    const bs = new BackBits(b, start + 1 + dist.size, start + size);
    let s1 = bs.read(t.log), s2 = bs.read(t.log);
    for (;;) {
      if (n >= 255) throw corrupt('too many Huffman weights');
      weights[n++] = t.symbol[s1];
      s1 = t.base[s1] + bs.read(t.nbBits[s1]);
      if (bs.pos < 0) { weights[n++] = t.symbol[s2]; break; }
      if (n >= 255) throw corrupt('too many Huffman weights');
      weights[n++] = t.symbol[s2];
      s2 = t.base[s2] + bs.read(t.nbBits[s2]);
      if (bs.pos < 0) { weights[n++] = t.symbol[s1]; break; }
    }
  }
  // The last weight is implied by the others
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (weights[i] > 12) throw corrupt('bad Huffman weight');
    if (weights[i]) sum += 1 << (weights[i] - 1);
  }
  if (sum === 0) throw corrupt('empty Huffman tree');
  const maxBits = 32 - Math.clz32(sum);
  const left = (1 << maxBits) - sum;
  if (left & (left - 1)) throw corrupt('bad Huffman tree');
  if (maxBits > 12) throw corrupt('Huffman code too long');
  weights[n] = 31 - Math.clz32(left) + 1;
  const nSym = n + 1;
  const tsize = 1 << maxBits;
  const symbol = new Uint8Array(tsize), nbBits = new Uint8Array(tsize);
  let pos = 0;
  for (let w = 1; w <= maxBits; w++) {
    for (let s = 0; s < nSym; s++) {
      if (weights[s] !== w) continue;
      const span = 1 << (w - 1);
      symbol.fill(s, pos, pos + span);
      nbBits.fill(maxBits + 1 - w, pos, pos + span);
      pos += span;
    }
  }
  if (pos !== tsize) throw corrupt('bad Huffman tree');
  return { table: { maxBits, symbol, nbBits }, size };
}

function decodeHufStream(b: Uint8Array, start: number, end: number, t: HufTable, out: Uint8Array, o: number, count: number): void {
  const bs = new BackBits(b, start, end);
  const mb = t.maxBits;
  for (let i = 0; i < count; i++) {
    const v = bs.peek(mb);
    out[o + i] = t.symbol[v];
    bs.skip(t.nbBits[v]);
  }
  if (bs.pos !== 0) throw corrupt('Huffman stream size');
}

// ── Sequences ─────────────────────────────────────────────────────────

const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const ML_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
  35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
const ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
const ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];
const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];
let defaultTables: { ll: FseTable; ml: FseTable; of: FseTable } | null = null;
const defaults = () => (defaultTables ??= { ll: buildFse(LL_DEFAULT, 6), ml: buildFse(ML_DEFAULT, 6), of: buildFse(OF_DEFAULT, 5) });

// ── Frames ────────────────────────────────────────────────────────────

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

interface FrameState {
  huf: HufTable | null;
  ll: FseTable | null;
  ml: FseTable | null;
  of: FseTable | null;
  rep: number[];
  frameStart: number;
  windowSize: number;
}

const MAX_BLOCK = 128 * 1024;

function selectTable(b: Uint8Array, p: number, end: number, mode: number, prev: FseTable | null, dflt: FseTable,
  maxSym: number, maxLog: number): { table: FseTable; size: number } {
  switch (mode) {
    case 0: return { table: dflt, size: 0 };
    case 1:
      if (p >= end) throw eof();
      if (b[p] > maxSym) throw corrupt('bad RLE symbol');
      return { table: rleFse(b[p]), size: 1 };
    case 2: {
      const d = readFseDistribution(b, p, end, maxSym, maxLog);
      return { table: buildFse(d.norm, d.log), size: d.size };
    }
    default:
      if (!prev) throw corrupt('repeat table without a previous one');
      return { table: prev, size: 0 };
  }
}

function decodeCompressedBlock(b: Uint8Array, start: number, end: number, out: Out, st: FrameState): void {
  // Literals section
  let p = start;
  if (p >= end) throw eof();
  const b0 = b[p];
  const litType = b0 & 3, sf = (b0 >> 2) & 3;
  let regen: number, comp = 0, hsize: number, streams = 1;
  if (litType < 2) {
    if (sf === 0 || sf === 2) { regen = b0 >> 3; hsize = 1; }
    else if (sf === 1) { regen = (b0 >> 4) + (b[p + 1] << 4); hsize = 2; }
    else { regen = (b0 >> 4) + (b[p + 1] << 4) + (b[p + 2] << 12); hsize = 3; }
  } else {
    if (sf <= 1) {
      const v = b0 | (b[p + 1] << 8) | (b[p + 2] << 16);
      regen = (v >> 4) & 0x3ff; comp = (v >> 14) & 0x3ff; hsize = 3; streams = sf === 0 ? 1 : 4;
    } else if (sf === 2) {
      const v = (b0 | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
      regen = (v >>> 4) & 0x3fff; comp = (v >>> 18) & 0x3fff; hsize = 4; streams = 4;
    } else {
      const v = (b0 | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
      regen = (v >>> 4) & 0x3ffff; comp = (v >>> 22) + (b[p + 4] << 10); hsize = 5; streams = 4;
    }
  }
  if (p + hsize > end) throw eof();
  p += hsize;
  if (regen > MAX_BLOCK) throw corrupt('literals too large');
  let lits: Uint8Array;
  if (litType === 0) {
    if (p + regen > end) throw eof();
    lits = b.subarray(p, p + regen);
    p += regen;
  } else if (litType === 1) {
    if (p >= end) throw eof();
    lits = new Uint8Array(regen).fill(b[p]);
    p += 1;
  } else {
    if (p + comp > end) throw eof();
    const litEnd = p + comp;
    if (litType === 2) {
      const h = readHuffman(b, p, litEnd);
      st.huf = h.table;
      p += h.size;
    } else if (!st.huf) throw corrupt('treeless literals without a table');
    lits = new Uint8Array(regen);
    if (streams === 1) decodeHufStream(b, p, litEnd, st.huf!, lits, 0, regen);
    else {
      if (p + 6 > litEnd) throw eof();
      const s1 = b[p] | (b[p + 1] << 8), s2 = b[p + 2] | (b[p + 3] << 8), s3 = b[p + 4] | (b[p + 5] << 8);
      const q = p + 6;
      const e1 = q + s1, e2 = e1 + s2, e3 = e2 + s3;
      if (e3 > litEnd) throw corrupt('Huffman jump table');
      const seg = Math.floor((regen + 3) / 4);
      if (seg * 3 > regen) throw corrupt('Huffman stream sizes');
      decodeHufStream(b, q, e1, st.huf!, lits, 0, seg);
      decodeHufStream(b, e1, e2, st.huf!, lits, seg, seg);
      decodeHufStream(b, e2, e3, st.huf!, lits, 2 * seg, seg);
      decodeHufStream(b, e3, litEnd, st.huf!, lits, 3 * seg, regen - 3 * seg);
    }
    p = litEnd;
  }

  // Sequences section
  if (p >= end) throw eof();
  let nSeq = b[p++];
  if (nSeq >= 128) {
    if (nSeq === 255) {
      if (p + 2 > end) throw eof();
      nSeq = b[p] + (b[p + 1] << 8) + 0x7f00;
      p += 2;
    } else {
      if (p >= end) throw eof();
      nSeq = ((nSeq - 128) << 8) + b[p++];
    }
  }
  out.ensure(MAX_BLOCK + lits.length);
  const buf = out.buf;
  let o = out.pos;
  let lp = 0;
  if (nSeq > 0) {
    if (p >= end) throw eof();
    const modes = b[p++];
    if (modes & 3) throw corrupt('reserved sequence mode bits');
    const d = defaults();
    const llT = selectTable(b, p, end, modes >> 6, st.ll, d.ll, 35, 9); p += llT.size;
    const ofT = selectTable(b, p, end, (modes >> 4) & 3, st.of, d.of, 31, 8); p += ofT.size;
    const mlT = selectTable(b, p, end, (modes >> 2) & 3, st.ml, d.ml, 52, 9); p += mlT.size;
    const ll = st.ll = llT.table, of = st.of = ofT.table, ml = st.ml = mlT.table;
    const bs = new BackBits(b, p, end);
    let sLL = bs.read(ll.log), sOF = bs.read(of.log), sML = bs.read(ml.log);
    const rep = st.rep;
    const blockLimit = out.pos + MAX_BLOCK;
    for (let i = 0; i < nSeq; i++) {
      const ofCode = of.symbol[sOF], mlCode = ml.symbol[sML], llCode = ll.symbol[sLL];
      if (ofCode > 31 || mlCode > 52 || llCode > 35) throw corrupt('bad sequence code');
      const ofValue = 2 ** ofCode + bs.read(ofCode);
      const mlen = ML_BASE[mlCode] + bs.read(ML_BITS[mlCode]);
      const llen = LL_BASE[llCode] + bs.read(LL_BITS[llCode]);
      let offset: number;
      if (ofValue > 3) {
        offset = ofValue - 3;
        rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = offset;
      } else {
        const idx = ofValue - 1 + (llen === 0 ? 1 : 0);
        if (idx === 0) offset = rep[0];
        else {
          offset = idx === 3 ? rep[0] - 1 : rep[idx];
          if (offset === 0) throw corrupt('zero offset');
          if (idx !== 1) rep[2] = rep[1];
          rep[1] = rep[0];
          rep[0] = offset;
        }
      }
      if (i + 1 < nSeq) {
        sLL = ll.base[sLL] + bs.read(ll.nbBits[sLL]);
        sML = ml.base[sML] + bs.read(ml.nbBits[sML]);
        sOF = of.base[sOF] + bs.read(of.nbBits[sOF]);
      }
      if (lp + llen > lits.length) throw corrupt('literal length past the literals');
      if (o + llen + mlen > blockLimit) throw corrupt('block too large');
      buf.set(lits.subarray(lp, lp + llen), o);
      o += llen;
      lp += llen;
      if (offset > o - st.frameStart) throw corrupt('offset before the start');
      let src = o - offset;
      if (offset >= mlen) { buf.copyWithin(o, src, src + mlen); o += mlen; }
      else for (let k = 0; k < mlen; k++) buf[o++] = buf[src++];
    }
    if (bs.pos !== 0) throw corrupt('sequence bitstream size');
  } else if (p !== end) {
    throw corrupt('data after the literals');
  }
  if (o + lits.length - lp > out.pos + MAX_BLOCK) throw corrupt('block too large');
  buf.set(lits.subarray(lp), o);
  o += lits.length - lp;
  out.pos = o;
}

const FCS_SIZES = [0, 2, 4, 8];

function decodeFrame(b: Uint8Array, p: number, out: Out): number {
  if (p + 5 > b.length) throw eof();
  p += 4;
  const fhd = b[p++];
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, didFlag = fhd & 3;
  if (fhd & 8) throw corrupt('reserved frame header bit');
  let windowSize = 0;
  if (!single) {
    if (p >= b.length) throw eof();
    const wd = b[p++];
    const base = 2 ** (10 + (wd >> 3));
    windowSize = base + (base / 8) * (wd & 7);
  }
  const didSize = [0, 1, 2, 4][didFlag];
  if (p + didSize > b.length) throw eof();
  let dictId = 0;
  for (let i = 0; i < didSize; i++) dictId += b[p + i] * 2 ** (8 * i);
  p += didSize;
  if (dictId !== 0) throw new ZstdError('dictionary', 'Dictionary mismatch (frame needs a dictionary)');
  const fcsSize = fcsFlag === 0 ? (single ? 1 : 0) : FCS_SIZES[fcsFlag];
  if (p + fcsSize > b.length) throw eof();
  let contentSize = -1;
  if (fcsSize) {
    contentSize = 0;
    for (let i = 0; i < fcsSize; i++) contentSize += b[p + i] * 2 ** (8 * i);
    if (fcsSize === 2) contentSize += 256;
  }
  p += fcsSize;
  if (single) windowSize = contentSize;

  const st: FrameState = { huf: null, ll: null, ml: null, of: null, rep: [1, 4, 8], frameStart: out.pos, windowSize };
  if (contentSize > 0 && contentSize < 0x7fffffff) out.ensure(contentSize);
  for (;;) {
    if (p + 3 > b.length) throw eof();
    const bh = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
    p += 3;
    const last = bh & 1, type = (bh >> 1) & 3, size = bh >>> 3;
    if (type === 3) throw corrupt('reserved block type');
    if (type === 1) {
      if (size > MAX_BLOCK) throw corrupt('block too large');
      if (p >= b.length) throw eof();
      out.ensure(size);
      out.buf.fill(b[p], out.pos, out.pos + size);
      out.pos += size;
      p += 1;
    } else {
      if (size > MAX_BLOCK) throw corrupt('block too large');
      if (p + size > b.length) throw eof();
      if (type === 0) {
        out.ensure(size);
        out.buf.set(b.subarray(p, p + size), out.pos);
        out.pos += size;
      } else {
        decodeCompressedBlock(b, p, p + size, out, st);
      }
      p += size;
    }
    if (last) break;
  }
  if (contentSize >= 0 && out.pos - st.frameStart !== contentSize) throw corrupt('frame size mismatch');
  if (checksum) {
    if (p + 4 > b.length) throw eof();
    if (xxh64Low32(out.buf, st.frameStart, out.pos) !== u32le(b, p)) throw new ZstdError('checksum', 'Restored data doesn\'t match checksum');
    p += 4;
  }
  return p;
}

const isZstdMagic = (b: Uint8Array, p: number) => b[p] === 0x28 && b[p + 1] === 0xb5 && b[p + 2] === 0x2f && b[p + 3] === 0xfd;
const isSkippable = (b: Uint8Array, p: number) => (b[p] & 0xf0) === 0x50 && b[p + 1] === 0x2a && b[p + 2] === 0x4d && b[p + 3] === 0x18;

/** Decode all frames (zstd and skippable) in the input */
export function zstdDecodeAll(b: Uint8Array): Uint8Array {
  const out = new Out(b.length * 4);
  let p = 0;
  let frames = 0;
  while (p < b.length) {
    if (b.length - p < 4) {
      throw frames ? new ZstdError('format', 'unknown header') : new ZstdError('format', 'unsupported format');
    }
    if (isZstdMagic(b, p)) p = decodeFrame(b, p, out);
    else if (isSkippable(b, p)) {
      if (p + 8 > b.length) throw eof();
      const size = u32le(b, p + 4);
      if (p + 8 + size > b.length) throw eof();
      p += 8 + size;
    } else {
      throw frames ? new ZstdError('format', 'unknown header') : new ZstdError('format', 'unsupported format');
    }
    frames++;
  }
  if (!frames) throw new ZstdError('format', 'unsupported format');
  return out.buf.slice(0, out.pos);
}
