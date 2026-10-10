/**
 * util.inspect as node prints values: `{ a: 1, b: 'x' }`, `[ 1, 2, 3 ]`,
 * `Map(1) { 'k' => 1 }`, `<Buffer 68 69>`, `[Function: f]`, `[class A]`,
 * `<ref *1> { self: [Circular *1] }`, `[ <2 empty items>, 3 ]`, colors when
 * asked. The layout follows node's lib/internal/util/inspect.js: an object
 * goes on one line when it fits the break length (80) and has fewer than
 * `compact` (3) levels under it; arrays of more than six short entries are
 * grouped into columns; strings take single quotes unless they contain one.
 * console.log, util.format, util.inspect and `node -p` all print with it.
 */

export interface InspectOptions {
  depth?: number | null;
  colors?: boolean;
  compact?: number | boolean;
  breakLength?: number;
  maxArrayLength?: number | null;
  maxStringLength?: number | null;
  sorted?: boolean | ((a: string, b: string) => number);
  showHidden?: boolean;
  customInspect?: boolean;
  getters?: boolean;
}

export const inspectCustom = Symbol.for('nodejs.util.inspect.custom');

/** node's util.inspect.styles and their ANSI colors */
export const styles: Record<string, string> = {
  special: 'cyan', number: 'yellow', bigint: 'yellow', boolean: 'yellow', undefined: 'grey', null: 'bold',
  string: 'green', symbol: 'green', date: 'magenta', regexp: 'red', module: 'underline',
};
export const colors: Record<string, [number, number]> = {
  bold: [1, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27], white: [37, 39], grey: [90, 39], gray: [90, 39],
  black: [30, 39], blue: [34, 39], cyan: [36, 39], green: [32, 39], magenta: [35, 39], red: [31, 39], yellow: [33, 39],
};

interface Ctx {
  depth: number;
  colors: boolean;
  compact: number | boolean;
  breakLength: number;
  maxArrayLength: number;
  maxStringLength: number;
  sorted?: boolean | ((a: string, b: string) => number);
  customInspect: boolean;
  showHidden: boolean;
  seen: unknown[];
  circular: Map<unknown, number>;
  indentationLvl: number;
  currentDepth: number;
  stylize(text: string, style: string): string;
}

