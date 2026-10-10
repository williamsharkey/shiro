/**
 * bc - arbitrary precision calculator (POSIX bc with the GNU extensions)
 *
 * Numbers are decimals of any length (a BigInt and a scale), with bc's
 * rules for the scale of each result: `scale` digits for / and sqrt, the
 * operands' for + - and *, truncation, never rounding. The language:
 * expressions, assignments (= += ... ^=, ++, --), relations, ! && ||,
 * if/else, while, for, break, continue, define with auto variables and
 * arrays, return, print, strings, quit/halt, ibase/obase/scale/last, and
 * length(), scale(), sqrt(). -l loads the math library (s c a l e j) and
 * sets scale=20.
 */
import type { Command } from './index';
import { readFileText } from './flags';

// ── numbers ──────────────────────────────────────────────────────────────

interface Num { n: bigint; s: number }
const TEN = 10n;
const p10 = (k: number) => TEN ** BigInt(k);
const num = (n: bigint, s = 0): Num => ({ n, s });
const ZERO = num(0n);
const ONE = num(1n);

function rescale(x: Num, s: number): Num {
  if (s === x.s) return x;
  return s > x.s ? num(x.n * p10(s - x.s), s) : num(x.n / p10(x.s - s), s);
}
const isZero = (x: Num) => x.n === 0n;
function cmp(a: Num, b: Num): number {
  const s = Math.max(a.s, b.s);
  const x = rescale(a, s).n, y = rescale(b, s).n;
  return x < y ? -1 : x > y ? 1 : 0;
}
function add(a: Num, b: Num): Num { const s = Math.max(a.s, b.s); return num(rescale(a, s).n + rescale(b, s).n, s); }
function sub(a: Num, b: Num): Num { return add(a, num(-b.n, b.s)); }
function mul(a: Num, b: Num, scale: number): Num {
  const full = num(a.n * b.n, a.s + b.s);
  return rescale(full, Math.min(a.s + b.s, Math.max(scale, a.s, b.s)));
}
class BcError extends Error {}
function div(a: Num, b: Num, scale: number): Num {
  if (isZero(b)) throw new BcError('Divide by zero');
  // a/b to `scale` digits: a.n·10^(b.s+scale) / (b.n·10^a.s)
  return num((a.n * p10(b.s + scale)) / (b.n * p10(a.s)), scale);
}
function mod(a: Num, b: Num, scale: number): Num {
  if (isZero(b)) throw new BcError('Modulo by zero');
  const q = div(a, b, scale);
  const r = sub(a, mul(q, b, Math.max(scale + b.s, a.s)));
  return rescale(r, Math.max(scale + b.s, a.s));
}
function pow(a: Num, e: Num, scale: number): Num {
  let k = rescale(e, 0).n;
  const neg = k < 0n;
  if (neg) k = -k;
  let r = ONE, base = a;
  // exact power, then the scale bc gives it
  let full = num(1n);
  for (let i = k; i > 0n; i >>= 1n) {
    if (i & 1n) full = num(full.n * base.n, full.s + base.s);
    if (i > 1n) base = num(base.n * base.n, base.s * 2);
  }
  if (neg) return div(ONE, full, scale);
  r = rescale(full, Math.min(a.s * Number(k), Math.max(scale, a.s)));
  return r;
}
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2) + 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
function sqrt(a: Num, scale: number): Num {
  if (a.n < 0n) throw new BcError('Square root of a negative number');
  const s = Math.max(scale, a.s);
  return num(isqrt(rescale(a, 2 * s).n * 1n), s);
}

function parseNum(text: string, ibase: number): Num {
  const [ip, fp = ''] = text.split('.');
  const digit = (c: string) => parseInt(c, 16);
  if (ibase === 10) return num(BigInt((ip || '0') + fp), fp.length);
  let n = 0n;
  for (const c of ip) n = n * BigInt(ibase) + BigInt(digit(c));
  if (!fp) return num(n);
  // the fraction in base ibase, to as many decimal digits as it has digits
  let f = ZERO;
  const s = fp.length;
  let scaleDen = ONE;
  for (const c of fp) {
    scaleDen = num(scaleDen.n * BigInt(ibase), 0);
    f = add(mul(f, num(BigInt(ibase)), s), num(BigInt(digit(c))));
  }
  return add(num(n), div(f, scaleDen, s));
}

