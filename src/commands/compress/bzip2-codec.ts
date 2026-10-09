/**
 * bzip2 file format (bzip2 1.0.x compatible), pure TypeScript.
 *
 * Decoder: stream header BZh1-9, bit-aligned blocks (magic 0x314159265359),
 * symbol map, Huffman tables with MTF-coded selectors, MTF/RUNA/RUNB,
 * inverse BWT, de-randomisation of old randomised blocks, RLE1, per-block
 * and combined CRCs, end-of-stream magic 0x177245385090, and concatenated
 * streams (pbzip2/lbzip2 output, `cat a.bz2 b.bz2`).
 *
 * Encoder: RLE1, BWT of the cyclic block via SA-IS suffix sorting (linear
 * time, so repetitive input never goes quadratic), MTF + RUNA/RUNB,
 * 2-6 Huffman tables refined like bzip2's encoder, CRCs. Its output is a
 * standard .bz2 stream that the reference bzip2 reads.
 */

export type Bzip2ErrorKind = 'magic' | 'data' | 'crc' | 'eof';

/** A decode failure; `partial` holds the output of the blocks decoded before it */
export class Bzip2Error extends Error {
  partial: Uint8Array = new Uint8Array(0);
  constructor(public kind: Bzip2ErrorKind, message: string) {
    super(message);
    this.name = 'Bzip2Error';
  }
}

// ── CRC (bzip2 uses the MSB-first CRC-32, polynomial 0x04c11db7) ──────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c;
  }
  return t;
})();

/** bzip2's CRC of a byte range (initial 0xffffffff, final complement) */
export function bzip2Crc(data: Uint8Array, start = 0, end = data.length): number {
  let crc = -1;
  for (let i = start; i < end; i++) crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xff];
  return ~crc >>> 0;
}

/** The table bzip2 0.9.0 used to randomise blocks of repetitive data (BZ2_rNums) */
const RNUMS = new Int16Array([
  619, 720, 127, 481, 931, 816, 813, 233, 566, 247, 985, 724, 205, 454, 863, 491,
  741, 242, 949, 214, 733, 859, 335, 708, 621, 574, 73, 654, 730, 472, 419, 436,
  278, 496, 867, 210, 399, 680, 480, 51, 878, 465, 811, 169, 869, 675, 611, 697,
  867, 561, 862, 687, 507, 283, 482, 129, 807, 591, 733, 623, 150, 238, 59, 379,
  684, 877, 625, 169, 643, 105, 170, 607, 520, 932, 727, 476, 693, 425, 174, 647,
  73, 122, 335, 530, 442, 853, 695, 249, 445, 515, 909, 545, 703, 919, 874, 474,
  882, 500, 594, 612, 641, 801, 220, 162, 819, 984, 589, 513, 495, 799, 161, 604,
  958, 533, 221, 400, 386, 867, 600, 782, 382, 596, 414, 171, 516, 375, 682, 485,
  911, 276, 98, 553, 163, 354, 666, 933, 424, 341, 533, 870, 227, 730, 475, 186,
  263, 647, 537, 686, 600, 224, 469, 68, 770, 919, 190, 373, 294, 822, 808, 206,
  184, 943, 795, 384, 383, 461, 404, 758, 839, 887, 715, 67, 618, 276, 204, 918,
  873, 777, 604, 560, 951, 160, 578, 722, 79, 804, 96, 409, 713, 940, 652, 934,
  970, 447, 318, 353, 859, 672, 112, 785, 645, 863, 803, 350, 139, 93, 354, 99,
  820, 908, 609, 772, 154, 274, 580, 184, 79, 626, 630, 742, 653, 282, 762, 623,
  680, 81, 927, 626, 789, 125, 411, 521, 938, 300, 821, 78, 343, 175, 128, 250,
  170, 774, 972, 275, 999, 639, 495, 78, 352, 126, 857, 956, 358, 619, 580, 124,
  737, 594, 701, 612, 669, 112, 134, 694, 363, 992, 809, 743, 168, 974, 944, 375,
  748, 52, 600, 747, 642, 182, 862, 81, 344, 805, 988, 739, 511, 655, 814, 334,
  249, 515, 897, 955, 664, 981, 649, 113, 974, 459, 893, 228, 433, 837, 553, 268,
  926, 240, 102, 654, 459, 51, 686, 754, 806, 760, 493, 403, 415, 394, 687, 700,
  946, 670, 656, 610, 738, 392, 760, 799, 887, 653, 978, 321, 576, 617, 626, 502,
  894, 679, 243, 440, 680, 879, 194, 572, 640, 724, 926, 56, 204, 700, 707, 151,
  457, 449, 797, 195, 791, 558, 945, 679, 297, 59, 87, 824, 713, 663, 412, 693,
  342, 606, 134, 108, 571, 364, 631, 212, 174, 643, 304, 329, 343, 97, 430, 751,
  497, 314, 983, 374, 822, 928, 140, 206, 73, 263, 980, 736, 876, 478, 430, 305,
  170, 514, 364, 692, 829, 82, 855, 953, 676, 246, 369, 970, 294, 750, 807, 827,
  150, 790, 288, 923, 804, 378, 215, 828, 592, 281, 565, 555, 710, 82, 896, 831,
  547, 261, 524, 462, 293, 465, 502, 56, 661, 821, 976, 991, 658, 869, 905, 758,
  745, 193, 768, 550, 608, 933, 378, 286, 215, 979, 792, 961, 61, 688, 793, 644,
  986, 403, 106, 366, 905, 644, 372, 567, 466, 434, 645, 210, 389, 550, 919, 135,
  780, 773, 635, 389, 707, 100, 626, 958, 165, 504, 920, 176, 193, 713, 857, 265,
  203, 50, 668, 108, 645, 990, 626, 197, 510, 357, 358, 850, 858, 364, 936, 638,
]);

