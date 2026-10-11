import type { Command, CommandContext } from './index';

/**
 * jq, built in: the jq 1.7 language — pipes and generators, paths and
 * assignment (=, |=, +=, …), variables and destructuring (`. as [$a, {b: $c}]`,
 * `?//`), reduce/foreach, def with filter and $value parameters, try/catch,
 * label/break, optional `?`, string interpolation and @formats, the builtins
 * jq ships (dates, regexes, paths, streams, math) — and its command line
 * (--arg, --argjson, --slurpfile, --rawfile, --args, combined short flags, …).
 *
 * Anything it doesn't know is an error, never an empty result: an unknown
 * function or variable is a compile error (exit 3, as jq), a runtime error
 * exits 5.
 */

type V = any;
type PathKey = string | number | { start: V; end: V };
type Path = PathKey[];
type Out = [V, Path | null];

/** A jq runtime error: `error(v)`, or a builtin's message (v is then that string) */
export class JqError extends Error {
  constructor(message: string, public value: V = message) { super(message); this.name = 'JqError'; }
}
/** The program doesn't compile: jq's exit 3 */
class JqCompileError extends Error {}
class BreakSignal { constructor(public label: object) {} }
class HaltSignal { constructor(public code: number, public message?: string) {} }

// ─── Values ──────────────────────────────────────────────────────────────

const isObj = (v: V): v is Record<string, V> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const truthy = (v: V) => v !== null && v !== false && v !== undefined;
function typeOf(v: V): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v;
}
/** o[k] = v, `__proto__` included (as an own key, the way JSON.parse makes it) */
function put(o: Record<string, V>, k: string, v: V): Record<string, V> {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
  return o;
}

function jsonReplacer(_k: string, v: V): V {
  if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? null : v > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
  return v;
}
/** JSON.stringify as jq prints: NaN is null, ±infinity the largest double (the replacer only when the text has a null it could be) */
function stringify(v: V, indent?: string | number): string {
  if (typeof v === 'number') return JSON.stringify(jsonReplacer('', v));
  const s = JSON.stringify(v, null, indent) ?? 'null';
  return s.includes('null') ? JSON.stringify(v, jsonReplacer, indent) : s;
}
/** v as jq prints it compactly */
const dump = (v: V): string => (v === undefined ? 'null' : stringify(v));
/** `type (value)` for error messages, the value cut short as jq does */
function brief(v: V): string {
  let s = dump(v);
  if (s.length > 11) s = s.slice(0, 10) + '...';
  return `${typeOf(v)} (${s})`;
}
const tostr = (v: V): string => (typeof v === 'string' ? v : dump(v));

function rank(v: V): number {
  if (v === null || v === undefined) return 0;
  if (v === false) return 1;
  if (v === true) return 2;
  if (typeof v === 'number') return 3;
  if (typeof v === 'string') return 4;
  return Array.isArray(v) ? 5 : 6;
}
/** jq's order: null < false < true < numbers < strings < arrays < objects */
function compare(a: V, b: V): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3 || ra === 4) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 5) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { const c = compare(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  if (ra === 6) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    const c = compare(ka, kb);
    if (c) return c;
    for (const k of ka) { const d = compare(a[k], b[k]); if (d) return d; }
  }
  return 0;
}
const equal = (a: V, b: V) => compare(a, b) === 0;

const hasSurrogates = (s: string) => /[\uD800-\uDFFF]/.test(s);
const cpLength = (s: string) => (hasSurrogates(s) ? Array.from(s).length : s.length);
/** The code point index of UTF-16 index i in s */
const cpIndex = (s: string, i: number) => (hasSurrogates(s) ? Array.from(s.slice(0, i)).length : i);

// ─── Paths ───────────────────────────────────────────────────────────────

const isSliceKey = (k: V): k is { start: V; end: V } => isObj(k) && ('start' in k || 'end' in k);

function sliceBounds(len: number, from: V, to: V): [number, number] {
  if ((from !== null && from !== undefined && typeof from !== 'number') || (to !== null && to !== undefined && typeof to !== 'number')) {
    throw new JqError('Start and end indices of an array slice must be numbers');
  }
  let s = from == null ? 0 : Math.floor(from), e = to == null ? len : Math.ceil(to);
  if (s < 0) s = Math.max(0, len + s);
  if (e < 0) e = Math.max(0, len + e);
  s = Math.min(s, len); e = Math.min(e, len);
  return [s, Math.max(s, e)];
}

function slice(t: V, from: V, to: V): V {
  if (t === null) return null;
  if (typeof t === 'string') {
    const cps = hasSurrogates(t) ? Array.from(t) : null;
    const [s, e] = sliceBounds(cps ? cps.length : t.length, from, to);
    return cps ? cps.slice(s, e).join('') : t.slice(s, e);
  }
  if (Array.isArray(t)) { const [s, e] = sliceBounds(t.length, from, to); return t.slice(s, e); }
  throw new JqError(`Cannot index ${typeOf(t)} with object`);
}

/** The positions of sub-array `sub` in `a` */
function subarrayIndices(a: V[], sub: V[]): V {
  if (sub.length === 0) return null;
  const out: number[] = [];
  for (let i = 0; i + sub.length <= a.length; i++) {
    if (sub.every((x, j) => equal(a[i + j], x))) out.push(i);
  }
  return out;
}

function index(t: V, k: V): V {
  if (typeof k === 'string') {
    if (isObj(t)) return own(t, k) ? t[k] : null;
    if (t === null) return null;
    throw new JqError(`Cannot index ${typeOf(t)} with string "${k}"`);
  }
  if (typeof k === 'number') {
    if (Array.isArray(t)) {
      if (Number.isNaN(k)) return null;
      let i = Math.floor(k);
      if (i < 0) i += t.length;
      return i >= 0 && i < t.length ? t[i] : null;
    }
    if (t === null) return null;
    throw new JqError(`Cannot index ${typeOf(t)} with number`);
  }
  if (isSliceKey(k) && (t === null || typeof t === 'string' || Array.isArray(t))) return slice(t, k.start, k.end);
  if (Array.isArray(k) && Array.isArray(t)) return subarrayIndices(t, k);
  if (t === null && (k === null || isObj(k))) return null;
  throw new JqError(`Cannot index ${typeOf(t)} with ${typeOf(k)}`);
}

function checkPath(p: V): Path {
  if (!Array.isArray(p)) throw new JqError('Path must be specified as an array');
  return p;
}

function getpath(v: V, p: Path): V {
  for (const k of p) {
    if (v === null) return null;
    v = index(v, k);
  }
  return v;
}

function setpath(v: V, p: Path, i: number, x: V): V {
  if (i === p.length) return x;
  const k = p[i];
  if (typeof k === 'string') {
    if (v !== null && !isObj(v)) throw new JqError(`Cannot index ${typeOf(v)} with string "${k}"`);
    const o = v === null ? {} : { ...v };
    return put(o, k, setpath(v !== null && own(v, k) ? v[k] : null, p, i + 1, x));
  }
  if (typeof k === 'number') {
    if (v !== null && !Array.isArray(v)) throw new JqError(`Cannot index ${typeOf(v)} with number`);
    const a: V[] = v === null ? [] : v.slice();
    let n = Math.floor(k);
    if (n < 0) { n += a.length; if (n < 0) throw new JqError('Out of bounds negative array index'); }
    const nv = setpath(n < a.length ? a[n] : null, p, i + 1, x);
    while (a.length < n) a.push(null);
    a[n] = nv;
    return a;
  }
  if (isSliceKey(k)) {
    if (typeof v === 'string') throw new JqError('Cannot update string slices');
    if (v !== null && !Array.isArray(v)) throw new JqError(`Cannot update field at object index of ${typeOf(v)}`);
    const a: V[] = v === null ? [] : v;
    const [s, e] = sliceBounds(a.length, k.start, k.end);
    const nv = setpath(a.slice(s, e), p, i + 1, x);
    if (!Array.isArray(nv)) throw new JqError('A slice of an array can only be assigned another array');
    return [...a.slice(0, s), ...nv, ...a.slice(e)];
  }
  throw new JqError(`Invalid path component ${dump(k)}`);
}

function delpath(v: V, p: Path, i: number): V {
  if (v === null) return null;
  const k = p[i];
  if (i < p.length - 1) {
    const child = index(v, k);
    if (child === null) return v;
    return setpath(v, [k], 0, delpath(child, p, i + 1));
  }
  if (typeof k === 'string') {
    if (!isObj(v)) throw new JqError(`Cannot delete fields from ${typeOf(v)}`);
    if (!own(v, k)) return v;
    const o = { ...v };
    delete o[k];
    return o;
  }
  if (typeof k === 'number') {
    if (!Array.isArray(v)) throw new JqError(`Cannot delete elements from ${typeOf(v)}`);
    let n = Math.floor(k);
    if (n < 0) { n += v.length; if (n < 0) throw new JqError('Out of bounds negative array index'); }
    return n < v.length ? [...v.slice(0, n), ...v.slice(n + 1)] : v;
  }
  if (isSliceKey(k)) {
    if (!Array.isArray(v)) throw new JqError(`Cannot delete slice of ${typeOf(v)}`);
    const [s, e] = sliceBounds(v.length, k.start, k.end);
    return [...v.slice(0, s), ...v.slice(e)];
  }
  throw new JqError(`Invalid path component ${dump(k)}`);
}

function delpaths(v: V, ps: V): V {
  if (!Array.isArray(ps)) throw new JqError('Paths must be specified as an array');
  let r = v;
  for (const q of [...ps].sort((a, b) => compare(b, a))) {
    checkPath(q);
    r = q.length === 0 ? null : delpath(r, q, 0);
  }
  return r;
}

// ─── Arithmetic ──────────────────────────────────────────────────────────

function deepMerge(a: Record<string, V>, b: Record<string, V>): Record<string, V> {
  const r = { ...a };
  for (const k of Object.keys(b)) put(r, k, isObj(r[k]) && own(r, k) && isObj(b[k]) ? deepMerge(r[k], b[k]) : b[k]);
  return r;
}

function binop(op: string, l: V, r: V): V {
  switch (op) {
    case '+':
      if (l === null) return r;
      if (r === null) return l;
      if (typeof l === 'number' && typeof r === 'number') return l + r;
      if (typeof l === 'string' && typeof r === 'string') return l + r;
      if (Array.isArray(l) && Array.isArray(r)) return l.concat(r);
      if (isObj(l) && isObj(r)) return { ...l, ...r };
      throw new JqError(`${brief(l)} and ${brief(r)} cannot be added`);
    case '-':
      if (typeof l === 'number' && typeof r === 'number') return l - r;
      if (Array.isArray(l) && Array.isArray(r)) return l.filter((x) => !r.some((y) => equal(x, y)));
      throw new JqError(`${brief(l)} and ${brief(r)} cannot be subtracted`);
    case '*':
      if (typeof l === 'number' && typeof r === 'number') return l * r;
      if ((typeof l === 'string' && typeof r === 'number') || (typeof l === 'number' && typeof r === 'string')) {
        const [s, n] = typeof l === 'string' ? [l, r as number] : [r as string, l];
        return s.repeat(Math.max(0, Math.floor(n)));
      }
      if (isObj(l) && isObj(r)) return deepMerge(l, r);
      throw new JqError(`${brief(l)} and ${brief(r)} cannot be multiplied`);
    case '/':
      if (typeof l === 'number' && typeof r === 'number') {
        if (r === 0) throw new JqError(`${brief(l)} and ${brief(r)} cannot be divided because the divisor is zero`);
        return l / r;
      }
      if (typeof l === 'string' && typeof r === 'string') return l === '' ? [] : l.split(r);
      throw new JqError(`${brief(l)} and ${brief(r)} cannot be divided`);
    case '%': {
      if (typeof l !== 'number' || typeof r !== 'number') throw new JqError(`${brief(l)} and ${brief(r)} cannot be divided`);
      const a = Math.trunc(l), b = Math.trunc(r);
      if (b === 0 || Number.isNaN(b)) throw new JqError(`${brief(l)} and ${brief(r)} cannot be divided because the divisor is zero`);
      return (a % b) || 0;
    }
    case '==': return equal(l, r);
    case '!=': return !equal(l, r);
    case '<': return compare(l, r) < 0;
    case '<=': return compare(l, r) <= 0;
    case '>': return compare(l, r) > 0;
    case '>=': return compare(l, r) >= 0;
  }
  throw new JqError(`unknown operator ${op}`);
}

// ─── Lexer ───────────────────────────────────────────────────────────────

type StrPart = string | Node;
interface Tok { k: string; v?: any; pos: number }

