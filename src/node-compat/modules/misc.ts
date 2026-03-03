import type { CommandContext } from '../../commands/index';

export interface MiscDeps {
  ctx: CommandContext;
  FakeBuffer: any;
  fakeProcess: any;
  fakeConsole: any;
  getBuiltinModule: (name: string) => any;
  fileCache: Map<string, string>;
  moduleCache: Map<string, { exports: any }>;
  requireModule: (id: string, fromDir: string) => any;
}

export function createMiscModule(name: string, deps: MiscDeps): any | null {
  const { ctx, FakeBuffer, fakeProcess, fakeConsole, getBuiltinModule, fileCache, moduleCache, requireModule } = deps;

  switch (name) {
    case 'buffer':
    case 'node:buffer': return {
      Buffer: FakeBuffer,
      Blob: typeof globalThis.Blob !== 'undefined' ? globalThis.Blob : class Blob { constructor(parts?: any[], opts?: any) {} text() { return Promise.resolve(''); } arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); } },
      File: typeof globalThis.File !== 'undefined' ? globalThis.File : class File { name = ''; constructor(parts: any[], name: string, opts?: any) { this.name = name; } },
      btoa: typeof globalThis.btoa !== 'undefined' ? globalThis.btoa : (s: string) => s,
      atob: typeof globalThis.atob !== 'undefined' ? globalThis.atob : (s: string) => s,
      constants: { MAX_LENGTH: 2147483647, MAX_STRING_LENGTH: 536870888 },
      kMaxLength: 2147483647,
      SlowBuffer: FakeBuffer,
      isUtf8: (buf: Uint8Array) => { try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; } },
      isAscii: (buf: Uint8Array) => { for (let i = 0; i < buf.length; i++) if (buf[i] > 127) return false; return true; },
    };

    case 'querystring':
    case 'node:querystring': return {
      parse: (str: string) => {
        const obj: Record<string, string> = {};
        for (const pair of str.split('&')) {
          const [k, v] = pair.split('=');
          if (k) obj[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
        }
        return obj;
      },
      stringify: (obj: Record<string, any>) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
      encode: (obj: Record<string, any>) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
      decode: (str: string) => {
        const obj: Record<string, string> = {};
        for (const pair of str.split('&')) {
          const [k, v] = pair.split('=');
          if (k) obj[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
        }
        return obj;
      },
      escape: encodeURIComponent,
      unescape: decodeURIComponent,
    };

    case 'string_decoder':
    case 'node:string_decoder': {
      class StringDecoder {
        encoding: string;
        constructor(encoding = 'utf8') { this.encoding = encoding; }
        write(buf: any): string { return new TextDecoder(this.encoding).decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf)); }
        end(buf?: any): string { return buf ? this.write(buf) : ''; }
      }
      return { StringDecoder };
    }

    case 'constants':
    case 'node:constants': return {
      O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128,
      O_TRUNC: 512, O_APPEND: 1024, O_DIRECTORY: 65536, O_NOFOLLOW: 131072,
      S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960,
      S_IRWXU: 448, S_IRUSR: 256, S_IWUSR: 128, S_IXUSR: 64,
      S_IRWXG: 56, S_IRGRP: 32, S_IWGRP: 16, S_IXGRP: 8,
      S_IRWXO: 7, S_IROTH: 4, S_IWOTH: 2, S_IXOTH: 1,
      SIGINT: 2, SIGTERM: 15, SIGKILL: 9,
    };

    case 'tty':
    case 'node:tty': return {
      isatty: (fd?: number) => !!ctx.terminal,
      ReadStream: class ReadStream { constructor() {} setRawMode() { return this; } isTTY = !!ctx.terminal; },
      WriteStream: class WriteStream {
        isTTY = !!ctx.terminal;
        get columns() { return ctx.terminal ? ctx.terminal.getSize().cols : 80; }
        get rows() { return ctx.terminal ? ctx.terminal.getSize().rows : 24; }
        getColorDepth() { return ctx.terminal ? 24 : 1; }
        hasColors(count?: number) { return ctx.terminal ? (count ? count <= 16777216 : true) : false; }
        getWindowSize() { return [this.columns, this.rows]; }
        cursorTo() {}
        moveCursor() {}
        clearLine() {}
        clearScreenDown() {}
        write(data: any) { fakeProcess.stdout.write(typeof data === 'string' ? data : String(data)); }
      },
    };

    case 'zlib':
    case 'node:zlib': {
      // Stub zlib using DecompressionStream/CompressionStream when possible
      const passthrough = (data: any, cb?: Function) => {
        if (cb) cb(null, data);
        return data;
      };
      return {
        createGunzip: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
        createGzip: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
        createDeflate: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
        createInflate: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
        gzip: passthrough,
        gunzip: passthrough,
        deflate: passthrough,
        inflate: passthrough,
        gzipSync: (data: any) => data,
        gunzipSync: (data: any) => data,
        deflateSync: (data: any) => data,
        inflateSync: (data: any) => data,
        brotliCompressSync: (data: any) => data,
        brotliDecompressSync: (data: any) => data,
        createInflateRaw: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
        createDeflateRaw: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
        createBrotliCompress: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
        createBrotliDecompress: () => ({ pipe: (d: any) => d, on: () => {}, once: () => {}, end: () => {} }),
        deflateRawSync: (data: any) => data,
        inflateRawSync: (data: any) => data,
        Z_DEFAULT_WINDOWBITS: 15,
        Z_NO_FLUSH: 0,
        Z_PARTIAL_FLUSH: 1,
        constants: {
          Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9,
          Z_DEFAULT_COMPRESSION: -1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3,
          Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_DEFAULT_WINDOWBITS: 15,
          BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,
        },
      };
    }

    case 'dns':
    case 'node:dns': {
      const dnsModule: any = {
        lookup: (hostname: string, opts: any, cb?: Function) => {
          if (typeof opts === 'function') { cb = opts; opts = {}; }
          cb?.(null, '127.0.0.1', 4);
        },
        resolve: (hostname: string, rrtype: any, cb?: Function) => {
          if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
          cb?.(null, ['127.0.0.1']);
        },
        resolve4: (hostname: string, cb: Function) => cb(null, ['127.0.0.1']),
        resolve6: (hostname: string, cb: Function) => cb(null, ['::1']),
        setServers: () => {},
        getServers: () => ['8.8.8.8'],
      };
      dnsModule.promises = {
        lookup: async (hostname: string) => ({ address: '127.0.0.1', family: 4 }),
        resolve: async (hostname: string) => ['127.0.0.1'],
        resolve4: async (hostname: string) => ['127.0.0.1'],
        resolve6: async (hostname: string) => ['::1'],
      };
      return dnsModule;
    }

    case 'perf_hooks':
    case 'node:perf_hooks': return {
      performance: typeof performance !== 'undefined' ? performance : {
        now: () => Date.now(),
        timeOrigin: Date.now(),
        mark: () => {},
        measure: () => {},
        getEntries: () => [],
        getEntriesByName: () => [],
        getEntriesByType: () => [],
        clearMarks: () => {},
        clearMeasures: () => {},
      },
      PerformanceObserver: class PerformanceObserver {
        constructor(cb: Function) {}
        observe() {}
        disconnect() {}
      },
      monitorEventLoopDelay: () => ({
        enable: () => {},
        disable: () => {},
        percentile: () => 0,
        min: 0, max: 0, mean: 0, stddev: 0,
      }),
    };

    case 'timers':
    case 'node:timers': return {
      setTimeout, setInterval, setImmediate: (fn: Function, ...args: any[]) => setTimeout(fn, 0, ...args),
      clearTimeout, clearInterval, clearImmediate: clearTimeout,
    };

    case 'timers/promises':
    case 'node:timers/promises': return {
      setTimeout: (ms: number, value?: any) => new Promise(resolve => globalThis.setTimeout(() => resolve(value), ms)),
      setInterval: async function*(ms: number, value?: any) { while (true) { await new Promise(r => globalThis.setTimeout(r, ms)); yield value; } },
      setImmediate: (value?: any) => new Promise(resolve => globalThis.setTimeout(() => resolve(value), 0)),
      scheduler: { wait: (ms: number) => new Promise(r => globalThis.setTimeout(r, ms)), yield: () => new Promise(r => globalThis.setTimeout(r, 0)) },
    };

    case 'module':
    case 'node:module': {
      // Provide createRequire that delegates to our require system
      const modExport: any = {
        createRequire: (_url: string) => {
          // Return a require function that uses our module resolution
          const fakeReq: any = (id: string) => requireModule(id, ctx.cwd);
          fakeReq.resolve = (id: string) => {
            // Simple resolve: check builtins first, then file paths
            if (getBuiltinModule(id) || getBuiltinModule('node:' + id)) return id;
            // Try to find the file in cache
            const tryPaths = [
              id,
              id + '.js',
              id + '/index.js',
            ];
            for (const p of tryPaths) {
              if (fileCache.has(p)) return p;
            }
            return id;
          };
          fakeReq.resolve.paths = () => [ctx.cwd + '/node_modules', '/usr/local/lib/node_modules'];
          fakeReq.cache = moduleCache;
          return fakeReq;
        },
        builtinModules: [
          'assert', 'async_hooks', 'buffer', 'child_process', 'constants', 'crypto',
          'diagnostics_channel', 'dns', 'events', 'fs', 'fs/promises', 'http', 'https',
          'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring',
          'readline', 'stream', 'string_decoder', 'timers', 'timers/promises', 'tls',
          'tty', 'url', 'util', 'v8', 'worker_threads', 'zlib',
        ],
        isBuiltin: (name: string) => {
          const clean = name.startsWith('node:') ? name.slice(5) : name;
          return modExport.builtinModules.includes(clean);
        },
        _resolveFilename: (request: string) => request,
        _cache: moduleCache,
        Module: class Module {
          id: string;
          exports: any = {};
          constructor(id = '') { this.id = id; }
        },
      };
      return modExport;
    }

    case 'process':
    case 'node:process':
      return fakeProcess;

    case 'path/posix':
    case 'node:path/posix': return getBuiltinModule('path');

    case 'path/win32':
    case 'node:path/win32': return getBuiltinModule('path');

    case 'async_hooks':
    case 'node:async_hooks': {
      // AsyncLocalStorage: context propagation for async operations
      class AsyncLocalStorage {
        private _store: any = undefined;
        getStore() { return this._store; }
        run(store: any, fn: Function, ...args: any[]) { const prev = this._store; this._store = store; try { return fn(...args); } finally { this._store = prev; } }
        enterWith(store: any) { this._store = store; }
        disable() { this._store = undefined; }
        exit(fn: Function, ...args: any[]) { const prev = this._store; this._store = undefined; try { return fn(...args); } finally { this._store = prev; } }
      }
      class AsyncResource {
        type: string;
        constructor(type: string) { this.type = type; }
        runInAsyncScope(fn: Function, thisArg?: any, ...args: any[]) { return fn.apply(thisArg, args); }
        emitDestroy() { return this; }
        asyncId() { return 0; }
        triggerAsyncId() { return 0; }
        bind(fn: Function) { return fn; }
        static bind(fn: Function) { return fn; }
      }
      return {
        AsyncLocalStorage,
        AsyncResource,
        createHook: () => ({ enable: () => {}, disable: () => {} }),
        executionAsyncId: () => 0,
        triggerAsyncId: () => 0,
        executionAsyncResource: () => ({}),
      };
    }

    case 'worker_threads':
    case 'node:worker_threads': {
      // EventEmitter mixin for Worker/MessagePort
      function makeEmitter(obj: any) {
        const _events: Record<string, Function[]> = {};
        obj.on = (ev: string, fn: Function) => { (_events[ev] ??= []).push(fn); return obj; };
        obj.once = (ev: string, fn: Function) => {
          const wrapped = (...args: any[]) => { obj.off(ev, wrapped); fn(...args); };
          return obj.on(ev, wrapped);
        };
        obj.off = (ev: string, fn: Function) => { _events[ev] = (_events[ev] || []).filter(f => f !== fn); return obj; };
        obj.addListener = obj.on;
        obj.removeListener = obj.off;
        obj.removeAllListeners = (ev?: string) => { if (ev) delete _events[ev]; else Object.keys(_events).forEach(k => delete _events[k]); return obj; };
        obj.emit = (ev: string, ...args: any[]) => { (_events[ev] || []).forEach(f => { try { f(...args); } catch {} }); return !!(_events[ev]?.length); };
        obj.listeners = (ev: string) => [...(_events[ev] || [])];
        obj.listenerCount = (ev: string) => (_events[ev] || []).length;
        obj.eventNames = () => Object.keys(_events).filter(k => _events[k].length > 0);
        return obj;
      }

      class MessagePort {
        constructor() { makeEmitter(this); }
        postMessage(_value: any, _transferList?: any[]) {}
        start() {}
        close() { (this as any).emit('close'); }
        ref() { return this; }
        unref() { return this; }
        // EventEmitter methods added by makeEmitter
        on!: (ev: string, fn: Function) => this;
        once!: (ev: string, fn: Function) => this;
        off!: (ev: string, fn: Function) => this;
        addListener!: (ev: string, fn: Function) => this;
        removeListener!: (ev: string, fn: Function) => this;
        removeAllListeners!: (ev?: string) => this;
        emit!: (ev: string, ...args: any[]) => boolean;
      }

      class MessageChannel {
        port1: MessagePort;
        port2: MessagePort;
        constructor() {
          this.port1 = new MessagePort();
          this.port2 = new MessagePort();
        }
      }

      class Worker {
        threadId = 1;
        resourceLimits = {};
        constructor(_filename: string | URL, _options?: any) {
          makeEmitter(this);
          // Only emit error if someone is listening; always emit exit(1) for graceful degradation
          setTimeout(() => {
            if ((this as any).listenerCount('error') > 0) {
              (this as any).emit('error', new Error('Worker threads not supported in browser'));
            }
            (this as any).emit('exit', 1);
          }, 0);
        }
        postMessage(_value: any, _transferList?: any[]) {}
        terminate(): Promise<number> {
          (this as any).emit('exit', 0);
          return Promise.resolve(0);
        }
        ref() { return this; }
        unref() { return this; }
        getHeapSnapshot() { return Promise.resolve({}); }
        // EventEmitter methods added by makeEmitter
        on!: (ev: string, fn: Function) => this;
        once!: (ev: string, fn: Function) => this;
        off!: (ev: string, fn: Function) => this;
        addListener!: (ev: string, fn: Function) => this;
        removeListener!: (ev: string, fn: Function) => this;
        removeAllListeners!: (ev?: string) => this;
        emit!: (ev: string, ...args: any[]) => boolean;
        listenerCount!: (ev: string) => number;
      }

      class BroadcastChannel {
        name: string;
        constructor(name: string) { this.name = name; makeEmitter(this); }
        postMessage(_msg: any) {}
        close() {}
        on!: (ev: string, fn: Function) => this;
        off!: (ev: string, fn: Function) => this;
      }

      const envData = new Map<string, any>();

      return {
        isMainThread: true,
        parentPort: null,
        workerData: null,
        threadId: 0,
        resourceLimits: {},
        SHARE_ENV: Symbol('SHARE_ENV'),
        Worker,
        MessageChannel,
        MessagePort,
        BroadcastChannel,
        markAsUntransferable: (_obj: any) => {},
        moveMessagePortToContext: (port: any, _ctx: any) => port,
        receiveMessageOnPort: (_port: any) => undefined,
        setEnvironmentData: (key: any, value: any) => { envData.set(key, value); },
        getEnvironmentData: (key: any) => envData.get(key),
      };
    }

    case 'readline':
    case 'node:readline': return {
      cursorTo: (stream: any, x: number, y?: number | Function, cb?: Function) => {
        if (stream?.write) {
          let seq = `\x1b[${x + 1}G`;
          if (typeof y === 'number') seq = `\x1b[${y + 1};${x + 1}H`;
          stream.write(seq);
        }
        if (typeof y === 'function') y(); else if (cb) cb();
        return true;
      },
      clearLine: (stream: any, dir: number, cb?: Function) => {
        if (stream?.write) {
          stream.write(dir === -1 ? '\x1b[1K' : dir === 1 ? '\x1b[0K' : '\x1b[2K');
        }
        if (cb) cb();
        return true;
      },
      moveCursor: (stream: any, dx: number, dy: number, cb?: Function) => {
        if (stream?.write) {
          let seq = '';
          if (dx > 0) seq += `\x1b[${dx}C`;
          else if (dx < 0) seq += `\x1b[${-dx}D`;
          if (dy > 0) seq += `\x1b[${dy}B`;
          else if (dy < 0) seq += `\x1b[${-dy}A`;
          if (seq) stream.write(seq);
        }
        if (cb) cb();
        return true;
      },
      clearScreenDown: (stream: any, cb?: Function) => {
        if (stream?.write) stream.write('\x1b[J');
        if (cb) cb();
        return true;
      },
      createInterface: (opts: any) => {
        const events: Record<string, Function[]> = {};
        const iface: any = {
          on: (ev: string, fn: Function) => { (events[ev] ??= []).push(fn); return iface; },
          once: (ev: string, fn: Function) => iface.on(ev, fn),
          off: (ev: string, fn: Function) => { events[ev] = (events[ev] || []).filter(f => f !== fn); return iface; },
          removeListener: (ev: string, fn: Function) => iface.off(ev, fn),
          removeAllListeners: () => { Object.keys(events).forEach(k => delete events[k]); return iface; },
          close: () => { (events['close'] || []).forEach(f => f()); },
          question: (q: string, cb: Function) => cb(''),
          write: () => {},
          setPrompt: () => {},
          prompt: () => {},
          [Symbol.asyncIterator]: async function*() {},
        };
        return iface;
      },
      Interface: class Interface {},
      emitKeypressEvents: (stream: any) => {
        // ink calls this to enable keypress events on stdin
        // Parse raw input into keypress events, handling ANSI escape sequences
        if (stream && stream.on && !stream._keypressListenerAdded) {
          stream._keypressListenerAdded = true;
          let escBuf = '';
          stream.on('data', (data: any) => {
            const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
            let i = 0;
            while (i < str.length) {
              const ch = str[i];
              const code = ch.charCodeAt(0);
              const key: any = { sequence: '', name: '', ctrl: false, meta: false, shift: false };
              if (code === 0x1b && i + 1 < str.length) {
                // Escape sequence
                const next = str[i + 1];
                if (next === '[') {
                  // CSI sequence: \x1b[...
                  let seq = '\x1b[';
                  i += 2;
                  while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) { seq += str[i]; i++; }
                  if (i < str.length) { seq += str[i]; i++; }
                  key.sequence = seq;
                  const final = seq[seq.length - 1];
                  const params = seq.slice(2, -1);
                  if (final === 'A') key.name = 'up';
                  else if (final === 'B') key.name = 'down';
                  else if (final === 'C') key.name = 'right';
                  else if (final === 'D') key.name = 'left';
                  else if (final === 'H') key.name = 'home';
                  else if (final === 'F') key.name = 'end';
                  else if (final === 'Z') { key.name = 'tab'; key.shift = true; }
                  else if (final === '~') {
                    if (params === '3') key.name = 'delete';
                    else if (params === '5') key.name = 'pageup';
                    else if (params === '6') key.name = 'pagedown';
                    else if (params === '2') key.name = 'insert';
                    else key.name = 'undefined';
                  }
                  else key.name = 'undefined';
                  if (params.includes(';')) {
                    const mod = parseInt(params.split(';')[1]) - 1;
                    if (mod & 1) key.shift = true;
                    if (mod & 2) key.meta = true;
                    if (mod & 4) key.ctrl = true;
                  }
                } else if (next === 'O') {
                  // SS3 sequence: \x1bO... (function keys)
                  i += 2;
                  const fk = i < str.length ? str[i++] : '';
                  key.sequence = '\x1bO' + fk;
                  if (fk === 'P') key.name = 'f1';
                  else if (fk === 'Q') key.name = 'f2';
                  else if (fk === 'R') key.name = 'f3';
                  else if (fk === 'S') key.name = 'f4';
                  else key.name = 'undefined';
                } else {
                  // Alt+key
                  key.sequence = '\x1b' + next;
                  key.name = next.toLowerCase();
                  key.meta = true;
                  i += 2;
                }
              } else {
                key.sequence = ch;
                i++;
                if (code === 13) key.name = 'return';
                else if (code === 10) key.name = 'return';
                else if (code === 127) key.name = 'backspace';
                else if (code === 8) key.name = 'backspace';
                else if (code === 9) key.name = 'tab';
                else if (code === 32) key.name = 'space';
                else if (code < 27) { key.name = String.fromCharCode(code + 96); key.ctrl = true; }
                else key.name = ch.toLowerCase();
              }
              stream.emit('keypress', key.sequence, key);
            }
          });
        }
      },
    };

    case 'readline/promises':
    case 'node:readline/promises': {
      const rlp: any = {
        createInterface: (opts: any) => {
          const events: Record<string, Function[]> = {};
          const iface: any = {
            on: (ev: string, fn: Function) => { (events[ev] ??= []).push(fn); return iface; },
            once: (ev: string, fn: Function) => iface.on(ev, fn),
            off: (ev: string, fn: Function) => { events[ev] = (events[ev] || []).filter(f => f !== fn); return iface; },
            close: () => { (events['close'] || []).forEach(f => f()); },
            question: async (_q: string) => '',
            [Symbol.asyncIterator]: async function*() {},
          };
          return iface;
        },
      };
      return rlp;
    }

    case 'diagnostics_channel':
    case 'node:diagnostics_channel': return {
      channel: (name: string) => ({ subscribe: () => {}, unsubscribe: () => {}, hasSubscribers: false }),
      hasSubscribers: () => false,
      subscribe: () => {},
      unsubscribe: () => {},
      Channel: class Channel { subscribe() {} unsubscribe() {} hasSubscribers = false; },
    };

    case 'v8':
    case 'node:v8': return {
      serialize: (v: any) => new Uint8Array(new TextEncoder().encode(JSON.stringify(v))),
      deserialize: (b: any) => JSON.parse(new TextDecoder().decode(b)),
      getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0 }),
      setFlagsFromString: () => {},
    };

    case 'assert':
    case 'node:assert': {
      const assert: any = (value: any, msg?: string) => { if (!value) throw new Error(msg || 'Assertion failed'); };
      assert.ok = assert;
      assert.equal = (a: any, b: any, msg?: string) => { if (a != b) throw new Error(msg || `${a} != ${b}`); };
      assert.strictEqual = (a: any, b: any, msg?: string) => { if (a !== b) throw new Error(msg || `${a} !== ${b}`); };
      assert.deepEqual = assert.deepStrictEqual = (a: any, b: any, msg?: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || 'Deep equal failed'); };
      assert.notEqual = (a: any, b: any, msg?: string) => { if (a == b) throw new Error(msg || `${a} == ${b}`); };
      assert.notStrictEqual = (a: any, b: any, msg?: string) => { if (a === b) throw new Error(msg || `${a} === ${b}`); };
      assert.throws = (fn: Function, msg?: any) => { try { fn(); throw new Error(typeof msg === 'string' ? msg : 'Expected throw'); } catch(e) { /* ok */ } };
      assert.doesNotThrow = (fn: Function) => { fn(); };
      assert.fail = (msg?: string) => { throw new Error(msg || 'Assert.fail'); };
      assert.AssertionError = class extends Error {};
      return assert;
    }

    case 'console':
    case 'node:console': {
      return { Console: fakeConsole.Console, default: fakeConsole.Console };
    }

    case 'util/types':
    case 'node:util/types': return (getBuiltinModule('util') as any).types;

    case 'inspector':
    case 'node:inspector': return {
      open: () => {},
      close: () => {},
      url: () => undefined,
      Session: class InspectorSession {
        connect() {}
        disconnect() {}
        post(_method: string, _params: any, cb?: Function) { cb?.(null); }
        on() { return this; }
      },
    };

    case 'vm':
    case 'node:vm': {
      const VM_CONTEXT_SYMBOL = Symbol.for('__isVMContext');

      function createContext(sandbox?: any): any {
        if (!sandbox) sandbox = {};
        Object.defineProperty(sandbox, VM_CONTEXT_SYMBOL, { value: true, enumerable: false, configurable: false });
        return new Proxy(sandbox, {
          get(target, prop, receiver) {
            if (prop in target) return Reflect.get(target, prop, receiver);
            if (typeof prop === 'string' && prop in globalThis) return (globalThis as any)[prop];
            return undefined;
          },
          has(target, prop) {
            return prop in target || prop in globalThis;
          },
          set(target, prop, value) { target[prop] = value; return true; },
        });
      }

      function isContext(obj: any): boolean {
        if (!obj || typeof obj !== 'object') return false;
        return obj[VM_CONTEXT_SYMBOL] === true;
      }

      // Script class wraps new Function for running code in contexts
      class Script {
        private _code: string;
        private _options: any;
        constructor(code: string, options?: any) {
          this._code = code;
          this._options = options || {};
        }
        runInThisContext(options?: any): any {
          return new Function(this._code)();
        }
        runInNewContext(sandbox?: any, options?: any): any {
          return this.runInContext(createContext(sandbox), options);
        }
        runInContext(context?: any, options?: any): any {
          if (!context) return this.runInThisContext(options);
          // For proxy-based contexts, enumerate own keys from underlying sandbox
          const keys = Object.keys(context);
          const values = keys.map(k => context[k]);
          // Try eval-based execution first (returns last expression value, matches vm.Script behavior)
          // Fall back to direct Function execution for code with return statements
          try {
            const fn = new Function(...keys, 'return eval(' + JSON.stringify(this._code) + ')');
            return fn(...values);
          } catch {
            const fn = new Function(...keys, this._code);
            return fn(...values);
          }
        }
      }

      function createScript(code: string, options?: any): Script {
        return new Script(code, options);
      }
      function runInThisContext(code: string, options?: any): any {
        return new Script(code, options).runInThisContext(options);
      }
      function runInNewContext(code: string, sandbox?: any, options?: any): any {
        return new Script(code, options).runInNewContext(sandbox, options);
      }
      function runInContext(code: string, context: any, options?: any): any {
        return new Script(code, options).runInContext(context, options);
      }
      function compileFunction(code: string, params?: string[], options?: any): Function {
        const context = options?.parsingContext;
        if (context) {
          const ctxKeys = Object.keys(context);
          const ctxVals = ctxKeys.map(k => context[k]);
          const inner = new Function(...ctxKeys, ...(params || []), code);
          const bound = (...args: any[]) => inner(...ctxVals, ...args);
          return bound;
        }
        return new Function(...(params || []), code);
      }
      return {
        Script,
        createContext,
        createScript,
        runInThisContext,
        runInNewContext,
        runInContext,
        compileFunction,
        isContext,
      };
    }

    default: return null;
  }
}