function toText(x: Num, obase: number): string {
  if (x.n === 0n) return '0';
  const neg = x.n < 0n;
  const abs = neg ? -x.n : x.n;
  const ip = abs / p10(x.s), fp = abs % p10(x.s);
  let out: string;
  if (obase === 10) {
    const frac = x.s ? fp.toString().padStart(x.s, '0') : '';
    out = (ip === 0n && x.s ? '' : ip.toString()) + (x.s ? '.' + frac : '');
    if (ip === 0n && !x.s) out = '0';
  } else {
    const big = obase > 16;
    const width = String(obase - 1).length;
    const dig = (d: bigint) => (big ? ' ' + d.toString().padStart(width, '0') : d.toString(16).toUpperCase());
    let ints = '';
    if (ip === 0n) ints = big ? '' : '0';
    for (let v = ip; v > 0n; v /= BigInt(obase)) ints = dig(v % BigInt(obase)) + ints;
    if (ip === 0n && x.s) ints = '';
    let frac = '';
    if (x.s) {
      // digits until the base's place value is below 10^-scale
      let f = num(fp, x.s);
      for (let place = 1n; place < p10(x.s); place *= BigInt(obase)) {
        f = num(f.n * BigInt(obase), x.s);
        const d = f.n / p10(x.s);
        frac += dig(d);
        f = num(f.n % p10(x.s), x.s);
      }
      frac = '.' + frac;
    }
    out = ints + frac;
    if (!out) out = '0';
  }
  if (neg && x.n !== 0n) out = '-' + out;
  return out;
}

// ── the math library (-l) ───────────────────────────────────────────────

/** Fixed point at P digits: values are bigints scaled by 10^P */
function mathLib(name: string, args: Num[], scale: number): Num {
  const P = scale + 12;
  const one = p10(P);
  const fx = (x: Num) => rescale(x, P).n;
  const out = (v: bigint) => rescale(num(v, P), scale);
  const m = (a: bigint, b: bigint) => (a * b) / one;
  const d = (a: bigint, b: bigint) => (a * one) / b;
  const exp = (x: bigint): bigint => {
    if (x < 0n) return d(one, exp(-x));
    let k = 0;
    while (x > one / 2n) { x /= 2n; k++; }
    let term = one, sum = one;
    for (let i = 1n; term !== 0n; i++) { term = m(term, x) / i; sum += term; }
    for (; k > 0; k--) sum = m(sum, sum);
    return sum;
  };
  const ln = (x: bigint): bigint => {
    if (x <= 0n) throw new BcError('logarithm of a non-positive number');
    let k = 0n;
    // bring x near 1 by square roots: l(x) = 2^k l(x^(1/2^k))
    while (x > one + one / 10n || x < one - one / 10n) { x = isqrt(x * one); k++; }
    const y = d(x - one, x + one), y2 = m(y, y);
    let term = y, sum = y;
    for (let i = 3n; term !== 0n; i += 2n) { term = m(term, y2); sum += term / i; }
    return (2n * sum) << k;
  };
  const atan = (x: bigint): bigint => {
    if (x < 0n) return -atan(-x);
    if (x > one) return pi() / 2n - atan(d(one, x));
    let k = 0n;
    while (x > one / 5n) { x = d(x, one + isqrt(one * one + m(x, x) * one)); k++; }
    const x2 = m(x, x);
    let term = x, sum = x;
    for (let i = 3n, sign = -1n; term !== 0n; i += 2n, sign = -sign) { term = m(term, x2); sum += sign * term / i; }
    return sum << k;
  };
  let piCache: bigint | null = null;
  const atanInv = (n: bigint): bigint => {
    let term = one / n, sum = term;
    const n2 = n * n;
    for (let i = 3n, sign = -1n; term !== 0n; i += 2n, sign = -sign) { term /= n2; sum += sign * term / i; }
    return sum;
  };
  const pi = () => (piCache ??= 16n * atanInv(5n) - 4n * atanInv(239n));
  const sin = (x: bigint): bigint => {
    const twoPi = 2n * pi();
    x %= twoPi;
    if (x > pi()) x -= twoPi;
    if (x < -pi()) x += twoPi;
    const x2 = m(x, x);
    let term = x, sum = x;
    for (let i = 2n; term !== 0n; i += 2n) { term = -m(term, x2) / (i * (i + 1n)); sum += term; }
    return sum;
  };
  const a = args.map(fx);
  switch (name) {
    case 'e': return out(exp(a[0]));
    case 'l': return out(ln(a[0]));
    case 's': return out(sin(a[0]));
    case 'c': return out(sin(a[0] + pi() / 2n));
    case 'a': return out(atan(a[0]));
    case 'j': {
      const n = Number(rescale(args[0], 0).n), x = a[1];
      const an = Math.abs(n);
      const half = x / 2n;
      // (x/2)^n / n!
      let term = one;
      for (let i = 0; i < an; i++) term = m(term, half) / BigInt(i + 1);
      let sum = term;
      const h2 = m(half, half);
      for (let k = 1n; term !== 0n; k++) { term = -m(term, h2) / (k * (k + BigInt(an))); sum += term; }
      return out(n < 0 && an % 2 ? -sum : sum);
    }
  }
  throw new BcError(`Function ${name} not defined`);
}