const KEYWORDS = new Set(['def', 'if', 'then', 'elif', 'else', 'end', 'as', 'reduce', 'foreach', 'try', 'catch', 'label', 'import', 'include', 'and', 'or']);
const OPS = ['?//', '//=', '|=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '//', '|', ',', '+', '-', '*', '/', '%', '=', '<', '>', '(', ')', '[', ']', '{', '}', ':', ';', '?'];
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** A string literal at src[i] (the opening quote): its parts, interpolations parsed, and the index past it */
function lexString(src: string, i: number): [StrPart[], number] {
  const parts: StrPart[] = [];
  let lit = '';
  i++;
  while (true) {
    if (i >= src.length) throw new JqCompileError('syntax error, unterminated string literal');
    const c = src[i];
    if (c === '"') { i++; break; }
    if (c !== '\\') { lit += c; i++; continue; }
    const e = src[i + 1];
    if (e === '(') {
      let depth = 1, j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '"') { j = lexString(src, j)[1]; continue; }
        if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
        j++;
      }
      if (depth > 0) throw new JqCompileError('syntax error, unterminated string interpolation');
      if (lit) parts.push(lit);
      lit = '';
      parts.push(parseProgram(src.slice(i + 2, j - 1)));
      i = j;
    } else if (e === 'u') {
      const hex = src.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JqCompileError(`syntax error, invalid \\u escape in string literal`);
      lit += String.fromCharCode(parseInt(hex, 16));
      i += 6;
    } else if (e !== undefined && e in ESCAPES) {
      lit += ESCAPES[e];
      i += 2;
    } else {
      throw new JqCompileError(`syntax error, invalid escape \\${e ?? ''} in string literal`);
    }
  }
  if (lit || parts.length === 0) parts.push(lit);
  return [parts, i];
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const pos = i;
    if (c === '"') { const [parts, j] = lexString(src, i); out.push({ k: 'str', v: parts, pos }); i = j; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: Number(m[0]), pos });
      i += m[0].length;
      continue;
    }
    if (c === '.') {
      if (src[i + 1] === '.') { out.push({ k: '..', pos }); i += 2; continue; }
      const m = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(src.slice(i + 1));
      if (m) { out.push({ k: 'field', v: m[0], pos }); i += 1 + m[0].length; continue; }
      out.push({ k: '.', pos });
      i++;
      continue;
    }
    if (c === '$') {
      const m = /^\$([a-zA-Z_][a-zA-Z_0-9]*(?:::[a-zA-Z_][a-zA-Z_0-9]*)*)/.exec(src.slice(i));
      if (!m) throw new JqCompileError(`syntax error, unexpected '$'`);
      out.push({ k: 'var', v: m[1], pos });
      i += m[0].length;
      continue;
    }
    if (c === '@') {
      const m = /^@([a-zA-Z0-9_]+)/.exec(src.slice(i));
      if (!m) throw new JqCompileError(`syntax error, unexpected '@'`);
      out.push({ k: 'fmt', v: m[1], pos });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z_0-9]*(?:::[a-zA-Z_][a-zA-Z_0-9]*)*/.exec(src.slice(i))!;
      out.push({ k: KEYWORDS.has(m[0]) ? 'kw' : 'ident', v: m[0], pos });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new JqCompileError(`syntax error, unexpected INVALID_CHARACTER '${c}'`);
    out.push({ k: op, pos });
    i += op.length;
  }
  out.push({ k: 'eof', pos: src.length });
  return out;
}

// ─── Parser ──────────────────────────────────────────────────────────────

type Pattern =
  | { t: 'var'; name: string }
  | { t: 'array'; items: Pattern[] }
  | { t: 'object'; entries: { keyVar?: string; key?: Node; pattern?: Pattern }[] };

interface ObjEntry { key: Node; value: Node }
interface Param { name: string; isVar: boolean }

type Node =
  | { t: 'id' } | { t: 'recurse' }
  | { t: 'lit'; v: V }
  | { t: 'str'; parts: StrPart[]; fmt: string | null }
  | { t: 'fmt'; name: string }
  | { t: 'index'; target: Node; key: Node }
  | { t: 'slice'; target: Node; from: Node | null; to: Node | null }
  | { t: 'iter'; target: Node }
  | { t: 'try'; body: Node; handler: Node | null }
  | { t: 'neg'; body: Node }
  | { t: 'pipe'; left: Node; right: Node }
  | { t: 'comma'; left: Node; right: Node }
  | { t: 'bin'; op: string; left: Node; right: Node }
  | { t: 'and' | 'or' | 'alt'; left: Node; right: Node }
  | { t: 'assign'; op: string; left: Node; right: Node }
  | { t: 'if'; cond: Node; then: Node; else: Node | null }
  | { t: 'array'; body: Node | null }
  | { t: 'object'; entries: ObjEntry[] }
  | { t: 'var'; name: string }
  | { t: 'loc'; line: number }
  | { t: 'as'; source: Node; patterns: Pattern[]; body: Node }
  | { t: 'reduce'; source: Node; patterns: Pattern[]; init: Node; update: Node }
  | { t: 'foreach'; source: Node; patterns: Pattern[]; init: Node; update: Node; extract: Node | null }
  | { t: 'def'; name: string; params: Param[]; body: Node; rest: Node }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'label'; name: string; body: Node }
  | { t: 'break'; name: string };

const ID: Node = { t: 'id' };
const FORMATS = new Set(['text', 'json', 'html', 'uri', 'csv', 'tsv', 'sh', 'base64', 'base64d', 'base32', 'base32d']);
// binding powers: [left, right]; '|' is below all of them (parsePipe)
const BINARY: Record<string, [number, number]> = {
  ',': [10, 11],
  '//': [20, 20],
  '=': [30, 31], '|=': [30, 31], '+=': [30, 31], '-=': [30, 31], '*=': [30, 31], '/=': [30, 31], '%=': [30, 31], '//=': [30, 31],
  or: [40, 41],
  and: [50, 51],
  '==': [60, 61], '!=': [60, 61], '<': [60, 61], '<=': [60, 61], '>': [60, 61], '>=': [60, 61],
  '+': [70, 71], '-': [70, 71],
  '*': [80, 81], '/': [80, 81], '%': [80, 81],
};

class Parser {
  private i = 0;
  constructor(private toks: Tok[], private src: string) {}