const strip = (s: string) => s.replace(/\x1b\[\d+m/g, '');
const isIdentifier = (k: string) => /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(k); // node's: $ keys are quoted

function quote(s: string): string {
  let q = "'";
  if (s.includes("'")) {
    if (!s.includes('"')) q = '"';
    else if (!s.includes('`') && !s.includes('${')) q = '`';
  }
  const esc = s.replace(/[\\\x00-\x1f\x7f]/g, (c) => {
    if (c === '\\') return '\\\\';
    if (c === '\n') return '\\n';
    if (c === '\t') return '\\t';
    if (c === '\r') return '\\r';
    if (c === '\b') return '\\b';
    if (c === '\f') return '\\f';
    if (c === '\v') return '\\v';
    return '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase();
  });
  return q + (q === "'" ? esc.replace(/'/g, "\\'") : esc) + q;
}

export function inspect(value: unknown, opts?: InspectOptions | boolean, depthArg?: number, colorsArg?: boolean): string {
  // util.inspect(obj, showHidden, depth, colors), the old signature
  const o: InspectOptions = typeof opts === 'object' && opts !== null ? opts
    : { showHidden: !!opts, ...(depthArg !== undefined ? { depth: depthArg } : {}), ...(colorsArg !== undefined ? { colors: colorsArg } : {}) };
  const ctx: Ctx = {
    depth: o.depth === null ? Infinity : o.depth ?? 2,
    colors: !!o.colors,
    compact: o.compact ?? 3,
    breakLength: o.breakLength ?? 80,
    maxArrayLength: o.maxArrayLength === null ? Infinity : o.maxArrayLength ?? 100,
    maxStringLength: o.maxStringLength === null ? Infinity : o.maxStringLength ?? 10000,
    sorted: o.sorted,
    customInspect: o.customInspect ?? true,
    showHidden: !!o.showHidden,
    seen: [],
    circular: new Map(),
    indentationLvl: 0,
    currentDepth: 0,
    stylize(text, style) {
      if (!this.colors) return text;
      const c = colors[styles[style]];
      return c ? `\x1b[${c[0]}m${text}\x1b[${c[1]}m` : text;
    },
  };
  return formatValue(ctx, value, 0, true);
}

function formatPrimitive(ctx: Ctx, v: unknown): string {
  switch (typeof v) {
    case 'string': {
      let s = v as string;
      let trailer = '';
      if (s.length > ctx.maxStringLength) {
        trailer = `... ${s.length - ctx.maxStringLength} more character${s.length - ctx.maxStringLength > 1 ? 's' : ''}`;
        s = s.slice(0, ctx.maxStringLength);
      }
      return ctx.stylize(quote(s), 'string') + trailer;
    }
    case 'number': return ctx.stylize(Object.is(v, -0) ? '-0' : String(v), 'number');
    case 'bigint': return ctx.stylize(`${v}n`, 'bigint');
    case 'boolean': return ctx.stylize(String(v), 'boolean');
    case 'undefined': return ctx.stylize('undefined', 'undefined');
    case 'symbol': return ctx.stylize((v as symbol).toString(), 'symbol');
  }
  return String(v);
}

function constructorName(v: object): string | null {
  let obj: any = v;
  while (obj) {
    const d = Object.getOwnPropertyDescriptor(obj, 'constructor');
    if (d && typeof d.value === 'function' && d.value.name !== '') return d.value.name === 'FakeBuffer' ? 'Buffer' : d.value.name;
    obj = Object.getPrototypeOf(obj);
  }
  return null;
}

function functionBase(fn: Function, ctor: string | null): string {
  const src = (() => { try { return Function.prototype.toString.call(fn); } catch { return ''; } })();
  if (src.startsWith('class') && /^class\s*[\w$]*\s*(extends|\{)/.test(src)) {
    let s = `[class ${fn.name || '(anonymous)'}`;
    const sup = Object.getPrototypeOf(fn);
    if (sup && sup.name) s += ` extends ${sup.name}`;
    return s + ']';
  }
  let type = 'Function';
  if (ctor === 'AsyncFunction') type = 'AsyncFunction';
  else if (ctor === 'GeneratorFunction') type = 'GeneratorFunction';
  else if (ctor === 'AsyncGeneratorFunction') type = 'AsyncGeneratorFunction';
  return `[${type}${fn.name ? `: ${fn.name}` : ' (anonymous)'}]`;
}

function formatError(err: Error, ctx: Ctx): string {
  const name = err.name || 'Error';
  let stack = typeof err.stack === 'string' && err.stack ? err.stack : '';
  if (!stack || !stack.includes(err.message ?? '')) stack = `[${name}${err.message ? `: ${err.message}` : ''}]`;
  // node's stacks start with "Name: message"; the browser's (Firefox, Safari) don't
  else if (!/^\w*(Error|Exception)?\b/.test(stack) || !stack.startsWith(name)) {
    const head = `${name}${err.message ? `: ${err.message}` : ''}`;
    if (!stack.startsWith(head)) stack = `${head}\n${stack.split('\n').filter((l) => l.trim()).map((l) => /^\s*at /.test(l) ? l : `    at ${l.trim()}`).join('\n')}`;
  }
  if (ctx.indentationLvl) stack = stack.replace(/\n/g, `\n${' '.repeat(ctx.indentationLvl)}`);
  return stack;
}

function formatValue(ctx: Ctx, value: unknown, recurseTimes: number, typedArray?: boolean): string {
  if (typeof value !== 'object' && typeof value !== 'function') return formatPrimitive(ctx, value);
  if (value === null) return ctx.stylize('null', 'null');
  const v = value as any;
  if (ctx.customInspect) {
    let custom: unknown;
    try { custom = v[inspectCustom]; } catch { custom = undefined; }
    if (typeof custom === 'function' && custom !== inspect) {
      const depth = ctx.depth - recurseTimes;
      const ret = (custom as Function).call(v, depth, { ...ctx, stylize: ctx.stylize.bind(ctx), depth }, inspect);
      if (ret !== v) return typeof ret === 'string' ? ret.replace(/\n/g, `\n${' '.repeat(ctx.indentationLvl)}`) : formatValue(ctx, ret, recurseTimes);
    }
  }
  if (ctx.seen.includes(v)) {
    let index = ctx.circular.get(v);
    if (index === undefined) { index = ctx.circular.size + 1; ctx.circular.set(v, index); }
    return ctx.stylize(`[Circular *${index}]`, 'special');
  }
  void typedArray;
  return formatRaw(ctx, v, recurseTimes);
}

function formatRaw(ctx: Ctx, value: any, recurseTimes: number): string {
  const ctor = constructorName(value);
  let keys: (string | symbol)[] = [];
  const ownKeys = () => {
    const ks: (string | symbol)[] = Object.keys(value);
    for (const s of Object.getOwnPropertySymbols(value)) if (Object.getOwnPropertyDescriptor(value, s)?.enumerable) ks.push(s);
    return ks;
  };
  let base = '';
  let braces: [string, string] = ['{', '}'];
  let formatter: (() => string[]) | null = null;
  let isArrayLike = false;
  const prefix = (fallback: string, size?: string) => {
    const name = ctor ?? `[${fallback}: null prototype]`;
    return `${name}${size ?? ''} `;
  };

  if (Array.isArray(value)) {
    keys = Object.keys(value).filter((k) => !/^\d+$/.test(k));
    const p = ctor === 'Array' ? '' : prefix('Array', `(${value.length})`);
    braces = [`${p}[`, ']'];
    isArrayLike = true;
    formatter = () => formatArray(ctx, value, recurseTimes);
  } else if (typeof value === 'function') {
    base = functionBase(value, ctor);
    keys = ownKeys().filter((k) => k !== 'prototype');
    if (!keys.length) return ctx.stylize(base, 'special');
    base = ctx.stylize(base, 'special');
  } else if (value instanceof Map) {
    keys = ownKeys();
    braces = [`${prefix('Map', `(${value.size})`)}{`, '}'];
    formatter = () => formatMap(ctx, value, recurseTimes);
  } else if (value instanceof Set) {
    keys = ownKeys();
    braces = [`${prefix('Set', `(${value.size})`)}{`, '}'];
    formatter = () => formatSet(ctx, value, recurseTimes);
  } else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const arr = value as unknown as ArrayLike<number | bigint>;
    if (ctor === 'Buffer') {
      // <Buffer 68 69 ...>
      const n = Math.min(50, arr.length);
      let s = Array.from({ length: n }, (_, i) => (arr[i] as number).toString(16).padStart(2, '0')).join(' ');
      if (arr.length > 50) s += ` ... ${arr.length - 50} more byte${arr.length - 50 > 1 ? 's' : ''}`;
      return `<Buffer${s ? ' ' + s : ''}>`;
    }
    keys = Object.keys(value).filter((k) => !/^\d+$/.test(k));
    braces = [`${prefix('TypedArray', `(${arr.length})`)}[`, ']'];
    isArrayLike = true;
    formatter = () => {
      const out: string[] = [];
      const max = Math.min(arr.length, ctx.maxArrayLength);
      for (let i = 0; i < max; i++) out.push(formatPrimitive(ctx, arr[i]));
      if (arr.length > max) out.push(`... ${arr.length - max} more item${arr.length - max > 1 ? 's' : ''}`);
      return out;
    };
  } else if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    const n = Math.min(50, bytes.length);
    let hex = Array.from(bytes.subarray(0, n), (b) => b.toString(16).padStart(2, '0')).join(' ');
    if (bytes.length > 50) hex += ` ... ${bytes.length - 50} more byte${bytes.length - 50 > 1 ? 's' : ''}`;
    return `ArrayBuffer { [Uint8Contents]: <${hex}>, byteLength: ${formatPrimitive(ctx, bytes.length)} }`;
  } else if (value instanceof Date) {
    keys = ownKeys();
    base = ctx.stylize(isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString(), 'date');
    if (!keys.length) return base;
  } else if (value instanceof RegExp) {
    keys = ownKeys().filter((k) => k !== 'lastIndex');
    base = ctx.stylize(String(value), 'regexp');
    if (!keys.length) return base;
  } else if (value instanceof Error) {
    keys = ownKeys().filter((k) => k !== 'stack' && k !== 'message');
    base = formatError(value, ctx);
    if (!keys.length) return base;
  } else if (typeof Promise !== 'undefined' && value instanceof Promise) {
    braces = [`${prefix('Promise')}{`, '}'];
    keys = ownKeys();
    formatter = () => [ctx.stylize('<pending>', 'special')];
  } else if (value instanceof WeakMap || value instanceof WeakSet) {
    return `${prefix(value instanceof WeakMap ? 'WeakMap' : 'WeakSet')}{ ${ctx.stylize('<items unknown>', 'special')} }`;
  } else if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    const t = value instanceof Number ? 'Number' : value instanceof String ? 'String' : 'Boolean';
    base = `[${t}: ${formatPrimitive(ctx, value.valueOf())}]`;
    keys = ownKeys().filter((k) => !(value instanceof String && /^\d+$/.test(String(k))));
    if (!keys.length) return base;
  } else {
    keys = ownKeys();
    const tag = (value as any)[Symbol.toStringTag];
    let p = ctor === 'Object' ? '' : ctor === null ? '[Object: null prototype] ' : `${ctor} `;
    if (typeof tag === 'string' && tag !== '' && tag !== ctor) p = `${p || 'Object '}[${tag}] `;
    if (ctor === 'Object' && typeof tag === 'string' && tag) p = `Object [${tag}] `;
    braces = [`${p}{`, '}'];
    if (!keys.length) return `${braces[0]}}`;
  }

  if (recurseTimes > ctx.depth) {
    const name = (ctor ?? 'Object').replace(/^\[|\]$/g, '');
    return ctx.stylize(Array.isArray(value) ? '[Array]' : `[${name}]`, 'special');
  }

  ctx.seen.push(value);
  ctx.currentDepth = recurseTimes;
  let output: string[];
  try {
    output = formatter ? formatter() : [];
    if (ctx.sorted) {
      const cmp = typeof ctx.sorted === 'function' ? ctx.sorted : undefined;
      keys = [...keys].sort((a, b) => (cmp ? cmp(String(a), String(b)) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    }
    for (const k of keys) output.push(formatProperty(ctx, value, recurseTimes, k, isArrayLike));
    if (ctx.showHidden && Array.isArray(value)) output.push(`[length]: ${formatPrimitive(ctx, value.length)}`);
  } finally {
    ctx.seen.pop();
  }
  const ref = ctx.circular.get(value);
  if (ref !== undefined) {
    const r = ctx.stylize(`<ref *${ref}>`, 'special');
    if (base) base = `${r} ${base}`; else braces[0] = `${r} ${braces[0]}`;
  }
  if (base && !output.length) return base;
  if (!output.length) return `${braces[0]}${braces[1]}`;
  return reduceToSingleString(ctx, output, base, braces, isArrayLike, recurseTimes, value);
}

function formatArray(ctx: Ctx, value: any[], recurseTimes: number): string[] {
  const out: string[] = [];
  const len = value.length;
  const max = Math.min(len, ctx.maxArrayLength);
  let i = 0;
  let shown = 0;
  while (i < len && shown < max) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      let j = i;
      while (j < len && !Object.prototype.hasOwnProperty.call(value, j)) j++;
      const holes = j - i;
      out.push(ctx.stylize(`<${holes} empty item${holes > 1 ? 's' : ''}>`, 'undefined'));
      i = j;
      shown++;
      continue;
    }
    out.push(formatProperty(ctx, value, recurseTimes, i, true));
    i++;
    shown++;
  }
  if (i < len) out.push(`... ${len - i} more item${len - i > 1 ? 's' : ''}`);
  return out;
}

function formatMap(ctx: Ctx, value: Map<unknown, unknown>, recurseTimes: number): string[] {
  const out: string[] = [];
  ctx.indentationLvl += 2;
  let n = 0;
  for (const [k, v] of value) {
    if (n++ >= ctx.maxArrayLength) { out.push(`... ${value.size - ctx.maxArrayLength} more item${value.size - ctx.maxArrayLength > 1 ? 's' : ''}`); break; }
    out.push(`${formatValue(ctx, k, recurseTimes + 1)} => ${formatValue(ctx, v, recurseTimes + 1)}`);
  }
  ctx.indentationLvl -= 2;
  return out;
}

function formatSet(ctx: Ctx, value: Set<unknown>, recurseTimes: number): string[] {
  const out: string[] = [];
  ctx.indentationLvl += 2;
  let n = 0;
  for (const v of value) {
    if (n++ >= ctx.maxArrayLength) { out.push(`... ${value.size - ctx.maxArrayLength} more item${value.size - ctx.maxArrayLength > 1 ? 's' : ''}`); break; }
    out.push(formatValue(ctx, v, recurseTimes + 1));
  }
  ctx.indentationLvl -= 2;
  return out;
}

function formatProperty(ctx: Ctx, value: any, recurseTimes: number, key: string | symbol | number, arrayEntry: boolean): string {
  let str: string;
  const desc = Object.getOwnPropertyDescriptor(value, key) ?? { value: value[key as any], enumerable: true };
  if ('value' in desc) {
    const diff = ctx.compact !== true ? 2 : 3;
    ctx.indentationLvl += diff;
    str = formatValue(ctx, desc.value, recurseTimes + 1);
    ctx.indentationLvl -= diff;
  } else if (desc.get) {
    str = ctx.stylize(desc.set ? '[Getter/Setter]' : '[Getter]', 'special');
  } else if (desc.set) {
    str = ctx.stylize('[Setter]', 'special');
  } else {
    str = ctx.stylize('undefined', 'undefined');
  }
  if (arrayEntry && typeof key === 'number') return str;
  let name: string;
  if (typeof key === 'symbol') name = `[${ctx.stylize(key.toString(), 'symbol')}]`;
  else if (isIdentifier(String(key))) name = String(key);
  else name = ctx.stylize(quote(String(key)), 'string');
  return `${name}: ${str}`;
}

function isBelowBreakLength(ctx: Ctx, output: string[], start: number, base: string): boolean {
  let total = output.length + start;
  if (total + output.length > ctx.breakLength) return false;
  for (const o of output) {
    total += ctx.colors ? strip(o).length : o.length;
    if (total > ctx.breakLength) return false;
  }
  return base === '' || !base.includes('\n');
}

function reduceToSingleString(ctx: Ctx, output: string[], base: string, braces: [string, string], arrayLike: boolean, recurseTimes: number, value: unknown): string {
  if (ctx.compact !== true) {
    if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
      const entries = output.length;
      if (arrayLike && entries > 6) output = groupArrayElements(ctx, output, value as ArrayLike<unknown>);
      if (ctx.currentDepth - recurseTimes < ctx.compact && entries === output.length) {
        const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
        if (isBelowBreakLength(ctx, output, start, base)) {
          const joined = output.join(', ');
          if (!joined.includes('\n')) return `${base ? `${base} ` : ''}${braces[0]} ${joined} ${braces[1]}`;
        }
      }
    }
    const ind = `\n${' '.repeat(ctx.indentationLvl)}`;
    return `${base ? `${base} ` : ''}${braces[0]}${ind}  ${output.join(`,${ind}  `)}${ind}${braces[1]}`;
  }
  if (isBelowBreakLength(ctx, output, 0, base)) return `${braces[0]}${base ? ` ${base}` : ''} ${output.join(', ')} ${braces[1]}`;
  const ind = `\n${' '.repeat(ctx.indentationLvl)}`;
  return `${base ? `${base} ` : ''}${braces[0]}${ind}  ${output.join(`,${ind}  `)}${ind}${braces[1]}`;
}