const BLOCK_MAGIC_HI = 0x314159, BLOCK_MAGIC_LO = 0x265359;
const EOS_MAGIC_HI = 0x177245, EOS_MAGIC_LO = 0x385090;
const STREAM_MAGIC = [0x42, 0x5a, 0x68];
const MAX_SELECTORS = 18002;
const MAX_CODE_LEN = 20;
const MAX_ALPHA = 258;

// ── Decoder ───────────────────────────────────────────────────────────

class BitReader {
  private acc = 0;
  private live = 0;
  constructor(private buf: Uint8Array, public pos: number) {}

  /** Read n bits, 1 <= n <= 24, MSB first */
  bits(n: number): number {
    while (this.live < n) {
      if (this.pos >= this.buf.length) throw new Bzip2Error('eof', 'Compressed file ends unexpectedly');
      this.acc = (this.acc << 8) | this.buf[this.pos++];
      this.live += 8;
    }
    this.live -= n;
    const v = (this.acc >>> this.live) & ((1 << n) - 1);
    this.acc &= (1 << this.live) - 1;
    return v;
  }

  bit(): number {
    if (this.live === 0) {
      if (this.pos >= this.buf.length) throw new Bzip2Error('eof', 'Compressed file ends unexpectedly');
      this.acc = this.buf[this.pos++];
      this.live = 8;
    }
    this.live--;
    const v = (this.acc >>> this.live) & 1;
    this.acc &= (1 << this.live) - 1;
    return v;
  }

  /** Byte offset of the next stream: drop the padding bits of the current byte */
  alignedPos(): number {
    return this.pos - (this.live >> 3);
  }
}

class OutBuf {
  buf: Uint8Array;
  len = 0;
  constructor(cap: number) { this.buf = new Uint8Array(Math.max(cap, 64)); }
  ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  result(): Uint8Array { return this.buf.slice(0, this.len); }
}

const dataError = (msg: string) => new Bzip2Error('data', msg);

interface DecodeTable { limit: Int32Array; base: Int32Array; perm: Int32Array; minLen: number }

function makeDecodeTable(length: Uint8Array, alphaSize: number): DecodeTable {
  let minLen = 32, maxLen = 0;
  for (let i = 0; i < alphaSize; i++) {
    if (length[i] > maxLen) maxLen = length[i];
    if (length[i] < minLen) minLen = length[i];
  }
  const perm = new Int32Array(MAX_ALPHA);
  const base = new Int32Array(MAX_CODE_LEN + 3);
  const limit = new Int32Array(MAX_CODE_LEN + 2);
  let pp = 0;
  for (let i = minLen; i <= maxLen; i++)
    for (let j = 0; j < alphaSize; j++) if (length[j] === i) perm[pp++] = j;
  for (let i = 0; i < alphaSize; i++) base[length[i] + 1]++;
  for (let i = 1; i < base.length; i++) base[i] += base[i - 1];
  let vec = 0;
  for (let i = minLen; i <= maxLen; i++) {
    vec += base[i + 1] - base[i];
    limit[i] = vec - 1;
    vec <<= 1;
  }
  for (let i = minLen + 1; i <= maxLen; i++) base[i] = ((limit[i - 1] + 1) << 1) - base[i];
  // lengths past maxLen never match: make the decoder walk on to the error
  for (let i = maxLen + 1; i <= MAX_CODE_LEN; i++) limit[i] = -1;
  return { limit, base, perm, minLen };
}

