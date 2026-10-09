// The Browser app's TLS client (docs/BROWSER.md, "Network"): TLS 1.3 and 1.2
// from one ClientHello, on WebCrypto, so the relay only ever carries
// ciphertext.
//
// Two shapes of ClientHello:
//   'chrome'  looks like Chrome's (GREASE, Chrome's suite and group lists, ALPN
//             h2 + http/1.1, extension order shuffled per connection), so
//             fingerprinting bot defenses treat us like a browser. It offers a
//             few things we can't do (ChaCha20, CBC and RSA key exchange in
//             1.2); a server that picks one of those gets a 'narrow' retry.
//   'narrow'  offers only what we implement.
// What we implement:
//   TLS 1.3: X25519 / P-256 / P-384 key shares (HelloRetryRequest included),
//            AES-128-GCM-SHA256 and AES-256-GCM-SHA384, ECDSA and RSA-PSS
//            CertificateVerify, ALPN.
//   TLS 1.2: ECDHE (X25519, P-256, P-384) with AES-GCM, extended master secret
//            when offered (required unless the server lacks it), no
//            renegotiation, resumption, CBC or RSA key exchange.
// Certificates: subtls's parser and chain checks (src/browser/vendor/subtls),
// against Mozilla's roots plus the user's.
import { Cert, verifyCerts, type RootCertsDatabase } from './vendor/subtls/index.js';
import type { ByteStream } from './http1';

export type HelloShape = 'chrome' | 'narrow';

export interface TlsOptions {
  shape: HelloShape;
  alpn?: string[];
}

export interface TlsSession extends ByteStream {
  version: '1.2' | '1.3';
  alpn: string | null;
  cipher: number;
}

/** Thrown when the server chose something the 'chrome' hello offered but we can't do. */
export class UnsupportedChoice extends Error {}

const te = new TextEncoder();
const subtle = crypto.subtle;

// ── bytes ──

export function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u8 = (n: number) => new Uint8Array([n & 255]);
const u16 = (n: number) => new Uint8Array([(n >> 8) & 255, n & 255]);
const u24 = (n: number) => new Uint8Array([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
const vec8 = (b: Uint8Array) => cat(u8(b.length), b);
const vec16 = (b: Uint8Array) => cat(u16(b.length), b);
const vec24 = (b: Uint8Array) => cat(u24(b.length), b);
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

class Reader {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  get left() { return this.b.length - this.o; }
  n8() { if (this.o + 1 > this.b.length) throw new Error('TLS message truncated'); return this.b[this.o++]; }
  n16() { return (this.n8() << 8) | this.n8(); }
  n24() { return (this.n8() << 16) | (this.n8() << 8) | this.n8(); }
  bytes(n: number) { if (this.o + n > this.b.length) throw new Error('TLS message truncated'); const r = this.b.subarray(this.o, this.o + n); this.o += n; return r; }
  v8() { return this.bytes(this.n8()); }
  v16() { return this.bytes(this.n16()); }
  v24() { return this.bytes(this.n24()); }
}

// ── GREASE (RFC 8701) ──

function grease(): number {
  const n = crypto.getRandomValues(new Uint8Array(1))[0] & 0x0f;
  return (n << 12) | 0x0a00 | (n << 4) | 0x0a; // 0x?a?a
}

// ── crypto helpers ──

type Hash = 'SHA-256' | 'SHA-384';
const hashLen = (h: Hash) => (h === 'SHA-256' ? 32 : 48);
const digest = async (h: Hash, d: Uint8Array) => new Uint8Array(await subtle.digest(h, d as BufferSource));

async function hmac(h: Hash, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey('raw', (key.length ? key : new Uint8Array(hashLen(h))) as BufferSource, { name: 'HMAC', hash: h }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data as BufferSource));
}

const hkdfExtract = (h: Hash, salt: Uint8Array, ikm: Uint8Array) => hmac(h, salt, ikm);

async function hkdfExpand(h: Hash, prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  let t: Uint8Array = new Uint8Array(0);
  for (let i = 1, have = 0; have < len; i++) {
    t = await hmac(h, prk, cat(t, info, u8(i)));
    out.push(t);
    have += t.length;
  }
  return cat(...out).subarray(0, len);
}

const expandLabel = (h: Hash, secret: Uint8Array, label: string, ctx: Uint8Array, len: number) =>
  hkdfExpand(h, secret, cat(u16(len), vec8(te.encode('tls13 ' + label)), vec8(ctx)), len);

/** TLS 1.2 PRF (RFC 5246 5). */
export async function prf(h: Hash, secret: Uint8Array, label: string, seed: Uint8Array, len: number): Promise<Uint8Array> {
  const s = cat(te.encode(label), seed);
  const out: Uint8Array[] = [];
  let a = s;
  for (let have = 0; have < len;) {
    a = await hmac(h, secret, a);
    const p = await hmac(h, secret, cat(a, s));
    out.push(p);
    have += p.length;
  }
  return cat(...out).subarray(0, len);
}

// Key exchange groups
const X25519 = 29, P256 = 23, P384 = 24;
interface Share { group: number; pub: Uint8Array; derive: (peer: Uint8Array) => Promise<Uint8Array> }

async function makeShare(group: number): Promise<Share> {
  if (group === X25519) {
    const kp = await subtle.generateKey({ name: 'X25519' } as Algorithm, true, ['deriveBits']) as CryptoKeyPair;
    const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
    return {
      group, pub, derive: async (peer) => {
        const k = await subtle.importKey('raw', peer as BufferSource, { name: 'X25519' } as Algorithm, false, []);
        return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: k } as unknown as EcdhKeyDeriveParams, kp.privateKey, 256));
      },
    };
  }
  const curve = group === P256 ? 'P-256' : group === P384 ? 'P-384' : null;
  if (!curve) throw new UnsupportedChoice(`key exchange group ${group}`);
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: curve }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return {
    group, pub, derive: async (peer) => {
      const k = await subtle.importKey('raw', peer as BufferSource, { name: 'ECDH', namedCurve: curve }, false, []);
      return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: k }, kp.privateKey, curve === 'P-256' ? 256 : 384));
    },
  };
}