  peek(o = 0): Tok { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  next(): Tok { return this.toks[this.i++]; }
  is(k: string, v?: string): boolean { const t = this.peek(); return t.k === k && (v === undefined || t.v === v); }
  isKw(v: string): boolean { return this.is('kw', v); }
  eat(k: string, v?: string): boolean { if (this.is(k, v)) { this.i++; return true; } return false; }
  expect(k: string, v?: string): Tok {
    if (!this.is(k, v)) this.unexpected();
    return this.next();
  }
  unexpected(): never {
    const t = this.peek();
    const what = t.k === 'eof' ? 'end of file' : t.k === 'str' ? 'string' : t.k === 'num' ? `number ${t.v}` : `'${t.v ?? t.k}'`;
    throw new JqCompileError(`syntax error, unexpected ${what} (Unix shell quoting issues?)`);
  }
  lineAt(pos: number): number { return this.src.slice(0, pos).split('\n').length; }

  /** Exp ('|' Exp)*, right-assoc, its binary operators at minBp or above */
  parsePipe(minBp = 0): Node {
    if (this.isKw('def')) return this.parseDef();
    const left = this.parseExpr(minBp);
    if (this.eat('|')) return { t: 'pipe', left, right: this.parsePipe(minBp) };
    return left;
  }

  parseExpr(minBp: number): Node {
    let left = this.parseOperand();
    while (true) {
      const t = this.peek();
      const op = t.k === 'kw' && (t.v === 'and' || t.v === 'or') ? t.v : t.k;
      const bp = BINARY[op];
      if (!bp || bp[0] < minBp) break;
      this.next();
      const right = this.parseExpr(bp[1]);
      if (op === ',') left = { t: 'comma', left, right };
      else if (op === 'and' || op === 'or') left = { t: op, left, right };
      else if (op === '//') left = { t: 'alt', left, right };
      else if (op.endsWith('=') && op !== '==' && op !== '!=' && op !== '<=' && op !== '>=') left = { t: 'assign', op, left, right };
      else left = { t: 'bin', op, left, right };
    }
    return left;
  }

  parseOperand(): Node {
    if (this.eat('-')) return { t: 'neg', body: this.parseExpr(80) };
    if (this.isKw('def')) return this.parseDef();
    const term = this.parsePostfix();
    if (this.isKw('as')) {
      this.next();
      const patterns = this.parsePatterns();
      this.expect('|');
      return { t: 'as', source: term, patterns, body: this.parsePipe() };
    }
    return term;
  }

  parseDef(): Node {
    this.expect('kw', 'def');
    const nt = this.next();
    if (nt.k !== 'ident' && nt.k !== 'kw') { this.i--; this.unexpected(); }
    const params: Param[] = [];
    if (this.eat('(')) {
      do {
        const p = this.next();
        if (p.k === 'var') params.push({ name: p.v, isVar: true });
        else if (p.k === 'ident' || p.k === 'kw') params.push({ name: p.v, isVar: false });
        else { this.i--; this.unexpected(); }
      } while (this.eat(';'));
      this.expect(')');
    }
    this.expect(':');
    const body = this.parsePipe();
    this.expect(';');
    const rest = this.is('eof') || this.is(')') || this.is(']') || this.is('}') ? ID : this.parsePipe();
    return { t: 'def', name: nt.v, params, body, rest };
  }

  parsePostfix(): Node {
    let n = this.parsePrimary();
    while (true) {
      const t = this.peek();
      if (t.k === 'field') { this.next(); n = { t: 'index', target: n, key: { t: 'lit', v: t.v } }; continue; }
      if (t.k === '.' && this.peek(1).k === 'str') { this.next(); n = { t: 'index', target: n, key: this.parseString(null) }; continue; }
      if (t.k === '.' && this.peek(1).k === '[') { this.next(); continue; }
      if (t.k === '[') { n = this.parseBracket(n); continue; }
      if (t.k === '?') { this.next(); n = { t: 'try', body: n, handler: null }; continue; }
      if (t.k === '?//') { t.k = '//'; n = { t: 'try', body: n, handler: null }; continue; }
      return n;
    }
  }

  parseBracket(target: Node): Node {
    this.expect('[');
    if (this.eat(']')) return { t: 'iter', target };
    if (this.eat(':')) {
      const to = this.parsePipe();
      this.expect(']');
      return { t: 'slice', target, from: null, to };
    }
    const k = this.parsePipe();
    if (this.eat(':')) {
      const to = this.is(']') ? null : this.parsePipe();
      this.expect(']');
      return { t: 'slice', target, from: k, to };
    }
    this.expect(']');
    return { t: 'index', target, key: k };
  }

  parseString(fmt: string | null): Node {
    const t = this.expect('str');
    const parts = t.v as StrPart[];
    if (fmt === null && parts.length === 1 && typeof parts[0] === 'string') return { t: 'lit', v: parts[0] };
    return { t: 'str', parts, fmt };
  }

  parsePrimary(): Node {
    const t = this.peek();
    switch (t.k) {
      case 'num': this.next(); return { t: 'lit', v: t.v };
      case 'str': return this.parseString(null);
      case 'fmt': {
        this.next();
        if (!FORMATS.has(t.v)) throw new JqCompileError(`${t.v} is not a valid format`);
        if (this.is('str')) return this.parseString(t.v);
        return { t: 'fmt', name: t.v };
      }
      case 'field': this.next(); return { t: 'index', target: ID, key: { t: 'lit', v: t.v } };
      case '.':
        this.next();
        if (this.is('str')) return { t: 'index', target: ID, key: this.parseString(null) };
        return ID;
      case '..': this.next(); return { t: 'recurse' };
      case 'var':
        this.next();
        if (t.v === '__loc__') return { t: 'loc', line: this.lineAt(t.pos) };
        return { t: 'var', name: t.v };
      case '(': {
        this.next();
        const n = this.parsePipe();
        this.expect(')');
        return n;
      }
      case '[': {
        this.next();
        if (this.eat(']')) return { t: 'array', body: null };
        const body = this.parsePipe();
        this.expect(']');
        return { t: 'array', body };
      }
      case '{': return this.parseObject();
      case 'kw':
        switch (t.v) {
          case 'if': return this.parseIf();
          case 'try': {
            this.next();
            const body = this.parsePostfixNoAs();
            const handler = this.isKw('catch') ? (this.next(), this.parsePostfixNoAs()) : null;
            return { t: 'try', body, handler };
          }
          case 'reduce': case 'foreach': return this.parseFold(t.v);
          case 'label': {
            this.next();
            const name = this.expect('var').v;
            this.expect('|');
            return { t: 'label', name, body: this.parsePipe() };
          }
          case 'def': return this.parseDef();
          case 'import': case 'include':
            throw new JqCompileError(`${t.v} (modules) is not supported by the built-in jq`);
        }
        this.unexpected();
      // falls through (unexpected throws)
      case 'ident': {
        this.next();
        if (t.v === 'true') return { t: 'lit', v: true };
        if (t.v === 'false') return { t: 'lit', v: false };
        if (t.v === 'null') return { t: 'lit', v: null };
        if (t.v === 'break') return { t: 'break', name: this.expect('var').v };
        const args: Node[] = [];
        if (this.eat('(')) {
          do args.push(this.parsePipe()); while (this.eat(';'));
          this.expect(')');
        }
        return { t: 'call', name: t.v, args };
      }
    }
    this.unexpected();
  }

  /** try's and catch's operand: a postfix term (jq 1.7) */
  parsePostfixNoAs(): Node {
    if (this.eat('-')) return { t: 'neg', body: this.parsePostfix() };
    return this.parsePostfix();
  }

  parseIf(): Node {
    this.expect('kw', 'if');
    return this.parseIfBody();
  }

  /** cond then … (elif …)* (else …)? end, an elif being a nested if that shares the end */
  parseIfBody(): Node {
    const cond = this.parsePipe();
    this.expect('kw', 'then');
    const then = this.parsePipe();
    if (this.eat('kw', 'elif')) return { t: 'if', cond, then, else: this.parseIfBody() };
    const els = this.eat('kw', 'else') ? this.parsePipe() : null;
    this.expect('kw', 'end');
    return { t: 'if', cond, then, else: els };
  }

  parseFold(kind: 'reduce' | 'foreach'): Node {
    this.next();
    const source = this.parsePostfix();
    this.expect('kw', 'as');
    const patterns = this.parsePatterns();
    this.expect('(');
    const init = this.parsePipe();
    this.expect(';');
    const update = this.parsePipe();
    let extract: Node | null = null;
    if (kind === 'foreach' && this.eat(';')) extract = this.parsePipe();
    this.expect(')');
    return kind === 'reduce' ? { t: 'reduce', source, patterns, init, update } : { t: 'foreach', source, patterns, init, update, extract };
  }

  parsePatterns(): Pattern[] {
    const ps = [this.parsePattern()];
    while (this.eat('?//')) ps.push(this.parsePattern());
    return ps;
  }

  parsePattern(): Pattern {
    const t = this.peek();
    if (t.k === 'var') { this.next(); return { t: 'var', name: t.v }; }
    if (this.eat('[')) {
      const items: Pattern[] = [];
      do items.push(this.parsePattern()); while (this.eat(','));
      this.expect(']');
      return { t: 'array', items };
    }
    if (this.eat('{')) {
      const entries: { keyVar?: string; key?: Node; pattern?: Pattern }[] = [];
      do {
        const k = this.peek();
        if (k.k === 'var') {
          this.next();
          entries.push({ keyVar: k.v, pattern: this.eat(':') ? this.parsePattern() : undefined });
          continue;
        }
        let key: Node;
        if (k.k === 'ident' || k.k === 'kw') { this.next(); key = { t: 'lit', v: k.v }; }
        else if (k.k === 'str') key = this.parseString(null);
        else if (k.k === '(') { this.next(); key = this.parsePipe(); this.expect(')'); }
        else this.unexpected();
        this.expect(':');
        entries.push({ key, pattern: this.parsePattern() });
      } while (this.eat(','));
      this.expect('}');
      return { t: 'object', entries };
    }
    this.unexpected();
  }

  parseObject(): Node {
    this.expect('{');
    const entries: ObjEntry[] = [];
    if (this.eat('}')) return { t: 'object', entries };
    do {
      const k = this.peek();
      let key: Node, value: Node | null = null;
      if (k.k === 'var') {
        this.next();
        key = { t: 'lit', v: k.v };
        value = k.v === '__loc__' ? { t: 'loc', line: this.lineAt(k.pos) } : { t: 'var', name: k.v };
      } else if (k.k === 'ident' || k.k === 'kw') {
        this.next();
        key = { t: 'lit', v: k.v };
      } else if (k.k === 'num') {
        this.next();
        key = { t: 'lit', v: k.v };
      } else if (k.k === 'str') {
        key = this.parseString(null);
      } else if (k.k === 'fmt' && this.peek(1).k === 'str') {
        this.next();
        key = this.parseString(k.v);
      } else if (k.k === '(') {
        this.next();
        key = this.parsePipe();
        this.expect(')');
      } else this.unexpected();
      if (this.eat(':')) value = this.parsePipe(11);
      else if (!value) {
        if (k.k === 'num' || k.k === '(') this.unexpected();
        value = { t: 'index', target: ID, key };
      }
      entries.push({ key, value });
    } while (this.eat(','));
    this.expect('}');
    return { t: 'object', entries };
  }
}

function parseProgram(src: string): Node {
  const toks = lex(src);
  if (toks.length === 1) return ID;
  const p = new Parser(toks, src);
  const n = p.parsePipe();
  if (!p.is('eof')) p.unexpected();
  return n;
}

// ─── Static check: every function and variable is defined (jq's compile errors) ──

class Scope {
  constructor(public parent: Scope | null, public names: Set<string> = new Set()) {}
  has(n: string): boolean { for (let s: Scope | null = this; s; s = s.parent) if (s.names.has(n)) return true; return false; }
  child(...names: string[]): Scope { return new Scope(this, new Set(names)); }
}

function patternVars(p: Pattern, out: string[] = []): string[] {
  if (p.t === 'var') out.push('$' + p.name);
  else if (p.t === 'array') p.items.forEach((q) => patternVars(q, out));
  else for (const e of p.entries) { if (e.keyVar) out.push('$' + e.keyVar); if (e.pattern) patternVars(e.pattern, out); }
  return out;
}

function check(n: Node, s: Scope, uses: { input: boolean }): void {
  const c = (m: Node | null, sc: Scope = s) => { if (m) check(m, sc, uses); };
  switch (n.t) {
    case 'id': case 'recurse': case 'lit': case 'fmt': case 'loc': return;
    case 'str': n.parts.forEach((p) => { if (typeof p !== 'string') c(p); }); return;
    case 'index': c(n.target); c(n.key); return;
    case 'slice': c(n.target); c(n.from); c(n.to); return;
    case 'iter': c(n.target); return;
    case 'try': c(n.body); c(n.handler); return;
    case 'neg': c(n.body); return;
    case 'pipe': case 'comma': case 'bin': case 'and': case 'or': case 'alt': case 'assign': c(n.left); c(n.right); return;
    case 'if': c(n.cond); c(n.then); c(n.else); return;
    case 'array': c(n.body); return;
    case 'object': n.entries.forEach((e) => { c(e.key); c(e.value); }); return;
    case 'var':
      if (!s.has('$' + n.name)) throw new JqCompileError(`$${n.name} is not defined`);
      return;
    case 'as': case 'reduce': case 'foreach': {
      c(n.source);
      for (const p of n.patterns) checkPattern(p, s, uses);
      const inner = s.child(...n.patterns.flatMap((p) => patternVars(p)));
      if (n.t === 'as') c(n.body, inner);
      else { c(n.init); c(n.update, inner); if (n.t === 'foreach') c(n.extract, inner); }
      return;
    }
    case 'def': {
      const self = s.child(`${n.name}/${n.params.length}`);
      const body = self.child(...n.params.flatMap((p) => (p.isVar ? [`${p.name}/0`, '$' + p.name] : [`${p.name}/0`])));
      c(n.body, body);
      c(n.rest, self);
      return;
    }
    case 'call': {
      const key = `${n.name}/${n.args.length}`;
      if (!s.has(key)) throw new JqCompileError(`${key} is not defined`);
      if (key === 'input/0' || key === 'inputs/0') uses.input = true;
      n.args.forEach((a) => c(a));
      return;
    }
    case 'label': c(n.body, s.child('*label*' + n.name)); return;
    case 'break':
      if (!s.has('*label*' + n.name)) throw new JqCompileError(`$*label-${n.name} is not defined`);
      return;
  }
}

function checkPattern(p: Pattern, s: Scope, uses: { input: boolean }): void {
  if (p.t === 'array') p.items.forEach((q) => checkPattern(q, s, uses));
  else if (p.t === 'object') for (const e of p.entries) { if (e.key) check(e.key, s, uses); if (e.pattern) checkPattern(e.pattern, s, uses); }
}

// ─── Evaluation ──────────────────────────────────────────────────────────

type Native = (v: V, p: Path | null, args: Node[], env: Env) => Generator<Out>;
type Fn =
  | { kind: 'def'; node: Extract<Node, { t: 'def' }>; env: Env }
  | { kind: 'closure'; node: Node; env: Env }
  | { kind: 'native'; impl: Native };

class Env {
  constructor(public parent: Env | null, public vars: Map<string, V> | null = null, public funcs: Map<string, Fn> | null = null) {}
  getVar(name: string): V {
    for (let e: Env | null = this; e; e = e.parent) if (e.vars?.has(name)) return e.vars.get(name);
    if (name === 'ENV') return RT.env;
    throw new JqError(`$${name} is not defined`);
  }
  getFn(key: string): Fn {
    for (let e: Env | null = this; e; e = e.parent) { const f = e.funcs?.get(key); if (f) return f; }
    throw new JqError(`${key} is not defined`);
  }
}

/** What a run reads and writes outside its values: inputs, stderr */
interface Runtime {
  nextInput(): { value: V } | null;
  stderr(s: string): void;
  filename: V;
  env: Record<string, string>;
}
let RT: Runtime = { nextInput: () => null, stderr: () => {}, filename: null, env: {} };

function badPath(x: V): never {
  throw new JqError(`Invalid path expression with result ${dump(x).length > 11 ? dump(x).slice(0, 10) + '...' : dump(x)}`);
}
function* one(x: V, p: Path | null): Generator<Out> {
  if (p) badPath(x);
  yield [x, null];
}
/** The values of n on v, as a plain list (not a path) */
const vals = (n: Node, v: V, env: Env): V[] => Array.from(ev(n, v, null, env), (o) => o[0]);

function* iterate(v: V, p: Path | null): Generator<Out> {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) yield [v[i], p ? [...p, i] : null]; return; }
  if (isObj(v)) { for (const k of Object.keys(v)) yield [v[k], p ? [...p, k] : null]; return; }
  throw new JqError(`Cannot iterate over ${v === null ? 'null' : brief(v)}`);
}
function* iterateOpt(v: V, p: Path | null): Generator<Out> {
  if (Array.isArray(v) || isObj(v)) yield* iterate(v, p);
}

/** `recurse(f)`: v, then depth first what f gives, without a JS frame per level */
function* recurseGen(v: V, p: Path | null, f: (x: V, xp: Path | null) => Iterator<Out>): Generator<Out> {
  yield [v, p];
  const stack: Iterator<Out>[] = [f(v, p)];
  while (stack.length) {
    const r = stack[stack.length - 1].next();
    if (r.done) { stack.pop(); continue; }
    yield r.value;
    stack.push(f(r.value[0], r.value[1]));
  }
}

function* ev(n: Node, v: V, p: Path | null, env: Env): Generator<Out> {
  switch (n.t) {
    case 'id': yield [v, p]; return;
    case 'recurse': yield* recurseGen(v, p, iterateOpt); return;
    case 'lit': yield* one(n.v, p); return;
    case 'str': for (const s of interpolate(n, v, env)) yield* one(s, p); return;
    case 'fmt': yield* one(format(n.name, v), p); return;
    case 'index':
      for (const [k] of ev(n.key, v, null, env)) {
        for (const [t, tp] of ev(n.target, v, p, env)) yield [index(t, k), tp ? [...tp, k] : null];
      }
      return;
    case 'slice':
      for (const [to] of n.to ? ev(n.to, v, null, env) : [[null, null] as Out]) {
        for (const [from] of n.from ? ev(n.from, v, null, env) : [[null, null] as Out]) {
          for (const [t, tp] of ev(n.target, v, p, env)) yield [slice(t, from, to), tp ? [...tp, { start: from, end: to }] : null];
        }
      }
      return;
    case 'iter': for (const [t, tp] of ev(n.target, v, p, env)) yield* iterate(t, tp); return;
    case 'try': {
      const it = ev(n.body, v, p, env);
      while (true) {
        let r: IteratorResult<Out>;
        try { r = it.next(); } catch (e) {
          if (!(e instanceof JqError)) throw e;
          if (n.handler) yield* ev(n.handler, e.value, null, env);
          return;
        }
        if (r.done) return;
        yield r.value;
      }
    }
    case 'neg':
      for (const [x] of ev(n.body, v, null, env)) {
        if (typeof x !== 'number') throw new JqError(`${brief(x)} cannot be negated`);
        yield* one(-x, p);
      }
      return;
    case 'pipe': for (const [x, xp] of ev(n.left, v, p, env)) yield* ev(n.right, x, xp, env); return;
    case 'comma': yield* ev(n.left, v, p, env); yield* ev(n.right, v, p, env); return;
    case 'bin':
      for (const [r] of ev(n.right, v, null, env)) for (const [l] of ev(n.left, v, null, env)) yield* one(binop(n.op, l, r), p);
      return;
    case 'and': case 'or':
      for (const [l] of ev(n.left, v, null, env)) {
        if (n.t === 'and' ? !truthy(l) : truthy(l)) { yield* one(n.t === 'or', p); continue; }
        for (const [r] of ev(n.right, v, null, env)) yield* one(truthy(r), p);
      }
      return;
    case 'alt': {
      let any = false;
      for (const o of ev(n.left, v, p, env)) if (truthy(o[0])) { any = true; yield o; }
      if (!any) yield* ev(n.right, v, p, env);
      return;
    }
    case 'assign': yield* assign(n, v, p, env); return;
    case 'if':
      for (const [c] of ev(n.cond, v, null, env)) {
        if (truthy(c)) yield* ev(n.then, v, p, env);
        else if (n.else) yield* ev(n.else, v, p, env);
        else yield [v, p];
      }
      return;
    case 'array': yield* one(n.body ? vals(n.body, v, env) : [], p); return;
    case 'object': for (const o of construct(n.entries, 0, {}, v, env)) yield* one(o, p); return;
    case 'var': yield* one(env.getVar(n.name), p); return;
    case 'loc': yield* one({ file: '<top-level>', line: n.line }, p); return;
    case 'as':
      for (const [src] of ev(n.source, v, null, env)) yield* bindPatterns(n.patterns, src, env, (e2) => ev(n.body, v, p, e2));
      return;
    case 'reduce':
      for (const [init] of ev(n.init, v, null, env)) {
        let acc: V = init;
        for (const [src] of ev(n.source, v, null, env)) {
          for (const _ of bindPatterns(n.patterns, src, env, function* (e2) {
            let last: V = null;
            for (const [u] of ev(n.update, acc, null, e2)) last = u;
            acc = last;
          }));
        }
        yield* one(acc, p);
      }
      return;
    case 'foreach':
      for (const [init] of ev(n.init, v, null, env)) {
        let acc: V = init;
        for (const [src] of ev(n.source, v, null, env)) {
          yield* bindPatterns(n.patterns, src, env, function* (e2) {
            for (const [u] of ev(n.update, acc, null, e2)) {
              acc = u;
              if (n.extract) for (const [x] of ev(n.extract, u, null, e2)) yield* one(x, p);
              else yield* one(u, p);
            }
          });
        }
      }
      return;
    case 'def': {
      const e2 = new Env(env, null, new Map());
      e2.funcs!.set(`${n.name}/${n.params.length}`, { kind: 'def', node: n, env: e2 });
      yield* ev(n.rest, v, p, e2);
      return;
    }
    case 'call': yield* call(n, v, p, env); return;
    case 'label': {
      const label = {};
      const it = ev(n.body, v, p, new Env(env, new Map([['*label*' + n.name, label]])));
      while (true) {
        let r: IteratorResult<Out>;
        try { r = it.next(); } catch (e) { if (e instanceof BreakSignal && e.label === label) return; throw e; }
        if (r.done) return;
        yield r.value;
      }
    }
    case 'break': throw new BreakSignal(env.getVar('*label*' + n.name));
  }
}