/** Decode one block (after its magic) and append its bytes; returns the block's CRC */
function decodeBlock(br: BitReader, blockSize100k: number, tt: Uint32Array, out: OutBuf): number {
  const storedCrc = ((br.bits(16) << 16) | br.bits(16)) >>> 0;
  const randomised = br.bit();
  const origPtr = br.bits(24);

  // Symbol map
  const seqToUnseq = new Uint8Array(256);
  let numInUse = 0;
  const inUse16 = br.bits(16);
  for (let i = 0; i < 16; i++) {
    if (!(inUse16 & (0x8000 >> i))) continue;
    const w = br.bits(16);
    for (let j = 0; j < 16; j++) if (w & (0x8000 >> j)) seqToUnseq[numInUse++] = i * 16 + j;
  }
  if (numInUse === 0) throw dataError('no symbols in use');
  const alphaSize = numInUse + 2;
  const EOB = numInUse + 1;

  const nGroups = br.bits(3);
  if (nGroups < 2 || nGroups > 6) throw dataError('bad number of Huffman tables');
  const nSelectorsRaw = br.bits(15);
  if (nSelectorsRaw < 1) throw dataError('no selectors');

  // Selectors, MTF coded in unary
  const mtfPos = [0, 1, 2, 3, 4, 5];
  const nSelectors = Math.min(nSelectorsRaw, MAX_SELECTORS);
  const selectors = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectorsRaw; i++) {
    let j = 0;
    while (br.bit()) {
      j++;
      if (j >= nGroups) throw dataError('bad selector');
    }
    if (i < MAX_SELECTORS) {
      const v = mtfPos[j];
      for (; j > 0; j--) mtfPos[j] = mtfPos[j - 1];
      mtfPos[0] = v;
      selectors[i] = v;
    }
  }

  // Code lengths, delta coded
  const tables: DecodeTable[] = [];
  const len = new Uint8Array(MAX_ALPHA);
  for (let t = 0; t < nGroups; t++) {
    let curr = br.bits(5);
    for (let i = 0; i < alphaSize; i++) {
      for (;;) {
        if (curr < 1 || curr > MAX_CODE_LEN) throw dataError('bad code length');
        if (!br.bit()) break;
        curr += br.bit() ? -1 : 1;
      }
      len[i] = curr;
    }
    tables.push(makeDecodeTable(len, alphaSize));
  }

  // Huffman + MTF + RUNA/RUNB
  const nblockMAX = 100000 * blockSize100k;
  const unzftab = new Int32Array(256);
  const yy = new Uint8Array(256);
  for (let i = 0; i < 256; i++) yy[i] = i;
  let groupNo = -1, groupPos = 0;
  let limit = tables[0].limit, base = tables[0].base, perm = tables[0].perm, minLen = 0;
  const nextSym = (): number => {
    if (groupPos === 0) {
      groupNo++;
      if (groupNo >= nSelectors) throw dataError('selector overflow');
      groupPos = 50;
      const tb = tables[selectors[groupNo]];
      limit = tb.limit; base = tb.base; perm = tb.perm; minLen = tb.minLen;
    }
    groupPos--;
    let zn = minLen;
    let zvec = br.bits(zn);
    while (zvec > limit[zn]) {
      if (++zn > MAX_CODE_LEN) throw dataError('bad Huffman code');
      zvec = (zvec << 1) | br.bit();
    }
    const idx = zvec - base[zn];
    if (idx < 0 || idx >= MAX_ALPHA) throw dataError('bad Huffman code');
    return perm[idx];
  };

  let nblock = 0;
  let sym = nextSym();
  for (;;) {
    if (sym === EOB) break;
    if (sym <= 1) {
      let es = 0, N = 1;
      do {
        if (N >= 2 * 1024 * 1024) throw dataError('run too long');
        es += sym === 0 ? N : 2 * N;
        N <<= 1;
        sym = nextSym();
      } while (sym <= 1);
      const uc = seqToUnseq[yy[0]];
      unzftab[uc] += es;
      if (nblock + es > nblockMAX) throw dataError('block too long');
      tt.fill(uc, nblock, nblock + es);
      nblock += es;
    } else {
      if (nblock >= nblockMAX) throw dataError('block too long');
      let nn = sym - 1;
      if (nn >= numInUse) throw dataError('bad MTF index');
      const v = yy[nn];
      if (nn < 16) { for (; nn > 0; nn--) yy[nn] = yy[nn - 1]; } else yy.copyWithin(1, 0, nn);
      yy[0] = v;
      const uc = seqToUnseq[v];
      unzftab[uc]++;
      tt[nblock++] = uc;
      sym = nextSym();
    }
  }
  if (origPtr >= nblock) throw dataError('bad origPtr');

  // Inverse BWT: link each position to the next one
  const cftab = new Int32Array(257);
  for (let i = 1; i <= 256; i++) cftab[i] = cftab[i - 1] + unzftab[i - 1];
  for (let i = 0; i < nblock; i++) {
    const uc = tt[i] & 0xff;
    tt[cftab[uc]] |= i << 8;
    cftab[uc]++;
  }

  // Walk the BWT, undo randomisation and RLE1, and compute the CRC
  out.ensure(nblock);
  let ob = out.buf, ol = out.len;
  let crc = -1;
  let tPos = tt[origPtr] >>> 8;
  let last = -1, run = 0;
  let rNToGo = 0, rTPos = 0;
  for (let k = 0; k < nblock; k++) {
    tPos = tt[tPos];
    let ch = tPos & 0xff;
    tPos >>>= 8;
    if (randomised) {
      if (rNToGo === 0) { rNToGo = RNUMS[rTPos]; rTPos = (rTPos + 1) & 511; }
      rNToGo--;
      if (rNToGo === 1) ch ^= 1;
    }
    if (run === 4) {
      // ch is the count of extra copies of the 4-byte run
      run = 0;
      if (ch > 0) {
        out.len = ol;
        out.ensure(ch + (nblock - k));
        ob = out.buf;
        for (let r = 0; r < ch; r++) {
          ob[ol++] = last;
          crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ last) & 0xff];
        }
      }
      continue;
    }
    if (ch === last) run++;
    else { last = ch; run = 1; }
    ob[ol++] = ch;
    crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ ch) & 0xff];
  }
  out.len = ol;
  crc = ~crc >>> 0;
  if (crc !== storedCrc) throw new Bzip2Error('crc', 'data integrity (CRC) error in data');
  return crc;
}

