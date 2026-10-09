// A TLS 1.2 client on WebCrypto, for servers that don't speak TLS 1.3
// (docs/BROWSER.md, "Network"). Deliberately narrow:
//   ECDHE (P-256, P-384) + AES-GCM only (RFC 5289), so forward secrecy and
//   AEAD always; no RSA key exchange, CBC, renegotiation, resumption or
//   client certificates. Extended master secret (RFC 7627) is required.
// Certificates go through the same chain checks as TLS 1.3 (subtls's verifyCerts).
import { Cert, verifyCerts, type RootCertsDatabase } from './vendor/subtls/index.js';
import type { ByteStream } from './http1';

const SUITES: Record<number, { hash: 'SHA-256' | 'SHA-384'; keyLen: 16 | 32 }> = {
  0xc02b: { hash: 'SHA-256', keyLen: 16 }, // ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
  0xc02f: { hash: 'SHA-256', keyLen: 16 }, // ECDHE_RSA_WITH_AES_128_GCM_SHA256
  0xc02c: { hash: 'SHA-384', keyLen: 32 }, // ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
  0xc030: { hash: 'SHA-384', keyLen: 32 }, // ECDHE_RSA_WITH_AES_256_GCM_SHA384
};
const CURVES: Record<number, { name: 'P-256' | 'P-384'; size: number }> = { 23: { name: 'P-256', size: 32 }, 24: { name: 'P-384', size: 48 } };
const SIGALGS = [0x0403, 0x0503, 0x0804, 0x0805, 0x0806, 0x0401, 0x0501, 0x0601];

const te = new TextEncoder();
const subtle = crypto.subtle;

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u16 = (n: number) => new Uint8Array([n >> 8, n & 255]);
const u24 = (n: number) => new Uint8Array([n >> 16, (n >> 8) & 255, n & 255]);
const vec8 = (b: Uint8Array) => cat(new Uint8Array([b.length]), b);
const vec16 = (b: Uint8Array) => cat(u16(b.length), b);

/** P_hash from RFC 5246 5 (the TLS 1.2 PRF). */
export async function prf(hash: 'SHA-256' | 'SHA-384', secret: Uint8Array, label: string, seed: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash }, false, ['sign']);
  const s = cat(te.encode(label), seed);
  const out: Uint8Array[] = [];
  let a = s;
  let have = 0;
  while (have < len) {
    a = new Uint8Array(await subtle.sign('HMAC', key, a as BufferSource));
    const p = new Uint8Array(await subtle.sign('HMAC', key, cat(a, s) as BufferSource));
    out.push(p);
    have += p.length;
  }
  return cat(...out).subarray(0, len);
}

/** DER ECDSA signature → the raw r||s WebCrypto wants. */
function derToRaw(der: Uint8Array, size: number): Uint8Array {
  let i = 2;
  if (der[0] !== 0x30) throw new Error('bad ECDSA signature');
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const int = () => {
    if (der[i++] !== 0x02) throw new Error('bad ECDSA signature');
    const len = der[i++];
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error('bad ECDSA signature');
    return cat(new Uint8Array(size - v.length), v);
  };
  return cat(int(), int());
}

async function verifySignature(cert: Cert, scheme: number, signed: Uint8Array, sig: Uint8Array): Promise<boolean> {
  const spki = cert.publicKey.all as BufferSource;
  const hashOf = (s: number) => (({ 4: 'SHA-256', 5: 'SHA-384', 6: 'SHA-512' }) as Record<number, string>)[s >> 8];
  if (scheme === 0x0403 || scheme === 0x0503) {
    const ids = cert.publicKey.identifiers.map(String);
    const curve = ids.includes('1.2.840.10045.3.1.7') ? 'P-256' : ids.includes('1.3.132.0.34') ? 'P-384' : null;
    if (!curve) throw new Error('unsupported ECDSA curve');
    const key = await subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: curve }, false, ['verify']);
    return subtle.verify({ name: 'ECDSA', hash: scheme === 0x0403 ? 'SHA-256' : 'SHA-384' }, key, derToRaw(sig, curve === 'P-256' ? 32 : 48) as BufferSource, signed as BufferSource);
  }
  if (scheme >= 0x0804 && scheme <= 0x0806) {
    const hash = ({ 0x0804: 'SHA-256', 0x0805: 'SHA-384', 0x0806: 'SHA-512' } as Record<number, string>)[scheme];
    const key = await subtle.importKey('spki', spki, { name: 'RSA-PSS', hash }, false, ['verify']);
    return subtle.verify({ name: 'RSA-PSS', saltLength: hash === 'SHA-256' ? 32 : hash === 'SHA-384' ? 48 : 64 }, key, sig as BufferSource, signed as BufferSource);
  }
  if ((scheme & 0xff) === 0x01 && hashOf(scheme)) {
    const key = await subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: hashOf(scheme) }, false, ['verify']);
    return subtle.verify('RSASSA-PKCS1-v1_5', key, sig as BufferSource, signed as BufferSource);
  }
  throw new Error(`unsupported signature scheme 0x${scheme.toString(16)}`);
}