/** node's column layout for long arrays of short entries */
function groupArrayElements(ctx: Ctx, output: string[], value: ArrayLike<unknown> | undefined): string[] {
  let totalLength = 0;
  let maxLength = 0;
  let outputLength = output.length;
  if (output.length && /^\.\.\. \d+ more item/.test(output[output.length - 1])) outputLength--;
  const separatorSpace = 2;
  const dataLen: number[] = new Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const len = ctx.colors ? strip(output[i]).length : output[i].length;
    dataLen[i] = len;
    totalLength += len + separatorSpace;
    if (maxLength < len) maxLength = len;
  }
  const actualMax = maxLength + separatorSpace;
  if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength && (totalLength / actualMax > 5 || maxLength <= 6)) {
    const averageBias = Math.sqrt(actualMax - totalLength / output.length);
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    const columns = Math.min(
      Math.round(Math.sqrt(2.5 * biasedMax * outputLength) / biasedMax),
      Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
      (ctx.compact as number) * 4,
      15,
    );
    if (columns <= 1) return output;
    const tmp: string[] = [];
    const maxLineLength: number[] = [];
    for (let i = 0; i < columns; i++) {
      let lineLength = 0;
      for (let j = i; j < output.length; j += columns) if (dataLen[j] > lineLength) lineLength = dataLen[j];
      maxLineLength.push(lineLength + separatorSpace);
    }
    let padStart = true;
    if (value !== undefined) {
      for (let i = 0; i < output.length; i++) {
        if (typeof value[i] !== 'number' && typeof value[i] !== 'bigint') { padStart = false; break; }
      }
    }
    for (let i = 0; i < outputLength; i += columns) {
      const max = Math.min(i + columns, outputLength);
      let str = '';
      let j = i;
      for (; j < max - 1; j++) {
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
        str += padStart ? `${output[j]}, `.padStart(padding, ' ') : `${output[j]}, `.padEnd(padding, ' ');
      }
      if (padStart) {
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j] - separatorSpace;
        str += output[j].padStart(padding, ' ');
      } else {
        str += output[j];
      }
      tmp.push(str);
    }
    if (outputLength < output.length) tmp.push(output[outputLength]);
    return tmp;
  }
  return output;
}