let x25519Ok: Promise<boolean> | null = null;
function haveX25519(): Promise<boolean> {
  x25519Ok ??= subtle.generateKey({ name: 'X25519' } as Algorithm, false, ['deriveBits']).then(() => true, () => false);
  return x25519Ok;
}

function derToRaw(der: Uint8Array, size: number): Uint8Array {
  const r = new Reader(der);
  if (r.n8() !== 0x30) throw new Error('bad ECDSA signature');
  let l = r.n8();
  if (l & 0x80) r.bytes(l & 0x7f);
  const int = () => {
    if (r.n8() !== 0x02) throw new Error('bad ECDSA signature');
    let v = r.v8();
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error('bad ECDSA signature');
    return cat(new Uint8Array(size - v.length), v);
  };
  return cat(int(), int());
}

/** Verify a handshake signature (scheme from RFC 8446 4.2.3) with the leaf certificate's key. */
async function verifySig(cert: Cert, scheme: number, signed: Uint8Array, sig: Uint8Array, tls13: boolean): Promise<void> {
  const spki = cert.publicKey.all as BufferSource;
  let ok = false;
  if (scheme === 0x0403 || scheme === 0x0503) {
    const ids = cert.publicKey.identifiers.map(String);
    const curve = ids.includes('1.2.840.10045.3.1.7') ? 'P-256' : ids.includes('1.3.132.0.34') ? 'P-384' : null;
    if (!curve || (tls13 && curve !== (scheme === 0x0403 ? 'P-256' : 'P-384'))) throw new Error('ECDSA curve does not match the signature scheme');
    const key = await subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: curve }, false, ['verify']);
    ok = await subtle.verify({ name: 'ECDSA', hash: scheme === 0x0403 ? 'SHA-256' : 'SHA-384' }, key, derToRaw(sig, curve === 'P-256' ? 32 : 48) as BufferSource, signed as BufferSource);
  } else if (scheme >= 0x0804 && scheme <= 0x0806) {
    const hash = ({ 0x0804: 'SHA-256', 0x0805: 'SHA-384', 0x0806: 'SHA-512' } as Record<number, string>)[scheme];
    const key = await subtle.importKey('spki', spki, { name: 'RSA-PSS', hash }, false, ['verify']);
    ok = await subtle.verify({ name: 'RSA-PSS', saltLength: hash === 'SHA-256' ? 32 : hash === 'SHA-384' ? 48 : 64 }, key, sig as BufferSource, signed as BufferSource);
  } else if (!tls13 && (scheme === 0x0401 || scheme === 0x0501 || scheme === 0x0601)) {
    const hash = ({ 0x0401: 'SHA-256', 0x0501: 'SHA-384', 0x0601: 'SHA-512' } as Record<number, string>)[scheme];
    const key = await subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
    ok = await subtle.verify('RSASSA-PKCS1-v1_5', key, sig as BufferSource, signed as BufferSource);
  } else {
    throw new Error(`unsupported signature scheme 0x${scheme.toString(16)}`);
  }
  if (!ok) throw new Error('server signature does not verify');
}