function* call(n: Extract<Node, { t: 'call' }>, v: V, p: Path | null, env: Env): Generator<Out> {
  const fn = env.getFn(`${n.name}/${n.args.length}`);
  if (fn.kind === 'closure') { yield* ev(fn.node, v, p, fn.env); return; }
  if (fn.kind === 'native') { yield* fn.impl(v, p, n.args, env); return; }
  const d = fn.node;
  const fenv = new Env(fn.env, null, new Map());
  const valueParams: [string, Node][] = [];
  d.params.forEach((pr, i) => {
    fenv.funcs!.set(`${pr.name}/0`, { kind: 'closure', node: n.args[i], env });
    if (pr.isVar) valueParams.push([pr.name, n.args[i]]);
  });
  if (!valueParams.length) { yield* ev(d.body, v, p, fenv); return; }
  // $params: each of their values (first parameter outermost), evaluated on the input in the caller's scope
  function* bind(i: number, e: Env): Generator<Out> {
    if (i === valueParams.length) { yield* ev(d.body, v, p, e); return; }
    for (const [x] of ev(valueParams[i][1], v, null, env)) yield* bind(i + 1, new Env(e, new Map([[valueParams[i][0], x]])));
  }
  yield* bind(0, fenv);
}

function* interpolate(n: Extract<Node, { t: 'str' }>, v: V, env: Env): Generator<string> {
  const fmt = n.fmt;
  // (the later interpolations vary slowest, as jq)
  function* upTo(k: number): Generator<string> {
    if (k === 0) { yield ''; return; }
    const part = n.parts[k - 1];
    if (typeof part === 'string') { for (const pre of upTo(k - 1)) yield pre + part; return; }
    for (const [x] of ev(part, v, null, env)) {
      const s = fmt ? format(fmt, x) : tostr(x);
      for (const pre of upTo(k - 1)) yield pre + s;
    }
  }
  yield* upTo(n.parts.length);
}

function* construct(entries: ObjEntry[], i: number, acc: Record<string, V>, v: V, env: Env): Generator<Record<string, V>> {
  if (i === entries.length) { yield acc; return; }
  const e = entries[i];
  for (const [k] of ev(e.key, v, null, env)) {
    if (typeof k !== 'string') throw new JqError(`Object keys must be strings`);
    for (const [x] of ev(e.value, v, null, env)) yield* construct(entries, i + 1, put({ ...acc }, k, x), v, env);
  }
}

function* bindPatterns(pats: Pattern[], src: V, env: Env, body: (e: Env) => Generator<Out>): Generator<Out> {
  if (pats.length === 1) { for (const e2 of destructure(pats[0], src, env, [])) yield* body(e2); return; }
  // `?//`: the next pattern when one fails (in binding or in the body); every pattern's variables exist, null when unbound
  const all = [...new Set(pats.flatMap((q) => patternVars(q)))];
  for (let i = 0; i < pats.length; i++) {
    try {
      for (const e2 of destructure(pats[i], src, env, all)) yield* body(e2);
      return;
    } catch (e) {
      if (!(e instanceof JqError) || i === pats.length - 1) throw e;
    }
  }
}

function* destructure(pat: Pattern, src: V, env: Env, all: string[]): Generator<Env> {
  const vars = new Map<string, V>(all.map((n) => [n.slice(1), null]));
  for (const _ of bindInto(pat, src, env, vars)) yield new Env(env, new Map(vars));
}

function* bindInto(pat: Pattern, v: V, env: Env, vars: Map<string, V>): Generator<void> {
  if (pat.t === 'var') { vars.set(pat.name, v); yield; return; }
  if (pat.t === 'array') {
    if (v !== null && !Array.isArray(v)) throw new JqError(`Cannot index ${typeOf(v)} with number`);
    const items = pat.items;
    function* rec(i: number): Generator<void> {
      if (i === items.length) { yield; return; }
      for (const _ of bindInto(items[i], index(v, i), env, vars)) yield* rec(i + 1);
    }
    yield* rec(0);
    return;
  }
  const entries = pat.entries;
  function* rec(i: number): Generator<void> {
    if (i === entries.length) { yield; return; }
    const e = entries[i];
    if (e.keyVar) {
      const x = index(v, e.keyVar);
      vars.set(e.keyVar, x);
      if (e.pattern) { for (const _ of bindInto(e.pattern, x, env, vars)) yield* rec(i + 1); }
      else yield* rec(i + 1);
      return;
    }
    for (const [k] of ev(e.key!, v, null, new Env(env, new Map(vars)))) {
      if (typeof k !== 'string') throw new JqError(`Cannot index ${typeOf(v)} with ${typeOf(k)}`);
      for (const _ of bindInto(e.pattern!, index(v, k), env, vars)) yield* rec(i + 1);
    }
  }
  yield* rec(0);
}

/** The paths lhs selects in v */
function pathsOf(lhs: Node, v: V, env: Env): Path[] {
  return Array.from(ev(lhs, v, [], env), (o) => o[1] as Path);
}

function* assign(n: Extract<Node, { t: 'assign' }>, v: V, p: Path | null, env: Env): Generator<Out> {
  if (n.op === '|=') {
    // jq 1.7's _modify: the first output of the update; the paths it gives none are deleted, together, at the end
    let r = v;
    const del: Path[] = [];
    for (const q of pathsOf(n.left, v, env)) {
      const first = ev(n.right, getpath(r, q), null, env).next();
      if (first.done) del.push(q); else r = setpath(r, q, 0, first.value[0]);
    }
    yield* one(del.length ? delpaths(r, del) : r, p);
    return;
  }
  for (const [x] of ev(n.right, v, null, env)) {
    let r = v;
    for (const q of pathsOf(n.left, v, env)) {
      let nv: V;
      if (n.op === '=') nv = x;
      else if (n.op === '//=') { const old = getpath(r, q); nv = truthy(old) ? old : x; }
      else nv = binop(n.op[0], getpath(r, q), x);
      r = setpath(r, q, 0, nv);
    }
    yield* one(r, p);
  }
}

// ─── Builtins ────────────────────────────────────────────────────────────

/** Each combination of the arguments' values (the first argument outermost) */
function* argCombos(args: Node[], v: V, env: Env, i = 0, acc: V[] = []): Generator<V[]> {
  if (i === args.length) { yield acc.slice(); return; }
  for (const [x] of ev(args[i], v, null, env)) { acc[i] = x; yield* argCombos(args, v, env, i + 1, acc); }
}
/** A builtin of the input and its arguments' values: one output per combination */
const fn = (f: (v: V, ...a: V[]) => V): Native => function* (v, p, args, env) {
  for (const a of argCombos(args, v, env)) yield* one(f(v, ...a), p);
};
/** A builtin that outputs any number of values per combination */
const gen = (f: (v: V, ...a: V[]) => Iterable<V>): Native => function* (v, p, args, env) {
  for (const a of argCombos(args, v, env)) for (const x of f(v, ...a)) yield* one(x, p);
};
const num = (name: string, f: (x: number) => V) => fn((v) => {
  if (typeof v !== 'number') throw new JqError(`${brief(v)} number required`);
  return f(v);
});
const num2 = (f: (a: number, b: number) => V) => fn((_v, a, b) => {
  if (typeof a !== 'number' || typeof b !== 'number') throw new JqError(`${brief(typeof a !== 'number' ? a : b)} number required`);
  return f(a, b);
});
const explodes = (f: (s: string) => V) => fn((v) => {
  if (typeof v !== 'string') throw new JqError('explode input must be a string');
  return f(v);
});
const str = (name: string, f: (s: string) => V) => fn((v) => {
  if (typeof v !== 'string') throw new JqError(`${brief(v)} cannot be ${name}`);
  return f(v);
});
/** The values f gives for x, as sort keys */
const keyOf = (f: Node, x: V, env: Env) => vals(f, x, env);

function sortedBy(v: V, f: Node, env: Env, what: string): [V, V][] {
  if (!Array.isArray(v)) throw new JqError(`${brief(v)} cannot be ${what}, as it is not an array`);
  return v.map((x) => [keyOf(f, x, env), x] as [V, V]).sort((a, b) => compare(a[0], b[0]));
}

function contains(a: V, b: V, top = true): boolean {
  if (typeOf(a) !== typeOf(b)) {
    if (top) throw new JqError(`${brief(a)} and ${brief(b)} cannot have their containment checked`);
    return false;
  }
  if (isObj(a)) return Object.keys(b).every((k) => own(a, k) && contains(a[k], b[k], false));
  if (Array.isArray(a)) return (b as V[]).every((y) => a.some((x) => contains(x, y, false)));
  if (typeof a === 'string') return a.includes(b);
  return equal(a, b);
}

function indicesOf(v: V, x: V): V {
  if (v === null) return null;
  if (typeof v === 'string' && typeof x === 'string') {
    if (x === '') return null;
    const out: number[] = [];
    for (let i = v.indexOf(x); i >= 0; i = v.indexOf(x, i + 1)) out.push(cpIndex(v, i));
    return out;
  }
  if (Array.isArray(v)) return subarrayIndices(v, Array.isArray(x) ? x : [x]);
  throw new JqError(`Cannot determine the indices of ${brief(x)} in ${brief(v)}`);
}

function flatten(v: V, depth: V): V {
  if (!Array.isArray(v)) throw new JqError(`Cannot iterate over ${brief(v)}`);
  if (typeof depth !== 'number') throw new JqError('flatten depth must not be negative');
  if (depth < 0) throw new JqError('flatten depth must not be negative');
  const out: V[] = [];
  const walk = (a: V[], d: number) => { for (const x of a) { if (Array.isArray(x) && d > 0) walk(x, d - 1); else out.push(x); } };
  walk(v, depth);
  return out;
}

function addAll(v: V): V {
  const items = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : null;
  if (!items) throw new JqError(`Cannot iterate over ${brief(v)}`);
  if (items.length && items.every((x) => typeof x === 'string')) return items.join('');
  if (items.length && items.every((x) => Array.isArray(x))) return ([] as V[]).concat(...items);
  return items.reduce((acc, x) => binop('+', acc, x), null);
}