export interface Bzip2DecodeResult {
  data: Uint8Array;
  /** bytes after the last stream that are not another bzip2 stream (bzip2 warns and ignores them) */
  trailingGarbage: boolean;
}

/** Decompress one or more concatenated bzip2 streams */
export function bzip2DecompressDetailed(input: Uint8Array): Bzip2DecodeResult {
  const out = new OutBuf(input.length * 4);
  let tt: Uint32Array | null = null;
  let pos = 0;
  let streams = 0;
  let trailingGarbage = false;
  try {
    for (;;) {
      if (streams > 0 && pos >= input.length) break;
      // Stream header "BZh1".."BZh9"; a truncated header is a truncated file
      const avail = Math.min(4, input.length - pos);
      let ok = true;
      for (let i = 0; i < avail && ok; i++) {
        const b = input[pos + i];
        ok = i < 3 ? b === STREAM_MAGIC[i] : b >= 0x31 && b <= 0x39; // "BZh" + '1'..'9'
      }
      if (!ok) {
        if (streams === 0) throw new Bzip2Error('magic', 'not a bzip2 file');
        trailingGarbage = true;
        break;
      }
      if (avail < 4) throw new Bzip2Error('eof', 'Compressed file ends unexpectedly');
      const blockSize100k = input[pos + 3] - 0x30;
      if (!tt || tt.length < blockSize100k * 100000) tt = new Uint32Array(blockSize100k * 100000);
      const br = new BitReader(input, pos + 4);
      let combined = 0;
      for (;;) {
        const hi = br.bits(24), lo = br.bits(24);
        if (hi === BLOCK_MAGIC_HI && lo === BLOCK_MAGIC_LO) {
          const crc = decodeBlock(br, blockSize100k, tt, out);
          combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
        } else if (hi === EOS_MAGIC_HI && lo === EOS_MAGIC_LO) {
          const stored = ((br.bits(16) << 16) | br.bits(16)) >>> 0;
          if (stored !== combined) throw new Bzip2Error('crc', 'data integrity (CRC) error in data');
          break;
        } else {
          throw dataError('bad block header');
        }
      }
      pos = br.alignedPos();
      streams++;
    }
  } catch (e) {
    if (e instanceof Bzip2Error) e.partial = out.result();
    throw e;
  }
  return { data: out.result(), trailingGarbage };
}

export function bzip2Decompress(input: Uint8Array): Uint8Array {
  return bzip2DecompressDetailed(input).data;
}

// ── Suffix sorting (SA-IS) ────────────────────────────────────────────