// ── the language ─────────────────────────────────────────────────────────

type Tok = { t: string; v: string; line: number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let line = 1;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '\n') { toks.push({ t: 'nl', v: '\n', line }); line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? src.length : end + 2);
      line += body.split('\n').length - 1;
      i += body.length;
      continue;
    }
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      const body = src.slice(i + 1, end < 0 ? src.length : end);
      toks.push({ t: 'str', v: body, line });
      line += body.split('\n').length - 1;
      i += body.length + 2;
      continue;
    }
    if (c === '.' && !/[0-9A-F]/.test(src[i + 1] ?? '')) { toks.push({ t: '.', v: '.', line }); i++; continue; }
    const n = /^(?:[0-9A-F]+(?:\.[0-9A-F]*)?|\.[0-9A-F]+)/.exec(src.slice(i, i + 4096));
    if (n && /[0-9A-F.]/.test(c)) { toks.push({ t: 'num', v: n[0], line }); i += n[0].length; continue; }
    const id = /^[a-z][a-z0-9_]*/.exec(src.slice(i, i + 256));
    if (id) { toks.push({ t: 'id', v: id[0], line }); i += id[0].length; continue; }
    const op = /^(\+\+|--|\+=|-=|\*=|\/=|%=|\^=|==|<=|>=|!=|&&|\|\||[-+*/%^=<>!(){}[\],;])/.exec(src.slice(i, i + 3));
    if (op) { toks.push({ t: op[0], v: op[0], line }); i += op[0].length; continue; }
    throw new BcError(`illegal character: ${c}`);
  }
  toks.push({ t: 'eof', v: '', line });
  return toks;
}

type Node = any;
const KEYWORDS = new Set(['if', 'else', 'while', 'for', 'break', 'continue', 'return', 'define', 'auto', 'print', 'quit', 'halt', 'length', 'sqrt', 'scale', 'ibase', 'obase', 'last', 'read', 'limits', 'warranty']);