// Regular expressions: JS's, with the u flag where the pattern allows it; offsets in code points
interface Rx { rx: RegExp; global: boolean; noEmpty: boolean; names: (string | null)[] }
function captureNames(src: string): (string | null)[] {
  const names: (string | null)[] = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c !== '(') continue;
    if (src[i + 1] !== '?') { names.push(null); continue; }
    const m = /^\(\?(?:P?<([a-zA-Z_][a-zA-Z0-9_]*)>)/.exec(src.slice(i));
    if (m) names.push(m[1]);
  }
  return names;
}
function regex(re: V, flags: V): Rx {
  if (typeof re !== 'string') throw new JqError(`${brief(re)} cannot be matched, as it is not a string`);
  if (flags !== null && flags !== undefined && typeof flags !== 'string') throw new JqError(`${brief(flags)} is not a string`);
  let global = false, noEmpty = false, js = 'd';
  let src = re;
  for (const f of flags ?? '') {
    if (f === 'g') global = true;
    else if (f === 'i') js += 'i';
    else if (f === 'n') noEmpty = true;
    else if (f === 'p') js += 's';
    else if (f === 's') { /* single-line mode: ^ and $ are already the whole string's */ }
    else if (f === 'x') src = src.replace(/\\.|\s+|#[^\n]*/g, (m) => (m[0] === '\\' ? m : ''));
    else if (f !== 'l') throw new JqError(`${flags} is not a valid modifier string`);
  }
  // Oniguruma spellings JS lacks
  const inline = /^\(\?([imsx]+)\)/.exec(src);
  if (inline) { src = src.slice(inline[0].length); if (inline[1].includes('i')) js += 'i'; if (inline[1].includes('s') || inline[1].includes('m')) js += 's'; }
  src = src.replace(/\\[AzZh]|\(\?P</g, (m) => ({ '\\A': '^', '\\z': '$', '\\Z': '(?=\\n?$)', '\\h': '[0-9a-fA-F]', '(?P<': '(?<' } as Record<string, string>)[m]);
  let rx: RegExp;
  try { rx = new RegExp(src, js + 'gu'); } catch {
    try { rx = new RegExp(src, js + 'g'); } catch (e: any) { throw new JqError(`${re} (at offset 0) is not a valid regex: ${e.message}`); }
  }
  return { rx, global, noEmpty, names: captureNames(src) };
}
function* matches(s: string, r: Rx): Generator<V> {
  if (typeof s !== 'string') throw new JqError(`${brief(s)} cannot be matched, as it is not a string`);
  r.rx.lastIndex = 0;
  while (r.rx.lastIndex <= s.length) {
    const m = r.rx.exec(s) as (RegExpExecArray & { indices?: [number, number][] }) | null;
    if (!m) return;
    if (m[0] === '') r.rx.lastIndex = m.index + ((s.codePointAt(m.index) ?? 0) > 0xffff ? 2 : 1);
    if (!(m[0] === '' && r.noEmpty)) {
      yield {
        offset: cpIndex(s, m.index),
        length: cpLength(m[0]),
        string: m[0],
        captures: m.slice(1).map((c, i) => {
          const at = m.indices?.[i + 1];
          return c === undefined
            ? { offset: -1, length: 0, string: null, name: r.names[i] ?? null }
            : { offset: at ? cpIndex(s, at[0]) : -1, length: cpLength(c), string: c, name: r.names[i] ?? null };
        }),
      };
    }
    if (!r.global) return;
  }
}
const captureObject = (m: V) => {
  const o: Record<string, V> = {};
  for (const c of m.captures) if (c.name) put(o, c.name, c.string);
  return o;
};

function* subGen(v: V, re: V, repl: Node, flags: V, env: Env): Generator<string> {
  if (typeof v !== 'string') throw new JqError(`${brief(v)} cannot be matched, as it is not a string`);
  const ms = Array.from(matches(v, regex(re, flags)));
  // each match's replacements (the replacement filter's input: the named captures)
  const repls = ms.map((m) => vals(repl, captureObject(m), env).map((x) => {
    if (typeof x !== 'string') throw new JqError(`${brief(x)} cannot be added to a string`);
    return x;
  }));
  const cps = hasSurrogates(v) ? Array.from(v) : null;
  const at = (a: number, b?: number) => (cps ? cps.slice(a, b).join('') : v.slice(a, b));
  function* build(i: number, pos: number, acc: string): Generator<string> {
    if (i === ms.length) { yield acc + at(pos); return; }
    for (const r of repls[i]) yield* build(i + 1, ms[i].offset + ms[i].length, acc + at(pos, ms[i].offset) + r);
  }
  yield* build(0, 0, '');
}

function splitRegex(v: V, re: V, flags: V): V {
  if (typeof v !== 'string') throw new JqError(`${brief(v)} cannot be matched, as it is not a string`);
  const ms = Array.from(matches(v, { ...regex(re, flags), global: true }));
  const cps = hasSurrogates(v) ? Array.from(v) : null;
  const at = (a: number, b?: number) => (cps ? cps.slice(a, b).join('') : v.slice(a, b));
  const out: string[] = [];
  let pos = 0;
  for (const m of ms) { out.push(at(pos, m.offset)); pos = m.offset + m.length; }
  out.push(at(pos));
  return out;
}

// Dates: jq's broken-down time is [year, month (0-11), mday, hours, minutes, seconds, wday, yday]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function brokenDown(t: number, utc: boolean): V[] {
  const d = new Date(Math.floor(t) * 1000);
  const frac = t - Math.floor(t);
  const g = utc
    ? [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCDay()]
    : [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getDay()];
  const yday = Math.round((Date.UTC(g[0], g[1], g[2]) - Date.UTC(g[0], 0, 1)) / 86400000);
  return [g[0], g[1], g[2], g[3], g[4], g[5] + frac, g[6], yday];
}
function timeOf(bd: V): number {
  if (!Array.isArray(bd)) throw new JqError('mktime requires array inputs');
  if (bd.length < 6 || bd.slice(0, 6).some((x) => typeof x !== 'number')) throw new JqError('mktime requires parsed datetime inputs');
  return Date.UTC(bd[0], bd[1], bd[2], bd[3], bd[4], Math.floor(bd[5])) / 1000;
}
function asBrokenDown(v: V, utc: boolean, name: string): V[] {
  if (typeof v === 'number') return brokenDown(v, utc);
  if (Array.isArray(v) && v.length >= 6 && v.slice(0, 6).every((x) => typeof x === 'number')) return v;
  throw new JqError(`${name}/1 requires parsed datetime inputs`);
}
function strftime(v: V, fmt: V, utc: boolean, name: string): string {
  if (typeof fmt !== 'string') throw new JqError(`${name}/1 requires a string format`);
  const bd = asBrokenDown(v, utc, name);
  const [Y, M, D, h, m] = bd as number[];
  const s = Math.floor(bd[5]);
  const wday = typeof bd[6] === 'number' ? bd[6] : new Date(Date.UTC(Y, M, D)).getUTCDay();
  const yday = typeof bd[7] === 'number' ? bd[7] : Math.round((Date.UTC(Y, M, D) - Date.UTC(Y, 0, 1)) / 86400000);
  const p2 = (x: number) => String(x).padStart(2, '0');
  const off = utc ? 0 : -new Date(Date.UTC(Y, M, D, h, m, s)).getTimezoneOffset();
  const map: Record<string, () => string> = {
    Y: () => String(Y), C: () => p2(Math.floor(Y / 100)), y: () => p2(Y % 100), m: () => p2(M + 1), d: () => p2(D), e: () => String(D).padStart(2, ' '),
    H: () => p2(h), I: () => p2(h % 12 || 12), M: () => p2(m), S: () => p2(s), j: () => String(yday + 1).padStart(3, '0'),
    a: () => DAYS[wday].slice(0, 3), A: () => DAYS[wday], b: () => MONTHS[M].slice(0, 3), h: () => MONTHS[M].slice(0, 3), B: () => MONTHS[M],
    p: () => (h < 12 ? 'AM' : 'PM'), u: () => String(wday || 7), w: () => String(wday),
    Z: () => (utc ? 'UTC' : Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value ?? ''),
    z: () => (off < 0 ? '-' : '+') + p2(Math.floor(Math.abs(off) / 60)) + p2(Math.abs(off) % 60),
    s: () => String(timeOf(bd) - off * 60), n: () => '\n', t: () => '\t', '%': () => '%',
    T: () => `${p2(h)}:${p2(m)}:${p2(s)}`, D: () => `${p2(M + 1)}/${p2(D)}/${p2(Y % 100)}`, F: () => `${Y}-${p2(M + 1)}-${p2(D)}`,
    R: () => `${p2(h)}:${p2(m)}`, r: () => `${p2(h % 12 || 12)}:${p2(m)}:${p2(s)} ${h < 12 ? 'AM' : 'PM'}`,
    c: () => `${DAYS[wday].slice(0, 3)} ${MONTHS[M].slice(0, 3)} ${String(D).padStart(2, ' ')} ${p2(h)}:${p2(m)}:${p2(s)} ${Y}`,
    G: () => String(Y), U: () => p2(Math.floor((yday + 7 - wday) / 7)), V: () => p2(Math.max(1, Math.floor((yday - ((wday + 6) % 7) + 10) / 7))),
  };
  return fmt.replace(/%([a-zA-Z%])/g, (all, c) => (map[c] ? map[c]() : all));
}
function strptime(v: V, fmt: V): V[] {
  if (typeof v !== 'string') throw new JqError(`strptime/1 requires string inputs and arguments`);
  if (typeof fmt !== 'string') throw new JqError(`strptime/1 requires string inputs and arguments`);
  let Y = 1900, M = 0, D = 1, h = 0, m = 0, s = 0, pm: boolean | null = null, epoch: number | null = null;
  let i = 0;
  const fail = (): never => { throw new JqError(`date "${v}" does not match format "${fmt}"`); };
  const int = (max: number, signed = false) => {
    const re = new RegExp(`^${signed ? '[+-]?' : ''}\\d{1,${max}}`);
    const mm = re.exec(v.slice(i));
    if (!mm) fail();
    i += mm![0].length;
    return Number(mm![0]);
  };
  const word = (list: string[]) => {
    const rest = v.slice(i).toLowerCase();
    for (let k = 0; k < list.length; k++) {
      for (const w of [list[k], list[k].slice(0, 3)]) if (rest.startsWith(w.toLowerCase())) { i += w.length; return k; }
    }
    return fail();
  };
  for (let f = 0; f < fmt.length; f++) {
    const c = fmt[f];
    if (c === '%') {
      const d = fmt[++f];
      switch (d) {
        case 'Y': Y = int(4, true); break;
        case 'm': M = int(2) - 1; break;
        case 'd': case 'e': while (v[i] === ' ') i++; D = int(2); break;
        case 'H': h = int(2); break;
        case 'I': h = int(2); break;
        case 'M': m = int(2); break;
        case 'S': s = int(2); break;
        case 'j': int(3); break;
        case 'y': { const y = int(2); Y = y < 69 ? 2000 + y : 1900 + y; break; }
        case 'b': case 'B': case 'h': M = word(MONTHS); break;
        case 'a': case 'A': word(DAYS); break;
        case 'p': { const r = v.slice(i, i + 2).toUpperCase(); if (r !== 'AM' && r !== 'PM') fail(); pm = r === 'PM'; i += 2; break; }
        case 'Z': { const mm = /^[A-Za-z]+/.exec(v.slice(i)); if (mm) i += mm[0].length; break; }
        case 'z': { const mm = /^(?:Z|[+-]\d{2}:?\d{2})/.exec(v.slice(i)); if (!mm) fail(); i += mm![0].length; break; }
        case 's': epoch = int(20, true); break;
        case 'T': h = int(2); if (v[i++] !== ':') fail(); m = int(2); if (v[i++] !== ':') fail(); s = int(2); break;
        case 'D': M = int(2) - 1; if (v[i++] !== '/') fail(); D = int(2); if (v[i++] !== '/') fail(); { const y = int(2); Y = y < 69 ? 2000 + y : 1900 + y; } break;
        case 'F': Y = int(4, true); if (v[i++] !== '-') fail(); M = int(2) - 1; if (v[i++] !== '-') fail(); D = int(2); break;
        case 'R': h = int(2); if (v[i++] !== ':') fail(); m = int(2); break;
        case 'n': case 't': while (/\s/.test(v[i] ?? '')) i++; break;
        case '%': if (v[i++] !== '%') fail(); break;
        default: throw new JqError(`strptime/1: unsupported conversion %${d}`);
      }
    } else if (/\s/.test(c)) {
      while (/\s/.test(v[i] ?? '')) i++;
    } else if (v[i++] !== c) fail();
  }
  if (i !== v.length) fail();
  if (pm !== null) h = (h % 12) + (pm ? 12 : 0);
  if (epoch !== null) return brokenDown(epoch, true);
  const t = Date.UTC(Y, M, D, h, m, s);
  const d = new Date(t);
  const yday = Math.round((Date.UTC(Y, M, D) - Date.UTC(Y, 0, 1)) / 86400000);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCDay(), yday];
}
function fromdate(v: V): number {
  if (typeof v !== 'string') throw new JqError(`strptime/1 requires string inputs and arguments`);
  // (fractional seconds too: they are kept)
  const m = /^(.*T\d\d:\d\d:\d\d)(\.\d+)?Z$/.exec(v);
  const t = timeOf(strptime(m ? m[1] + 'Z' : v, '%Y-%m-%dT%H:%M:%SZ'));
  return m?.[2] ? t + Number(m[2]) : t;
}