// ── records ──

class RecordReader {
  private buf: Uint8Array = new Uint8Array(0);
  received = 0;
  constructor(private raw: ByteStream) {}
  private async need(n: number): Promise<boolean> {
    while (this.buf.length < n) {
      const d = await this.raw.read();
      if (!d) return false;
      this.received += d.length;
      this.buf = this.buf.length ? cat(this.buf, d) : d;
    }
    return true;
  }
  async next(): Promise<{ type: number; header: Uint8Array; body: Uint8Array } | null> {
    if (!(await this.need(5))) return null;
    const len = (this.buf[3] << 8) | this.buf[4];
    if (len > 16384 + 2048) throw new Error('TLS record too long');
    if (!(await this.need(5 + len))) throw new Error('connection closed mid-record');
    const header = this.buf.slice(0, 5);
    const body = this.buf.slice(5, 5 + len);
    this.buf = this.buf.subarray(5 + len);
    return { type: header[0], header, body };
  }
}

const ALERT = 21, HANDSHAKE = 22, APPDATA = 23, CCS = 20;
function alertError(body: Uint8Array): Error {
  const names: Record<number, string> = { 0: 'close_notify', 10: 'unexpected_message', 20: 'bad_record_mac', 40: 'handshake_failure', 42: 'bad_certificate', 47: 'illegal_parameter', 50: 'decode_error', 70: 'protocol_version', 71: 'insufficient_security', 80: 'internal_error', 109: 'missing_extension', 110: 'unsupported_extension', 112: 'unrecognized_name', 120: 'no_application_protocol' };
  return new Error(`TLS alert ${names[body[1]] ?? body[1]}`);
}

/** AES-GCM record protection; TLS 1.3 (nonce = iv xor seq) or 1.2 (salt + explicit nonce). */
class Aead {
  seq = 0n;
  private constructor(private key: CryptoKey, private iv: Uint8Array, private v13: boolean) {}
  static async make(key: Uint8Array, iv: Uint8Array, v13: boolean, use: 'encrypt' | 'decrypt') {
    return new Aead(await subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [use]), iv, v13);
  }
  private seqBytes() { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, this.seq); return b; }
  private nonce13() {
    const n = this.iv.slice();
    const s = this.seqBytes();
    for (let i = 0; i < 8; i++) n[4 + i] ^= s[i];
    return n;
  }
  async seal(type: number, plain: Uint8Array): Promise<Uint8Array> {
    if (this.v13) {
      const inner = cat(plain, u8(type));
      const header = cat(u8(APPDATA), u16(0x0303), u16(inner.length + 16));
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: this.nonce13() as BufferSource, additionalData: header as BufferSource }, this.key, inner as BufferSource));
      this.seq++;
      return cat(header, ct);
    }
    const explicit = this.seqBytes();
    const aad = cat(explicit, u8(type), u16(0x0303), u16(plain.length));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: cat(this.iv, explicit) as BufferSource, additionalData: aad as BufferSource }, this.key, plain as BufferSource));
    this.seq++;
    const body = cat(explicit, ct);
    return cat(u8(type), u16(0x0303), u16(body.length), body);
  }
  /** Returns [inner type, plaintext]. */
  async open(rec: { type: number; header: Uint8Array; body: Uint8Array }): Promise<[number, Uint8Array]> {
    let pt: Uint8Array;
    try {
      if (this.v13) {
        pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: this.nonce13() as BufferSource, additionalData: rec.header as BufferSource }, this.key, rec.body as BufferSource));
      } else {
        if (rec.body.length < 24) throw new Error('short record');
        const explicit = rec.body.subarray(0, 8);
        const aad = cat(this.seqBytes(), u8(rec.type), u16(0x0303), u16(rec.body.length - 24));
        pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: cat(this.iv, explicit) as BufferSource, additionalData: aad as BufferSource }, this.key, rec.body.subarray(8) as BufferSource));
      }
    } catch { throw new Error('TLS record authentication failed'); }
    this.seq++;
    if (!this.v13) return [rec.type, pt];
    let i = pt.length - 1;
    while (i >= 0 && pt[i] === 0) i--;
    if (i < 0) throw new Error('TLS 1.3 record without a content type');
    return [pt[i], pt.subarray(0, i)];
  }
}

