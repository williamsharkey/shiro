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

export function createCryptoModule(deps: CryptoDeps): any {
  const { sha256sync, sha1sync, fnvHash, FakeBuffer } = deps;

  return {
    randomBytes: (n: number, cb?: Function) => {
      const bytes = new Uint8Array(n);
      crypto.getRandomValues(bytes);
      Object.setPrototypeOf(bytes, FakeBuffer.prototype);
      if (cb) { setTimeout(() => cb(null, bytes), 0); return; }
      return bytes;
    },
    createHash: (algo: string) => {
      const chunks: Uint8Array[] = [];
      const hashObj: any = {
        update: (d: string | Uint8Array, encoding?: string) => {
          if (typeof d === 'string') {
            if (encoding === 'hex') {
              const hex = d.replace(/[^0-9a-fA-F]/g, '');
              const bytes = new Uint8Array(hex.length / 2);
              for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
              chunks.push(bytes);
            } else {
              chunks.push(new TextEncoder().encode(d));
            }
          } else {
            chunks.push(d instanceof Uint8Array ? d : new Uint8Array(d));
          }
          return hashObj;
        },
        digest: (enc?: string) => {
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const all = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { all.set(c, off); off += c.length; }
          // Real SHA-256 (synchronous implementation for PKCE etc.)
          const result = (algo === 'sha256' || algo === 'sha-256') ? sha256sync(all)
            : algo === 'sha1' || algo === 'sha-1' ? sha1sync(all)
            : fnvHash(all, algo === 'md5' ? 16 : 32);
          if (enc === 'hex') return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
          if (enc === 'base64' || enc === 'base64url') { let s = ''; for (let i = 0; i < result.length; i++) s += String.fromCharCode(result[i]); const b64 = btoa(s); return enc === 'base64url' ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64; }
          Object.setPrototypeOf(result, FakeBuffer.prototype);
          return result;
        },
      };
      return hashObj;
    },
    createHmac: (algo: string, key: string | Uint8Array) => {
      // Simple HMAC shim — same as createHash but XOR key into data
      const mod = createCryptoModule(deps);
      const hash = mod.createHash(algo);
      const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
      hash.update(keyBytes);
      return hash;
    },
    randomUUID: () => crypto.randomUUID(),
    randomFillSync: (buf: Uint8Array) => { crypto.getRandomValues(buf); return buf; },
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => {
      if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
      let result = 0;
      for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
      return result === 0;
    },
    getHashes: () => ['sha1', 'sha256', 'sha384', 'sha512', 'md5'],
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
