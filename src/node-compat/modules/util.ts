import { createAssertModule } from './assert';
import { inspect, inspectCustom, styles, colors, formatWithOptions } from '../inspect';

let deepStrict: ((a: any, b: any) => boolean) | undefined;

export function createUtilModule(): any {
  const _inspect: any = (obj: any, opts?: any, depth?: number, colors?: boolean): string => inspect(obj, opts, depth, colors);
  _inspect.custom = inspectCustom;
  _inspect.styles = styles;
  _inspect.colors = colors;
  _inspect.defaultOptions = { depth: 2, colors: false, compact: 3, breakLength: 80, maxArrayLength: 100, maxStringLength: 10000 };
  const _format = (...args: any[]): string => formatWithOptions({}, args);
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
    formatWithOptions: (opts: any, ...args: any[]) => formatWithOptions(opts ?? {}, args),
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
      isBigIntObject: (v: any) => typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object BigInt]',
      isSymbolObject: (v: any) => typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object Symbol]',
      isBoxedPrimitive: (v: any) => typeof v === 'object' && v !== null && (v instanceof String || v instanceof Number || v instanceof Boolean
        || ['[object BigInt]', '[object Symbol]'].includes(Object.prototype.toString.call(v))),
      isArrayBufferView: (v: any) => ArrayBuffer.isView(v),
      isArgumentsObject: (v: any) => Object.prototype.toString.call(v) === '[object Arguments]',
      isGeneratorObject: (v: any) => Object.prototype.toString.call(v) === '[object Generator]',
      isMapIterator: (v: any) => Object.prototype.toString.call(v) === '[object Map Iterator]',
      isSetIterator: (v: any) => Object.prototype.toString.call(v) === '[object Set Iterator]',
      isModuleNamespaceObject: (v: any) => Object.prototype.toString.call(v) === '[object Module]',
      isWeakRef: (v: any) => typeof WeakRef !== 'undefined' && v instanceof WeakRef,
      isExternal: (_v: any) => false,
      isKeyObject: (_v: any) => false,
      isUint8ClampedArray: (v: any) => v instanceof Uint8ClampedArray,
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
    isDeepStrictEqual: (a: any, b: any) => (deepStrict ??= createAssertModule().isDeepStrictEqual)(a, b),
    debuglog: (_section: string) => Object.assign((..._args: any[]) => {}, { enabled: false }),
    debug: (_section: string) => Object.assign((..._args: any[]) => {}, { enabled: false }),
    getSystemErrorName: (err: number) => `ERRNO_${err}`,
    toUSVString: (s: string) => s,
    stripVTControlCharacters: (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07/g, ''),
    styleText: (_style: string, text: string) => text,
    TextEncoder,
    TextDecoder,
    parseArgs: (config: any = {}) => {
      const { args = [], options = {}, strict = true, allowPositionals = false, allowNegative = false } = config;
      const values: Record<string, any> = {};
      const positionals: string[] = [];
      const tokens: any[] = [];

      // Initialize defaults
      for (const [key, opt] of Object.entries(options) as [string, any][]) {
        if (opt.default !== undefined) values[key] = opt.default;
        else if (opt.type === 'boolean') values[key] = false;
        else if (opt.multiple) values[key] = [];
      }

      // Build short-to-long alias map
      const shortToLong: Record<string, string> = {};
      for (const [key, opt] of Object.entries(options) as [string, any][]) {
        if (opt.short) shortToLong[opt.short] = key;
      }

      function setOption(name: string, value: any) {
        const opt = (options as Record<string, any>)[name];
        if (opt?.multiple) {
          if (!Array.isArray(values[name])) values[name] = [];
          values[name].push(value);
        } else {
          values[name] = value;
        }
      }

      function findOption(name: string): { key: string; opt: any } | null {
        if ((options as Record<string, any>)[name]) return { key: name, opt: (options as Record<string, any>)[name] };
        if (shortToLong[name]) return { key: shortToLong[name], opt: (options as Record<string, any>)[shortToLong[name]] };
        return null;
      }

      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
          positionals.push(...args.slice(i + 1));
          break;
        }
        if (arg.startsWith('--')) {
          // Handle --no-X boolean negation
          const eqIdx = arg.indexOf('=');
          let name: string, val: string | undefined;
          if (eqIdx !== -1) {
            name = arg.slice(2, eqIdx);
            val = arg.slice(eqIdx + 1);
          } else {
            name = arg.slice(2);
          }

          // Check --no-X negation
          let negated = false;
          let found = findOption(name);
          if (!found && name.startsWith('no-') && allowNegative) {
            const posName = name.slice(3);
            found = findOption(posName);
            if (found && found.opt.type === 'boolean') {
              negated = true;
              name = posName;
            } else {
              found = null;
            }
          }

          if (!found) {
            if (strict) {
              const err = new TypeError(`Unknown option '${arg}'`);
              (err as any).code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
              throw err;
            }
            // Non-strict: skip unknown
            continue;
          }

          if (found.opt.type === 'boolean') {
            setOption(found.key, !negated);
          } else {
            // String type
            if (val !== undefined) {
              setOption(found.key, val);
            } else if (i + 1 < args.length) {
              setOption(found.key, args[++i]);
            }
          }
        } else if (arg.startsWith('-') && arg.length === 2) {
          const ch = arg[1];
          const found = findOption(ch);
          if (!found) {
            if (strict) {
              const err = new TypeError(`Unknown option '${arg}'`);
              (err as any).code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
              throw err;
            }
            continue;
          }
          if (found.opt.type === 'boolean') {
            setOption(found.key, true);
          } else {
            if (i + 1 < args.length) {
              setOption(found.key, args[++i]);
            }
          }
        } else {
          if (strict && !allowPositionals) {
            const err = new TypeError(`Unexpected argument '${arg}'`);
            (err as any).code = 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL';
            throw err;
          }
          positionals.push(arg);
        }
      }
      return { values, positionals, tokens };
    },
  };
}