// ── ClientHello ──

const SUITES_13: Record<number, { hash: Hash; keyLen: number }> = {
  0x1301: { hash: 'SHA-256', keyLen: 16 },
  0x1302: { hash: 'SHA-384', keyLen: 32 },
};
const SUITES_12: Record<number, { hash: Hash; keyLen: number }> = {
  0xc02b: { hash: 'SHA-256', keyLen: 16 }, 0xc02f: { hash: 'SHA-256', keyLen: 16 },
  0xc02c: { hash: 'SHA-384', keyLen: 32 }, 0xc030: { hash: 'SHA-384', keyLen: 32 },
};
// Chrome's list (TLS 1.3, then 1.2 with ChaCha20, CBC and RSA key exchange we don't implement)
const CHROME_SUITES = [0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035];
const NARROW_SUITES = [0x1301, 0x1302, 0xc02b, 0xc02f, 0xc02c, 0xc030];
const SIGALGS = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601];

interface HelloParts { random: Uint8Array; sessionId: Uint8Array; shares: Share[]; build: (shares: Share[], cookie?: Uint8Array, retry?: boolean) => Uint8Array }

async function clientHello(host: string, o: TlsOptions): Promise<HelloParts> {
  const chrome = o.shape === 'chrome';
  const random = crypto.getRandomValues(new Uint8Array(32));
  const sessionId = crypto.getRandomValues(new Uint8Array(32)); // middlebox compatibility (RFC 8446 D.4)
  const x = await haveX25519();
  const groups = x ? [X25519, P256, P384] : [P256, P384];
  const shares = [await makeShare(groups[0])];
  const g = { cipher: grease(), group: grease(), version: grease(), ext1: grease(), ext2: grease() };
  if (g.ext2 === g.ext1) g.ext2 ^= 0x1010;
  const isIp = /^[\d.]+$/.test(host) || host.includes(':');
  const ext = (type: number, data: Uint8Array) => cat(u16(type), vec16(data));
  let order: number[] | undefined;
  let shuffled = false;
  const build = (sh: Share[], cookie?: Uint8Array, retry = false): Uint8Array => {
    const exts: Uint8Array[] = [];
    if (!isIp) exts.push(ext(0, vec16(cat(u8(0), vec16(te.encode(host))))));
    exts.push(ext(23, new Uint8Array(0)));                                   // extended_master_secret
    exts.push(ext(0xff01, vec8(new Uint8Array(0))));                         // renegotiation_info
    exts.push(ext(10, vec16(cat(...(chrome ? [g.group, ...groups] : groups).map(u16)))));
    exts.push(ext(11, vec8(u8(0))));                                         // ec_point_formats: uncompressed
    if (chrome) exts.push(ext(35, new Uint8Array(0)));                       // session_ticket (we never resume)
    if (o.alpn?.length) exts.push(ext(16, vec16(cat(...o.alpn.map((p) => vec8(te.encode(p)))))));
    if (chrome) exts.push(ext(5, cat(u8(1), u16(0), u16(0))));               // status_request (OCSP)
    exts.push(ext(13, vec16(cat(...SIGALGS.map(u16)))));
    if (chrome) exts.push(ext(18, new Uint8Array(0)));                       // signed_certificate_timestamp
    const ks = sh.map((s) => cat(u16(s.group), vec16(s.pub)));
    // After a HelloRetryRequest the key_share holds exactly the requested group's share (RFC 8446 4.1.2)
    exts.push(ext(51, vec16(cat(...(chrome && !retry ? [cat(u16(g.group), vec16(u8(0)))  /* same GREASE value as in supported_groups, as Chrome does */] : []), ...ks))));
    exts.push(ext(45, vec8(u8(1))));                                         // psk_key_exchange_modes: psk_dhe_ke
    exts.push(ext(43, vec8(cat(...(chrome ? [g.version] : []).map(u16), u16(0x0304), u16(0x0303)))));
    if (cookie) exts.push(ext(44, vec16(cookie)));
    // Chrome shuffles extension order on every connection (GREASE first and last); a retry after
    // HelloRetryRequest must keep the first hello's order, so the permutation is drawn once
    if (chrome) {
      order ??= exts.map((_, i) => i).filter((i) => !(cookie && i === exts.length - 1));
      if (!shuffled) {
        for (let i = order.length - 1; i > 0; i--) {
          const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
          [order[i], order[j]] = [order[j], order[i]];
        }
        shuffled = true;
      }
      // the cookie (HRR only) goes last, after the permuted ones
      const permuted = order.filter((i) => i < exts.length - (cookie ? 1 : 0)).map((i) => exts[i]);
      if (cookie) permuted.push(exts[exts.length - 1]);
      exts.splice(0, exts.length, ...permuted);
    }
    const all = chrome ? [ext(g.ext1, new Uint8Array(0)), ...exts, ext(g.ext2, u8(0))] : exts;
    const suites = chrome ? [g.cipher, ...CHROME_SUITES] : NARROW_SUITES;
    const body = cat(u16(0x0303), random, vec8(sessionId), vec16(cat(...suites.map(u16))), vec8(u8(0)), vec16(cat(...all)));
    return cat(u8(1), vec24(body));
  };
  return { random, sessionId, shares, build };
}