class Parser {
  i = 0;
  quit = false;
  constructor(private toks: Tok[]) {}
  peek(o = 0) { return this.toks[this.i + o]; }
  next() { return this.toks[this.i++]; }
  is(t: string) { return this.peek().t === t; }
  isKw(k: string) { return this.peek().t === 'id' && this.peek().v === k; }
  expect(t: string) { if (!this.is(t)) throw new BcError(`syntax error`); return this.next(); }
  skipNl() { while (this.is('nl')) this.i++; }
  /** the next top-level statement, or null at the end */
  statement(): Node | null {
    while (this.is('nl') || this.is(';')) this.i++;
    if (this.is('eof')) return null;
    return this.stmt();
  }
  stmt(): Node {
    const tk = this.peek();
    if (tk.t === '{') {
      this.next();
      const body: Node[] = [];
      for (;;) {
        while (this.is('nl') || this.is(';')) this.i++;
        if (this.is('}')) { this.next(); break; }
        if (this.is('eof')) throw new BcError('syntax error');
        body.push(this.stmt());
      }
      return { k: 'block', body };
    }
    if (tk.t === 'str') { this.next(); return { k: 'str', v: tk.v }; }
    if (tk.t === 'id') {
      switch (tk.v) {
        case 'quit': this.next(); this.quit = true; return { k: 'quit' };
        case 'halt': this.next(); return { k: 'halt' };
        case 'break': this.next(); return { k: 'break' };
        case 'continue': this.next(); return { k: 'continue' };
        case 'limits': case 'warranty': this.next(); return { k: 'nop' };
        case 'return': {
          this.next();
          if (this.is('nl') || this.is(';') || this.is('}') || this.is('eof')) return { k: 'return' };
          const paren = this.is('(');
          const e = this.expr();
          void paren;
          return { k: 'return', e };
        }
        case 'print': {
          this.next();
          const items: Node[] = [];
          do {
            if (this.is('str')) items.push({ k: 'str', v: this.next().v, esc: true });
            else items.push(this.expr());
          } while (this.is(',') && this.next());
          return { k: 'print', items };
        }
        case 'if': {
          this.next(); this.expect('('); const cond = this.expr(); this.expect(')'); this.skipNl();
          const then = this.stmt();
          let els: Node = null;
          const save = this.i;
          this.skipNl();
          if (this.isKw('else')) { this.next(); this.skipNl(); els = this.stmt(); } else this.i = save;
          return { k: 'if', cond, then, els };
        }
        case 'while': {
          this.next(); this.expect('('); const cond = this.expr(); this.expect(')'); this.skipNl();
          return { k: 'while', cond, body: this.stmt() };
        }
        case 'for': {
          this.next(); this.expect('(');
          const init = this.is(';') ? null : this.expr(); this.expect(';');
          const cond = this.is(';') ? null : this.expr(); this.expect(';');
          const step = this.is(')') ? null : this.expr(); this.expect(')'); this.skipNl();
          return { k: 'for', init, cond, step, body: this.stmt() };
        }
        case 'define': {
          this.next();
          const name = this.expect('id').v;
          this.expect('(');
          const params: { name: string; arr: boolean }[] = [];
          while (!this.is(')')) {
            const p = this.expect('id').v;
            let arr = false;
            if (this.is('[')) { this.next(); this.expect(']'); arr = true; }
            params.push({ name: p, arr });
            if (this.is(',')) this.next();
          }
          this.next(); this.skipNl();
          this.expect('{');
          const autos: { name: string; arr: boolean }[] = [];
          const body: Node[] = [];
          for (;;) {
            while (this.is('nl') || this.is(';')) this.i++;
            if (this.isKw('auto')) {
              this.next();
              do {
                const a = this.expect('id').v;
                let arr = false;
                if (this.is('[')) { this.next(); this.expect(']'); arr = true; }
                autos.push({ name: a, arr });
              } while (this.is(',') && this.next());
              continue;
            }
            if (this.is('}')) { this.next(); break; }
            if (this.is('eof')) throw new BcError('syntax error');
            body.push(this.stmt());
          }
          return { k: 'define', name, params, autos, body };
        }
      }
    }
    return { k: 'expr', e: this.expr() };
  }
  // precedence, lowest first: || && ! relational assignment + - * / % ^ unary ++/--
  expr(): Node { return this.or(); }
  or(): Node { let l = this.and(); while (this.is('||')) { this.next(); l = { k: 'or', l, r: this.and() }; } return l; }
  and(): Node { let l = this.not(); while (this.is('&&')) { this.next(); l = { k: 'and', l, r: this.not() }; } return l; }
  not(): Node { if (this.is('!')) { this.next(); return { k: 'not', e: this.not() }; } return this.rel(); }
  rel(): Node {
    const l = this.assign();
    if (['<', '<=', '>', '>=', '==', '!='].includes(this.peek().t)) { const op = this.next().t; return { k: 'rel', op, l, r: this.assign() }; }
    return l;
  }
  assign(): Node {
    const save = this.i;
    if (this.is('id') && !KEYWORDS.has(this.peek().v) || this.isKw('scale') || this.isKw('ibase') || this.isKw('obase') || this.isKw('last')) {
      const target = this.lvalue();
      if (target && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(this.peek().t)) {
        // (scale(x) is a function call, not the variable)
        const op = this.next().t;
        return { k: 'assign', op, target, e: this.assign() };
      }
      this.i = save;
    }
    return this.additive();
  }
  lvalue(): Node | null {
    if (!this.is('id')) return null;
    const name = this.next().v;
    if (name === 'scale' && this.is('(')) return null;
    if (this.is('[')) { this.next(); const idx = this.expr(); this.expect(']'); return { k: 'arr', name, idx }; }
    if (this.is('(')) return null;
    return { k: 'var', name };
  }
  additive(): Node {
    let l = this.mult();
    while (this.is('+') || this.is('-')) { const op = this.next().t; l = { k: 'bin', op, l, r: this.mult() }; }
    return l;
  }
  mult(): Node {
    let l = this.power();
    while (this.is('*') || this.is('/') || this.is('%')) { const op = this.next().t; l = { k: 'bin', op, l, r: this.power() }; }
    return l;
  }
  power(): Node {
    const l = this.unary();
    if (this.is('^')) { this.next(); return { k: 'bin', op: '^', l, r: this.power() }; }
    return l;
  }
  unary(): Node {
    if (this.is('-')) { this.next(); return { k: 'neg', e: this.unary() }; }
    if (this.is('+')) { this.next(); return this.unary(); }
    if (this.is('++') || this.is('--')) { const op = this.next().t; const target = this.lvalue(); if (!target) throw new BcError('syntax error'); return { k: 'incdec', op, pre: true, target }; }
    return this.postfix();
  }
  postfix(): Node {
    const save = this.i;
    if (this.is('id')) {
      const target = this.lvalue();
      if (target && (this.is('++') || this.is('--'))) return { k: 'incdec', op: this.next().t, pre: false, target };
      this.i = save;
    }
    return this.primary();
  }
  primary(): Node {
    const tk = this.next();
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === '(') { this.skipNl(); const e = this.expr(); this.skipNl(); this.expect(')'); return e; }
    if (tk.t === '.') return { k: 'var', name: 'last' };
    if (tk.t === 'id') {
      if (this.is('(')) {
        this.next();
        const args: Node[] = [];
        while (!this.is(')')) {
          this.skipNl();
          if (this.is('id') && this.peek(1).t === '[' && this.peek(2).t === ']') { const n = this.next().v; this.next(); this.next(); args.push({ k: 'arrref', name: n }); }
          else args.push(this.expr());
          this.skipNl();
          if (this.is(',')) this.next();
          else if (!this.is(')')) throw new BcError('syntax error');
        }
        this.next();
        return { k: 'call', name: tk.v, args };
      }
      if (this.is('[')) { this.next(); const idx = this.expr(); this.expect(']'); return { k: 'arr', name: tk.v, idx }; }
      return { k: 'var', name: tk.v };
    }
    throw new BcError('syntax error');
  }
}

