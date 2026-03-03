export function createUtilModule(): any {
  const _inspect = (obj: any, opts?: any): string => {
    if (obj === null) return 'null';
    if (obj === undefined) return 'undefined';
    if (typeof obj === 'string') return opts?.stylize ? opts.stylize(`'${obj}'`, 'string') : `'${obj}'`;
    if (typeof obj === 'number' || typeof obj === 'boolean' || typeof obj === 'bigint') return String(obj);
    if (typeof obj === 'function') return `[Function: ${obj.name || 'anonymous'}]`;
    if (typeof obj === 'symbol') return obj.toString();
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof RegExp) return obj.toString();
    if (obj instanceof Error) return `${obj.name}: ${obj.message}`;
    if (ArrayBuffer.isView(obj)) return `<Buffer ${Array.from(obj as Uint8Array).slice(0, 50).map(b => b.toString(16).padStart(2, '0')).join(' ')}${(obj as Uint8Array).length > 50 ? ' ...' : ''}>`;
    try { return JSON.stringify(obj, null, 2); } catch { return '[Circular]'; }
  };
  _inspect.custom = Symbol.for('nodejs.util.inspect.custom');
  _inspect.styles = {};
  _inspect.colors = {};
  _inspect.defaultOptions = { depth: 2, colors: false };
  const _format = (fmt: any, ...args: any[]): string => {
    if (typeof fmt !== 'string') return [fmt, ...args].map(a => typeof a === 'object' ? _inspect(a) : String(a)).join(' ');
    let i = 0;
    const str = fmt.replace(/%[sdjifoO%]/g, (m: string) => {
      if (m === '%%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      switch (m) {
        case '%s': return String(a);
        case '%d': case '%i': return parseInt(a, 10).toString();
        case '%f': return parseFloat(a).toString();
        case '%j': try { return JSON.stringify(a); } catch { return '[Circular]'; }
        case '%o': case '%O': return _inspect(a);
        default: return m;
      }
    });
    const rest = args.slice(i).map(a => typeof a === 'object' ? _inspect(a) : String(a));
    return rest.length ? str + ' ' + rest.join(' ') : str;
  };
  return {
    promisify: (fn: any) => {
      // Check for custom promisify implementation (e.g., child_process.exec)
      const customSym = Symbol.for('nodejs.util.promisify.custom');
      if (fn[customSym]) return fn[customSym];
      return (...args: any[]) => new Promise((resolve, reject) => {
        fn(...args, (err: any, result: any) => err ? reject(err) : resolve(result));
      });
    },
    callbackify: (fn: Function) => (...args: any[]) => {
      const cb = args.pop();
      fn(...args).then((r: any) => cb(null, r)).catch((e: any) => cb(e));
    },
    inspect: _inspect,
    format: _format,
    types: {
      isDate: (v: any) => v instanceof Date,
      isRegExp: (v: any) => v instanceof RegExp,
      isCryptoKey: (key: any) => typeof CryptoKey !== 'undefined' && key instanceof CryptoKey,
      isTypedArray: (v: any) => ArrayBuffer.isView(v) && !(v instanceof DataView),
      isNativeError: (v: any) => v instanceof Error,
      isPromise: (v: any) => v instanceof Promise,
      isProxy: (_v: any) => false,
      isAnyArrayBuffer: (v: any) => v instanceof ArrayBuffer || v instanceof SharedArrayBuffer,
      isArrayBuffer: (v: any) => v instanceof ArrayBuffer,
      isSharedArrayBuffer: (v: any) => typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer,
      isDataView: (v: any) => v instanceof DataView,
      isMap: (v: any) => v instanceof Map,
      isSet: (v: any) => v instanceof Set,
      isWeakMap: (v: any) => v instanceof WeakMap,
      isWeakSet: (v: any) => v instanceof WeakSet,
      isUint8Array: (v: any) => v instanceof Uint8Array,
      isUint16Array: (v: any) => v instanceof Uint16Array,
      isUint32Array: (v: any) => v instanceof Uint32Array,
      isInt8Array: (v: any) => v instanceof Int8Array,
      isInt16Array: (v: any) => v instanceof Int16Array,
      isInt32Array: (v: any) => v instanceof Int32Array,
      isFloat32Array: (v: any) => v instanceof Float32Array,
      isFloat64Array: (v: any) => v instanceof Float64Array,
      isBigInt64Array: (v: any) => typeof BigInt64Array !== 'undefined' && v instanceof BigInt64Array,
      isBigUint64Array: (v: any) => typeof BigUint64Array !== 'undefined' && v instanceof BigUint64Array,
      isGeneratorFunction: (v: any) => v?.constructor?.name === 'GeneratorFunction',
      isAsyncFunction: (v: any) => v?.constructor?.name === 'AsyncFunction',
      isStringObject: (v: any) => typeof v === 'object' && v instanceof String,
      isNumberObject: (v: any) => typeof v === 'object' && v instanceof Number,
      isBooleanObject: (v: any) => typeof v === 'object' && v instanceof Boolean,
      isSymbolObject: (v: any) => typeof v === 'object' && Object.prototype.toString.call(v) === '[object Symbol]',
    },
    deprecate: (fn: Function, _msg: string) => fn, // Return function unchanged, skip warning
    inherits: (ctor: any, superCtor: any) => {
      if (superCtor && superCtor.prototype) {
        ctor.super_ = superCtor;
        ctor.prototype = Object.create(superCtor.prototype, {
          constructor: { value: ctor, writable: true, configurable: true }
        });
      }
    },
    isArray: Array.isArray,
    isBuffer: (obj: any) => obj instanceof Uint8Array,
    isString: (obj: any) => typeof obj === 'string',
    isNumber: (obj: any) => typeof obj === 'number',
    isBoolean: (obj: any) => typeof obj === 'boolean',
    isObject: (obj: any) => obj !== null && typeof obj === 'object',
    isFunction: (obj: any) => typeof obj === 'function',
    isNull: (obj: any) => obj === null,
    isUndefined: (obj: any) => obj === undefined,
    isNullOrUndefined: (obj: any) => obj == null,
    isPrimitive: (obj: any) => obj === null || (typeof obj !== 'object' && typeof obj !== 'function'),
    isDeepStrictEqual: (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b),
    debuglog: (_section: string) => Object.assign((..._args: any[]) => {}, { enabled: false }),
    debug: (_section: string) => Object.assign((..._args: any[]) => {}, { enabled: false }),
    getSystemErrorName: (err: number) => `ERRNO_${err}`,
    toUSVString: (s: string) => s,
    stripVTControlCharacters: (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07/g, ''),
    styleText: (_style: string, text: string) => text,
    TextEncoder,
    TextDecoder,
  };
}