/** Byte reader over the record layer. */
class Records {
  private buf: Uint8Array = new Uint8Array(0);
  constructor(private raw: ByteStream) {}
  private async need(n: number): Promise<boolean> {
    while (this.buf.length < n) {
      const d = await this.raw.read();
      if (!d) return false;
      this.buf = cat(this.buf, d);
    }
    return true;
  }
  /** Next record, or null at EOF. */
  async next(): Promise<{ type: number; version: number; body: Uint8Array } | null> {
    if (!(await this.need(5))) return null;
    const type = this.buf[0], version = (this.buf[1] << 8) | this.buf[2], len = (this.buf[3] << 8) | this.buf[4];
    if (len > 16384 + 2048) throw new Error('TLS record too long');
    if (!(await this.need(5 + len))) throw new Error('connection closed mid-record');
    const body = this.buf.slice(5, 5 + len);
    this.buf = this.buf.subarray(5 + len);
    return { type, version, body };
  }
}

class Gcm {
  seq = 0n;
  constructor(private key: CryptoKey, private salt: Uint8Array) {}
  private seqBytes() { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, this.seq); return b; }
  async seal(type: number, plain: Uint8Array): Promise<Uint8Array> {
    const explicit = this.seqBytes();
    const aad = cat(explicit, new Uint8Array([type, 3, 3]), u16(plain.length));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: cat(this.salt, explicit) as BufferSource, additionalData: aad as BufferSource }, this.key, plain as BufferSource));
    this.seq++;
    const body = cat(explicit, ct);
    return cat(new Uint8Array([type, 3, 3]), u16(body.length), body);
  }
  async open(type: number, body: Uint8Array): Promise<Uint8Array> {
    if (body.length < 24) throw new Error('short TLS record');
    const explicit = body.subarray(0, 8);
    const aad = cat(this.seqBytes(), new Uint8Array([type, 3, 3]), u16(body.length - 24));
    let pt: ArrayBuffer;
    try {
      pt = await subtle.decrypt({ name: 'AES-GCM', iv: cat(this.salt, explicit) as BufferSource, additionalData: aad as BufferSource }, this.key, body.subarray(8) as BufferSource);
    } catch { throw new Error('TLS record authentication failed'); }
    this.seq++;
    return new Uint8Array(pt);
  }
}

