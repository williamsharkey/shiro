/**
 * Node.js 'crypto' module shim.
 * Extracted from node-cmd.ts case 'crypto'.
 */

export interface CryptoDeps {
  sha256sync: (data: Uint8Array) => Uint8Array;
  sha1sync: (data: Uint8Array) => Uint8Array;
  fnvHash: (data: Uint8Array, size: number) => Uint8Array;
  FakeBuffer: any;
}

import { sha512sync, sha384sync, md5sync, hmacSync } from '../../utils/hashes';

export function createCryptoModule(deps: CryptoDeps): any {
  const { sha256sync, sha1sync, FakeBuffer } = deps;
  // Synchronous digests and their block sizes (for HMAC)
  const HASHES: Record<string, [(d: Uint8Array) => Uint8Array, number]> = {
    sha1: [sha1sync, 64], sha256: [sha256sync, 64], sha384: [sha384sync, 128], sha512: [sha512sync, 128], md5: [md5sync, 64],
  };
  const hashFor = (algo: string) => {
    const h = HASHES[String(algo).toLowerCase().replace(/^sha-/, 'sha')];
    if (!h) throw Object.assign(new Error(`Digest method not supported: ${algo}`), { code: 'ERR_CRYPTO_INVALID_DIGEST' });
    return h;
  };
  const toBytes = (d: string | Uint8Array, encoding?: string): Uint8Array => {
    if (typeof d !== 'string') return d instanceof Uint8Array ? d : new Uint8Array(d as any);
    if (encoding === 'hex') {
      const hex = d.replace(/[^0-9a-fA-F]/g, '');
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      return bytes;
    }
    if (encoding === 'base64' || encoding === 'base64url') return new Uint8Array(FakeBuffer.from(d, encoding));
    if (encoding === 'latin1' || encoding === 'binary') return Uint8Array.from(d, (c) => c.charCodeAt(0) & 255);
    return new TextEncoder().encode(d);
  };
  const encodeDigest = (result: Uint8Array, enc?: string): any => {
    if (enc === 'hex') return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
    if (enc === 'base64' || enc === 'base64url') { let s = ''; for (let i = 0; i < result.length; i++) s += String.fromCharCode(result[i]); const b64 = btoa(s); return enc === 'base64url' ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64; }
    if (enc === 'latin1' || enc === 'binary') return String.fromCharCode(...result);
    Object.setPrototypeOf(result, FakeBuffer.prototype);
    return result;
  };
  /** A Hash/Hmac object: update/digest, and copy() for Hash. */
  const digester = (compute: (all: Uint8Array) => Uint8Array) => {
    const chunks: Uint8Array[] = [];
    const obj: any = {
      update: (d: string | Uint8Array, encoding?: string) => { chunks.push(toBytes(d, encoding)); return obj; },
      digest: (enc?: string) => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const all = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        return encodeDigest(compute(all), enc);
      },
      copy: () => { const c = digester(compute); for (const x of chunks) c.update(x); return c; },
    };
    return obj;
  };

  return {
    randomBytes: (n: number, cb?: Function) => {
      const bytes = new Uint8Array(n);
      crypto.getRandomValues(bytes);
      Object.setPrototypeOf(bytes, FakeBuffer.prototype);
      if (cb) { setTimeout(() => cb(null, bytes), 0); return; }
      return bytes;
    },
    createHash: (algo: string) => { const [h] = hashFor(algo); return digester(h); },
    createHmac: (algo: string, key: string | Uint8Array) => {
      const [h, block] = hashFor(algo);
      const k = toBytes(typeof key === 'object' && key && 'export' in (key as any) ? (key as any).export() : key);
      return digester((all) => hmacSync(h, block, k, all));
    },
    hash: (algo: string, data: string | Uint8Array, enc = 'hex') => encodeDigest(hashFor(algo)[0](toBytes(data)), enc),
    randomUUID: () => crypto.randomUUID(),
    // (vite makes its dev server's WebSocket token with it)
    getRandomValues: <T extends ArrayBufferView>(a: T): T => crypto.getRandomValues(a as any) as T,
    randomFillSync: (buf: Uint8Array) => { crypto.getRandomValues(buf); return buf; },
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => {
      if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
      let result = 0;
      for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
      return result === 0;
    },
    getHashes: () => Object.keys(HASHES),
    getCiphers: () => ['aes-256-cbc', 'aes-128-cbc', 'aes-256-gcm'],
    createPrivateKey: (key: any) => ({ type: 'private', export: () => key }),
    createPublicKey: (key: any) => ({ type: 'public', export: () => key }),
    createSecretKey: (key: any) => ({ type: 'secret', export: () => key }),
    KeyObject: class KeyObject { type = 'secret'; constructor(type?: string) { if (type) this.type = type; } export() { return new Uint8Array(0); } },
    // Web Crypto API for jose and other crypto libraries
    webcrypto: crypto,
    subtle: crypto.subtle,
  };
}