/** Suffix array of T[0..n) over alphabet [0, K), with an implicit smallest sentinel */
function sais(T: Int32Array, SA: Int32Array, n: number, K: number): void {
  if (n === 0) return;
  if (n === 1) { SA[0] = 0; return; }
  const t = new Uint8Array(n); // 1 = S-type
  for (let i = n - 2; i >= 0; i--) t[i] = T[i] < T[i + 1] || (T[i] === T[i + 1] && t[i + 1] === 1) ? 1 : 0;
  const C = new Int32Array(K);
  for (let i = 0; i < n; i++) C[T[i]]++;
  const bkt = new Int32Array(K);
  const bucketEnds = () => { let s = 0; for (let i = 0; i < K; i++) { s += C[i]; bkt[i] = s; } };
  const bucketStarts = () => { let s = 0; for (let i = 0; i < K; i++) { bkt[i] = s; s += C[i]; } };
  const isLMS = (i: number) => i > 0 && t[i] === 1 && t[i - 1] === 0;
  const induce = () => {
    bucketStarts();
    SA[bkt[T[n - 1]]++] = n - 1; // induced by the sentinel
    for (let i = 0; i < n; i++) {
      const j = SA[i] - 1;
      if (j >= 0 && t[j] === 0) SA[bkt[T[j]]++] = j;
    }
    bucketEnds();
    for (let i = n - 1; i >= 0; i--) {
      const j = SA[i] - 1;
      if (j >= 0 && t[j] === 1) SA[--bkt[T[j]]] = j;
    }
  };

  // Sort the LMS substrings
  SA.fill(-1, 0, n);
  bucketEnds();
  for (let i = 1; i < n; i++) if (isLMS(i)) SA[--bkt[T[i]]] = i;
  induce();

  let n1 = 0;
  for (let i = 0; i < n; i++) if (isLMS(SA[i])) SA[n1++] = SA[i];

  // Name them
  SA.fill(-1, n1, n);
  let name = 0, prev = -1;
  for (let i = 0; i < n1; i++) {
    const p = SA[i];
    let diff = false;
    for (let d = 0; ; d++) {
      if (prev === -1 || p + d === n || prev + d === n || T[p + d] !== T[prev + d] || t[p + d] !== t[prev + d]) {
        diff = true;
        break;
      }
      if (d > 0 && (isLMS(p + d) || isLMS(prev + d))) break;
    }
    if (diff) { name++; prev = p; }
    SA[n1 + (p >> 1)] = name - 1;
  }
  for (let i = n - 1, j = n - 1; i >= n1; i--) if (SA[i] >= 0) SA[j--] = SA[i];

  // Sort the reduced string
  const s1 = SA.subarray(n - n1, n);
  const SA1 = SA.subarray(0, n1);
  if (name < n1) sais(s1, SA1, n1, name);
  else for (let i = 0; i < n1; i++) SA1[s1[i]] = i;

  // Induce the full order from the sorted LMS suffixes
  for (let i = 1, j = 0; i < n; i++) if (isLMS(i)) s1[j++] = i;
  for (let i = 0; i < n1; i++) SA1[i] = s1[SA1[i]];
  SA.fill(-1, n1, n);
  bucketEnds();
  for (let i = n1 - 1; i >= 0; i--) {
    const p = SA[i];
    SA[i] = -1;
    SA[--bkt[T[p]]] = p;
  }
  induce();
}

/** Exported for tests: suffix array of a byte string */
export function suffixArray(s: Uint8Array): Int32Array {
  const T = Int32Array.from(s);
  const SA = new Int32Array(s.length);
  sais(T, SA, s.length, 256);
  return SA;
}

/** Start of the lexicographically least rotation of block[0..n) (Duval / Booth) */
function leastRotation(s: Uint8Array, n: number): number {
  let i = 0, ans = 0;
  while (i < n) {
    ans = i;
    let j = i + 1, k = i;
    while (j < i + n) {
      const a = s[j % n], b = s[k % n];
      if (a < b) break;
      k = a > b ? i : k + 1;
      j++;
    }
    while (i <= k) i += j - k;
  }
  return ans;
}

/**
 * BWT of the cyclic block (the order of its rotations, like bzip2's sort).
 * Rotated to its least rotation the block is a Lyndon word when it is not
 * periodic, and a Lyndon word's rotations sort like its suffixes, so one
 * suffix array of length n is enough. A periodic block sorts the suffixes
 * of block+block instead.
 */
