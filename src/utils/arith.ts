/**
 * Shell arithmetic ($((…)), ((…)), let, array subscripts): bash's grammar
 * evaluated on 64-bit integers. Variables are read and written through an
 * ArithEnv; a variable whose value is not a number is evaluated as an
 * expression itself (x='1+2'; $((x)) is 3), as in bash.
 */

export class ArithError extends Error {}

export interface ArithEnv {
  /** Value of NAME or NAME[SUB] (SUB is the raw subscript text); undefined if unset */
  get(name: string, sub?: string): string | undefined;
  set(name: string, value: string, sub?: string): void;
}

type Tok =
  | { t: 'num'; v: bigint }
  | { t: 'id'; name: string; sub?: string; dollar?: boolean }
  | { t: 'op'; v: string };

const OPS = [
  '<<=', '>>=', '**', '++', '--', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=',
  '&=', '^=', '|=', '<<', '>>', '+', '-', '*', '/', '%', '<', '>', '&', '^', '|', '!', '~', '?', ':',
  '=', ',', '(', ')',
];
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=']);
const BINARY: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

const wrap = (n: bigint) => BigInt.asIntN(64, n);

/** Parse an integer constant: 10, 0x1f, 017, BASE#DIGITS. Throws on a bad one. */
export function parseArithNumber(text: string): bigint {
  const s = text;
  let m = /^0[xX]([0-9a-fA-F]+)$/.exec(s);
  if (m) return wrap(BigInt('0x' + m[1]));
  m = /^(\d+)#([0-9A-Za-z@_]+)$/.exec(s);
  if (m) {
    const base = Number(m[1]);
    // (the base is decimal: 02#… is no number)
    if (m[1].length > 1 && m[1][0] === '0') throw new ArithError(`${s}: invalid number (error token is "${s}")`);
    if (base < 2 || base > 64) throw new ArithError(`${s}: invalid arithmetic base`);
    let v = 0n;
    for (const c of m[2]) {
      let d: number;
      if (c >= '0' && c <= '9') d = c.charCodeAt(0) - 48;
      else if (c >= 'a' && c <= 'z') d = c.charCodeAt(0) - 97 + 10;
      else if (c >= 'A' && c <= 'Z') d = base <= 36 ? c.charCodeAt(0) - 65 + 10 : c.charCodeAt(0) - 65 + 36;
      else if (c === '@') d = 62;
      else d = 63;
      if (d >= base) throw new ArithError(`${s}: value too great for base`);
      v = wrap(v * BigInt(base) + BigInt(d));
    }
    return v;
  }
  if (/^0[0-7]*$/.test(s)) return wrap(BigInt('0o' + (s.slice(1) || '0')));
  if (/^0\d+$/.test(s)) throw new ArithError(`${s}: value too great for base`);
  if (/^\d+$/.test(s)) return wrap(BigInt(s));
  throw new ArithError(`${s}: syntax error: invalid arithmetic operator`);
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9A-Za-z_@#]/.test(src[j])) j++;
      toks.push({ t: 'num', v: parseArithNumber(src.slice(i, j)) });
      i = j;
      continue;
    }
    const dollar = c === '$' && /[A-Za-z_0-9]/.test(src[i + 1] ?? '');
    if (/[A-Za-z_]/.test(c) || dollar) {
      let j = dollar ? i + 1 : i;
      const start = j;
      if (dollar && /\d/.test(src[j])) j++;
      else while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const name = src.slice(start, j);
      let sub: string | undefined;
      if (!dollar && src[j] === '[') {
        let depth = 0, k = j;
        for (; k < src.length; k++) {
          if (src[k] === '[') depth++;
          else if (src[k] === ']' && --depth === 0) break;
        }
        if (k >= src.length) throw new ArithError(`${src.slice(i)}: bad array subscript`);
        sub = src.slice(j + 1, k);
        j = k + 1;
      }
      toks.push({ t: 'id', name, sub, dollar });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ArithError(`${src.slice(i)}: syntax error: invalid arithmetic operator (error token is "${src.slice(i)}")`);
    toks.push({ t: 'op', v: op });
    i += op.length;
  }
  return toks;
}

const MAX_DEPTH = 1024;