// @formats
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);
function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function format(name: string, v: V): string {
  switch (name) {
    case 'text': return tostr(v);
    case 'json': return dump(v);
    case 'html': return tostr(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' } as Record<string, string>)[c]);
    case 'uri': return Array.from(utf8(tostr(v)), (b) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');
    case 'csv': case 'tsv': {
      if (!Array.isArray(v)) throw new JqError(`${brief(v)} cannot be ${name}-formatted, only an array can be`);
      return v.map((x) => {
        if (typeof x === 'number') return dump(x);
        if (typeof x === 'boolean') return String(x);
        if (x === null) return '';
        if (typeof x === 'string') {
          return name === 'csv' ? '"' + x.replace(/"/g, '""') + '"' : x.replace(/[\\\t\n\r]/g, (c) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' } as Record<string, string>)[c]);
        }
        throw new JqError(`${brief(x)} is not valid in a ${name} row`);
      }).join(name === 'csv' ? ',' : '\t');
    }
    case 'sh': {
      const q = (x: V) => {
        if (typeof x === 'string') return "'" + x.replace(/'/g, "'\\''") + "'";
        if (Array.isArray(x) || isObj(x)) throw new JqError(`${brief(x)} can not be escaped for shell`);
        return dump(x);
      };
      return Array.isArray(v) ? v.map(q).join(' ') : q(v);
    }
    case 'base64': return bytesToBase64(utf8(tostr(v)));
    case 'base64d': {
      const s = tostr(v).replace(/[\s=]+$/g, '').replace(/-/g, '+').replace(/_/g, '/');
      if (/[^A-Za-z0-9+/]/.test(s) || s.length % 4 === 1) throw new JqError(`${brief(v)} is not valid base64 data`);
      const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
      return fromUtf8(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    case 'base32': {
      const b = utf8(tostr(v));
      let out = '', bits = 0, acc = 0;
      for (const x of b) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; } }
      if (bits) out += B32[(acc << (5 - bits)) & 31];
      return out + '='.repeat((8 - (out.length % 8)) % 8);
    }
    case 'base32d': {
      const s = tostr(v).replace(/=+$/, '').toUpperCase();
      const bytes: number[] = [];
      let bits = 0, acc = 0;
      for (const c of s) {
        const i = B32.indexOf(c);
        if (i < 0) throw new JqError(`${brief(v)} is not valid base32 data`);
        acc = (acc << 5) | i; bits += 5;
        if (bits >= 8) { bytes.push((acc >> (bits - 8)) & 255); bits -= 8; }
      }
      return fromUtf8(Uint8Array.from(bytes));
    }
  }
  throw new JqError(`${name} is not a valid format`);
}

const MATH1: Record<string, (x: number) => number> = {
  floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, fabs: Math.abs, trunc: Math.trunc,
  round: (x) => Math.sign(x) * Math.round(Math.abs(x)),
  rint: (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; },
  nearbyint: (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; },
  exp: Math.exp, exp2: (x) => 2 ** x, exp10: (x) => 10 ** x, expm1: Math.expm1,
  log: Math.log, log2: Math.log2, log10: Math.log10, log1p: Math.log1p, logb: (x) => Math.floor(Math.log2(Math.abs(x))),
  significand: (x) => (x === 0 ? 0 : x / 2 ** Math.floor(Math.log2(Math.abs(x)))),
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh, cbrt: Math.cbrt,
};

function tostreamGen(v: V): Generator<V> {
  function* walk(x: V, p: Path): Generator<V> {
    const keys = Array.isArray(x) ? x.map((_, i) => i) : isObj(x) ? Object.keys(x) : null;
    if (!keys || keys.length === 0) { yield [p, x]; return; }
    for (const k of keys) yield* walk((x as any)[k], [...p, k]);
    yield [[...p, keys[keys.length - 1]]];
  }
  return walk(v, []);
}

const NATIVES: Record<string, Native> = {
  'empty/0': function* () { /* no outputs */ },
  'select/1': function* (v, p, args, env) { for (const [c] of ev(args[0], v, null, env)) if (truthy(c)) yield [v, p]; },
  'map/1': function* (v, p, args, env) {
    const out: V[] = [];
    for (const [x] of iterate(v, null)) for (const [y] of ev(args[0], x, null, env)) out.push(y);
    yield* one(out, p);
  },
  'not/0': fn((v) => !truthy(v)),
  'error/0': function* (v) { throw new JqError(errorMessage(v), v); },
  'error/1': function* (v, _p, args, env) { for (const [m] of ev(args[0], v, null, env)) throw new JqError(errorMessage(m), m); },
  'path/1': function* (v, p, args, env) { for (const [, q] of ev(args[0], v, [], env)) yield* one(q, p); },
  'getpath/1': function* (v, p, args, env) {
    for (const [q] of ev(args[0], v, null, env)) {
      checkPath(q);
      yield [getpath(v, q), p ? [...p, ...q] : null];
    }
  },
  'setpath/2': fn((v, q, x) => setpath(v, checkPath(q), 0, x)),
  'delpaths/1': fn((v, ps) => delpaths(v, ps)),
  'to_entries/0': fn((v) => {
    if (isObj(v)) return Object.keys(v).map((key) => ({ key, value: v[key] }));
    if (Array.isArray(v)) return v.map((value, key) => ({ key, value }));
    throw new JqError(`${brief(v)} has no keys`);
  }),
  'length/0': fn((v) => {
    if (v === null) return 0;
    if (typeof v === 'boolean') throw new JqError(`${brief(v)} has no length`);
    if (typeof v === 'number') return Math.abs(v);
    if (typeof v === 'string') return cpLength(v);
    return Array.isArray(v) ? v.length : Object.keys(v).length;
  }),
  'utf8bytelength/0': fn((v) => { if (typeof v !== 'string') throw new JqError(`${brief(v)} only strings have UTF-8 byte length`); return utf8(v).length; }),
  'keys/0': fn((v) => { if (isObj(v)) return Object.keys(v).sort(); if (Array.isArray(v)) return v.map((_, i) => i); throw new JqError(`${brief(v)} has no keys`); }),
  'keys_unsorted/0': fn((v) => { if (isObj(v)) return Object.keys(v); if (Array.isArray(v)) return v.map((_, i) => i); throw new JqError(`${brief(v)} has no keys`); }),
  'has/1': fn((v, k) => {
    if (isObj(v) && typeof k === 'string') return own(v, k);
    if (Array.isArray(v) && typeof k === 'number') return k >= 0 && k < v.length;
    throw new JqError(`Cannot check whether ${typeOf(v)} has a ${typeOf(k)} key`);
  }),
  'contains/1': fn((a, b) => contains(a, b)),
  'type/0': fn(typeOf),
  'tostring/0': fn(tostr),
  'tonumber/0': fn((v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(v)) return Number(v);
    if (typeof v === 'string') throw new JqError(`Cannot parse '${v}' as JSON`);
    throw new JqError(`${brief(v)} cannot be parsed as a number`);
  }),
  'tojson/0': fn(dump),
  'fromjson/0': fn((v) => {
    if (typeof v !== 'string') throw new JqError(`${brief(v)} only strings can be parsed`);
    try { return JSON.parse(v); } catch (e: any) { throw new JqError(`${e.message} (while parsing '${v}')`); }
  }),
  'ascii_downcase/0': explodes((s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())),
  'ascii_upcase/0': explodes((s) => s.replace(/[a-z]/g, (c) => c.toUpperCase())),
  'explode/0': explodes((s) => Array.from(s, (c) => c.codePointAt(0)!)),
  'implode/0': fn((v) => {
    if (!Array.isArray(v)) throw new JqError('implode input must be an array');
    return v.map((c) => {
      if (typeof c !== 'number') throw new JqError('Unicode codepoint must be numeric');
      return c >= 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) ? String.fromCodePoint(c) : '\ufffd';
    }).join('');
  }),
  'ltrimstr/1': fn((v, s) => (typeof v === 'string' && typeof s === 'string' && v.startsWith(s) ? v.slice(s.length) : v)),
  'rtrimstr/1': fn((v, s) => (typeof v === 'string' && typeof s === 'string' && s && v.endsWith(s) ? v.slice(0, -s.length) : v)),
  'trim/0': str('trimmed', (s) => s.trim()),
  'ltrim/0': str('trimmed', (s) => s.trimStart()),
  'rtrim/0': str('trimmed', (s) => s.trimEnd()),
  'startswith/1': fn((v, s) => { if (typeof v !== 'string' || typeof s !== 'string') throw new JqError('startswith() requires string inputs'); return v.startsWith(s); }),
  'endswith/1': fn((v, s) => { if (typeof v !== 'string' || typeof s !== 'string') throw new JqError('endswith() requires string inputs'); return v.endsWith(s); }),
  'split/1': fn((v, s) => {
    if (typeof v !== 'string' || typeof s !== 'string') throw new JqError('split input and separator must be strings');
    if (v === '') return [];
    return s === '' ? Array.from(v) : v.split(s);
  }),
  'split/2': fn((v, re, flags) => splitRegex(v, re, flags)),
  'join/1': fn((v, sep) => {
    if (!Array.isArray(v)) throw new JqError(`Cannot iterate over ${brief(v)}`);
    if (v.length === 0) return '';
    if (typeof sep !== 'string') throw new JqError(`${brief(sep)} and string cannot be added`);
    let acc = '';
    v.forEach((x, i) => {
      if (Array.isArray(x) || isObj(x)) throw new JqError(`${brief(i ? acc + sep : acc)} and ${brief(x)} cannot be added`);
      acc += (i ? sep : '') + (x === null ? '' : typeof x === 'string' ? x : dump(x));
    });
    return acc;
  }),
  'test/1': fn((v, re) => !matches(v, regex(re, null)).next().done),
  'test/2': fn((v, re, flags) => !matches(v, regex(re, flags)).next().done),
  'match/1': gen((v, re) => matches(v, regex(re, null))),
  'match/2': gen((v, re, flags) => matches(v, regex(re, flags))),
  'capture/1': gen(function* (v, re) { for (const m of matches(v, regex(re, null))) yield captureObject(m); }),
  'capture/2': gen(function* (v, re, flags) { for (const m of matches(v, regex(re, flags))) yield captureObject(m); }),
  'scan/1': gen(function* (v, re) { yield* scan(v, re, null); }),
  'scan/2': gen(function* (v, re, flags) { yield* scan(v, re, flags); }),
  'sub/2': function* (v, p, args, env) { for (const [re] of ev(args[0], v, null, env)) for (const s of subGen(v, re, args[1], '', env)) yield* one(s, p); },
  'sub/3': function* (v, p, args, env) {
    for (const [flags] of ev(args[2], v, null, env)) for (const [re] of ev(args[0], v, null, env)) for (const s of subGen(v, re, args[1], flags, env)) yield* one(s, p);
  },
  'gsub/2': function* (v, p, args, env) { for (const [re] of ev(args[0], v, null, env)) for (const s of subGen(v, re, args[1], 'g', env)) yield* one(s, p); },
  'gsub/3': function* (v, p, args, env) {
    for (const [flags] of ev(args[2], v, null, env)) for (const [re] of ev(args[0], v, null, env)) for (const s of subGen(v, re, args[1], 'g' + (flags ?? ''), env)) yield* one(s, p);
  },
  'sort/0': fn((v) => { if (!Array.isArray(v)) throw new JqError(`${brief(v)} cannot be sorted, as it is not an array`); return [...v].sort(compare); }),
  'sort_by/1': function* (v, p, args, env) { yield* one(sortedBy(v, args[0], env, 'sorted').map((e) => e[1]), p); },
  'group_by/1': function* (v, p, args, env) {
    const out: V[][] = [];
    let last: V = undefined;
    for (const [k, x] of sortedBy(v, args[0], env, 'grouped')) {
      if (out.length && equal(k, last)) out[out.length - 1].push(x); else out.push([x]);
      last = k;
    }
    yield* one(out, p);
  },
  'unique_by/1': function* (v, p, args, env) {
    const out: V[] = [];
    let last: V = undefined, first = true;
    for (const [k, x] of sortedBy(v, args[0], env, 'sorted')) { if (first || !equal(k, last)) out.push(x); last = k; first = false; }
    yield* one(out, p);
  },
  'unique/0': fn((v) => {
    if (!Array.isArray(v)) throw new JqError(`${brief(v)} cannot be sorted, as it is not an array`);
    return [...v].sort(compare).filter((x, i, a) => i === 0 || !equal(x, a[i - 1]));
  }),
  'min/0': fn((v) => { if (!Array.isArray(v)) throw new JqError(`${brief(v)} cannot be sorted, as it is not an array`); return v.length ? v.reduce((a, b) => (compare(b, a) < 0 ? b : a)) : null; }),
  'max/0': fn((v) => { if (!Array.isArray(v)) throw new JqError(`${brief(v)} cannot be sorted, as it is not an array`); return v.length ? v.reduce((a, b) => (compare(b, a) >= 0 ? b : a)) : null; }),
  'min_by/1': function* (v, p, args, env) { const s = sortedBy(v, args[0], env, 'sorted'); yield* one(s.length ? s[0][1] : null, p); },
  'max_by/1': function* (v, p, args, env) { const s = sortedBy(v, args[0], env, 'sorted'); yield* one(s.length ? s[s.length - 1][1] : null, p); },
  'reverse/0': fn((v) => {
    if (v === null) return [];
    if (typeof v === 'string') return Array.from(v).reverse().join('');
    if (Array.isArray(v)) return [...v].reverse();
    throw new JqError(`Cannot index ${typeOf(v)} with number`);
  }),
  'flatten/0': fn((v) => flatten(v, 1e9)),
  'flatten/1': fn((v, d) => flatten(v, d)),
  'add/0': fn(addAll),
  'any/0': fn((v) => { for (const [x] of iterate(v, null)) if (truthy(x)) return true; return false; }),
  'all/0': fn((v) => { for (const [x] of iterate(v, null)) if (!truthy(x)) return false; return true; }),
  'any/1': function* (v, p, args, env) { yield* one(anyAll(iterate(v, null), args[0], env, true), p); },
  'all/1': function* (v, p, args, env) { yield* one(anyAll(iterate(v, null), args[0], env, false), p); },
  'any/2': function* (v, p, args, env) { yield* one(anyAll(ev(args[0], v, null, env), args[1], env, true), p); },
  'all/2': function* (v, p, args, env) { yield* one(anyAll(ev(args[0], v, null, env), args[1], env, false), p); },
  'isempty/1': function* (v, p, args, env) { yield* one(ev(args[0], v, null, env).next().done === true, p); },
  'range/1': gen(function* (_v, n) { if (typeof n !== 'number') throw new JqError('Range bounds must be numeric'); for (let i = 0; i < n; i++) yield i; }),
  'range/2': gen(function* (_v, a, b) { if (typeof a !== 'number' || typeof b !== 'number') throw new JqError('Range bounds must be numeric'); for (let i = a; i < b; i++) yield i; }),
  'range/3': gen(function* (_v, a, b, by) {
    if (typeof a !== 'number' || typeof b !== 'number' || typeof by !== 'number') throw new JqError('Range bounds must be numeric');
    if (by > 0) for (let i = a; i < b; i += by) yield i;
    else if (by < 0) for (let i = a; i > b; i += by) yield i;
  }),
  'pow/2': num2((a, b) => a ** b),
  'atan2/2': num2(Math.atan2),
  'fmin/2': num2(Math.min),
  'fmax/2': num2(Math.max),
  'fmod/2': num2((a, b) => a % b),
  'ldexp/2': num2((a, b) => a * 2 ** b),
  'scalb/2': num2((a, b) => a * 2 ** b),
  'copysign/2': num2((a, b) => Math.sign(b) * Math.abs(a) || (Object.is(b, -0) ? -Math.abs(a) : Math.abs(a))),
  'frexp/0': num('frexp', (x) => { if (x === 0 || !Number.isFinite(x)) return [x, 0]; const e = Math.floor(Math.log2(Math.abs(x))) + 1; return [x / 2 ** e, e]; }),
  'modf/0': num('modf', (x) => [x - Math.trunc(x), Math.trunc(x)]),
  'infinite/0': fn(() => Infinity),
  'nan/0': fn(() => NaN),
  'isinfinite/0': num('isinfinite', (x) => x === Infinity || x === -Infinity),
  'isnan/0': num('isnan', Number.isNaN),
  'isnormal/0': num('isnormal', (x) => Number.isFinite(x) && x !== 0 && Math.abs(x) >= 2.2250738585072014e-308),
  'indices/1': fn(indicesOf),
  'index/1': fn((v, x) => { const r = indicesOf(v, x); return r && r.length ? r[0] : null; }),
  'rindex/1': fn((v, x) => { const r = indicesOf(v, x); return r && r.length ? r[r.length - 1] : null; }),
  'tostream/0': gen(tostreamGen),
  'limit/2': function* (v, p, args, env) {
    for (const [n] of ev(args[0], v, null, env)) {
      if (typeof n !== 'number') throw new JqError('Invalid limit: must be a number');
      if (n < 0) { yield* ev(args[1], v, p, env); continue; }
      if (n === 0) continue;
      let c = 0;
      for (const o of ev(args[1], v, p, env)) { yield o; if (++c >= n) break; }
    }
  },
  'first/1': function* (v, p, args, env) { const r = ev(args[0], v, p, env).next(); if (!r.done) yield r.value; },
  'last/1': function* (v, p, args, env) { let last: Out | null = null; for (const o of ev(args[0], v, p, env)) last = o; if (last) yield last; },
  'recurse/1': function* (v, p, args, env) { yield* recurseGen(v, p, (x, xp) => ev(args[0], x, xp, env)); },
  'repeat/1': function* (v, p, args, env) { yield* recurseGen(v, p, (x, xp) => ev(args[0], x, xp, env)); },
  'while/2': function* (v, p, args, env) {
    const stack: Iterator<Out>[] = [[[v, p] as Out][Symbol.iterator]()];
    while (stack.length) {
      const r = stack[stack.length - 1].next();
      if (r.done) { stack.pop(); continue; }
      const [x, xp] = r.value;
      if (vals(args[0], x, env).some(truthy)) { yield [x, xp]; stack.push(ev(args[1], x, xp, env)); }
    }
  },
  'until/2': function* (v, p, args, env) {
    const stack: Iterator<Out>[] = [[[v, p] as Out][Symbol.iterator]()];
    while (stack.length) {
      const r = stack[stack.length - 1].next();
      if (r.done) { stack.pop(); continue; }
      const [x, xp] = r.value;
      if (vals(args[0], x, env).some(truthy)) yield [x, xp];
      else stack.push(ev(args[1], x, xp, env));
    }
  },
  'input/0': function* (_v, p) { const r = RT.nextInput(); if (!r) throw new JqError('No more inputs'); yield* one(r.value, p); },
  'inputs/0': function* (_v, p) { for (let r = RT.nextInput(); r; r = RT.nextInput()) yield* one(r.value, p); },
  'debug/0': function* (v, p) { RT.stderr(`["DEBUG:",${dump(v)}]\n`); yield [v, p]; },
  'stderr/0': function* (v, p) { RT.stderr(dump(v)); yield [v, p]; },
  'input_filename/0': fn(() => RT.filename),
  'halt/0': function* () { throw new HaltSignal(0); },
  'halt_error/1': function* (v, _p, args, env) {
    for (const [code] of ev(args[0], v, null, env)) {
      if (typeof code !== 'number') throw new JqError('halt_error/1: number required');
      throw new HaltSignal(code, typeof v === 'string' ? v : dump(v) + '\n');
    }
  },
  'now/0': fn(() => Date.now() / 1000),
  'mktime/0': fn((v) => timeOf(v)),
  'gmtime/0': fn((v) => { if (typeof v !== 'number') throw new JqError('gmtime() requires numeric inputs'); return brokenDown(v, true); }),
  'localtime/0': fn((v) => { if (typeof v !== 'number') throw new JqError('localtime() requires numeric inputs'); return brokenDown(v, false); }),
  'strftime/1': fn((v, f) => strftime(v, f, true, 'strftime')),
  'strflocaltime/1': fn((v, f) => strftime(v, f, false, 'strflocaltime')),
  'strptime/1': fn((v, f) => strptime(v, f)),
  'fromdate/0': fn(fromdate),
  'fromdateiso8601/0': fn(fromdate),
  'builtins/0': fn(() => builtinNames()),
  'input_line_number/0': fn(() => 0),
};
for (const [name, f] of Object.entries(MATH1)) NATIVES[`${name}/0`] = num(name, f);

