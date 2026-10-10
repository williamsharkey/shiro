/**
 * Incremental MD5, SHA-1, SHA-256 and SHA-512 (WebCrypto's digest takes the
 * whole input at once): for hashing a file while it streams through, as apt's
 * methods report every hash of what they wrote (src/debian/apt-store.ts).
 * The compression functions are those of src/utils/hashes.ts and xz-codec.
 */

abstract class BlockHash {
  private buf: Uint8Array;
  private bufLen = 0;
  private total = 0;
  constructor(readonly blockSize: number, private littleEndian: boolean) { this.buf = new Uint8Array(blockSize); }

  /** Compress the block at `off` of `dv`. */
  protected abstract compress(dv: DataView, off: number): void;
  protected abstract output(): Uint8Array;

  update(data: Uint8Array): this {
    const B = this.blockSize;
    let i = 0;
    this.total += data.length;
    if (this.bufLen) {
      const k = Math.min(B - this.bufLen, data.length);
      this.buf.set(data.subarray(0, k), this.bufLen);
      this.bufLen += k;
      i = k;
      if (this.bufLen < B) return this;
      this.compress(new DataView(this.buf.buffer), 0);
      this.bufLen = 0;
    }
    const full = data.length - ((data.length - i) % B);
    if (full > i) {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (; i < full; i += B) this.compress(dv, i);
    }
    if (i < data.length) { this.buf.set(data.subarray(i), 0); this.bufLen = data.length - i; }
    return this;
  }

  digest(): Uint8Array {
    const B = this.blockSize, lenBytes = B === 128 ? 16 : 8;
    const bits = this.total * 8;
    const pad = new Uint8Array(((this.bufLen + 1 + lenBytes + B - 1) / B | 0) * B);
    pad.set(this.buf.subarray(0, this.bufLen));
    pad[this.bufLen] = 0x80;
    const dv = new DataView(pad.buffer);
    const hi = Math.floor(bits / 0x100000000) >>> 0, lo = bits >>> 0;
    if (this.littleEndian) { dv.setUint32(pad.length - 8, lo, true); dv.setUint32(pad.length - 4, hi, true); }
    else { dv.setUint32(pad.length - 8, hi); dv.setUint32(pad.length - 4, lo); }
    for (let off = 0; off < pad.length; off += B) this.compress(dv, off);
    return this.output();
  }
}

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0);

export class Md5 extends BlockHash {
  private h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
  private m = new Int32Array(16);
  constructor() { super(64, true); }
  protected compress(dv: DataView, off: number): void {
    const m = this.m, h = this.h;
    for (let i = 0; i < 16; i++) m[i] = dv.getInt32(off + i * 4, true);
    let a = h[0], b = h[1], c = h[2], d = h[3];
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const t = d; d = c; c = b;
      const x = (a + f + MD5_K[i] + m[g]) | 0;
      b = (b + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) | 0;
      a = t;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  }
  protected output(): Uint8Array {
    const out = new Uint8Array(16), dv = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) dv.setInt32(i * 4, this.h[i], true);
    return out;
  }
}

export class Sha1 extends BlockHash {
  private h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0]);
  private w = new Int32Array(80);
  constructor() { super(64, false); }
  protected compress(dv: DataView, off: number): void {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? ((b & c) | (~b & d)) + 0x5a827999 : i < 40 ? (b ^ c ^ d) + 0x6ed9eba1
        : i < 60 ? ((b & c) | (b & d) | (c & d)) - 0x70e44324 : (b ^ c ^ d) - 0x359d3e2a;
      const t = (((a << 5) | (a >>> 27)) + f + e + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
  }
  protected output(): Uint8Array {
    const out = new Uint8Array(20), dv = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) dv.setInt32(i * 4, this.h[i]);
    return out;
  }
}

const K256 = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 extends BlockHash {
  private h = new Int32Array([0x6a09e667, 0xbb67ae85 | 0, 0x3c6ef372, 0xa54ff53a | 0, 0x510e527f, 0x9b05688c | 0, 0x1f83d9ab, 0x5be0cd19]);
  private w = new Int32Array(64);
  constructor() { super(64, false); }
  protected compress(dv: DataView, off: number): void {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  protected output(): Uint8Array {
    const out = new Uint8Array(32), dv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) dv.setInt32(i * 4, this.h[i]);
    return out;
  }
}

