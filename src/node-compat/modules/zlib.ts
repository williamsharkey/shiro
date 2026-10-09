/**
 * node:zlib on pako (already bundled for isomorphic-git): gzip, deflate and
 * raw deflate, synchronously, with callbacks, promises (via util.promisify)
 * and as Transform streams. Brotli is not available and says so. (This was
 * a pass-through stub: gunzip returned its input, so pnpm and yarn read
 * compressed tarballs as tar.)
 */
// @ts-ignore pako ships without types
import pako from 'pako';

type Mode = 'gzip' | 'gunzip' | 'deflate' | 'inflate' | 'deflateRaw' | 'inflateRaw' | 'unzip';

export function createZlibModule(getBuiltinModule: (name: string) => any): any {
  const B = () => getBuiltinModule('buffer').Buffer;
  const toU8 = (data: any): Uint8Array => typeof data === 'string' ? new TextEncoder().encode(data)
    : data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const zerr = (e: any, code = 'Z_DATA_ERROR') => Object.assign(new Error(typeof e === 'string' ? e : e?.message || 'zlib error'), { code, errno: -3 });
  const level = (o: any) => (o && typeof o.level === 'number' && o.level >= 0 ? o.level : 6);

  const run = (mode: Mode, data: any, opts?: any): any => {
    const u8 = toU8(data);
    let out: Uint8Array;
    try {
      switch (mode) {
        case 'gzip': out = pako.gzip(u8, { level: level(opts) }); break;
        case 'deflate': out = pako.deflate(u8, { level: level(opts) }); break;
        case 'deflateRaw': out = pako.deflateRaw(u8, { level: level(opts) }); break;
        case 'gunzip': out = pako.ungzip(u8); break;
        case 'inflate': out = pako.inflate(u8); break;
        case 'inflateRaw': out = pako.inflateRaw(u8); break;
        case 'unzip': out = pako.inflate(u8, { windowBits: 47 }); break; // gzip or zlib header
      }
    } catch (e) {
      throw zerr(e);
    }
    if (!out!) throw zerr('unexpected end of file', 'Z_BUF_ERROR');
    return B().from(out!);
  };

  const mod: any = {};
  for (const mode of ['gzip', 'gunzip', 'deflate', 'inflate', 'deflateRaw', 'inflateRaw', 'unzip'] as Mode[]) {
    mod[`${mode}Sync`] = (data: any, opts?: any) => run(mode, data, opts);
    mod[mode] = (data: any, optsOrCb?: any, cb?: Function) => {
      const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
      const opts = typeof optsOrCb === 'object' ? optsOrCb : undefined;
      setTimeout(() => {
        let r: any;
        try { r = run(mode, data, opts); } catch (e) { callback?.(e); return; }
        callback?.(null, r);
      }, 0);
    };
  }

  /** A Transform over pako's streaming Deflate/Inflate. */
  const makeStream = (mode: Mode, opts?: any) => {
    const { Transform } = getBuiltinModule('stream');
    const compress = mode === 'gzip' || mode === 'deflate' || mode === 'deflateRaw';
    const pakoOpts: any = compress
      ? { level: level(opts), gzip: mode === 'gzip', raw: mode === 'deflateRaw' }
      : { raw: mode === 'inflateRaw', windowBits: mode === 'unzip' || mode === 'gunzip' ? 47 : mode === 'inflateRaw' ? -15 : 15 };
    const engine: any = compress ? new pako.Deflate(pakoOpts) : new pako.Inflate(pakoOpts);
    let pending: Uint8Array[] = [];
    engine.onData = (chunk: Uint8Array) => { pending.push(chunk); };
    engine.onEnd = () => {};
    const t = new Transform({
      transform(chunk: any, _enc: string, cb: Function) {
        if (!engine.ended) engine.push(toU8(chunk), false);
        if (engine.err) { cb(zerr(engine.msg)); return; }
        for (const c of pending) this.push(B().from(c));
        pending = [];
        cb();
      },
      flush(cb: Function) {
        if (!engine.ended) engine.push(new Uint8Array(0), true);
        if (engine.err && !(engine.err === -5 && !compress && pending.length)) { cb(zerr(engine.msg || 'unexpected end of file')); return; }
        for (const c of pending) this.push(B().from(c));
        pending = [];
        cb();
      },
    });
    t.bytesWritten = 0;
    t.close = (cb?: Function) => { t.destroy(); if (cb) setTimeout(cb, 0); };
    t.flush = (_kind?: any, cb?: Function) => { if (typeof _kind === 'function') cb = _kind; if (cb) setTimeout(cb, 0); };
    t.params = (_l: any, _s: any, cb?: Function) => { if (cb) setTimeout(cb, 0); };
    t.reset = () => {};
    return t;
  };
  const streamCtor: Record<string, Mode> = {
    createGzip: 'gzip', createGunzip: 'gunzip', createDeflate: 'deflate', createInflate: 'inflate',
    createDeflateRaw: 'deflateRaw', createInflateRaw: 'inflateRaw', createUnzip: 'unzip',
  };
  for (const [name, mode] of Object.entries(streamCtor)) {
    mod[name] = (opts?: any) => makeStream(mode, opts);
    // class-style names (new zlib.Gunzip())
    mod[name.slice(6)] = function (this: any, opts?: any) { return makeStream(mode, opts); };
  }

  const noBrotli = () => { throw Object.assign(new Error('Brotli is not available in Shiro\'s zlib'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' }); };
  for (const n of ['brotliCompressSync', 'brotliDecompressSync', 'createBrotliCompress', 'createBrotliDecompress']) mod[n] = noBrotli;
  mod.brotliCompress = mod.brotliDecompress = (_d: any, a?: any, b?: any) => {
    const cb = typeof a === 'function' ? a : b;
    setTimeout(() => { try { noBrotli(); } catch (e) { cb?.(e); } }, 0);
  };

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  mod.crc32 = (data: any, value = 0) => {
    const u8 = toU8(data);
    let c = (value ^ 0xffffffff) >>> 0;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const constants = {
    Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
    Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
    Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
    Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
    Z_DEFAULT_WINDOWBITS: 15, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_MEMLEVEL: 8, Z_DEFAULT_CHUNK: 16384,
    DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7,
    BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,
  };
  Object.assign(mod, constants);
  mod.constants = constants;
  mod.codes = { Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6 };
  return mod;
}