const HRR_RANDOM = new Uint8Array([0xcf, 0x21, 0xad, 0x74, 0xe5, 0x9a, 0x61, 0x11, 0xbe, 0x1d, 0x8c, 0x02, 0x1e, 0x65, 0xb8, 0x91,
  0xc2, 0xa2, 0x11, 0x16, 0x7a, 0xbb, 0x8c, 0x5e, 0x07, 0x9e, 0x09, 0xe2, 0xc8, 0xa8, 0x33, 0x9c]);

const DOWNGRADE_12 = te.encode('DOWNGRD\x01');

interface ServerHello { version: number; random: Uint8Array; suite: number; exts: Map<number, Uint8Array>; raw: Uint8Array }

function parseServerHello(msg: Uint8Array): ServerHello {
  const r = new Reader(msg.subarray(4));
  const legacy = r.n16();
  const random = r.bytes(32).slice();
  r.v8(); // session id echo
  const suite = r.n16();
  if (r.n8() !== 0) throw new Error('server chose compression');
  const exts = new Map<number, Uint8Array>();
  if (r.left) {
    const er = new Reader(r.v16());
    while (er.left) { const t = er.n16(); exts.set(t, er.v16().slice()); }
  }
  const sv = exts.get(43);
  const version = sv ? (sv[0] << 8) | sv[1] : legacy;
  return { version, random, suite, exts, raw: msg };
}

/** Handshake messages out of (plaintext or decrypted) handshake records. */
class HandshakeBuffer {
  private buf: Uint8Array = new Uint8Array(0);
  push(d: Uint8Array) { this.buf = this.buf.length ? cat(this.buf, d) : d.slice(); }
  next(): Uint8Array | null {
    if (this.buf.length < 4) return null;
    const len = (this.buf[1] << 16) | (this.buf[2] << 8) | this.buf[3];
    if (this.buf.length < 4 + len) return null;
    const m = this.buf.slice(0, 4 + len);
    this.buf = this.buf.subarray(4 + len);
    return m;
  }
  get empty() { return this.buf.length === 0; }
}

async function readCertificates(list: Uint8Array, tls13: boolean): Promise<Cert[]> {
  const r = new Reader(list);
  const certs: Cert[] = [];
  while (r.left) {
    certs.push(await Cert.create(r.v24().slice()));
    if (tls13) r.v16(); // CertificateEntry extensions (OCSP, SCT): not used
  }
  if (!certs.length) throw new Error('no server certificate');
  return certs;
}

// ── the handshake ──