function errorMessage(v: V): string {
  if (typeof v === 'string') return v;
  if (v === null) return 'null (null) not a string';
  return `${dump(v)} (not a string)`;
}

function anyAll(src: Iterator<Out>, cond: Node, env: Env, any: boolean): boolean {
  for (let r = src.next(); !r.done; r = src.next()) {
    for (const [c] of ev(cond, r.value[0], null, env)) {
      if (truthy(c) === any) return any;
    }
  }
  return !any;
}

function* scan(v: V, re: V, flags: V): Generator<V> {
  for (const m of matches(v, { ...regex(re, flags), global: true })) {
    yield m.captures.length ? m.captures.map((c: V) => c.string) : m.string;
  }
}

/** The rest of jq's builtins, in jq (as jq defines most of them) */
const PRELUDE = `
def values: select(. != null);
def nulls: select(. == null);
def booleans: select(type == "boolean");
def numbers: select(type == "number");
def strings: select(type == "string");
def arrays: select(type == "array");
def objects: select(type == "object");
def iterables: select(type|. == "array" or . == "object");
def scalars: select(type|. != "array" and . != "object");
def finites: select(isinfinite or isnan | not);
def normals: select(isnormal);
def map_values(f): .[] |= f;
def recurse: recurse(.[]?);
def recurse(f; cond): def r: ., (f | select(cond) | r); r;
def recurse_down: recurse;
def add(f): reduce f as $x (null; . + $x);
def from_entries: reduce .[] as $x ({};
  . + { ($x | if .key == null then .k // .name // .Name // .K // .Key else .key end
           | if type == "string" then . else tojson end):
        ($x | if has("value") then .value elif has("v") then .v else .Value end) });
def with_entries(f): to_entries | map(f) | from_entries;
def del(f): delpaths([path(f)]);
def paths: path(..) | select(length > 0);
def paths(node_filter): . as $dot | paths | select(. as $p | $dot | getpath($p) | node_filter);
def leaf_paths: paths(scalars);
def pick(pathexps): . as $top | reduce path(pathexps) as $p (null; setpath($p; $top | getpath($p)));
def isvalid(f): try (f | true) catch false;
def in(xs): . as $x | xs | has($x);
def inside(xs): . as $x | xs | contains($x);
def combinations: if length == 0 then [] else .[0][] as $x | (.[1:] | combinations) as $w | [$x] + $w end;
def combinations(n): . as $dot | [range(n)] | map($dot) | combinations;
def walk(f): def w: if type == "object" then map_values(w) elif type == "array" then map(w) else . end | f; w;
def transpose: if . == [] then [] else . as $in | (map(length) | max) as $max | [range(0; $max) as $j | [range(0; $in | length) as $i | $in[$i][$j]]] end;
def first: .[0];
def last: .[-1];
def nth($n): .[$n];
def nth($n; f): if $n < 0 then error("nth doesn't support negative indices") else last(limit($n + 1; f)) end;
def todate: strftime("%Y-%m-%dT%H:%M:%SZ");
def todateiso8601: todate;
def env: $ENV;
def halt_error: halt_error(5);
def debug(msg): (msg | debug | empty), .;
def splits($re; flags): split($re; flags) | .[];
def splits($re): splits($re; null);
def abs: if type == "number" and . < 0 then -. else . end;
def toarray: if type == "array" then . else [.] end;
def have_decnum: false;
def have_literal_numbers: true;
def INDEX(stream; idx_expr): reduce stream as $row ({}; .[$row | idx_expr | tostring] |= $row);
def INDEX(idx_expr): INDEX(.[]; idx_expr);
def IN(s): any(s == .; .);
def IN(src; s): any(src == s; .);
def fromstream(f): { x: null, e: false } as $init
  | foreach f as $i ($init;
      if .e then $init else . end
      | if $i | length == 2
        then setpath(["e"]; $i[0] | length == 0) | setpath(["x"] + $i[0]; $i[1])
        else setpath(["e"]; $i[0] | length == 1) end;
      if .e then .x else empty end);
def truncate_stream(stream): . as $n | null | stream | . as $input | if (.[0] | length) > $n then setpath([0]; .[0][$n:]) else empty end;
`;

let rootEnv: Env | null = null;
let rootScope: Scope | null = null;
function prelude(): [Env, Scope] {
  if (rootEnv && rootScope) return [rootEnv, rootScope];
  const natives = new Env(null, null, new Map(Object.entries(NATIVES).map(([k, impl]) => [k, { kind: 'native', impl } as Fn])));
  let env = natives;
  const names = new Set(Object.keys(NATIVES));
  const program = parseProgram(PRELUDE + ' .');
  check(program, new Scope(null, new Set([...names, '$ENV'])), { input: false });
  for (let n: Node = program; n.t === 'def'; n = n.rest) {
    env = new Env(env, null, new Map());
    env.funcs!.set(`${n.name}/${n.params.length}`, { kind: 'def', node: n, env });
    names.add(`${n.name}/${n.params.length}`);
  }
  rootEnv = env;
  rootScope = new Scope(null, names);
  return [env, rootScope];
}
function builtinNames(): string[] {
  return [...prelude()[1].names];
}

/** A program: parsed and checked (throws JqCompileError) */
interface Program { node: Node; usesInput: boolean }
function compile(src: string, vars: string[]): Program {
  const node = parseProgram(src);
  const uses = { input: false };
  check(node, prelude()[1].child(...vars.map((n) => '$' + n), '$ENV', '$ARGS'), uses);
  return { node, usesInput: uses.input };
}

// ─── Output ──────────────────────────────────────────────────────────────

interface OutOpts { raw: boolean; compact: boolean; indent: string | number; sortKeys: boolean; ascii: boolean }

function sortDeep(v: V): V {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isObj(v)) { const o: Record<string, V> = {}; for (const k of Object.keys(v).sort()) put(o, k, sortDeep(v[k])); return o; }
  return v;
}
function render(v: V, o: OutOpts): string {
  if (o.raw && typeof v === 'string') return v;
  if (o.sortKeys) v = sortDeep(v);
  let s = stringify(v, o.compact ? undefined : o.indent);
  if (s.includes('\u007f')) s = s.replace(/\u007f/g, '\\u007f');
  if (o.ascii) s = s.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return s;
}

// ─── Inputs ──────────────────────────────────────────────────────────────

class InputError extends Error {}