class Signal { constructor(public kind: 'break' | 'continue' | 'return' | 'halt', public value?: Num) {} }

class Bc {
  scale = 0; ibase = 10; obase = 10; last = ZERO;
  vars = new Map<string, Num[]>();
  arrays = new Map<string, Map<string, Num>[]>();
  funcs = new Map<string, Node>();
  out = '';
  lineLength: number;
  constructor(public mathlib: boolean, env: Record<string, string>) {
    const ll = parseInt(env['BC_LINE_LENGTH'] ?? '', 10);
    this.lineLength = Number.isFinite(ll) ? ll : 70;
    if (mathlib) this.scale = 20;
  }
  write(s: string) { this.out += s; }
  printNum(x: Num) {
    let t = toText(x, this.obase);
    const L = this.lineLength;
    if (L > 1) {
      let wrapped = '';
      while (t.length > L - 1) { wrapped += t.slice(0, L - 1) + '\\\n'; t = t.slice(L - 1); }
      t = wrapped + t;
    }
    this.write(t + '\n');
  }
  getVar(name: string): Num {
    switch (name) {
      case 'scale': return num(BigInt(this.scale));
      case 'ibase': return num(BigInt(this.ibase));
      case 'obase': return num(BigInt(this.obase));
      case 'last': return this.last;
    }
    const st = this.vars.get(name);
    return st?.length ? st[st.length - 1] : ZERO;
  }
  setVar(name: string, v: Num) {
    const int = () => Number(rescale(v, 0).n);
    switch (name) {
      case 'scale': this.scale = Math.max(0, int()); return;
      case 'ibase': { const b = int(); if (b >= 2 && b <= 16) this.ibase = b; return; }
      case 'obase': { const b = int(); if (b >= 2) this.obase = b; return; }
      case 'last': this.last = v; return;
    }
    let st = this.vars.get(name);
    if (!st) this.vars.set(name, (st = [ZERO]));
    st[st.length - 1] = v;
  }
  arr(name: string): Map<string, Num> {
    let st = this.arrays.get(name);
    if (!st) this.arrays.set(name, (st = [new Map()]));
    return st[st.length - 1];
  }
  index(n: Node): string { return rescale(this.eval(n), 0).n.toString(); }
  get(t: Node): Num { return t.k === 'arr' ? this.arr(t.name).get(this.index(t.idx)) ?? ZERO : this.getVar(t.name); }
  set(t: Node, v: Num) { if (t.k === 'arr') this.arr(t.name).set(this.index(t.idx), v); else this.setVar(t.name, v); }
  bin(op: string, a: Num, b: Num): Num {
    switch (op) {
      case '+': return add(a, b);
      case '-': return sub(a, b);
      case '*': return mul(a, b, this.scale);
      case '/': return div(a, b, this.scale);
      case '%': return mod(a, b, this.scale);
      case '^': return pow(a, b, this.scale);
    }
    throw new BcError(`bad operator ${op}`);
  }
  eval(n: Node): Num {
    switch (n.k) {
      case 'num': return parseNum(n.v, n.v.length === 1 ? 16 : this.ibase);
      case 'var': case 'arr': return this.get(n);
      case 'neg': { const v = this.eval(n.e); return num(-v.n, v.s); }
      case 'bin': return this.bin(n.op, this.eval(n.l), this.eval(n.r));
      case 'rel': {
        const c = cmp(this.eval(n.l), this.eval(n.r));
        const r = { '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0, '==': c === 0, '!=': c !== 0 }[n.op as '<'];
        return r ? ONE : ZERO;
      }
      case 'not': return isZero(this.eval(n.e)) ? ONE : ZERO;
      case 'and': return !isZero(this.eval(n.l)) && !isZero(this.eval(n.r)) ? ONE : ZERO;
      case 'or': return !isZero(this.eval(n.l)) || !isZero(this.eval(n.r)) ? ONE : ZERO;
      case 'assign': {
        const v = this.eval(n.e);
        const r = n.op === '=' ? v : this.bin(n.op[0], this.get(n.target), v);
        this.set(n.target, r);
        return this.get(n.target);
      }
      case 'incdec': {
        const old = this.get(n.target);
        this.set(n.target, n.op === '++' ? add(old, ONE) : sub(old, ONE));
        return n.pre ? this.get(n.target) : old;
      }
      case 'call': return this.call(n);
    }
    throw new BcError('syntax error');
  }
  call(n: Node): Num {
    const args = n.args;
    switch (n.name) {
      case 'length': { const v = this.eval(args[0]); const digits = (v.n < 0n ? -v.n : v.n).toString().length; return num(BigInt(v.n === 0n ? Math.max(1, v.s) : Math.max(digits, v.s))); }
      case 'scale': return num(BigInt(this.eval(args[0]).s));
      case 'sqrt': return sqrt(this.eval(args[0]), this.scale);
      case 'read': throw new BcError('read() is not supported');
    }
    const f = this.funcs.get(n.name);
    if (!f) {
      if (this.mathlib && ['s', 'c', 'a', 'l', 'e', 'j'].includes(n.name)) return mathLib(n.name, args.map((a: Node) => this.eval(a)), this.scale);
      throw new BcError(`Function ${n.name} not defined.`);
    }
    // arguments are evaluated before the callee's names come into scope (dynamic scoping)
    const vals = f.params.map((p: any, i: number) => {
      const a = args[i];
      if (p.arr) return new Map(this.arr(a?.name ?? '').entries());
      return a ? this.eval(a) : ZERO;
    });
    const push = (name: string, arr: boolean, v: any) => {
      if (arr) { if (!this.arrays.has(name)) this.arrays.set(name, [new Map()]); this.arrays.get(name)!.push(v ?? new Map()); }
      else { if (!this.vars.has(name)) this.vars.set(name, [ZERO]); this.vars.get(name)!.push(v ?? ZERO); }
    };
    const pop = (name: string, arr: boolean) => { (arr ? this.arrays : this.vars).get(name)!.pop(); };
    f.params.forEach((p: any, i: number) => push(p.name, p.arr, vals[i]));
    f.autos.forEach((a: any) => push(a.name, a.arr, undefined));
    try {
      for (const s of f.body) this.exec(s);
      return ZERO;
    } catch (e) {
      if (e instanceof Signal && e.kind === 'return') return e.value ?? ZERO;
      throw e;
    } finally {
      f.autos.forEach((a: any) => pop(a.name, a.arr));
      f.params.forEach((p: any) => pop(p.name, p.arr));
    }
  }
  exec(s: Node): void {
    switch (s.k) {
      case 'nop': case 'quit': return;
      case 'halt': throw new Signal('halt');
      case 'expr': {
        const v = this.eval(s.e);
        if (s.e.k !== 'assign' && s.e.k !== 'incdec') { this.printNum(v); this.last = v; }
        return;
      }
      case 'str': this.write(s.v); return;
      case 'print':
        for (const it of s.items) {
          if (it.k === 'str') this.write(it.v.replace(/\\(.)/g, (_: string, c: string) => ({ n: '\n', t: '\t', a: '\x07', b: '\b', f: '\f', r: '\r', q: '"', e: '\\', '\\': '\\' } as any)[c] ?? c));
          else { const v = this.eval(it); this.write(toText(v, this.obase)); this.last = v; }
        }
        return;
      case 'block': for (const b of s.body) this.exec(b); return;
      case 'if': if (!isZero(this.eval(s.cond))) this.exec(s.then); else if (s.els) this.exec(s.els); return;
      case 'while':
        while (!isZero(this.eval(s.cond))) {
          try { this.exec(s.body); } catch (e) { if (e instanceof Signal && e.kind === 'break') break; if (e instanceof Signal && e.kind === 'continue') continue; throw e; }
        }
        return;
      case 'for':
        for (s.init && this.eval(s.init); !s.cond || !isZero(this.eval(s.cond)); s.step && this.eval(s.step)) {
          try { this.exec(s.body); } catch (e) { if (e instanceof Signal && e.kind === 'break') break; if (e instanceof Signal && e.kind === 'continue') continue; throw e; }
        }
        return;
      case 'break': throw new Signal('break');
      case 'continue': throw new Signal('continue');
      case 'return': throw new Signal('return', s.e ? this.eval(s.e) : ZERO);
      case 'define': this.funcs.set(s.name, s); return;
    }
  }
}

/** Run bc source; output, errors, and whether it quit */
export function runBc(src: string, bc: Bc, name: string): { err: string; quit: boolean } {
  let err = '';
  let toks: Tok[];
  try { toks = tokenize(src); } catch (e: any) { return { err: `(${name}) 1: ${e.message}\n`, quit: false }; }
  const p = new Parser(toks);
  for (;;) {
    const start = p.i;
    let s: Node | null;
    try {
      s = p.statement();
    } catch (e: any) {
      err += `(${name}) ${toks[Math.min(p.i, toks.length - 1)].line}: ${e.message}\n`;
      // skip the rest of the line
      if (p.i === start) p.i++;
      while (!p.is('nl') && !p.is('eof')) p.i++;
      continue;
    }
    if (!s) break;
    try {
      bc.exec(s);
    } catch (e: any) {
      if (e instanceof Signal) { if (e.kind === 'halt') return { err, quit: true }; continue; }
      if (e instanceof BcError || e instanceof RangeError) { err += `Runtime error: ${e.message}\n`; continue; }
      throw e;
    }
    if (p.quit) return { err, quit: true };
  }
  return { err, quit: false };
}

export const bc: Command = {
  name: "bc",
  description: "Arbitrary precision calculator language",
  async exec(ctx) {
    let mathlib = false;
    const files: string[] = [];
    for (const a of ctx.args) {
      if (a === '-l' || a === '--mathlib') mathlib = true;
      else if (/^-[lqsw]+$/.test(a)) { if (a.includes('l')) mathlib = true; }
      else if (a === '--quiet' || a === '--standard' || a === '--warn') { /* nothing to change */ }
      else if (a.startsWith('-') && a !== '-') { ctx.stderr += `bc: invalid option -- '${a.replace(/^-+/, '')}'\n`; return 1; }
      else files.push(a);
    }
    const machine = new Bc(mathlib, ctx.env);
    for (const f of files) {
      let text: string;
      try {
        text = await readFileText(ctx.fs, ctx.fs.resolvePath(f, ctx.cwd));
      } catch {
        ctx.stderr += `File ${f} is unavailable.\n`;
        return 1;
      }
      const r = runBc(text, machine, f);
      ctx.stdout += machine.out; machine.out = '';
      ctx.stderr += r.err;
      if (r.quit) return 0;
    }
    const r = runBc(ctx.stdin, machine, 'standard_in');
    ctx.stdout += machine.out;
    ctx.stderr += r.err;
    return 0;
  },
};