export async function tlsHandshake(raw: ByteStream, host: string, roots: RootCertsDatabase, o: TlsOptions): Promise<TlsSession> {
  const hello = await clientHello(host, o);
  let ch = hello.build(hello.shares);
  await raw.write(cat(u8(HANDSHAKE), u16(0x0301), u16(ch.length), ch));
  const rec = new RecordReader(raw);
  const hs = new HandshakeBuffer();

  const nextPlain = async (): Promise<Uint8Array> => {
    for (;;) {
      const m = hs.next();
      if (m) return m;
      const r = await rec.next();
      if (!r) throw Object.assign(new Error('connection closed during the TLS handshake'), { silent: rec.received === 0 });
      if (r.type === ALERT) throw alertError(r.body);
      if (r.type === CCS) continue;
      if (r.type !== HANDSHAKE) throw new Error(`unexpected TLS record type ${r.type}`);
      hs.push(r.body);
    }
  };

  let shMsg = await nextPlain();
  if (shMsg[0] !== 2) throw new Error('expected ServerHello');
  let sh = parseServerHello(shMsg);
  let transcript: Uint8Array[] = [ch];
  let shares = hello.shares;

  if (eq(sh.random, HRR_RANDOM)) {
    // HelloRetryRequest: the server wants another group (and maybe a cookie back)
    const suite = SUITES_13[sh.suite];
    if (!suite) throw new UnsupportedChoice(`TLS 1.3 cipher suite 0x${sh.suite.toString(16)}`);
    const ksExt = sh.exts.get(51);
    if (!ksExt) throw new Error('HelloRetryRequest without key_share');
    const group = (ksExt[0] << 8) | ksExt[1];
    shares = [await makeShare(group)];
    const ch1Hash = await digest(suite.hash, ch);
    transcript = [cat(u8(254), u24(ch1Hash.length), ch1Hash), shMsg];
    ch = hello.build(shares, sh.exts.get(44) ? new Reader(sh.exts.get(44)!).v16().slice() : undefined, true);
    transcript.push(ch);
    await raw.write(cat(u8(HANDSHAKE), u16(0x0303), u16(ch.length), ch));
    shMsg = await nextPlain();
    if (shMsg[0] !== 2) throw new Error('expected ServerHello');
    sh = parseServerHello(shMsg);
    if (eq(sh.random, HRR_RANDOM)) throw new Error('second HelloRetryRequest');
  }
  transcript.push(shMsg);

  if (sh.version === 0x0304) return tls13(raw, rec, hs, host, roots, sh, shares, transcript, o);
  if (sh.version === 0x0303) {
    // We offered 1.3, so a 1.3 server answering 1.2 marks its random (RFC 8446 4.1.3): a downgrade
    if (eq(sh.random.subarray(24), DOWNGRADE_12)) throw new Error('TLS downgrade detected');
    return tls12(raw, rec, hs, host, roots, sh, hello.random, transcript, nextPlain);
  }
  throw new Error(`server chose TLS version 0x${sh.version.toString(16)}`);
}