function bwt(block: Uint8Array, n: number, outLast: Uint8Array): number {
  const r = leastRotation(block, n);
  const T = new Int32Array(n);
  for (let i = 0, p = r; i < n; i++) { T[i] = block[p]; if (++p === n) p = 0; }
  // Lyndon iff no proper suffix is <= the word: one Duval step covers it all
  let j = 1, k = 0;
  while (j < n && T[j] >= T[k]) { k = T[j] > T[k] ? 0 : k + 1; j++; }
  const origRow = (n - r) % n; // rotation of T that is the original block
  let row = 0, origPtr = 0;
  if (j === n && j - k === n) {
    const SA = new Int32Array(n);
    sais(T, SA, n, 256);
    for (let i = 0; i < n; i++) {
      const p = SA[i];
      if (p === origRow) origPtr = row;
      outLast[row++] = T[p === 0 ? n - 1 : p - 1];
    }
    return origPtr;
  }
  const n2 = 2 * n;
  const T2 = new Int32Array(n2);
  T2.set(T);
  T2.set(T, n);
  const SA = new Int32Array(n2);
  sais(T2, SA, n2, 256);
  for (let i = 0; i < n2; i++) {
    const p = SA[i];
    if (p >= n) continue;
    if (p === origRow) origPtr = row;
    outLast[row++] = T[p === 0 ? n - 1 : p - 1];
  }
  return origPtr;
}

/** Exported for tests: [BWT, origPtr] of a block */
export function bwtForTest(block: Uint8Array): [Uint8Array, number] {
  const out = new Uint8Array(block.length);
  return [out, bwt(block, block.length, out)];
}

// ── Encoder ───────────────────────────────────────────────────────────

class BitWriter {
  buf: Uint8Array;
  pos = 0;
  private acc = 0;
  private n = 0;
  constructor(cap: number) { this.buf = new Uint8Array(Math.max(cap, 64)); }
  ensure(extra: number): void {
    const need = this.pos + extra + 8;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }
  /** n <= 24 */
  bits(n: number, v: number): void {
    this.acc = (this.acc << n) | v;
    this.n += n;
    while (this.n >= 8) {
      this.n -= 8;
      this.buf[this.pos++] = this.acc >>> this.n;
    }
    this.acc &= (1 << this.n) - 1;
  }
  u32(v: number): void { this.bits(16, (v >>> 16) & 0xffff); this.bits(16, v & 0xffff); }
  finish(): Uint8Array {
    if (this.n > 0) { this.ensure(1); this.buf[this.pos++] = this.acc << (8 - this.n); this.n = 0; this.acc = 0; }
    return this.buf.slice(0, this.pos);
  }
}

/** Huffman code lengths limited to maxLen (bzip2 style: flatten the weights until it fits) */
function makeCodeLengths(len: Uint8Array, freq: Int32Array, alphaSize: number, maxLen: number): void {
  const w = new Float64Array(alphaSize);
  for (let i = 0; i < alphaSize; i++) w[i] = freq[i] === 0 ? 1 : freq[i];
  const nodes = 2 * alphaSize;
  const weight = new Float64Array(nodes);
  const parent = new Int32Array(nodes);
  const heap = new Int32Array(nodes + 1);
  for (;;) {
    let nNodes = alphaSize, hn = 0;
    const push = (x: number) => {
      let i = ++hn;
      while (i > 1 && weight[heap[i >> 1]] > weight[x]) { heap[i] = heap[i >> 1]; i >>= 1; }
      heap[i] = x;
    };
    const pop = (): number => {
      const top = heap[1];
      const x = heap[hn--];
      let i = 1;
      for (;;) {
        let c = i << 1;
        if (c > hn) break;
        if (c < hn && weight[heap[c + 1]] < weight[heap[c]]) c++;
        if (weight[heap[c]] >= weight[x]) break;
        heap[i] = heap[c];
        i = c;
      }
      heap[i] = x;
      return top;
    };
    for (let i = 0; i < alphaSize; i++) { weight[i] = w[i]; parent[i] = -1; push(i); }
    while (hn > 1) {
      const a = pop(), b = pop();
      const p = nNodes++;
      weight[p] = weight[a] + weight[b];
      parent[p] = -1;
      parent[a] = parent[b] = p;
      push(p);
    }
    let tooLong = false;
    for (let i = 0; i < alphaSize; i++) {
      let d = 0;
      for (let k = i; parent[k] >= 0; k = parent[k]) d++;
      len[i] = d;
      if (d > maxLen) tooLong = true;
    }
    if (!tooLong) return;
    for (let i = 0; i < alphaSize; i++) w[i] = 1 + Math.floor(w[i] / 2);
  }
}

interface EncodeScratch {
  last: Uint8Array;
  mtfv: Uint16Array;
}

