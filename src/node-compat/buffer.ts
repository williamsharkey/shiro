/**
 * FakeBuffer: Node.js Buffer shim built on Uint8Array.
 *
 * Supports utf8, base64, base64url, hex, latin1/binary/ascii encodings.
 * Must be a constructor with prototype for safe-buffer compatibility.
 *
 * This module is self-contained — no dependencies on NodeEnv or closure variables.
 */

export function createFakeBuffer(): any {
  function FakeBuffer(arg?: any, encodingOrOffset?: any, length?: any): any {
    if (typeof arg === 'number') {
      return FakeBuffer.alloc(arg);
    }
    return FakeBuffer.from(arg, encodingOrOffset, length);
  }
  // Buffer[Symbol.species] is Buffer, as in node: ws makes views with
  // `new Buffer[Symbol.species](arrayBuffer, offset, length)` (its FastBuffer)
  Object.defineProperty(FakeBuffer, Symbol.species, { get: () => FakeBuffer, configurable: true });
  FakeBuffer.prototype = Object.create(Uint8Array.prototype);
  FakeBuffer.prototype.constructor = FakeBuffer;
  FakeBuffer.prototype.toString = function(encoding?: string, start?: number, end?: number) {
    const slice = (start !== undefined || end !== undefined)
      ? this.subarray(start ?? 0, end ?? this.length)
      : this;
    if (encoding === 'base64' || encoding === 'base64url') {
      let str = '';
      for (let i = 0; i < slice.length; i++) str += String.fromCharCode(slice[i]);
      const b64 = btoa(str);
      if (encoding === 'base64url') return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return b64;
    }
    if (encoding === 'hex') {
      return Array.from(slice as Uint8Array).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    if (encoding === 'latin1' || encoding === 'binary') {
      let str = '';
      for (let i = 0; i < slice.length; i++) str += String.fromCharCode(slice[i]);
      return str;
    }
    return new TextDecoder().decode(slice);
  };
  // write(string[, offset[, length]][, encoding]): es-module-lexer (vite's
  // import analysis) writes its source as utf16le into WebAssembly memory
  FakeBuffer.prototype.write = function(str: string, offset?: any, length?: any, encoding?: string) {
    if (typeof offset === 'string') { encoding = offset; offset = undefined; length = undefined; }
    else if (typeof length === 'string') { encoding = length; length = undefined; }
    const enc = (encoding || 'utf8').toLowerCase();
    const bytes: Uint8Array = enc === 'utf8' || enc === 'utf-8' ? new TextEncoder().encode(str) : FakeBuffer.from(str, enc);
    const off = offset ?? 0;
    let len = Math.min(length ?? bytes.length, bytes.length, this.length - off);
    // never half a character (utf16le: whole code units)
    if ((enc === 'utf16le' || enc === 'utf-16le' || enc === 'ucs2' || enc === 'ucs-2') && len % 2) len--;
    for (let i = 0; i < len; i++) this[off + i] = bytes[i];
    return len;
  };
  FakeBuffer.prototype.copy = function(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number) {
    const tStart = targetStart ?? 0;
    const sStart = sourceStart ?? 0;
    const sEnd = sourceEnd ?? this.length;
    for (let i = 0; i < sEnd - sStart && tStart + i < target.length; i++) {
      target[tStart + i] = this[sStart + i];
    }
    return Math.min(sEnd - sStart, target.length - tStart);
  };
  FakeBuffer.prototype.trim = function() { return this.toString().trim(); };
  FakeBuffer.prototype.trimEnd = function() { return this.toString().trimEnd(); };
  FakeBuffer.prototype.trimStart = function() { return this.toString().trimStart(); };
  FakeBuffer.prototype.split = function(sep: any, limit?: number) { return this.toString().split(sep, limit); };
  FakeBuffer.prototype.replace = function(search: any, replacement: any) { return this.toString().replace(search, replacement); };
  FakeBuffer.prototype.startsWith = function(s: string) { return this.toString().startsWith(s); };
  FakeBuffer.prototype.endsWith = function(s: string) { return this.toString().endsWith(s); };
  FakeBuffer.prototype.includes = function(s: any, from?: any, enc?: any) { return findIn(this, s, from, enc, false) !== -1; };
  // indexOf/lastIndexOf/includes of a string, Buffer or byte, as node's (Uint8Array's
  // only finds a number: a protocol parser's buf.indexOf('\r\n\r\n') was always -1)
  const needleBytes = (v: any, enc?: string): Uint8Array | number =>
    typeof v === 'number' ? v & 255 : typeof v === 'string' ? FakeBuffer.from(v, enc) : v instanceof Uint8Array ? v : new Uint8Array(v);
  const findIn = (hay: Uint8Array, v: any, from: any, enc: any, last: boolean): number => {
    if (typeof from === 'string') { enc = from; from = undefined; }
    const n = needleBytes(v, enc);
    const len = hay.length;
    let start = from === undefined ? (last ? len : 0) : Number(from) | 0;
    if (start < 0) start = Math.max(0, len + start);
    if (typeof n === 'number') return last ? Uint8Array.prototype.lastIndexOf.call(hay, n, Math.min(start, len - 1)) : Uint8Array.prototype.indexOf.call(hay, n, start);
    if (n.length === 0) return Math.min(start, len);
    if (last) {
      for (let i = Math.min(start, len - n.length); i >= 0; i--) { let j = 0; while (j < n.length && hay[i + j] === n[j]) j++; if (j === n.length) return i; }
      return -1;
    }
    outer: for (let i = start; i <= len - n.length; i++) {
      for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
      return i;
    }
    return -1;
  };
  FakeBuffer.prototype.indexOf = function(v: any, from?: any, enc?: any) { return findIn(this, v, from, enc, false); };
  FakeBuffer.prototype.lastIndexOf = function(v: any, from?: any, enc?: any) { return findIn(this, v, from, enc, true); };
  FakeBuffer.prototype.equals = function(other: Uint8Array) {
    if (this.length !== other.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  };
  FakeBuffer.prototype.compare = function(other: Uint8Array) {
    const len = Math.min(this.length, other.length);
    for (let i = 0; i < len; i++) {
      if (this[i] < other[i]) return -1;
      if (this[i] > other[i]) return 1;
    }
    return this.length < other.length ? -1 : this.length > other.length ? 1 : 0;
  };
  FakeBuffer.prototype.readUInt8 = function(offset: number) { return this[offset]; };
  FakeBuffer.prototype.readUInt16BE = function(offset: number) { return (this[offset] << 8) | this[offset + 1]; };
  FakeBuffer.prototype.readUInt16LE = function(offset: number) { return this[offset] | (this[offset + 1] << 8); };
  FakeBuffer.prototype.readUInt32BE = function(offset: number) { return ((this[offset] << 24) | (this[offset+1] << 16) | (this[offset+2] << 8) | this[offset+3]) >>> 0; };
  FakeBuffer.prototype.readUInt32LE = function(offset: number) { return (this[offset] | (this[offset+1] << 8) | (this[offset+2] << 16) | (this[offset+3] << 24)) >>> 0; };
  FakeBuffer.prototype.readInt8 = function(offset: number) { return this[offset] > 127 ? this[offset] - 256 : this[offset]; };
  FakeBuffer.prototype.readInt16BE = function(offset: number) { const v = (this[offset] << 8) | this[offset + 1]; return v > 32767 ? v - 65536 : v; };
  FakeBuffer.prototype.readInt32BE = function(offset: number) { return (this[offset] << 24) | (this[offset+1] << 16) | (this[offset+2] << 8) | this[offset+3]; };
  FakeBuffer.prototype.writeUInt8 = function(value: number, offset: number) { this[offset] = value & 0xff; return offset + 1; };
  FakeBuffer.prototype.writeUInt16BE = function(value: number, offset: number) { this[offset] = (value >> 8) & 0xff; this[offset+1] = value & 0xff; return offset + 2; };
  FakeBuffer.prototype.writeUInt32BE = function(value: number, offset: number) { this[offset] = (value >> 24) & 0xff; this[offset+1] = (value >> 16) & 0xff; this[offset+2] = (value >> 8) & 0xff; this[offset+3] = value & 0xff; return offset + 4; };
  // Every fixed-width read/write node has, both byte orders, through a DataView
  // (webpack's cache serializer writes with writeUInt32LE, writeDoubleLE and
  // writeBigInt64LE), with node's lower-case `Uint` aliases
  const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fixed: [string, number, string][] = [
    ['UInt8', 1, 'Uint8'], ['Int8', 1, 'Int8'], ['UInt16', 2, 'Uint16'], ['Int16', 2, 'Int16'],
    ['UInt32', 4, 'Uint32'], ['Int32', 4, 'Int32'], ['Float', 4, 'Float32'], ['Double', 8, 'Float64'],
    ['BigUInt64', 8, 'BigUint64'], ['BigInt64', 8, 'BigInt64'],
  ];
  for (const [name, size, dv] of fixed) {
    for (const suffix of size === 1 ? [''] : ['LE', 'BE']) {
      const le = suffix === 'LE';
      const read = function(this: Uint8Array, offset = 0) { return (view(this) as any)[`get${dv}`](offset, le); };
      const write = function(this: Uint8Array, value: any, offset = 0) { (view(this) as any)[`set${dv}`](offset, value, le); return offset + size; };
      for (const n of new Set([name, name.replace('UInt', 'Uint')])) {
        FakeBuffer.prototype[`read${n}${suffix}`] = read;
        FakeBuffer.prototype[`write${n}${suffix}`] = write;
      }
    }
  }
  // Variable width (1 to 6 bytes): readUIntLE(offset, byteLength), writeIntBE(value, offset, byteLength)...
  const readVar = (b: Uint8Array, offset: number, n: number, le: boolean, signed: boolean) => {
    if (offset < 0 || offset + n > b.length) throw new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${b.length - n}. Received ${offset}`);
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + b[offset + (le ? n - 1 - i : i)];
    return signed && v >= 2 ** (8 * n - 1) ? v - 2 ** (8 * n) : v;
  };
  const writeVar = (b: Uint8Array, value: number, offset: number, n: number, le: boolean) => {
    if (offset < 0 || offset + n > b.length) throw new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${b.length - n}. Received ${offset}`);
    let v = value < 0 ? value + 2 ** (8 * n) : value;
    for (let i = 0; i < n; i++) { b[offset + (le ? i : n - 1 - i)] = v % 256; v = Math.floor(v / 256); }
    return offset + n;
  };
  for (const [suffix, le] of [['LE', true], ['BE', false]] as const) {
    for (const u of ['UInt', 'Uint']) {
      FakeBuffer.prototype[`read${u}${suffix}`] = function(this: Uint8Array, offset: number, n: number) { return readVar(this, offset, n, le, false); };
      FakeBuffer.prototype[`write${u}${suffix}`] = function(this: Uint8Array, value: number, offset: number, n: number) { return writeVar(this, value, offset, n, le); };
    }
    FakeBuffer.prototype[`readInt${suffix}`] = function(this: Uint8Array, offset: number, n: number) { return readVar(this, offset, n, le, true); };
    FakeBuffer.prototype[`writeInt${suffix}`] = function(this: Uint8Array, value: number, offset: number, n: number) { return writeVar(this, value, offset, n, le); };
  }
  // Buffers of a buffer are Buffers (FakeBuffer has no Symbol.species, so
  // Uint8Array's subarray made plain arrays: toString() gave "48,48,...")
  const u8subarray = Uint8Array.prototype.subarray;
  FakeBuffer.prototype.subarray = function(start?: number, end?: number) {
    const sub = u8subarray.call(this, start, end);
    Object.setPrototypeOf(sub, FakeBuffer.prototype);
    return sub;
  };
  FakeBuffer.prototype.slice = function(start?: number, end?: number) {
    const sliced = this.subarray(start, end);
    Object.setPrototypeOf(sliced, FakeBuffer.prototype);
    return sliced;
  };
  FakeBuffer.prototype.toJSON = function() {
    return { type: 'Buffer', data: Array.from(this) };
  };
  FakeBuffer.from = (input: any, encoding?: any, length?: number): any => {
    let bytes: Uint8Array;
    // Buffer.from(arrayBuffer[, byteOffset[, length]]): a view on the same memory
    if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer)) {
      const off = Number(encoding) || 0;
      bytes = new Uint8Array(input, off, length ?? input.byteLength - off);
      Object.setPrototypeOf(bytes, FakeBuffer.prototype);
      return bytes;
    }
    if (input && typeof input === 'object' && input.type === 'Buffer' && Array.isArray(input.data)) input = input.data;
    if (typeof input === 'string' && (encoding === 'utf16le' || encoding === 'ucs2' || encoding === 'ucs-2' || encoding === 'utf-16le')) {
      bytes = new Uint8Array(input.length * 2);
      for (let i = 0; i < input.length; i++) { const c = input.charCodeAt(i); bytes[i * 2] = c & 255; bytes[i * 2 + 1] = c >> 8; }
      Object.setPrototypeOf(bytes, FakeBuffer.prototype);
      return bytes;
    }
    if (typeof input === 'string') {
      if (encoding === 'base64' || encoding === 'base64url') {
        // Lenient, like node: url-safe or standard alphabet, whitespace and
        // other characters skipped, padding optional, stops at the first '='
        let b64 = input.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
        const eq = b64.indexOf('=');
        if (eq >= 0) b64 = b64.slice(0, eq);
        if (b64.length % 4 === 1) b64 = b64.slice(0, -1);
        const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } else if (encoding === 'hex') {
        const hex = input.replace(/[^0-9a-fA-F]/g, '');
        bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      } else if (encoding === 'latin1' || encoding === 'binary' || encoding === 'ascii') {
        bytes = new Uint8Array(input.length);
        for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i) & 0xff;
      } else {
        bytes = new TextEncoder().encode(input);
      }
    } else if (input instanceof Uint8Array) {
      bytes = new Uint8Array(input);
    } else if (Array.isArray(input) || ArrayBuffer.isView(input)) {
      bytes = new Uint8Array(input as any);
    } else if (input && typeof input === 'object' && typeof input.length === 'number') {
      bytes = Uint8Array.from(input as ArrayLike<number>);
    } else {
      bytes = new Uint8Array(0);
    }
    Object.setPrototypeOf(bytes, FakeBuffer.prototype);
    return bytes;
  };
  FakeBuffer.alloc = (size: number, fill?: any) => {
    const bytes = new Uint8Array(size);
    if (fill !== undefined) bytes.fill(typeof fill === 'number' ? fill : 0);
    Object.setPrototypeOf(bytes, FakeBuffer.prototype);
    return bytes;
  };
  FakeBuffer.allocUnsafe = (size: number) => FakeBuffer.alloc(size);
  FakeBuffer.allocUnsafeSlow = (size: number) => FakeBuffer.alloc(size);
  FakeBuffer.compare = (a: Uint8Array, b: Uint8Array) => {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  };
  FakeBuffer.isBuffer = (obj: any) => obj instanceof Uint8Array;
  FakeBuffer.isEncoding = (enc: string) => ['utf8', 'utf-8', 'ascii', 'base64', 'base64url', 'hex', 'binary', 'latin1', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'].includes(enc?.toLowerCase());
  FakeBuffer.byteLength = (str: string, encoding?: string) => FakeBuffer.from(str, encoding).length;
  FakeBuffer.concat = (list: Uint8Array[], totalLength?: number) => {
    const total = totalLength ?? list.reduce((n: number, b: Uint8Array) => n + b.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const buf of list) { result.set(buf, offset); offset += buf.length; }
    Object.setPrototypeOf(result, FakeBuffer.prototype);
    return result;
  };
  return FakeBuffer;
}
