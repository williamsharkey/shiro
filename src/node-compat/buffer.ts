/**
 * FakeBuffer: Node.js Buffer shim built on Uint8Array.
 *
 * Supports utf8, base64, base64url, hex, latin1/binary/ascii encodings.
 * Must be a constructor with prototype for safe-buffer compatibility.
 *
 * This module is self-contained — no dependencies on NodeEnv or closure variables.
 */

export function createFakeBuffer(): any {
  function FakeBuffer(arg?: any, encodingOrOffset?: any, _length?: any): any {
    if (typeof arg === 'number') {
      return FakeBuffer.alloc(arg);
    }
    return FakeBuffer.from(arg, encodingOrOffset);
  }
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
  FakeBuffer.prototype.write = function(str: string, offset?: number, length?: number, _encoding?: string) {
    const bytes = new TextEncoder().encode(str);
    const off = offset ?? 0;
    const len = Math.min(length ?? bytes.length, bytes.length, this.length - off);
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
  FakeBuffer.prototype.includes = function(s: any) { if (typeof s === 'string') return this.toString().includes(s); return Uint8Array.prototype.includes.call(this, s); };
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
  FakeBuffer.prototype.slice = function(start?: number, end?: number) {
    const sliced = this.subarray(start, end);
    Object.setPrototypeOf(sliced, FakeBuffer.prototype);
    return sliced;
  };
  FakeBuffer.prototype.toJSON = function() {
    return { type: 'Buffer', data: Array.from(this) };
  };
  FakeBuffer.from = (input: any, encoding?: string): any => {
    let bytes: Uint8Array;
    if (typeof input === 'string') {
      if (encoding === 'base64' || encoding === 'base64url') {
        const binary = atob(encoding === 'base64url' ? input.replace(/-/g, '+').replace(/_/g, '/') : input);
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
    } else if (Array.isArray(input)) {
      bytes = new Uint8Array(input);
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
