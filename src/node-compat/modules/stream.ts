export function createStreamModule(): any {
  const streamModule: any = {};

  const Stream = function(this: any) { this._events = {}; this.destroyed = false; } as any;
  Stream.prototype.pipe = function(dest: any) { return dest; };
  Stream.prototype.on = function(event: string, cb: Function) { (this._events[event] ??= []).push(cb); return this; };
  Stream.prototype.once = function(event: string, cb: Function) { const w = (...a: any[]) => { this.off(event, w); cb(...a); }; return this.on(event, w); };
  Stream.prototype.emit = function(event: string, ...args: any[]) { (this._events[event] || []).forEach((fn: Function) => fn(...args)); return (this._events[event] || []).length > 0; };
  Stream.prototype.off = function(event: string, cb: Function) { this._events[event] = (this._events[event] || []).filter((f: Function) => f !== cb); return this; };
  Stream.prototype.removeListener = function(event: string, cb: Function) { return this.off(event, cb); };
  Stream.prototype.addListener = function(event: string, cb: Function) { return this.on(event, cb); };
  Stream.prototype.removeAllListeners = function(event?: string) { if (event) delete this._events[event]; else this._events = {}; return this; };
  Stream.prototype.listeners = function(event: string) { return [...(this._events[event] || [])]; };
  Stream.prototype.listenerCount = function(event: string) { return (this._events[event] || []).length; };
  Stream.prototype.setMaxListeners = function() { return this; };
  Stream.prototype.prependListener = function(event: string, cb: Function) { (this._events[event] ??= []).unshift(cb); return this; };
  Stream.prototype.eventNames = function() { return Object.keys(this._events); };
  streamModule.Stream = Stream;

  const Readable = function(this: any, opts?: any) { Stream.call(this); this.readable = true; this._readableState = { flowing: null, ended: false, objectMode: opts?.objectMode || false }; } as any;
  Readable.prototype = Object.create(Stream.prototype);
  Readable.prototype.constructor = Readable;
  Readable.prototype._read = function() {};
  Readable.prototype.push = function(_chunk: any) { return true; };
  Readable.prototype.read = function() { return null; };
  Readable.prototype.setEncoding = function(_enc: string) { return this; };
  Readable.prototype.pause = function() { if (this._readableState) this._readableState.flowing = false; return this; };
  Readable.prototype.resume = function() { if (this._readableState) this._readableState.flowing = true; return this; };
  Readable.prototype.isPaused = function() { return this._readableState ? this._readableState.flowing === false : false; };
  Readable.prototype.unshift = function(_chunk: any) {};
  Readable.prototype.wrap = function(_stream: any) { return this; };
  Readable.prototype.destroy = function(err?: any) { this.destroyed = true; if (err) this.emit('error', err); this.emit('close'); return this; };
  Readable.prototype[Symbol.asyncIterator] = async function*() {};
  Readable.from = (iterable: any) => {
    const stream = new Readable();
    (async () => {
      try {
        for await (const chunk of iterable) {
          stream.push(chunk);
        }
        stream.push(null);
      } catch (e) {
        stream.emit('error', e);
      }
    })();
    return stream;
  };
  streamModule.Readable = Readable;

  const Writable = function(this: any, opts?: any) { Stream.call(this); this.writable = true; this._writableState = { ended: false, objectMode: opts?.objectMode || false }; } as any;
  Writable.prototype = Object.create(Stream.prototype);
  Writable.prototype.constructor = Writable;
  Writable.prototype._write = function(_chunk: any, _encoding: string, callback: Function) { callback(); };
  Writable.prototype.write = function(_chunk: any, _encoding?: any, _cb?: any) { const cb = typeof _encoding === 'function' ? _encoding : _cb; if (cb) cb(); return true; };
  Writable.prototype.end = function(_chunk?: any, _encoding?: any, _cb?: any) { const cb = typeof _chunk === 'function' ? _chunk : typeof _encoding === 'function' ? _encoding : _cb; if (cb) cb(); this.emit('finish'); };
  Writable.prototype.destroy = function(err?: any) { this.destroyed = true; if (err) this.emit('error', err); this.emit('close'); return this; };
  Writable.prototype.cork = function() {};
  Writable.prototype.uncork = function() {};
  Writable.prototype.setDefaultEncoding = function() { return this; };
  streamModule.Writable = Writable;

  const Duplex = function(this: any, opts?: any) { Readable.call(this, opts); this.writable = true; this._writableState = { ended: false, objectMode: opts?.objectMode || false }; } as any;
  Duplex.prototype = Object.create(Readable.prototype);
  Object.assign(Duplex.prototype, Writable.prototype);
  Duplex.prototype.constructor = Duplex;
  streamModule.Duplex = Duplex;

  const Transform = function(this: any, opts?: any) { Duplex.call(this, opts); } as any;
  Transform.prototype = Object.create(Duplex.prototype);
  Transform.prototype.constructor = Transform;
  Transform.prototype._transform = function(_chunk: any, _encoding: string, callback: Function) { callback(); };
  Transform.prototype._flush = function(callback: Function) { callback(); };
  streamModule.Transform = Transform;

  const PassThrough = function(this: any, opts?: any) { Transform.call(this, opts); } as any;
  PassThrough.prototype = Object.create(Transform.prototype);
  PassThrough.prototype.constructor = PassThrough;
  streamModule.PassThrough = PassThrough;

  // pipeline/finished — used by many Node.js libraries
  streamModule.pipeline = (...args: any[]) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    if (cb) setTimeout(() => cb(null), 0);
    return args[args.length - 1]; // Return last stream
  };
  streamModule.finished = (stream: any, opts: any, cb?: Function) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (callback) setTimeout(() => callback(null), 0);
    return () => {}; // cleanup function
  };
  streamModule.promises = {
    pipeline: async (...streams: any[]) => streams[streams.length - 1],
    finished: async () => {},
  };
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
  // Make the module itself a constructor (for `const Stream = require('stream')`)
  streamModule.default = Stream;
  // Node.js stream module is itself a constructor with a prototype
  streamModule.prototype = Stream.prototype;
  streamModule.isErrored = (s: any) => !!s?.destroyed;
  streamModule.isDisturbed = (s: any) => !!s?._readableState?.reading;
  streamModule.isReadable = (s: any) => s instanceof Readable;
  streamModule.isWritable = (s: any) => s instanceof Writable;

  return streamModule;
}