function writeBlock(bw: BitWriter, block: Uint8Array, nb: number, blockCrc: number, sc: EncodeScratch, randomise: boolean): void {
  if (randomise) {
    // What bzip2 0.9.0 did to repetitive blocks; kept to test the decoder's side of it
    let rNToGo = 0, rTPos = 0;
    for (let i = 0; i < nb; i++) {
      if (rNToGo === 0) { rNToGo = RNUMS[rTPos]; rTPos = (rTPos + 1) & 511; }
      rNToGo--;
      if (rNToGo === 1) block[i] ^= 1;
    }
  }
  const last = sc.last;
  const origPtr = bwt(block, nb, last);

  // Symbol map
  const inUse = new Uint8Array(256);
  for (let i = 0; i < nb; i++) inUse[block[i]] = 1;
  const unseqToSeq = new Uint8Array(256);
  let nInUse = 0;
  for (let i = 0; i < 256; i++) if (inUse[i]) unseqToSeq[i] = nInUse++;
  const alphaSize = nInUse + 2;
  const EOB = nInUse + 1;

  // MTF + RUNA/RUNB
  const mtfv = sc.mtfv;
  const mtfFreq = new Int32Array(MAX_ALPHA);
  const yy = new Uint8Array(256);
  for (let i = 0; i < nInUse; i++) yy[i] = i;
  let nMTF = 0, zPend = 0;
  const flushZeros = () => {
    zPend--;
    for (;;) {
      const s = zPend & 1; // RUNB = 1, RUNA = 0
      mtfv[nMTF++] = s;
      mtfFreq[s]++;
      if (zPend < 2) break;
      zPend = (zPend - 2) >> 1;
    }
    zPend = 0;
  };
  for (let i = 0; i < nb; i++) {
    const ll = unseqToSeq[last[i]];
    if (yy[0] === ll) { zPend++; continue; }
    if (zPend > 0) flushZeros();
    let j = 1;
    let rtmp = yy[1];
    yy[1] = yy[0];
    while (rtmp !== ll) {
      j++;
      const r2 = rtmp;
      rtmp = yy[j];
      yy[j] = r2;
    }
    yy[0] = rtmp;
    mtfv[nMTF++] = j + 1;
    mtfFreq[j + 1]++;
  }
  if (zPend > 0) flushZeros();
  mtfv[nMTF++] = EOB;
  mtfFreq[EOB]++;

  // Huffman tables: bzip2's initial partition, then 4 refinement passes
  const nGroups = nMTF < 200 ? 2 : nMTF < 600 ? 3 : nMTF < 1200 ? 4 : nMTF < 2400 ? 5 : 6;
  const len: Uint8Array[] = [];
  for (let t = 0; t < nGroups; t++) len.push(new Uint8Array(MAX_ALPHA));
  {
    let nPart = nGroups, remF = nMTF, gs = 0;
    while (nPart > 0) {
      const tFreq = remF / nPart;
      let ge = gs - 1, aFreq = 0;
      while (aFreq < tFreq && ge < alphaSize - 1) { ge++; aFreq += mtfFreq[ge]; }
      if (ge > gs && nPart !== nGroups && nPart !== 1 && (nGroups - nPart) % 2 === 1) {
        aFreq -= mtfFreq[ge];
        ge--;
      }
      for (let v = 0; v < alphaSize; v++) len[nPart - 1][v] = v >= gs && v <= ge ? 0 : 15;
      nPart--;
      gs = ge + 1;
      remF -= aFreq;
    }
  }
  const nSelectors = Math.ceil(nMTF / 50);
  const selector = new Uint8Array(nSelectors);
  const rfreq: Int32Array[] = [];
  for (let t = 0; t < nGroups; t++) rfreq.push(new Int32Array(MAX_ALPHA));
  const cost = new Int32Array(6);
  for (let iter = 0; iter < 4; iter++) {
    for (let t = 0; t < nGroups; t++) rfreq[t].fill(0);
    for (let g = 0, gs = 0; gs < nMTF; g++, gs += 50) {
      const ge = Math.min(gs + 50, nMTF);
      cost.fill(0);
      for (let i = gs; i < ge; i++) {
        const s = mtfv[i];
        for (let t = 0; t < nGroups; t++) cost[t] += len[t][s];
      }
      let bt = 0;
      for (let t = 1; t < nGroups; t++) if (cost[t] < cost[bt]) bt = t;
      selector[g] = bt;
      const rf = rfreq[bt];
      for (let i = gs; i < ge; i++) rf[mtfv[i]]++;
    }
    for (let t = 0; t < nGroups; t++) makeCodeLengths(len[t], rfreq[t], alphaSize, 17);
  }

  // Canonical codes
  const code: Int32Array[] = [];
  for (let t = 0; t < nGroups; t++) {
    const c = new Int32Array(MAX_ALPHA);
    const L = len[t];
    let minLen = 32, maxLen = 0;
    for (let i = 0; i < alphaSize; i++) { if (L[i] > maxLen) maxLen = L[i]; if (L[i] < minLen) minLen = L[i]; }
    let vec = 0;
    for (let n = minLen; n <= maxLen; n++) {
      for (let i = 0; i < alphaSize; i++) if (L[i] === n) c[i] = vec++;
      vec <<= 1;
    }
    code.push(c);
  }

  // Emit
  bw.ensure(Math.ceil(nMTF * 17 / 8) + nSelectors + 2048);
  bw.bits(24, BLOCK_MAGIC_HI);
  bw.bits(24, BLOCK_MAGIC_LO);
  bw.u32(blockCrc);
  bw.bits(1, randomise ? 1 : 0);
  bw.bits(24, origPtr);
  let inUse16 = 0;
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) if (inUse[i * 16 + j]) { inUse16 |= 0x8000 >> i; break; }
  bw.bits(16, inUse16);
  for (let i = 0; i < 16; i++) {
    if (!(inUse16 & (0x8000 >> i))) continue;
    let w = 0;
    for (let j = 0; j < 16; j++) if (inUse[i * 16 + j]) w |= 0x8000 >> j;
    bw.bits(16, w);
  }
  bw.bits(3, nGroups);
  bw.bits(15, nSelectors);
  const pos = [0, 1, 2, 3, 4, 5];
  for (let i = 0; i < nSelectors; i++) {
    const ll = selector[i];
    let j = 0;
    while (pos[j] !== ll) j++;
    for (let k = j; k > 0; k--) pos[k] = pos[k - 1];
    pos[0] = ll;
    for (let k = 0; k < j; k++) bw.bits(1, 1);
    bw.bits(1, 0);
  }
  for (let t = 0; t < nGroups; t++) {
    const L = len[t];
    let curr = L[0];
    bw.bits(5, curr);
    for (let i = 0; i < alphaSize; i++) {
      while (curr < L[i]) { bw.bits(2, 2); curr++; }
      while (curr > L[i]) { bw.bits(2, 3); curr--; }
      bw.bits(1, 0);
    }
  }
  for (let g = 0, gs = 0; gs < nMTF; g++, gs += 50) {
    const ge = Math.min(gs + 50, nMTF);
    const L = len[selector[g]], c = code[selector[g]];
    for (let i = gs; i < ge; i++) {
      const s = mtfv[i];
      bw.bits(L[s], c[s]);
    }
  }
}