/** JSON texts one after another (whitespace between, or none: `1 2`, `{}{}`); at.line: the line the last one ended on */
function* jsonValues(text: string, name: string, at: { line: number } = { line: 0 }): Generator<V> {
  let i = 0, counted = 0;
  at.line = 1;
  const n = text.length;
  const ws = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 0xfeff;
  while (true) {
    while (i < n && ws(text.charCodeAt(i))) i++;
    if (i >= n) return;
    const start = i;
    const c = text[i];
    const skipString = (j: number) => { j++; while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1; return j + 1; };
    if (c === '{' || c === '[') {
      let depth = 0;
      while (i < n) {
        const ch = text[i];
        if (ch === '"') { i = skipString(i); continue; }
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
    } else if (c === '"') {
      i = skipString(i);
    } else {
      while (i < n && !ws(text.charCodeAt(i)) && !'{}[]"'.includes(text[i])) i++;
      if (i === start) i++;
    }
    const chunk = text.slice(start, i);
    let v: V;
    try {
      v = /^-?nan$/i.test(chunk) ? NaN : JSON.parse(chunk);
    } catch (e: any) {
      const line = text.slice(0, i).split('\n').length;
      throw new InputError(`jq: error (at ${name}:${line}): Cannot parse input: ${e.message}`);
    }
    for (let nl = text.indexOf('\n', counted); nl >= 0 && nl < i; nl = text.indexOf('\n', nl + 1)) at.line++;
    counted = i;
    yield v;
  }
}

function rawLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ─── Running ─────────────────────────────────────────────────────────────

/** Run `src` on `data` and print its outputs as jq does (pretty JSON, or `raw`/`compact`); gh's --jq. Throws JqError. */
export function evaluateJq(data: any, expr: string, raw = false, compact = false): string {
  let prog: Program;
  try { prog = compile(expr, []); } catch (e: any) { throw new JqError(e.message); }
  const env = new Env(prelude()[0], new Map<string, V>([['ARGS', { positional: [], named: {} }]]));
  const opts: OutOpts = { raw, compact, indent: 2, sortKeys: false, ascii: false };
  const saved = RT;
  RT = { nextInput: () => null, stderr: () => {}, filename: null, env: {} };
  try {
    const parts: string[] = [];
    for (const [v] of ev(prog.node, data, null, env)) parts.push(render(v, opts));
    return parts.map((s) => s + '\n').join('');
  } catch (e) {
    if (e instanceof JqError || e instanceof BreakSignal || e instanceof HaltSignal) throw e instanceof JqError ? e : new JqError('jq halted');
    if (e instanceof RangeError) throw new JqError('stack overflow');
    throw e;
  } finally {
    RT = saved;
  }
}

const HELP = `Usage:\tjq [OPTIONS] FILTER [FILES...]
\tjq [OPTIONS] --args FILTER [ARGUMENTS...]
\tjq [OPTIONS] --jsonargs FILTER [JSON_VALUES...]

jq is a tool for processing JSON inputs (this one is built in).

  -n, --null-input          use \`null\` as the single input value;
  -R, --raw-input           read each line as string instead of JSON;
  -s, --slurp               read all inputs into an array and use it as
                            the single input value;
  -c, --compact-output      compact instead of pretty-printed output;
  -r, --raw-output          output strings without escapes and quotes;
      --raw-output0         implies -r and output NUL after each output;
  -j, --join-output         implies -r and output without newline after
                            each output;
  -a, --ascii-output        output strings by only ASCII characters
                            using escape sequences;
  -S, --sort-keys           sort keys of each object on output;
      --tab                 use tabs for indentation;
      --indent n            use n spaces for indentation (max 7 spaces);
      --stream              parse the input value in streaming fashion;
      --seq                 parse input/output as application/json-seq;
  -f, --from-file file      load filter from the file;
      --arg name value      set $name to the string value;
      --argjson name value  set $name to the JSON value;
      --slurpfile name file set $name to an array of JSON values read
                            from the file;
      --rawfile name file   set $name to string contents of file;
      --args                consume remaining arguments as positional
                            string values;
      --jsonargs            consume remaining arguments as positional
                            JSON values;
  -e, --exit-status         set exit status code based on the output;
  -V, --version             show the version;
  -h, --help                show the help;
  --                        terminates argument processing;
`;

const USAGE_TAIL = 'Use jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n';

async function readText(ctx: CommandContext, file: string): Promise<string> {
  const data = await ctx.fs.readFile(ctx.fs.resolvePath(file, ctx.cwd));
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

export const jqCmd: Command = {
  name: 'jq',
  description: 'JSON processor',
  async exec(ctx) {
    let raw = false, join = false, nul = false, compact = false, slurp = false, nullInput = false, rawInput = false;
    let exitStatus = false, sortKeys = false, ascii = false, seq = false, stream = false;
    let indent: string | number = 2;
    let filter: string | undefined;
    let fromFile: string | undefined;
    let rest: 'files' | 'args' | 'jsonargs' = 'files';
    let endOfOpts = false;
    const files: string[] = [];
    const named: Record<string, V> = {};
    const positional: V[] = [];
    const usage = (msg: string) => { ctx.stderr += `jq: ${msg}\n${USAGE_TAIL}`; return 2; };

    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (endOfOpts || !a.startsWith('-') || a === '-') {
        if (filter === undefined && fromFile === undefined) filter = a;
        else if (rest === 'files') files.push(a);
        else if (rest === 'args') positional.push(a);
        else { try { positional.push(JSON.parse(a)); } catch { return usage(`Invalid JSON text passed to --jsonargs`); } }
        continue;
      }
      if (a === '--') { endOfOpts = true; continue; }
      const need = (n: number) => { if (i + n >= args.length) throw new InputError(`${a} takes ${n === 1 ? 'a parameter' : 'two parameters'} (e.g. ${a} ${n === 1 ? 'value' : 'name value'})`); };
      try {
        if (a.startsWith('--')) {
          switch (a) {
            case '--raw-output': raw = true; break;
            case '--raw-output0': raw = true; nul = true; break;
            case '--join-output': raw = true; join = true; break;
            case '--ascii-output': ascii = true; break;
            case '--compact-output': compact = true; break;
            case '--slurp': slurp = true; break;
            case '--null-input': nullInput = true; break;
            case '--raw-input': rawInput = true; break;
            case '--exit-status': exitStatus = true; break;
            case '--sort-keys': sortKeys = true; break;
            case '--tab': indent = '\t'; break;
            case '--indent': {
              need(1);
              const n = Number(args[++i]);
              if (!Number.isInteger(n) || n < 0) return usage('Cannot indent other than 0 to 7 spaces');
              if (n > 7) return usage('Cannot indent more than 7 characters');
              if (n === 0) compact = true; else indent = n;
              break;
            }
            case '--seq': seq = true; break;
            case '--stream': stream = true; break;
            case '--color-output': case '--monochrome-output': case '--unbuffered': break;
            case '--from-file': need(1); fromFile = args[++i]; break;
            case '--arg': need(2); named[args[i + 1]] = args[i + 2]; i += 2; break;
            case '--argjson': {
              need(2);
              try { named[args[i + 1]] = JSON.parse(args[i + 2]); } catch { ctx.stderr += `jq: Invalid JSON text passed to --argjson\n${USAGE_TAIL}`; return 2; }
              i += 2;
              break;
            }
            case '--slurpfile': case '--rawfile': {
              need(2);
              let text: string;
              try { text = await readText(ctx, args[i + 2]); } catch { ctx.stderr += `jq: error: Could not open file ${args[i + 2]}: No such file or directory\n`; return 2; }
              named[args[i + 1]] = a === '--rawfile' ? text : Array.from(jsonValues(text, args[i + 2]));
              i += 2;
              break;
            }
            case '--args': rest = 'args'; break;
            case '--jsonargs': rest = 'jsonargs'; break;
            case '--version': ctx.stdout += 'jq-1.7.1\n'; return 0;
            case '--help': ctx.stdout += HELP; return 0;
            case '--library-path': need(1); i++; break;
            default: return usage(`Unknown option ${a}`);
          }
          continue;
        }
        // short options, combined or not (-rs, -nr, -cer)
        for (let k = 1; k < a.length; k++) {
          const ch = a[k];
          switch (ch) {
            case 'r': raw = true; break;
            case 'j': raw = true; join = true; break;
            case 'a': ascii = true; break;
            case 'c': compact = true; break;
            case 's': slurp = true; break;
            case 'n': nullInput = true; break;
            case 'R': rawInput = true; break;
            case 'e': exitStatus = true; break;
            case 'S': sortKeys = true; break;
            case 'C': case 'M': break;
            case 'f': need(1); fromFile = args[++i]; break;
            case 'L': need(1); i++; break;
            case 'V': ctx.stdout += 'jq-1.7.1\n'; return 0;
            case 'h': ctx.stdout += HELP; return 0;
            default: return usage(`Unknown option ${a}`);
          }
        }
      } catch (e: any) {
        if (e instanceof InputError) return usage(e.message);
        throw e;
      }
    }

    if (fromFile !== undefined) {
      try { filter = await readText(ctx, fromFile); } catch { ctx.stderr += `jq: error: Could not open file ${fromFile}: No such file or directory\n`; return 2; }
    }
    if (filter === undefined) {
      if (!files.length && !ctx.stdin) { ctx.stderr += HELP; return 2; }
      filter = '.';
    }

    let prog: Program;
    try {
      prog = compile(filter, Object.keys(named));
    } catch (e: any) {
      if (!(e instanceof JqCompileError)) throw e;
      ctx.stderr += `jq: error: ${e.message} at <top-level>, line 1:\n${filter}\njq: 1 compile error\n`;
      return 3;
    }

    // The input text: the files, else stdin (stdin only when the program reads it: with -n, input/inputs)
    let text = '';
    const sources: { name: string; text: string }[] = [];
    if (files.length) {
      for (const f of files) {
        try { sources.push({ name: f, text: f === '-' ? ctx.stdin : await readText(ctx, f) }); } catch {
          ctx.stderr += `jq: error: Could not open file ${f}: No such file or directory\n`;
          return 2;
        }
      }
    } else if (!nullInput || prog.usesInput) {
      text = ctx.stdin;
      sources.push({ name: '<stdin>', text });
    }

    let inputError: string | null = null;
    let filename: V = null;
    const at = { line: 0 };
    function* values(): Generator<V> {
      try {
        if (rawInput) {
          if (slurp) { yield sources.map((s) => s.text).join(''); return; }
          for (const s of sources) {
            filename = files.length ? s.name : null;
            at.line = 0;
            for (const l of rawLines(s.text)) { at.line++; yield l; }
          }
          return;
        }
        const all = function* () {
          for (const s of sources) {
            filename = files.length ? s.name : null;
            for (const v of jsonValues(s.text, s.name, at)) {
              if (stream) yield* tostreamGen(v); else yield v;
            }
          }
        };
        if (slurp) { yield Array.from(all()); return; }
        yield* all();
      } catch (e) {
        if (e instanceof InputError) { inputError = e.message; return; }
        throw e;
      }
    }
    const it = values();
    const runtime: Runtime = {
      nextInput: () => { const r = it.next(); return r.done ? null : { value: r.value }; },
      stderr: (s) => { ctx.stderr += s; },
      get filename() { return filename; },
      env: { ...ctx.env },
    };

    const env = new Env(prelude()[0], new Map<string, V>([
      ['ARGS', { positional, named }],
      ...Object.entries(named),
    ]));

    const out: OutOpts = { raw, compact, indent, sortKeys, ascii };
    const parts: string[] = [];
    let last: V = undefined;
    let anyOutput = false;
    let status = 0;
    const saved = RT;
    RT = runtime;
    try {
      const run = (input: V) => {
        try {
          for (const [v] of ev(prog.node, input, null, env)) {
            last = v;
            anyOutput = true;
            const s = render(v, out);
            if (nul && typeof v === 'string' && v.includes('\0')) throw new JqError('Cannot dump a string containing NUL with --raw-output0 option');
            parts.push((seq ? '\x1e' : '') + s + (nul ? '\0' : join ? '' : '\n'));
          }
        } catch (e) {
          if (e instanceof JqError) {
            const where = nullInput ? '<unknown>' : `${filename ?? '<stdin>'}:${at.line}`;
            ctx.stderr += typeof e.value === 'string' || e.value === undefined
              ? `jq: error (at ${where}): ${e.message}\n`
              : `jq: error (at ${where}) (not a string): ${dump(e.value)}\n`;
            status = 5;
          } else if (e instanceof RangeError) {
            ctx.stderr += 'jq: error: stack overflow\n';
            status = 5;
          } else throw e;
        }
      };
      if (nullInput) run(null);
      else for (let r = it.next(); !r.done; r = it.next()) run(r.value);
    } catch (e) {
      if (!(e instanceof HaltSignal)) throw e;
      ctx.stdout += parts.join('');
      if (e.message !== undefined) ctx.stderr += e.message;
      return e.code;
    } finally {
      RT = saved;
    }
    ctx.stdout += parts.join('');
    if (inputError) { ctx.stderr += inputError + '\n'; return 2; }
    if (status) return status;
    if (exitStatus) return !anyOutput ? 4 : truthy(last) ? 0 : 1;
    return 0;
  },
};