/** console.log's and util.format's arguments as one line, as node joins them */
export function formatWithOptions(opts: InspectOptions, args: unknown[]): string {
  const first = args[0];
  let a = 0;
  let str = '';
  if (typeof first === 'string' && args.length > 1 && first.includes('%')) {
    a = 1;
    let last = 0;
    let out = '';
    for (let i = 0; i < first.length - 1; i++) {
      if (first.charCodeAt(i) !== 37) continue; // '%'
      const c = first[i + 1];
      if (a === args.length && c !== '%') continue;
      let rep: string | null = null;
      switch (c) {
        case 's': {
          const v = args[a++];
          if (typeof v === 'number') rep = formatPrimitive({ ...ctxFor(opts), colors: false } as Ctx, v);
          else if (typeof v === 'bigint') rep = `${v}n`;
          else if (typeof v !== 'object' || v === null || (typeof (v as any).toString === 'function' && Object.prototype.hasOwnProperty.call(v, 'toString'))) rep = String(v);
          else rep = inspect(v, { ...opts, depth: 0, colors: false, compact: 3 });
          break;
        }
        case 'j': try { rep = JSON.stringify(args[a++]); } catch { rep = '[Circular]'; } break;
        case 'd': {
          const v = args[a++];
          rep = typeof v === 'bigint' ? `${v}n` : typeof v === 'symbol' ? 'NaN' : formatPrimitive({ ...ctxFor(opts), colors: false } as Ctx, Number(v));
          break;
        }
        case 'O': rep = inspect(args[a++], opts); break;
        case 'o': rep = inspect(args[a++], { ...opts, showHidden: true, depth: 4 }); break;
        case 'i': {
          const v = args[a++];
          rep = typeof v === 'bigint' ? `${v}n` : typeof v === 'symbol' ? 'NaN' : String(parseInt(String(v), 10));
          break;
        }
        case 'f': { const v = args[a++]; rep = typeof v === 'symbol' ? 'NaN' : String(parseFloat(String(v))); break; }
        case 'c': a++; rep = ''; break;
        case '%': out += first.slice(last, i) + '%'; last = i + 2; i++; continue;
        default: continue;
      }
      out += first.slice(last, i) + rep;
      last = i + 2;
      i++;
    }
    str = out + first.slice(last);
  }
  for (; a < args.length; a++) {
    const v = args[a];
    const s = typeof v === 'string' ? v : inspect(v, opts);
    str += (str || a > 0 ? ' ' : '') + s;
  }
  return str;
}

function ctxFor(opts: InspectOptions): Partial<Ctx> {
  return { colors: !!opts.colors, stylize: (t: string) => t } as Partial<Ctx>;
}