async function tls13(raw: ByteStream, rec: RecordReader, _hs: HandshakeBuffer, host: string, roots: RootCertsDatabase,
  sh: ServerHello, shares: Share[], transcript: Uint8Array[], o: TlsOptions): Promise<TlsSession> {
  const suite = SUITES_13[sh.suite];
  if (!suite) throw new UnsupportedChoice(`TLS 1.3 cipher suite 0x${sh.suite.toString(16)}`);
  const { hash: H, keyLen } = suite;
  const L = hashLen(H);
  const ks = new Reader(sh.exts.get(51) ?? new Uint8Array(0));
  const group = ks.n16();
  const share = shares.find((s) => s.group === group);
  if (!share) throw new Error('server key share for a group we did not send');
  const shared = await share.derive(ks.v16().slice());
  const th = async () => digest(H, cat(...transcript));
  const zeros = new Uint8Array(L);
  const early = await hkdfExtract(H, zeros, zeros);
  const emptyHash = await digest(H, new Uint8Array(0));
  const hsSecret = await hkdfExtract(H, await expandLabel(H, early, 'derived', emptyHash, L), shared);
  const helloHash = await th();
  const cHs = await expandLabel(H, hsSecret, 'c hs traffic', helloHash, L);
  const sHs = await expandLabel(H, hsSecret, 's hs traffic', helloHash, L);
  const keys = async (secret: Uint8Array, use: 'encrypt' | 'decrypt') =>
    Aead.make(await expandLabel(H, secret, 'key', new Uint8Array(0), keyLen), await expandLabel(H, secret, 'iv', new Uint8Array(0), 12), true, use);
  const hsIn = await keys(sHs, 'decrypt');

  const encHs = new HandshakeBuffer();
  const nextEnc = async (): Promise<Uint8Array> => {
    for (;;) {
      const m = encHs.next();
      if (m) return m;
      const r = await rec.next();
      if (!r) throw new Error('connection closed during the TLS handshake');
      if (r.type === CCS) continue;
      if (r.type === ALERT) throw alertError(r.body);
      if (r.type !== APPDATA) throw new Error(`unexpected TLS record type ${r.type}`);
      const [type, pt] = await hsIn.open(r);
      if (type === ALERT) throw alertError(pt);
      if (type !== HANDSHAKE) throw new Error('expected an encrypted handshake message');
      encHs.push(pt);
    }
  };

  // EncryptedExtensions
  const ee = await nextEnc();
  if (ee[0] !== 8) throw new Error('expected EncryptedExtensions');
  transcript.push(ee);
  let alpn: string | null = null;
  const er = new Reader(new Reader(ee.subarray(4)).v16());
  while (er.left) {
    const t = er.n16(), d = er.v16();
    if (t === 16) {
      alpn = new TextDecoder().decode(new Reader(new Reader(d).v16()).v8());
      if (!o.alpn?.includes(alpn)) throw new Error(`server chose ALPN ${alpn}`);
    }
  }
  // Certificate (+ CertificateVerify)
  let m = await nextEnc();
  if (m[0] === 13) throw new Error('server asks for a client certificate');
  if (m[0] !== 11) throw new Error('expected Certificate');
  const cr = new Reader(m.subarray(4));
  cr.v8(); // request context
  const certs = await readCertificates(cr.v24(), true);
  transcript.push(m);
  if (!(await verifyCerts(host, certs, roots))) throw new Error('certificate chain does not reach a trusted root');
  m = await nextEnc();
  if (m[0] !== 15) throw new Error('expected CertificateVerify');
  const cv = new Reader(m.subarray(4));
  const scheme = cv.n16();
  const sig = cv.v16();
  const signed = cat(new Uint8Array(64).fill(0x20), te.encode('TLS 1.3, server CertificateVerify'), u8(0), await th());
  await verifySig(certs[0], scheme, signed, sig, true);
  transcript.push(m);
  // Finished
  m = await nextEnc();
  if (m[0] !== 20) throw new Error('expected Finished');
  const sFinKey = await expandLabel(H, sHs, 'finished', new Uint8Array(0), L);
  if (!eq(m.subarray(4), await hmac(H, sFinKey, await th()))) throw new Error('server Finished does not verify');
  transcript.push(m);
  const finHash = await th();
  const master = await hkdfExtract(H, await expandLabel(H, hsSecret, 'derived', emptyHash, L), zeros);
  const cAp = await expandLabel(H, master, 'c ap traffic', finHash, L);
  const sAp = await expandLabel(H, master, 's ap traffic', finHash, L);
  // Our Finished (after a middlebox-compatibility CCS)
  const cFinKey = await expandLabel(H, cHs, 'finished', new Uint8Array(0), L);
  const cFin = cat(u8(20), vec24(await hmac(H, cFinKey, finHash)));
  const hsOut = await keys(cHs, 'encrypt');
  await raw.write(cat(u8(CCS), u16(0x0303), u16(1), u8(1), await hsOut.seal(HANDSHAKE, cFin)));
  let out = await keys(cAp, 'encrypt');
  let inp = await keys(sAp, 'decrypt');
  let sTraffic = sAp, cTraffic = cAp;

  let closed = false;
  const self: TlsSession = {
    version: '1.3', alpn, cipher: sh.suite,
    async read() {
      for (;;) {
        if (closed) return undefined;
        const r = await rec.next();
        if (!r) { closed = true; return undefined; }
        if (r.type === CCS) continue;
        if (r.type !== APPDATA) throw new Error(`unexpected TLS record type ${r.type}`);
        const [type, pt] = await inp.open(r);
        if (type === APPDATA) { if (pt.length) return pt; continue; }
        if (type === ALERT) { closed = true; if (pt[1] === 0) return undefined; throw alertError(pt); }
        if (type === HANDSHAKE) {
          // NewSessionTicket (ignored: no resumption) or KeyUpdate
          if (pt[0] === 24) {
            sTraffic = await expandLabel(H, sTraffic, 'traffic upd', new Uint8Array(0), L);
            inp = await keys(sTraffic, 'decrypt');
            if (pt[4] === 1) {
              await raw.write(await out.seal(HANDSHAKE, cat(u8(24), u24(1), u8(0))));
              cTraffic = await expandLabel(H, cTraffic, 'traffic upd', new Uint8Array(0), L);
              out = await keys(cTraffic, 'encrypt');
            }
          }
          continue;
        }
        throw new Error(`unexpected TLS inner type ${type}`);
      }
    },
    async write(d) {
      for (let i = 0; i < d.length; i += 16384) await raw.write(await out.seal(APPDATA, d.subarray(i, i + 16384)));
    },
    close() { closed = true; raw.close(); },
  };
  return self;
}

