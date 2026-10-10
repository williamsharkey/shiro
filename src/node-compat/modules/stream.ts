import { createEventsModule } from './events';

/**
 * node:stream: Readable (buffering, flowing and paused modes, 'readable',
 * read(), async iteration), Writable (_write/_writev/_final, backpressure,
 * 'drain'/'finish'), Duplex, Transform, PassThrough, pipe, pipeline and
 * finished; a working subset of Node's semantics (fast-glob, through2,
 * split2 and the like are built on them).
 */
export function createStreamModule(events: any = createEventsModule(), BufferImpl?: any): any {
  // The process's Buffer (the page has none of its own): strings and Uint8Arrays become Buffers in streams
  const BufferCtor = () => BufferImpl ?? (globalThis as any)['Buffer'];
  const streamModule: any = {};
  const EventEmitter = events.EventEmitter;
  const tick = (fn: (...a: any[]) => void, ...args: any[]) => queueMicrotask(() => fn(...args));
  const inherit = (C: any, P: any) => { C.prototype = Object.create(P.prototype); C.prototype.constructor = C; Object.setPrototypeOf(C, P); };
  const chunkLength = (c: any, objectMode: boolean) => objectMode ? 1 : (c?.length ?? 1);

  // Legacy Stream: an EventEmitter with pipe()
  const Stream = function(this: any, opts?: any) { if (!(this instanceof Stream)) return new Stream(opts); EventEmitter.call(this, opts); if (this.destroyed === undefined) this.destroyed = false; } as any;
  inherit(Stream, EventEmitter);
  Stream.prototype.pipe = function(dest: any, opts?: any) {
    const src = this;
    const onData = (chunk: any) => { if (dest.write(chunk) === false && src.pause) { src.pause(); dest.once('drain', () => src.resume()); } };
    src.on('data', onData);
    if (!opts || opts.end !== false) src.once('end', () => { if (dest !== (globalThis as any).process?.stdout) dest.end?.(); });
    dest.emit?.('pipe', src);
    if (src.resume && src._readableState && src._readableState.flowing !== true) src.resume();
    return dest;
  };
  streamModule.Stream = Stream;

  // ── Readable ─────────────────────────────────────────────────────────
  /** A Uint8Array chunk as a Buffer over the same bytes (node streams hand on Buffers) */
  const asBufferView = (c: any) => {
    const B = BufferCtor();
    if (!(c instanceof Uint8Array) || typeof B?.from !== 'function' || c instanceof B) return c;
    return B.from(c.buffer, c.byteOffset, c.byteLength);
  };
  const Readable = function(this: any, opts: any = {}) { if (!(this instanceof Readable)) return new Readable(opts);
    Stream.call(this, opts);
    const objectMode = !!(opts.objectMode || opts.readableObjectMode);
    this._readableState = {
      objectMode, highWaterMark: opts.highWaterMark ?? opts.readableHighWaterMark ?? (objectMode ? 16 : 16384),
      buffer: [] as any[], length: 0, flowing: null as boolean | null, ended: false, endEmitted: false,
      reading: false, sync: false, encoding: opts.encoding ?? null, flowScheduled: false, readableEmitted: false,
      decoder: null as TextDecoder | null, errored: null as any, closed: false,
    };
    this.readable = true;
    if (typeof opts.read === 'function') this._read = opts.read;
    if (typeof opts.destroy === 'function') this._destroy = opts.destroy;
    if (typeof opts.construct === 'function') opts.construct.call(this, (err?: any) => { if (err) this.destroy(err); });
  } as any;
  inherit(Readable, Stream);
  const R = Readable.prototype;
  R._read = function() { /* the default source has nothing more */ };
  R.on = R.addListener = function(ev: string | symbol, fn: Function) {
    EventEmitter.prototype.on.call(this, ev, fn);
    const st = this._readableState;
    if (ev === 'data' && st.flowing !== false) this.resume();
    else if (ev === 'readable' && !st.endEmitted) {
      st.flowing = false;
      st.readableEmitted = false;
      scheduleReadable(this);
    }
    return this;
  };
  const decode = (st: any, chunk: any) => {
    if (!st.encoding || typeof chunk === 'string' || st.objectMode) return chunk;
    st.decoder ??= new TextDecoder(st.encoding === 'utf-8' ? 'utf8' : st.encoding);
    return st.decoder.decode(chunk, { stream: true });
  };
  R.push = function(chunk: any, encoding?: string) {
    const st = this._readableState;
    st.reading = false;
    if (chunk === null || chunk === undefined) {
      if (!st.ended) { st.ended = true; if (st.decoder) { const rest = st.decoder.decode(); if (rest) { st.buffer.push(rest); st.length += rest.length; } } }
      scheduleFlow(this);
      scheduleReadable(this);
      return false;
    }
    if (st.ended) { this.destroy(Object.assign(new Error('stream.push() after EOF'), { code: 'ERR_STREAM_PUSH_AFTER_EOF' })); return false; }
    if (!st.objectMode && typeof chunk === 'string' && encoding && encoding !== st.encoding && typeof BufferCtor()?.from === 'function') {
      chunk = BufferCtor().from(chunk, encoding);
    }
    else if (!st.objectMode) chunk = asBufferView(chunk);
    chunk = decode(st, chunk);
    if (!st.objectMode && chunk.length === 0) return st.length < st.highWaterMark;
    st.buffer.push(chunk);
    st.length += chunkLength(chunk, st.objectMode);
    scheduleFlow(this);
    scheduleReadable(this);
    return st.length < st.highWaterMark;
  };
  R.unshift = function(chunk: any) {
    const st = this._readableState;
    if (chunk === null || chunk === undefined) return;
    st.buffer.unshift(chunk);
    st.length += chunkLength(chunk, st.objectMode);
  };
  const callRead = (self: any) => {
    const st = self._readableState;
    if (st.reading || st.ended || self.destroyed) return;
    st.reading = true;
    try { self._read(st.highWaterMark); } catch (e) { self.destroy(e); }
  };
  const scheduleFlow = (self: any) => {
    const st = self._readableState;
    if (st.flowScheduled || st.flowing !== true) return;
    st.flowScheduled = true;
    tick(() => { st.flowScheduled = false; flow(self); });
  };
  const scheduleReadable = (self: any) => {
    const st = self._readableState;
    if (st.flowing !== false || st.readableEmitted || self.listenerCount('readable') === 0) return;
    if (!st.length && !st.ended) { callRead(self); return; }
    st.readableEmitted = true;
    tick(() => {
      if (self.destroyed) return;
      self.emit('readable');
      st.readableEmitted = false;
      if (st.ended && !st.length) endReadable(self);
    });
  };
  const flow = (self: any) => {
    const st = self._readableState;
    while (st.flowing === true && !self.destroyed) {
      if (st.buffer.length) {
        const chunk = st.buffer.shift();
        st.length -= chunkLength(chunk, st.objectMode);
        self.emit('data', chunk);
        continue;
      }
      if (st.ended) { endReadable(self); return; }
      const before = st.length;
      callRead(self);
      if (st.length === before && !st.ended) return; // async source: push() reschedules
    }
  };
  const endReadable = (self: any) => {
    const st = self._readableState;
    if (st.endEmitted || st.length) return;
    st.endEmitted = true;
    self.readable = false;
    tick(() => {
      self.emit('end');
      const ws = self._writableState;
      if (self.autoDestroy !== false && (!ws || ws.finished)) closeOnce(self);
    });
  };
  R.read = function(n?: number) {
    const st = this._readableState;
    if (n === 0 || !st.buffer.length) {
      if (st.ended) endReadable(this); else callRead(this);
      return null;
    }
    let out: any;
    if (st.objectMode) out = st.buffer.shift();
    else if (n !== undefined && n < st.length) {
      const all = joinChunks(st.buffer);
      out = all.slice(0, n);
      st.buffer = [all.slice(n)];
    } else { out = joinChunks(st.buffer); st.buffer = []; }
    st.length -= chunkLength(out, st.objectMode);
    if (st.ended && !st.length) endReadable(this);
    else if (st.length < st.highWaterMark) callRead(this);
    return out;
  };
  const joinChunks = (chunks: any[]) => {
    if (chunks.length === 1) return chunks[0];
    if (chunks.every(c => typeof c === 'string')) return chunks.join('');
    const B = BufferCtor();
    if (B?.concat) return B.concat(chunks.map(c => typeof c === 'string' ? B.from(c) : c));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { const b = typeof c === 'string' ? new TextEncoder().encode(c) : c; out.set(b, o); o += b.length; }
    return out;
  };
  R.setEncoding = function(enc: string) { this._readableState.encoding = enc || 'utf8'; this._readableState.decoder = null; return this; };
  R.pause = function() { if (this._readableState.flowing !== false) { this._readableState.flowing = false; this.emit('pause'); } return this; };
  R.resume = function() {
    const st = this._readableState;
    if (st.flowing !== true) { st.flowing = true; this.emit('resume'); }
    scheduleFlow(this);
    return this;
  };
  R.isPaused = function() { return this._readableState.flowing === false; };
  R.unpipe = function(dest?: any) { this.removeAllListeners('data'); if (dest) dest.emit?.('unpipe', this); return this; };
  R.wrap = function(old: any) {
    old.on('data', (c: any) => { if (!this.push(c)) old.pause?.(); });
    old.on('end', () => this.push(null));
    old.on('error', (e: any) => this.destroy(e));
    this._read = () => old.resume?.();
    return this;
  };
  const closeOnce = (self: any) => {
    const st = self._readableState ?? self._writableState;
    if (st.closed) return;
    st.closed = true;
    if (self._writableState) self._writableState.closed = true;
    self.emit('close');
  };
  const destroyImpl = function(this: any, err?: any, cb?: Function) {
    if (this.destroyed) { if (cb) tick(cb as any, err); return this; }
    this.destroyed = true;
    const rs = this._readableState, ws = this._writableState;
    if (rs) rs.errored = err ?? null;
    if (ws) ws.errored = err ?? null;
    this._destroy(err ?? null, (e: any) => {
      tick(() => {
        if (e) this.emit('error', e);
        closeOnce(this);
        cb?.(e);
      });
    });
    return this;
  };
  R.destroy = destroyImpl;
  R._destroy = function(err: any, cb: Function) { cb(err); };
  R[Symbol.asyncIterator] = function() {
    const self = this;
    const queue: any[] = [];
    let error: any = null, ended = false;
    let wake: (() => void) | null = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    const onData = (c: any) => { queue.push(c); if (queue.length >= self._readableState.highWaterMark) self.pause(); notify(); };
    const onEnd = () => { ended = true; notify(); };
    const onError = (e: any) => { error = e; notify(); };
    const onClose = () => { ended = true; notify(); };
    self.on('data', onData); self.once('end', onEnd); self.once('error', onError); self.once('close', onClose);
    const cleanup = () => { self.off('data', onData); self.off('end', onEnd); self.off('error', onError); self.off('close', onClose); };
    return {
      async next(): Promise<IteratorResult<any>> {
        while (!queue.length && !ended && !error) {
          if (self.isPaused()) self.resume();
          await new Promise<void>(r => { wake = r; });
        }
        if (queue.length) return { value: queue.shift(), done: false };
        cleanup();
        if (error) throw error;
        return { value: undefined, done: true };
      },
      async return(): Promise<IteratorResult<any>> { cleanup(); self.destroy(); return { value: undefined, done: true }; },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  for (const [name, get] of Object.entries({
    readableEnded: (s: any) => s._readableState.endEmitted,
    readableLength: (s: any) => s._readableState.length,
    readableObjectMode: (s: any) => s._readableState.objectMode,
    readableHighWaterMark: (s: any) => s._readableState.highWaterMark,
    readableFlowing: (s: any) => s._readableState.flowing,
    readableEncoding: (s: any) => s._readableState.encoding,
    closed: (s: any) => (s._readableState ?? s._writableState).closed,
    errored: (s: any) => (s._readableState ?? s._writableState).errored,
  })) Object.defineProperty(R, name, { get() { return get(this); }, configurable: true });
  Readable.from = (iterable: any, opts?: any) => {
    if (typeof iterable === 'string' || iterable instanceof Uint8Array) iterable = [iterable];
    const it = iterable[Symbol.asyncIterator]?.() ?? iterable[Symbol.iterator]();
    let busy = false;
    return new Readable({
      objectMode: true, ...opts,
      read(this: any) {
        if (busy) return;
        busy = true;
        Promise.resolve(it.next()).then((r: any) => Promise.resolve(r.value).then((v: any) => {
          busy = false;
          if (r.done) this.push(null); else this.push(v);
        }), (e: any) => { busy = false; this.destroy(e); });
      },
    });
  };
  streamModule.Readable = Readable;

  // ── Writable ─────────────────────────────────────────────────────────
  const initWritable = (self: any, opts: any) => {
    const objectMode = !!(opts.objectMode || opts.writableObjectMode);
    self._writableState = {
      objectMode, highWaterMark: opts.highWaterMark ?? opts.writableHighWaterMark ?? (objectMode ? 16 : 16384),
      length: 0, writing: false, buffered: [] as any[], ending: false, ended: false, finished: false,
      needDrain: false, corked: 0, finalCalled: false, defaultEncoding: opts.defaultEncoding ?? 'utf8',
      decodeStrings: opts.decodeStrings !== false, errored: null as any, closed: false,
    };
    self.writable = true;
    if (typeof opts.write === 'function') self._write = opts.write;
    if (typeof opts.writev === 'function') self._writev = opts.writev;
    if (typeof opts.final === 'function') self._final = opts.final;
    if (typeof opts.destroy === 'function') self._destroy = opts.destroy;
  };
  const Writable = function(this: any, opts: any = {}) { if (!(this instanceof Writable) && !(this instanceof Readable)) return new Writable(opts);
    if (!this._readableState) Stream.call(this, opts);
    initWritable(this, opts);
  } as any;
  inherit(Writable, Stream);
  // Duplex streams are Writable too (Node answers instanceof this way), so
  // `Writable.call(this)` from a Readable-based Duplex initialises it
  Object.defineProperty(Writable, Symbol.hasInstance, {
    value(this: any, obj: any) {
      if (Function.prototype[Symbol.hasInstance].call(this, obj)) return true;
      return this === Writable && !!obj?._writableState;
    },
  });
  const W = Writable.prototype;
  W._write = function(chunk: any, enc: string, cb: Function) {
    if (this._writev) this._writev([{ chunk, encoding: enc }], cb);
    else cb(Object.assign(new Error('The _write() method is not implemented'), { code: 'ERR_METHOD_NOT_IMPLEMENTED' }));
  };
  W._destroy = function(err: any, cb: Function) { cb(err); };
  W.destroy = destroyImpl;
  const doWrite = (self: any, item: any) => {
    const st = self._writableState;
    st.writing = true;
    let sync = true;
    self._write(item.chunk, item.encoding, (err?: any) => {
      const done = () => onWrite(self, item, err);
      if (sync) tick(done); else done();
    });
    sync = false;
  };
  const onWrite = (self: any, item: any, err: any) => {
    const st = self._writableState;
    st.writing = false;
    st.length -= chunkLength(item.chunk, st.objectMode);
    item.cb?.(err ?? null);
    if (err) { self.destroy(err); return; }
    if (st.buffered.length && !st.corked) { doWrite(self, st.buffered.shift()); return; }
    if (st.needDrain && st.length === 0 && !st.ending) { st.needDrain = false; self.emit('drain'); }
    finishMaybe(self);
  };
  W.write = function(chunk: any, encoding?: any, cb?: any) {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    const st = this._writableState;
    if (st.ending || this.destroyed) {
      const err = Object.assign(new Error(st.ending ? 'write after end' : 'Cannot call write after a stream was destroyed'), { code: st.ending ? 'ERR_STREAM_WRITE_AFTER_END' : 'ERR_STREAM_DESTROYED' });
      tick(() => { cb?.(err); this.emit('error', err); });
      return false;
    }
    if (chunk === null) throw Object.assign(new TypeError('May not write null values to stream'), { code: 'ERR_STREAM_NULL_VALUES' });
    encoding = encoding || st.defaultEncoding;
    if (!st.objectMode && typeof chunk === 'string' && st.decodeStrings && typeof BufferCtor()?.from === 'function') {
      chunk = BufferCtor().from(chunk, encoding);
      encoding = 'buffer';
    }
    else if (!st.objectMode) chunk = asBufferView(chunk);
    const item = { chunk, encoding, cb };
    st.length += chunkLength(chunk, st.objectMode);
    const ok = st.length < st.highWaterMark;
    if (!ok) st.needDrain = true;
    if (st.writing || st.corked || st.buffered.length) st.buffered.push(item);
    else doWrite(this, item);
    return ok;
  };
  W.end = function(chunk?: any, encoding?: any, cb?: any) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    const st = this._writableState;
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    if (st.corked) { st.corked = 1; this.uncork(); }
    if (cb) { if (st.finished) tick(cb); else this.once('finish', cb); }
    if (!st.ending) { st.ending = true; finishMaybe(this); }
    return this;
  };
  const finishMaybe = (self: any) => {
    const st = self._writableState;
    if (!st.ending || st.writing || st.buffered.length || st.finished || st.finalCalled || self.destroyed) return;
    st.finalCalled = true;
    const finish = (err?: any) => {
      if (err) { self.destroy(err); return; }
      st.finished = true;
      st.ended = true;
      self.writable = false;
      tick(() => {
        self.emit('finish');
        const rs = self._readableState;
        if (self.autoDestroy !== false && (!rs || rs.endEmitted)) closeOnce(self);
      });
    };
    if (self._final && self._final !== W._final) {
      tick(() => self._final((err?: any) => finish(err)));
    } else finish();
  };
  W.cork = function() { this._writableState.corked++; };
  W.uncork = function() {
    const st = this._writableState;
    if (st.corked) st.corked--;
    if (!st.corked && !st.writing && st.buffered.length) doWrite(this, st.buffered.shift());
  };
  W.setDefaultEncoding = function(enc: string) { this._writableState.defaultEncoding = enc; return this; };
  for (const [name, get] of Object.entries({
    writableEnded: (s: any) => s._writableState.ending,
    writableFinished: (s: any) => s._writableState.finished,
    writableLength: (s: any) => s._writableState.length,
    writableObjectMode: (s: any) => s._writableState.objectMode,
    writableHighWaterMark: (s: any) => s._writableState.highWaterMark,
    writableCorked: (s: any) => s._writableState.corked,
    writableNeedDrain: (s: any) => s._writableState.needDrain,
  })) Object.defineProperty(W, name, { get() { return get(this); }, configurable: true });
  streamModule.Writable = Writable;

  // ── Duplex, Transform, PassThrough ───────────────────────────────────
  const Duplex = function(this: any, opts: any = {}) { if (!(this instanceof Duplex)) return new Duplex(opts);
    Readable.call(this, opts);
    initWritable(this, opts);
    this.allowHalfOpen = opts.allowHalfOpen !== false;
    if (!this.allowHalfOpen) this.once('end', () => this.end());
  } as any;
  inherit(Duplex, Readable);
  for (const k of Object.getOwnPropertyNames(W)) {
    if (k === 'constructor' || k === 'destroy' || k === '_destroy') continue;
    if (!Object.prototype.hasOwnProperty.call(Duplex.prototype, k)) Object.defineProperty(Duplex.prototype, k, Object.getOwnPropertyDescriptor(W, k)!);
  }
  Duplex.from = (src: any) => {
    if (src instanceof Duplex) return src;
    if (src && (typeof src[Symbol.asyncIterator] === 'function' || typeof src[Symbol.iterator] === 'function')) return Readable.from(src);
    return src;
  };
  streamModule.Duplex = Duplex;

  // ── Web streams ↔ node streams (Readable.fromWeb: Next's prerender) ──
  const bytes = (c: any) => (typeof c === 'string' ? new TextEncoder().encode(c) : c);
  Readable.fromWeb = (rs: ReadableStream, opts: any = {}) => {
    const reader = rs.getReader();
    let reading = false;
    return new Readable({
      ...opts,
      read(this: any) {
        if (reading) return;
        reading = true;
        reader.read().then(({ done, value }) => {
          reading = false;
          if (done) this.push(null); else if (this.push(value)) this._read();
        }, (e: any) => { reading = false; this.destroy(e); });
      },
      destroy(err: any, cb: Function) { reader.cancel(err ?? undefined).then(() => cb(err), () => cb(err)); },
    });
  };
  Readable.toWeb = (r: any) => {
    const objectMode = !!r._readableState?.objectMode;
    return new ReadableStream({
      start(controller) {
        r.on('data', (c: any) => { controller.enqueue(objectMode ? c : bytes(c)); if ((controller.desiredSize ?? 1) <= 0) r.pause(); });
        r.on('end', () => { try { controller.close(); } catch { /* cancelled */ } });
        r.on('error', (e: any) => controller.error(e));
        r.pause();
      },
      pull() { r.resume(); },
      cancel(reason) { r.destroy(reason); },
    }, objectMode ? { highWaterMark: 16 } : new ByteLengthQueuingStrategy({ highWaterMark: 16384 }));
  };
  Writable.fromWeb = (ws: WritableStream, opts: any = {}) => {
    const writer = ws.getWriter();
    return new Writable({
      ...opts,
      write(chunk: any, _enc: any, cb: Function) { writer.write(chunk).then(() => cb(), (e: any) => cb(e)); },
      final(cb: Function) { writer.close().then(() => cb(), (e: any) => cb(e)); },
      destroy(err: any, cb: Function) { writer.abort(err ?? undefined).then(() => cb(err), () => cb(err)); },
    });
  };
  Writable.toWeb = (w: any) => new WritableStream({
    write(chunk) { return new Promise<void>((res, rej) => { w.write(chunk, (e: any) => (e ? rej(e) : res())); }); },
    close() { return new Promise<void>((res) => { w.end(() => res()); }); },
    abort(reason) { w.destroy(reason); },
  });
  Duplex.fromWeb = (pair: { readable: ReadableStream; writable: WritableStream }, opts: any = {}) => {
    const r = Readable.fromWeb(pair.readable, opts);
    const w = Writable.fromWeb(pair.writable, opts);
    const d = new Duplex({
      ...opts,
      read() { r.resume(); },
      write(chunk: any, enc: any, cb: Function) { w.write(chunk, enc, cb); },
      final(cb: Function) { w.end(cb); },
    });
    r.on('data', (c: any) => { if (!d.push(c)) r.pause(); });
    r.on('end', () => d.push(null));
    r.on('error', (e: any) => d.destroy(e));
    r.pause();
    return d;
  };
  Duplex.toWeb = (d: any) => ({ readable: Readable.toWeb(d), writable: Writable.toWeb(d) });

  const Transform = function(this: any, opts: any = {}) { if (!(this instanceof Transform)) return new Transform(opts);
    Duplex.call(this, opts);
    if (typeof opts.transform === 'function') this._transform = opts.transform;
    if (typeof opts.flush === 'function') this._flush = opts.flush;
  } as any;
  inherit(Transform, Duplex);
  const T = Transform.prototype;
  T._transform = function(_c: any, _e: string, _cb: Function) {
    throw Object.assign(new Error('The _transform() method is not implemented'), { code: 'ERR_METHOD_NOT_IMPLEMENTED' });
  };
  T._write = function(chunk: any, enc: string, cb: Function) {
    let called = false;
    this._transform(chunk, enc, (err?: any, data?: any) => {
      if (called) return;
      called = true;
      if (err) { cb(err); return; }
      if (data !== undefined && data !== null) this.push(data);
      cb();
    });
  };
  T._final = function(cb: Function) {
    const done = (err?: any, data?: any) => {
      if (err) { cb(err); return; }
      if (data !== undefined && data !== null) this.push(data);
      this.push(null);
      cb();
    };
    if (typeof this._flush === 'function') this._flush(done); else done();
  };
  T._read = function() { /* data comes from writes */ };
  streamModule.Transform = Transform;

  const PassThrough = function(this: any, opts?: any) { if (!(this instanceof PassThrough)) return new PassThrough(opts); Transform.call(this, opts); } as any;
  inherit(PassThrough, Transform);
  PassThrough.prototype._transform = function(chunk: any, _e: string, cb: Function) { cb(null, chunk); };
  streamModule.PassThrough = PassThrough;

  // ── finished / pipeline ──────────────────────────────────────────────
  const finished = (stream: any, opts: any, cb?: Function) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    let done = false;
    const call = (err?: any) => { if (done) return; done = true; cleanup(); cb?.(err ?? null); };
    const rs = stream._readableState, ws = stream._writableState;
    const readable = opts?.readable ?? !!rs;
    const writable = opts?.writable ?? !!ws;
    let rEnded = !readable || rs?.endEmitted, wEnded = !writable || ws?.finished;
    const onEnd = () => { rEnded = true; if (wEnded) call(); };
    const onFinish = () => { wEnded = true; if (rEnded) call(); };
    const onError = (e: any) => call(e);
    const onClose = () => {
      if (rEnded && wEnded) return call();
      call(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
    };
    stream.on('end', onEnd); stream.on('finish', onFinish); stream.on('error', onError); stream.on('close', onClose);
    const cleanup = () => { stream.off?.('end', onEnd); stream.off?.('finish', onFinish); stream.off?.('error', onError); stream.off?.('close', onClose); };
    if (rEnded && wEnded) tick(call);
    return cleanup;
  };
  streamModule.finished = finished;
  const pipeline = (...args: any[]) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    let streams: any[] = Array.isArray(args[0]) ? args[0] : args;
    streams = streams.map((s, i) => {
      if (typeof s === 'function') s = s(i === 0 ? undefined : streams[i - 1]);
      if (s && !s.on && (typeof s[Symbol.asyncIterator] === 'function' || typeof s[Symbol.iterator] === 'function')) s = Readable.from(s);
      return s;
    });
    let done = false;
    const finish = (err?: any) => {
      if (done) return;
      done = true;
      if (err) for (const s of streams) if (!s.destroyed) s.destroy?.(err.code === 'ERR_STREAM_PREMATURE_CLOSE' ? undefined : err);
      cb?.(err ?? null);
    };
    for (let i = 0; i < streams.length - 1; i++) streams[i].pipe(streams[i + 1]);
    streams.forEach((s, i) => {
      if (i < streams.length - 1) s.on('error', finish);
      else finished(s, (err: any) => finish(err));
    });
    return streams[streams.length - 1];
  };
  streamModule.pipeline = pipeline;
  streamModule.promises = {
    pipeline: (...streams: any[]) => new Promise((resolve, reject) => pipeline(...streams, (err: any) => err ? reject(err) : resolve(undefined))),
    finished: (stream: any, opts?: any) => new Promise((resolve, reject) => finished(stream, opts ?? {}, (err: any) => err ? reject(err) : resolve(undefined))),
  };
  streamModule.addAbortSignal = (_signal: any, stream: any) => stream;
  streamModule.compose = (...streams: any[]) => streams[streams.length - 1];
  streamModule.getDefaultHighWaterMark = (objectMode: boolean) => objectMode ? 16 : 16384;
  streamModule.setDefaultHighWaterMark = () => {};
  streamModule.consumers = {
    arrayBuffer: async (stream: any) => {
      const chunks: any[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      const totalLength = chunks.reduce((acc: number, c: any) => acc + (c.byteLength || c.length || 0), 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer || chunk);
        result.set(bytes, offset);
        offset += bytes.length;
      }
      return result.buffer;
    },
    blob: async (stream: any) => {
      const chunks: any[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      return new Blob(chunks);
    },
    buffer: async (stream: any) => {
      const chunks: any[] = [];
      for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      const totalLength = chunks.reduce((acc: number, c: any) => acc + (c.byteLength || c.length || 0), 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        const bytes = new Uint8Array(chunk.buffer || chunk);
        result.set(bytes, offset);
        offset += bytes.length;
      }
      return result;
    },
    json: async (stream: any) => {
      let text = '';
      for await (const chunk of stream) text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      return JSON.parse(text);
    },
    text: async (stream: any) => {
      let text = '';
      for await (const chunk of stream) text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      return text;
    },
  };
  // `const Stream = require('stream'); class X extends Stream`: the module is
  // the legacy Stream constructor, with the rest as its properties
  const mod: any = Stream;
  Object.assign(mod, streamModule);
  // (not enumerable: node's stream has no `default`)
  Object.defineProperty(mod, 'default', { value: Stream, writable: true, configurable: true, enumerable: false });
  mod.isErrored = (s: any) => !!(s?._readableState?.errored ?? s?._writableState?.errored);
  mod.isDisturbed = (s: any) => !!s?._readableState && (s._readableState.flowing !== null || s._readableState.endEmitted);
  mod.isReadable = (s: any) => !!s?._readableState && !s.destroyed && !s._readableState.endEmitted;
  mod.isWritable = (s: any) => !!s?._writableState && !s.destroyed && !s._writableState.ending;
  return mod;
}