/** TLS 1.2 handshake over `raw`; resolves to the encrypted application stream. */
export async function tls12Connect(raw: ByteStream, host: string, roots: RootCertsDatabase): Promise<ByteStream> {
  const clientRandom = crypto.getRandomValues(new Uint8Array(32));
  const isIp = /^[\d.]+$/.test(host) || host.includes(':');
  const ext = (type: number, data: Uint8Array) => cat(u16(type), vec16(data));
  const exts = cat(
    isIp ? new Uint8Array(0) : ext(0, vec16(cat(new Uint8Array([0]), vec16(te.encode(host))))),
    ext(10, vec16(cat(u16(23), u16(24)))),
    ext(11, vec8(new Uint8Array([0]))),
    ext(13, vec16(cat(...SIGALGS.map(u16)))),
    ext(23, new Uint8Array(0)),                 // extended_master_secret
    ext(0xff01, vec8(new Uint8Array(0))),       // renegotiation_info (empty: initial handshake)
  );
  const suites = Object.keys(SUITES).map(Number);
  const helloBody = cat(u16(0x0303), clientRandom, vec8(new Uint8Array(0)), vec16(cat(...suites.map(u16))), vec8(new Uint8Array([0])), vec16(exts));
  const clientHello = cat(new Uint8Array([1]), u24(helloBody.length), helloBody);
  const transcript: Uint8Array[] = [clientHello];
  await raw.write(cat(new Uint8Array([22, 3, 1]), u16(clientHello.length), clientHello));

  const rec = new Records(raw);
  let hsBuf: Uint8Array = new Uint8Array(0);
  /** Next plaintext handshake message (type, body), taken from handshake records. */
  const nextHandshake = async (): Promise<{ type: number; body: Uint8Array; raw: Uint8Array }> => {
    for (;;) {
      if (hsBuf.length >= 4) {
        const len = (hsBuf[1] << 16) | (hsBuf[2] << 8) | hsBuf[3];
        if (hsBuf.length >= 4 + len) {
          const msg = hsBuf.slice(0, 4 + len);
          hsBuf = hsBuf.subarray(4 + len);
          return { type: msg[0], body: msg.subarray(4), raw: msg };
        }
      }
      const r = await rec.next();
      if (!r) throw new Error('connection closed during the TLS 1.2 handshake');
      if (r.type === 21) throw new Error(`TLS alert ${r.body[1]}`);
      if (r.type !== 22) throw new Error(`unexpected TLS record type ${r.type}`);
      hsBuf = cat(hsBuf, r.body);
    }
  };

  // ServerHello
  const sh = await nextHandshake();
  if (sh.type !== 2) throw new Error('expected ServerHello');
  transcript.push(sh.raw);
  const b = sh.body;
  if (((b[0] << 8) | b[1]) !== 0x0303) throw new Error('server did not choose TLS 1.2');
  const serverRandom = b.slice(2, 34);
  // No RFC 8446 4.1.3 downgrade check: this hello doesn't offer 1.3 (it's the fallback after a 1.3 attempt
  // failed), so every 1.3-capable server sets the sentinel. A forced fallback still lands on ECDHE + AEAD + EMS.
  let o = 34;
  o += 1 + b[o]; // session id
  const suite = (b[o] << 8) | b[o + 1];
  o += 3; // suite + compression
  const params = SUITES[suite];
  if (!params) throw new Error(`server chose cipher suite 0x${suite.toString(16)}`);
  let ems = false;
  if (o < b.length) {
    const end = o + 2 + ((b[o] << 8) | b[o + 1]);
    for (o += 2; o < end;) {
      const t = (b[o] << 8) | b[o + 1], l = (b[o + 2] << 8) | b[o + 3];
      if (t === 23) ems = true;
      o += 4 + l;
    }
  }
  if (!ems) throw new Error('server does not support extended master secret');

  // Certificate
  const cm = await nextHandshake();
  if (cm.type !== 11) throw new Error('expected Certificate');
  transcript.push(cm.raw);
  const certs: Cert[] = [];
  for (let p = 3; p < cm.body.length;) {
    const l = (cm.body[p] << 16) | (cm.body[p + 1] << 8) | cm.body[p + 2];
    certs.push(await Cert.create(cm.body.slice(p + 3, p + 3 + l)));
    p += 3 + l;
  }
  if (!certs.length) throw new Error('no server certificate');
  if (!(await verifyCerts(host, certs, roots))) throw new Error('certificate chain does not reach a trusted root');

  // ServerKeyExchange (ECDHE only), signed by the certificate's key
  const ske = await nextHandshake();
  if (ske.type !== 12) throw new Error('expected ServerKeyExchange (ECDHE)');
  transcript.push(ske.raw);
  const k = ske.body;
  if (k[0] !== 3) throw new Error('not a named curve');
  const curve = CURVES[(k[1] << 8) | k[2]];
  if (!curve) throw new Error('unsupported curve');
  const pointLen = k[3];
  const serverPoint = k.slice(4, 4 + pointLen);
  const paramsEnd = 4 + pointLen;
  const scheme = (k[paramsEnd] << 8) | k[paramsEnd + 1];
  if (!SIGALGS.includes(scheme)) throw new Error('server used a signature scheme we did not offer');
  const sigLen = (k[paramsEnd + 2] << 8) | k[paramsEnd + 3];
  const sig = k.slice(paramsEnd + 4, paramsEnd + 4 + sigLen);
  if (!(await verifySignature(certs[0], scheme, cat(clientRandom, serverRandom, k.subarray(0, paramsEnd)), sig))) throw new Error('ServerKeyExchange signature does not verify');

  const done = await nextHandshake();
  if (done.type === 13) throw new Error('server asks for a client certificate');
  if (done.type !== 14) throw new Error('expected ServerHelloDone');
  transcript.push(done.raw);

  // Our key share, the master secret (extended) and the keys
  const mine = await subtle.generateKey({ name: 'ECDH', namedCurve: curve.name }, true, ['deriveBits']) as CryptoKeyPair;
  const myPoint = new Uint8Array(await subtle.exportKey('raw', mine.publicKey));
  const theirs = await subtle.importKey('raw', serverPoint as BufferSource, { name: 'ECDH', namedCurve: curve.name }, false, []);
  const pms = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: theirs }, mine.privateKey, curve.size * 8));
  const cke = cat(new Uint8Array([16]), u24(myPoint.length + 1), vec8(myPoint));
  transcript.push(cke);
  const hashAll = async () => new Uint8Array(await subtle.digest(params.hash, cat(...transcript) as BufferSource));
  const master = await prf(params.hash, pms, 'extended master secret', await hashAll(), 48);
  const kb = await prf(params.hash, master, 'key expansion', cat(serverRandom, clientRandom), 2 * params.keyLen + 8);
  const ck = await subtle.importKey('raw', kb.slice(0, params.keyLen) as BufferSource, 'AES-GCM', false, ['encrypt']);
  const sk = await subtle.importKey('raw', kb.slice(params.keyLen, 2 * params.keyLen) as BufferSource, 'AES-GCM', false, ['decrypt']);
  const out = new Gcm(ck, kb.slice(2 * params.keyLen, 2 * params.keyLen + 4));
  const inp = new Gcm(sk, kb.slice(2 * params.keyLen + 4, 2 * params.keyLen + 8));

  const clientVerify = await prf(params.hash, master, 'client finished', await hashAll(), 12);
  const finished = cat(new Uint8Array([20]), u24(12), clientVerify);
  transcript.push(finished);
  await raw.write(cat(
    new Uint8Array([22, 3, 3]), u16(cke.length), cke,
    new Uint8Array([20, 3, 3, 0, 1, 1]),
    await out.seal(22, finished),
  ));

  // Server ChangeCipherSpec + Finished (a NewSessionTicket before the CCS counts in the transcript)
  let ccs = false;
  for (;;) {
    const r = await rec.next();
    if (!r) throw new Error('connection closed before the server Finished');
    if (r.type === 21) throw new Error(`TLS alert ${r.body[1]}`);
    if (r.type === 20) { ccs = true; continue; }
    if (r.type !== 22) throw new Error('expected the server Finished');
    if (!ccs) { transcript.push(r.body); continue; }
    const expectServer = await prf(params.hash, master, 'server finished', await hashAll(), 12);
    const f = await inp.open(22, r.body);
    if (f[0] !== 20 || f.length !== 16 || !expectServer.every((x, i) => x === f[4 + i])) throw new Error('server Finished does not verify');
    break;
  }

  let closed = false;
  let pending: Uint8Array[] = [];
  return {
    async read() {
      for (;;) {
        if (pending.length) return pending.shift();
        if (closed) return undefined;
        const r = await rec.next();
        if (!r) { closed = true; return undefined; }
        if (r.type === 23) { const p = await inp.open(23, r.body); if (p.length) return p; continue; }
        if (r.type === 21) {
          const a = await inp.open(21, r.body);
          if (a[1] === 0 || a[0] === 2) { closed = true; return undefined; }
          continue;
        }
        if (r.type === 22) { await inp.open(22, r.body); continue; } // post-handshake (e.g. HelloRequest): ignored
        throw new Error(`unexpected TLS record type ${r.type}`);
      }
    },
    async write(d) {
      for (let i = 0; i < d.length; i += 16384) await raw.write(await out.seal(23, d.subarray(i, i + 16384)));
    },
    close() { closed = true; pending = []; raw.close(); },
  };
}