async function tls12(raw: ByteStream, rec: RecordReader, hs: HandshakeBuffer, host: string, roots: RootCertsDatabase,
  sh: ServerHello, clientRandom: Uint8Array, transcript: Uint8Array[], nextPlain: () => Promise<Uint8Array>): Promise<TlsSession> {
  const suite = SUITES_12[sh.suite];
  if (!suite) throw new UnsupportedChoice(`TLS 1.2 cipher suite 0x${sh.suite.toString(16)}`);
  const { hash: H, keyLen } = suite;
  const ems = sh.exts.has(23);
  let alpn: string | null = null;
  const ap = sh.exts.get(16);
  if (ap) alpn = new TextDecoder().decode(new Reader(new Reader(ap).v16()).v8());

  let m = await nextPlain();
  if (m[0] !== 11) throw new Error('expected Certificate');
  const certs = await readCertificates(new Reader(m.subarray(4)).v24(), false);
  transcript.push(m);
  if (!(await verifyCerts(host, certs, roots))) throw new Error('certificate chain does not reach a trusted root');
  m = await nextPlain();
  if (m[0] === 22) { transcript.push(m); m = await nextPlain(); } // CertificateStatus (OCSP stapling)
  if (m[0] !== 12) throw new UnsupportedChoice('TLS 1.2 without ECDHE');
  transcript.push(m);
  const k = new Reader(m.subarray(4));
  if (k.n8() !== 3) throw new Error('not a named curve');
  const group = k.n16();
  const serverPub = k.v8().slice();
  const paramsEnd = k.o;
  const scheme = k.n16();
  const sig = k.v16();
  await verifySig(certs[0], scheme, cat(clientRandom, sh.random, m.subarray(4, 4 + paramsEnd)), sig, false);
  m = await nextPlain();
  if (m[0] === 13) throw new Error('server asks for a client certificate');
  if (m[0] !== 14) throw new Error('expected ServerHelloDone');
  transcript.push(m);

  const share = await makeShare(group);
  const pms = await share.derive(serverPub);
  const cke = cat(u8(16), vec24(vec8(share.pub)));
  transcript.push(cke);
  const th = async () => digest(H, cat(...transcript));
  const master = ems
    ? await prf(H, pms, 'extended master secret', await th(), 48)
    : await prf(H, pms, 'master secret', cat(clientRandom, sh.random), 48);
  const kb = await prf(H, master, 'key expansion', cat(sh.random, clientRandom), 2 * keyLen + 8);
  const out = await Aead.make(kb.slice(0, keyLen), kb.slice(2 * keyLen, 2 * keyLen + 4), false, 'encrypt');
  const inp = await Aead.make(kb.slice(keyLen, 2 * keyLen), kb.slice(2 * keyLen + 4, 2 * keyLen + 8), false, 'decrypt');
  const cFin = cat(u8(20), u24(12), await prf(H, master, 'client finished', await th(), 12));
  transcript.push(cFin);
  await raw.write(cat(u8(HANDSHAKE), u16(0x0303), u16(cke.length), cke, u8(CCS), u16(0x0303), u16(1), u8(1), await out.seal(HANDSHAKE, cFin)));

  let ccs = false;
  for (;;) {
    const r = await rec.next();
    if (!r) throw new Error('connection closed before the server Finished');
    if (r.type === ALERT) throw alertError(r.body);
    if (r.type === CCS) { ccs = true; continue; }
    if (r.type !== HANDSHAKE) throw new Error('expected the server Finished');
    if (!ccs) { hs.push(r.body); let t; while ((t = hs.next())) transcript.push(t); continue; } // NewSessionTicket
    const [, f] = await inp.open(r);
    const expect = await prf(H, master, 'server finished', await th(), 12);
    if (f[0] !== 20 || f.length !== 16 || !eq(f.subarray(4), expect)) throw new Error('server Finished does not verify');
    break;
  }

  let closed = false;
  return {
    version: '1.2', alpn, cipher: sh.suite,
    async read() {
      for (;;) {
        if (closed) return undefined;
        const r = await rec.next();
        if (!r) { closed = true; return undefined; }
        const [type, pt] = await inp.open(r);
        if (type === APPDATA) { if (pt.length) return pt; continue; }
        if (type === ALERT) { closed = true; if (pt[1] === 0) return undefined; throw alertError(pt); }
        if (type === HANDSHAKE) continue; // HelloRequest: renegotiation refused by ignoring it
        throw new Error(`unexpected TLS record type ${type}`);
      }
    },
    async write(d) {
      for (let i = 0; i < d.length; i += 16384) await raw.write(await out.seal(APPDATA, d.subarray(i, i + 16384)));
    },
    close() { closed = true; raw.close(); },
  };
}