/**
 * Compress to a single bzip2 stream; blockSize is the 100k block size digit, 1-9.
 * `randomise` writes old-style randomised blocks (only useful for testing decoders).
 */
export function bzip2Compress(data: Uint8Array, blockSize = 9, opts: { randomise?: boolean } = {}): Uint8Array {
  if (!(blockSize >= 1 && blockSize <= 9)) blockSize = 9;
  blockSize = Math.floor(blockSize);
  const n = data.length;
  const bw = new BitWriter(Math.min(n, 1 << 24) / 2 + 64);
  bw.bits(24, 0x425a68); // "BZh"
  bw.bits(8, 0x30 + blockSize);
  const nblockMAX = 100000 * blockSize - 19;
  const block = new Uint8Array(Math.min(nblockMAX, n * 2 + 8));
  const sc: EncodeScratch = { last: new Uint8Array(block.length), mtfv: new Uint16Array(block.length + 1) };
  let combined = 0;
  let p = 0;
  while (p < n) {
    // RLE1: runs of 4-255 bytes become 4 bytes and a count
    const start = p;
    let nb = 0;
    while (p < n) {
      const c = data[p];
      const lim = Math.min(n, p + 255);
      let r = 1;
      while (p + r < lim && data[p + r] === c) r++;
      if (r >= 4) {
        if (nb + 5 > nblockMAX) break;
        block[nb] = block[nb + 1] = block[nb + 2] = block[nb + 3] = c;
        block[nb + 4] = r - 4;
        nb += 5;
      } else {
        if (nb + r > nblockMAX) break;
        for (let k = 0; k < r; k++) block[nb++] = c;
      }
      p += r;
    }
    const blockCrc = bzip2Crc(data, start, p);
    combined = (((combined << 1) | (combined >>> 31)) ^ blockCrc) >>> 0;
    writeBlock(bw, block, nb, blockCrc, sc, !!opts.randomise);
  }
  bw.ensure(16);
  bw.bits(24, EOS_MAGIC_HI);
  bw.bits(24, EOS_MAGIC_LO);
  bw.u32(combined);
  return bw.finish();
}