// SHA-512 round constants as [hi, lo] 32-bit halves
const K512 = new Int32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);

export class Sha512 extends BlockHash {
  private h = new Int32Array([0x6a09e667, 0xf3bcc908 | 0, 0xbb67ae85 | 0, 0x84caa73b | 0, 0x3c6ef372, 0xfe94f82b | 0, 0xa54ff53a | 0, 0x5f1d36f1,
    0x510e527f, 0xade682d1 | 0, 0x9b05688c | 0, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b | 0, 0x5be0cd19, 0x137e2179]);
  private w = new Int32Array(160);
  constructor() { super(128, false); }
  protected compress(dv: DataView, off: number): void {
    const w = this.w, h = this.h;
    for (let i = 0; i < 32; i++) w[i] = dv.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const xh = w[(i - 15) * 2], xl = w[(i - 15) * 2 + 1];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      const yh = w[(i - 2) * 2], yl = w[(i - 2) * 2 + 1];
      const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
      const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
      const lo = (s0l >>> 0) + (s1l >>> 0) + (w[(i - 16) * 2 + 1] >>> 0) + (w[(i - 7) * 2 + 1] >>> 0);
      w[i * 2] = s0h + s1h + w[(i - 16) * 2] + w[(i - 7) * 2] + Math.floor(lo / 0x100000000);
      w[i * 2 + 1] = lo;
    }
    let ah = h[0], al = h[1], bh = h[2], bl = h[3], ch = h[4], cl = h[5], dh = h[6], dl = h[7];
    let eh = h[8], el = h[9], fh = h[10], fl = h[11], gh = h[12], gl = h[13], hh = h[14], hl = h[15];
    for (let i = 0; i < 80; i++) {
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      let t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K512[i * 2 + 1] >>> 0) + (w[i * 2 + 1] >>> 0);
      const t1h = hh + S1h + chh + K512[i * 2] + w[i * 2] + Math.floor(t1l / 0x100000000);
      t1l >>>= 0;
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mh = (ah & bh) ^ (ah & ch) ^ (bh & ch), ml = (al & bl) ^ (al & cl) ^ (bl & cl);
      let t2l = (S0l >>> 0) + (ml >>> 0);
      const t2h = S0h + mh + Math.floor(t2l / 0x100000000);
      t2l >>>= 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      let nl = (dl >>> 0) + t1l;
      eh = (dh + t1h + Math.floor(nl / 0x100000000)) | 0; el = nl | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      nl = t1l + t2l;
      ah = (t1h + t2h + Math.floor(nl / 0x100000000)) | 0; al = nl | 0;
    }
    const add = (i: number, xh: number, xl: number) => {
      const lo = (h[i + 1] >>> 0) + (xl >>> 0);
      h[i] = (h[i] + xh + Math.floor(lo / 0x100000000)) | 0;
      h[i + 1] = lo | 0;
    };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl);
    add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }
  protected output(): Uint8Array {
    const out = new Uint8Array(64), dv = new DataView(out.buffer);
    for (let i = 0; i < 16; i++) dv.setInt32(i * 4, this.h[i]);
    return out;
  }
}

const hex = (b: Uint8Array) => { let s = ''; for (const x of b) s += x.toString(16).padStart(2, '0'); return s; };

/** MD5, SHA-1, SHA-256 and SHA-512 of one stream at once, as apt's methods report them. */
export class AptHashes {
  private hs = [new Md5(), new Sha1(), new Sha256(), new Sha512()] as const;
  size = 0;
  update(data: Uint8Array): void { this.size += data.length; for (const h of this.hs) h.update(data); }
  /** The `*-Hash` fields of a `201 URI Done` (the same as hashFields). */
  fields(): string {
    const [md5, sha1, sha256, sha512] = this.hs.map((h) => hex(h.digest()));
    return `MD5-Hash: ${md5}\nMD5Sum-Hash: ${md5}\nSHA1-Hash: ${sha1}\nSHA256-Hash: ${sha256}\nSHA512-Hash: ${sha512}\n`;
  }
}