/** Evaluate EXPR; throws ArithError on a syntax error, division by zero, etc. */
export function evalArith(expr: string, env: ArithEnv, depth = 0): bigint {
  if (depth > MAX_DEPTH) throw new ArithError(`${expr}: expression recursion level exceeded`);
  const toks = lex(expr);
  if (toks.length === 0) return 0n;
  let pos = 0;
  /** >0 while parsing a branch that is not evaluated (short-circuit) */
  let skip = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => { const t = toks[pos]; return t?.t === 'op' && t.v === v; };
  const fail = (msg?: string): never => {
    const rest = toks.slice(pos).map((t) => (t.t === 'num' ? String(t.v) : t.t === 'id' ? t.name : t.v)).join(' ');
    throw new ArithError(msg ?? `${expr}: syntax error: operand expected (error token is "${rest}")`);
  };

  const valueOf = (tok: { name: string; sub?: string }): bigint => {
    if (skip) return 0n;
    const raw = env.get(tok.name, tok.sub);
    if (raw === undefined) return 0n;
    const s = raw.trim();
    if (s === '') return 0n;
    if (/^-?\d+$/.test(s)) return wrap(BigInt(s));
    if (/^[0-9]/.test(s) && !/[^0-9A-Za-z_@#]/.test(s)) return parseArithNumber(s);
    return evalArith(s, env, depth + 1);
  };
  const store = (tok: { name: string; sub?: string }, v: bigint): bigint => {
    if (!skip) env.set(tok.name, String(v), tok.sub);
    return v;
  };

  const binop = (op: string, a: bigint, b: bigint): bigint => {
    switch (op) {
      case '+': return wrap(a + b);
      case '-': return wrap(a - b);
      case '*': return wrap(a * b);
      case '/': case '%':
        if (b === 0n) { if (skip) return 0n; fail(`${expr}: division by 0`); }
        return wrap(op === '/' ? a / b : a % b);
      case '<<': return wrap(a << (b & 63n));
      case '>>': return wrap(a >> (b & 63n));
      case '<': return a < b ? 1n : 0n;
      case '>': return a > b ? 1n : 0n;
      case '<=': return a <= b ? 1n : 0n;
      case '>=': return a >= b ? 1n : 0n;
      case '==': return a === b ? 1n : 0n;
      case '!=': return a !== b ? 1n : 0n;
      case '&': return a & b;
      case '^': return a ^ b;
      case '|': return a | b;
      case '**':
        if (b < 0n) { if (skip) return 0n; fail(`${expr}: exponent less than 0`); }
        return wrap(a ** b);
    }
    return fail();
  };

  const parseComma = (): bigint => {
    let v = parseAssign();
    while (isOp(',')) { pos++; v = parseAssign(); }
    return v;
  };

  const parseAssign = (): bigint => {
    const t = peek();
    const n = toks[pos + 1];
    if (t?.t === 'id' && !t.dollar && n?.t === 'op' && ASSIGN.has(n.v)) {
      pos += 2;
      const rhs = parseAssign();
      if (n.v === '=') return store(t, rhs);
      return store(t, binop(n.v.slice(0, -1), valueOf(t), rhs));
    }
    return parseTernary();
  };

  const parseTernary = (): bigint => {
    const cond = parseBinary(1);
    if (!isOp('?')) return cond;
    pos++;
    if (!cond) skip++;
    const a = parseComma();
    if (!cond) skip--;
    if (!isOp(':')) fail();
    pos++;
    if (cond) skip++;
    const b = parseAssign();
    if (cond) skip--;
    return cond ? a : b;
  };

  const parseBinary = (minPrec: number): bigint => {
    let left = parsePower();
    for (;;) {
      const t = peek();
      if (t?.t !== 'op' || !(t.v in BINARY) || BINARY[t.v] < minPrec) return left;
      const prec = BINARY[t.v];
      pos++;
      if (t.v === '&&' || t.v === '||') {
        const short = t.v === '&&' ? !left : !!left;
        if (short) skip++;
        const right = parseBinary(prec + 1);
        if (short) skip--;
        left = short ? (t.v === '||' ? 1n : 0n) : (right ? 1n : 0n);
        continue;
      }
      left = binop(t.v, left, parseBinary(prec + 1));
    }
  };

  const parseUnary = (): bigint => {
    const t = peek();
    if (t?.t === 'op') {
      if (t.v === '++' || t.v === '--') {
        const id = toks[pos + 1];
        if (id?.t !== 'id' || id.dollar) {
          // `--5` / `++x` with no variable: two unary signs
          pos++;
          return parseUnary();
        }
        pos += 2;
        return store(id, wrap(valueOf(id) + (t.v === '++' ? 1n : -1n)));
      }
      if (t.v === '-') { pos++; return wrap(-parseUnary()); }
      if (t.v === '+') { pos++; return parseUnary(); }
      if (t.v === '!') { pos++; return parseUnary() ? 0n : 1n; }
      if (t.v === '~') { pos++; return ~parseUnary(); }
    }
    return parsePostfix();
  };

  /** ** binds looser than unary minus (-2**2 is 4) and groups to the right */
  const parsePower = (): bigint => {
    const base = parseUnary();
    if (isOp('**')) { pos++; return binop('**', base, parsePower()); }
    return base;
  };

  const parsePostfix = (): bigint => {
    const t = peek();
    if (t?.t === 'id' && !t.dollar) {
      const n = toks[pos + 1];
      if (n?.t === 'op' && (n.v === '++' || n.v === '--')) {
        pos += 2;
        const v = valueOf(t);
        store(t, wrap(v + (n.v === '++' ? 1n : -1n)));
        return v;
      }
    }
    return parsePrimary();
  };

  const parsePrimary = (): bigint => {
    const t = toks[pos];
    if (!t) return fail();
    if (t.t === 'num') { pos++; return t.v; }
    if (t.t === 'id') { pos++; return valueOf(t); }
    if (t.v === '(') {
      pos++;
      const v = parseComma();
      if (!isOp(')')) fail(`${expr}: missing \`)'`);
      pos++;
      return v;
    }
    return fail();
  };

  const v = parseComma();
  if (pos < toks.length) fail(`${expr}: syntax error in expression (error token is "${toks.slice(pos).map((t) => (t.t === 'num' ? String(t.v) : t.t === 'id' ? t.name : t.v)).join(' ')}")`);
  return v;
}
