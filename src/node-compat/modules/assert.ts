/**
 * node:assert and node:assert/strict: AssertionError with Node's fields
 * (code ERR_ASSERTION, actual, expected, operator, generatedMessage), real
 * deep equality (prototypes, Map/Set, Date/RegExp, typed arrays, cycles,
 * NaN, -0), throws/rejects with every kind of expectation, match and
 * doesNotMatch, ifError and the strict variant. (It was a few stubs:
 * deepStrictEqual compared JSON, throws accepted anything, and match,
 * rejects and doesNotReject didn't exist.)
 */

type Inspect = (v: any) => string;

export function createAssertModule(inspect: Inspect = (v) => String(v)): any {
  const show = (v: any): string => {
    if (typeof v === 'string') return `'${v}'`;
    try { return inspect(v); } catch { return String(v); }
  };

  class AssertionError extends Error {
    code = 'ERR_ASSERTION';
    actual: any;
    expected: any;
    operator: string;
    generatedMessage: boolean;
    constructor(options: { message?: string | Error; actual?: any; expected?: any; operator?: string } = {}) {
      const generated = options.message === undefined;
      super(generated ? defaultMessage(options) : String(options.message));
      this.name = 'AssertionError';
      this.actual = options.actual;
      this.expected = options.expected;
      this.operator = options.operator ?? 'fail';
      this.generatedMessage = generated;
    }
  }

  const defaultMessage = (o: { actual?: any; expected?: any; operator?: string }): string => {
    switch (o.operator) {
      case 'strictEqual': return `Expected values to be strictly equal:\n\n${show(o.actual)} !== ${show(o.expected)}\n`;
      case 'deepStrictEqual': return `Expected values to be strictly deep-equal:\n${show(o.actual)}\n\nshould equal\n\n${show(o.expected)}`;
      case 'notStrictEqual': return `Expected "actual" to be strictly unequal to: ${show(o.expected)}`;
      case 'notDeepStrictEqual': return `Expected "actual" not to be strictly deep-equal to: ${show(o.expected)}`;
      case '==': return `${show(o.actual)} == ${show(o.expected)}`;
      case '!=': return `${show(o.actual)} != ${show(o.expected)}`;
      case 'deepEqual': return `Expected values to be loosely deep-equal:\n\n${show(o.actual)}\n\nshould loosely deep-equal\n\n${show(o.expected)}`;
      case 'notDeepEqual': return `Expected "actual" not to be loosely deep-equal to:\n\n${show(o.expected)}`;
      case 'match': return `The input did not match the regular expression ${String(o.expected)}. Input:\n\n${show(o.actual)}\n`;
      case 'doesNotMatch': return `The input was expected to not match the regular expression ${String(o.expected)}. Input:\n\n${show(o.actual)}\n`;
      default: return 'Failed';
    }
  };

  /** A message argument: an Error is thrown as is, a string replaces the generated one. */
  const raise = (message: any, fields: { actual?: any; expected?: any; operator: string }): never => {
    if (message instanceof Error) throw message;
    throw new AssertionError({ ...fields, message });
  };

  // ── Deep equality ──
  const isDeepEqual = (a: any, b: any, strict: boolean, memo?: Map<any, Set<any>>): boolean => {
    if (strict ? Object.is(a, b) : (a == b || (a !== a && b !== b))) return true; // eslint-disable-line eqeqeq
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
      if (!strict && (typeof a !== 'object' || a === null) && (typeof b !== 'object' || b === null)) return a == b; // eslint-disable-line eqeqeq
      return false;
    }
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    const tagA = Object.prototype.toString.call(a);
    if (tagA !== Object.prototype.toString.call(b)) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    // Cycles: a pair already being compared counts as equal
    memo ??= new Map();
    let seen = memo.get(a);
    if (seen?.has(b)) return true;
    if (!seen) memo.set(a, seen = new Set());
    seen.add(b);

    if (a instanceof Date) { if (a.getTime() !== b.getTime()) return false; }
    else if (a instanceof RegExp) { if (a.source !== b.source || a.flags !== b.flags || a.lastIndex !== b.lastIndex) return false; }
    else if (a instanceof Error) { if (a.message !== b.message || a.name !== b.name) return false; }
    else if (ArrayBuffer.isView(a)) {
      const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const y = new Uint8Array((b as ArrayBufferView).buffer, (b as ArrayBufferView).byteOffset, (b as ArrayBufferView).byteLength);
      if (x.length !== y.length) return false;
      if (!(a instanceof Uint8Array || a instanceof Int8Array || a instanceof Uint8ClampedArray) && !(a instanceof DataView)) {
        // Float arrays compare by value (NaN, -0) only loosely; strictly by bytes like Node
        if (!strict) { const ea = a as any, eb = b as any; for (let i = 0; i < ea.length; i++) if (ea[i] != eb[i]) return false; return true; } // eslint-disable-line eqeqeq
      }
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    } else if (a instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && a instanceof SharedArrayBuffer)) {
      const x = new Uint8Array(a), y = new Uint8Array(b);
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      return true;
    } else if (['[object Number]', '[object String]', '[object Boolean]', '[object BigInt]', '[object Symbol]'].includes(tagA)) {
      if (!Object.is(a.valueOf(), b.valueOf())) return false;
    }

    if (a instanceof Map) {
      if (a.size !== b.size) return false;
      outer: for (const [k, v] of a) {
        if (b.has(k)) { if (!isDeepEqual(v, b.get(k), strict, memo)) return false; continue; }
        if (typeof k !== 'object' || k === null) {
          if (strict) return false;
          for (const [k2, v2] of b) if (k2 == k && isDeepEqual(v, v2, strict, memo)) continue outer; // eslint-disable-line eqeqeq
          return false;
        }
        for (const [k2, v2] of b) if (isDeepEqual(k, k2, strict, memo) && isDeepEqual(v, v2, strict, memo)) continue outer;
        return false;
      }
    } else if (a instanceof Set) {
      if (a.size !== b.size) return false;
      outer: for (const v of a) {
        if (b.has(v)) continue;
        if (typeof v !== 'object' || v === null) {
          if (strict) return false;
          for (const w of b) if (w == v) continue outer; // eslint-disable-line eqeqeq
          return false;
        }
        for (const w of b) if (isDeepEqual(v, w, strict, memo)) continue outer;
        return false;
      }
    }

    // Own enumerable properties (and enumerable symbols when strict)
    const keys = (o: any) => {
      const ks: (string | symbol)[] = Object.keys(o);
      if (strict) for (const s of Object.getOwnPropertySymbols(o)) if (Object.prototype.propertyIsEnumerable.call(o, s)) ks.push(s);
      return ks;
    };
    let ka = keys(a), kb = keys(b);
    if (ArrayBuffer.isView(a)) { ka = ka.filter((k) => typeof k !== 'string' || !/^\d+$/.test(k)); kb = kb.filter((k) => typeof k !== 'string' || !/^\d+$/.test(k)); }
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k) && !(typeof k === 'symbol' && k in b)) return false;
      if (!isDeepEqual(a[k], b[k], strict, memo)) return false;
    }
    return true;
  };

  // ── throws / rejects ──
  const ARG = (name: string, msg: string) => Object.assign(new TypeError(msg), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError', argName: name });

  /** Whether `err` meets `expected` (a class, RegExp, validation function or object), else throws. */
  const checkError = (err: any, expected: any, message: any, operator: string): void => {
    if (expected === undefined) return;
    if (typeof expected === 'string') return; // the message (no expectation)
    if (expected instanceof RegExp) {
      if (expected.test(String(err))) return;
      raise(message, { actual: err, expected, operator });
    }
    if (typeof expected === 'function') {
      if (expected.prototype !== undefined && err instanceof expected) return;
      if (Error.isPrototypeOf(expected) || expected === Error) {
        raise(message ?? `The error is expected to be an instance of "${expected.name}". Received "${err?.constructor?.name ?? typeof err}"\n\nError message:\n\n${err?.message ?? show(err)}`, { actual: err, expected, operator });
      }
      const r = expected.call({}, err);
      if (r === true) return;
      raise(message ?? `The ${expected.name ? `"${expected.name}" ` : ''}validation function is expected to return "true". Received ${show(r)}`, { actual: err, expected, operator });
    }
    if (typeof expected === 'object' && expected !== null) {
      const keys = Object.keys(expected);
      if (expected instanceof Error) keys.push('name', 'message');
      for (const k of keys) {
        const want = expected[k];
        const got = err?.[k];
        if (want instanceof RegExp && typeof got === 'string') { if (want.test(got)) continue; }
        else if (isDeepEqual(got, want, true)) continue;
        raise(message ?? `Expected values to be strictly deep-equal:\n+ actual - expected\n\n  ${k}: ${show(got)} !== ${show(want)}`, { actual: err, expected, operator });
      }
      return;
    }
    throw ARG('expected', `The "expected" argument must be of type function or an instance of Error, RegExp, or Object. Received ${show(expected)}`);
  };

  const NO_EXCEPTION = Symbol('no exception');
  const splitArgs = (expected: any, message: any): [any, any] => (typeof expected === 'string' && message === undefined ? [undefined, expected] : [expected, message]);

  const throwsImpl = (fn: any, expectedArg: any, messageArg: any) => {
    if (typeof fn !== 'function') throw ARG('fn', `The "fn" argument must be of type function. Received ${show(fn)}`);
    const [expected, message] = splitArgs(expectedArg, messageArg);
    let err: any = NO_EXCEPTION;
    try { fn(); } catch (e) { err = e; }
    if (err === NO_EXCEPTION) {
      raise(message ?? `Missing expected exception${expected?.name ? ` (${expected.name})` : ''}${typeof messageArg === 'string' && expectedArg !== undefined && typeof expectedArg !== 'string' ? `: ${messageArg}` : ''}.`, { actual: undefined, expected, operator: 'throws' });
    }
    checkError(err, expected, message, 'throws');
  };

  const doesNotThrowImpl = (fn: any, expectedArg: any, messageArg: any) => {
    const [expected, message] = splitArgs(expectedArg, messageArg);
    try { fn(); } catch (e: any) {
      if (expected === undefined || (typeof expected === 'function' && e instanceof expected) || (expected instanceof RegExp && expected.test(String(e)))) {
        raise(`Got unwanted exception${message ? `: ${message}` : '.'}\nActual message: "${e?.message}"`, { actual: e, expected, operator: 'doesNotThrow' });
      }
      throw e;
    }
  };

  /** The promise to wait on (not awaited here: the caller decides what a rejection means) */
  const settle = (promiseFn: any): Promise<any> => {
    const p = typeof promiseFn === 'function' ? promiseFn() : promiseFn;
    if (!p || typeof p.then !== 'function') {
      throw Object.assign(new TypeError(`The "promiseFn" argument must be of type function or an instance of Promise. Received ${show(p)}`), { code: typeof promiseFn === 'function' ? 'ERR_INVALID_RETURN_VALUE' : 'ERR_INVALID_ARG_TYPE' });
    }
    return p;
  };

  const rejectsImpl = async (promiseFn: any, expectedArg: any, messageArg: any) => {
    const [expected, message] = splitArgs(expectedArg, messageArg);
    let err: any = NO_EXCEPTION;
    try { await settle(promiseFn); } catch (e: any) {
      if (e?.code === 'ERR_INVALID_RETURN_VALUE' || (e?.code === 'ERR_INVALID_ARG_TYPE' && e?.message?.includes('promiseFn'))) throw e;
      err = e;
    }
    if (err === NO_EXCEPTION) raise(message ?? `Missing expected rejection${expected?.name ? ` (${expected.name})` : ''}.`, { actual: undefined, expected, operator: 'rejects' });
    checkError(err, expected, message, 'rejects');
  };

  const doesNotRejectImpl = async (promiseFn: any, expectedArg: any, messageArg: any) => {
    const [expected, message] = splitArgs(expectedArg, messageArg);
    const p = settle(promiseFn);
    try { await p; } catch (e: any) {
      if (expected === undefined || (typeof expected === 'function' && e instanceof expected) || (expected instanceof RegExp && expected.test(String(e)))) {
        raise(`Got unwanted rejection${message ? `: ${message}` : '.'}\nActual message: "${e?.message}"`, { actual: e, expected, operator: 'doesNotReject' });
      }
      throw e;
    }
  };

  const matchImpl = (string: any, regexp: any, message: any, negate: boolean) => {
    if (!(regexp instanceof RegExp)) throw ARG('regexp', `The "regexp" argument must be an instance of RegExp. Received ${show(regexp)}`);
    if (typeof string !== 'string') {
      raise(message ?? `The "string" argument must be of type string. Received type ${typeof string} (${show(string)})`, { actual: string, expected: regexp, operator: negate ? 'doesNotMatch' : 'match' });
    }
    if (regexp.test(string) === negate) raise(message, { actual: string, expected: regexp, operator: negate ? 'doesNotMatch' : 'match' });
  };

  const build = (strictMode: boolean): any => {
    const ok = (...args: any[]) => {
      if (args.length === 0) raise('No value argument passed to `assert.ok()`', { actual: undefined, expected: true, operator: '==' });
      if (!args[0]) raise(args[1] ?? `The expression evaluated to a falsy value:\n\n  assert.ok(${show(args[0])})\n`, { actual: args[0], expected: true, operator: '==' });
    };
    const a: any = (...args: any[]) => ok(...args);
    a.ok = ok;
    a.AssertionError = AssertionError;
    a.fail = (...args: any[]) => {
      const [actual, expected, message, operator] = args;
      if (args.length >= 2) {
        raise(message ?? `${show(actual)} ${operator ?? '!='} ${show(expected)}`, { actual, expected, operator: operator ?? 'fail' });
      }
      raise(actual ?? 'Failed', { operator: 'fail' });
    };
    a.strictEqual = (actual: any, expected: any, message?: any) => { if (!Object.is(actual, expected)) raise(message, { actual, expected, operator: 'strictEqual' }); };
    a.notStrictEqual = (actual: any, expected: any, message?: any) => { if (Object.is(actual, expected)) raise(message, { actual, expected, operator: 'notStrictEqual' }); };
    a.deepStrictEqual = (actual: any, expected: any, message?: any) => { if (!isDeepEqual(actual, expected, true)) raise(message, { actual, expected, operator: 'deepStrictEqual' }); };
    a.notDeepStrictEqual = (actual: any, expected: any, message?: any) => { if (isDeepEqual(actual, expected, true)) raise(message, { actual, expected, operator: 'notDeepStrictEqual' }); };
    a.equal = strictMode ? a.strictEqual : (actual: any, expected: any, message?: any) => {
      if (!(actual == expected || (actual !== actual && expected !== expected))) raise(message, { actual, expected, operator: '==' }); // eslint-disable-line eqeqeq
    };
    a.notEqual = strictMode ? a.notStrictEqual : (actual: any, expected: any, message?: any) => {
      if (actual == expected || (actual !== actual && expected !== expected)) raise(message, { actual, expected, operator: '!=' }); // eslint-disable-line eqeqeq
    };
    a.deepEqual = strictMode ? a.deepStrictEqual : (actual: any, expected: any, message?: any) => { if (!isDeepEqual(actual, expected, false)) raise(message, { actual, expected, operator: 'deepEqual' }); };
    a.notDeepEqual = strictMode ? a.notDeepStrictEqual : (actual: any, expected: any, message?: any) => { if (isDeepEqual(actual, expected, false)) raise(message, { actual, expected, operator: 'notDeepEqual' }); };
    a.throws = (fn: any, expected?: any, message?: any) => throwsImpl(fn, expected, message);
    a.doesNotThrow = (fn: any, expected?: any, message?: any) => doesNotThrowImpl(fn, expected, message);
    a.rejects = (fn: any, expected?: any, message?: any) => rejectsImpl(fn, expected, message);
    a.doesNotReject = (fn: any, expected?: any, message?: any) => doesNotRejectImpl(fn, expected, message);
    a.match = (string: any, regexp: any, message?: any) => matchImpl(string, regexp, message, false);
    a.doesNotMatch = (string: any, regexp: any, message?: any) => matchImpl(string, regexp, message, true);
    a.ifError = (value: any) => {
      if (value === null || value === undefined) return;
      raise(`ifError got unwanted exception: ${typeof value === 'object' && typeof value.message === 'string' ? value.message : show(value)}`, { actual: value, expected: null, operator: 'ifError' });
    };
    return a;
  };

  const assert = build(false);
  const strict = build(true);
  assert.strict = strict;
  strict.strict = strict;
  // (not enumerable: node's assert has no `default`)
  Object.defineProperty(assert, 'default', { value: assert, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(strict, 'default', { value: strict, writable: true, configurable: true, enumerable: false });
  return { assert, strict, isDeepStrictEqual: (a: any, b: any) => isDeepEqual(a, b, true) };
}
