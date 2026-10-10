/**
 * `[[ … ]]` conditional expressions, parsed from the raw text between the
 * brackets so that operands keep their quoting (quoted parts of a pattern or
 * regex match literally) and && || ! ( ) < > are operators, not shell syntax.
 * The shell evaluates the tree (operands are expanded without word splitting
 * or globbing).
 */
import { EscapedBytes } from './utils/printf';

export type DbNode =
  | { t: 'and' | 'or'; a: DbNode; b: DbNode }
  | { t: 'not'; a: DbNode }
  | { t: 'unary'; op: string; w: string }
  | { t: 'binary'; op: string; l: string; r: string }
  | { t: 'word'; w: string };

export class DbSyntaxError extends Error {}

export const DB_UNARY = new Set([
  '-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-p', '-r', '-s', '-t', '-u', '-w', '-x',
  '-G', '-L', '-N', '-O', '-S', '-z', '-n', '-o', '-v', '-R',
]);
const BINARY = new Set(['=', '==', '!=', '=~', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

type Tok = { op: string } | { word: string };

/** Index just past the quoted section starting at s[i] (' " or $'), or -1 */
function skipQuote(s: string, i: number): number {
  if (s[i] === "'") { const e = s.indexOf("'", i + 1); return e < 0 ? -1 : e + 1; }
  if (s[i] === '$' && s[i + 1] === "'") {
    for (let j = i + 2; j < s.length; j++) { if (s[j] === '\\') j++; else if (s[j] === "'") return j + 1; }
    return -1;
  }
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
    else if (s[j] === '$' && s[j + 1] === '(') { const e = skipNested(s, j + 1, '(', ')'); if (e < 0) return -1; j = e - 1; }
  }
  return -1;
}

/** Index just past the close matching the open at s[i] */
function skipNested(s: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { const e = skipQuote(s, i); if (e < 0) return -1; i = e - 1; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Read one word starting at s[i]. In regex mode (the right side of =~)
 * parentheses group and may hold blanks and |.
 */
function readWord(s: string, i: number, regex: boolean): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'" || c === '"' || (c === '$' && s[i + 1] === "'")) {
      const e = skipQuote(s, i);
      if (e < 0) throw new DbSyntaxError('unexpected EOF while looking for matching quote');
      i = e;
      continue;
    }
    if (c === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) {
      const e = skipNested(s, i + 1, s[i + 1], s[i + 1] === '(' ? ')' : '}');
      if (e < 0) throw new DbSyntaxError('unexpected EOF');
      i = e;
      continue;
    }
    if (c === '`') { const e = s.indexOf('`', i + 1); if (e < 0) throw new DbSyntaxError('unexpected EOF'); i = e + 1; continue; }
    if (regex) {
      if (c === '(') { depth++; i++; continue; }
      if (c === ')' && depth > 0) { depth--; i++; continue; }
      if (depth > 0) { i++; continue; }
      if (/\s/.test(c) || c === ')') return i;
      if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) return i;
      if (c === '<' || c === '>' || c === ';' || c === '&') throw new DbSyntaxError(`syntax error near \`${c}'`);
      i++;
      continue;
    }
    // extglob ?(…) *(…) +(…) @(…) !(…) inside a word
    if (c === '(' && i > 0 && '?*+@!'.includes(s[i - 1])) {
      const e = skipNested(s, i, '(', ')');
      if (e < 0) throw new DbSyntaxError('unexpected EOF');
      i = e;
      continue;
    }
    if (/[\s()<>;&|]/.test(c)) return i;
    i++;
  }
  return i;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let regexNext = false;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const two = src.slice(i, i + 2);
    if (!regexNext && (two === '&&' || two === '||')) { toks.push({ op: two }); i += 2; continue; }
    if (!regexNext && (c === '(' || c === ')' || c === '<' || c === '>')) { toks.push({ op: c }); i++; continue; }
    if (!regexNext && (c === ';' || c === '&' || c === '|')) throw new DbSyntaxError(`syntax error near \`${c}'`);
    const end = readWord(src, i, regexNext);
    if (end === i) throw new DbSyntaxError(`syntax error near \`${c}'`);
    const word = src.slice(i, end);
    toks.push({ word });
    regexNext = word === '=~';
    i = end;
  }
  return toks;
}

export function parseDoubleBracket(src: string): DbNode {
  const toks = tokenize(src);
  if (!toks.length) throw new DbSyntaxError('expression expected');
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (t: Tok | undefined, op: string) => !!t && 'op' in t && t.op === op;
  const word = (t: Tok | undefined) => (t && 'word' in t ? t.word : null);
  const isBinary = (t: Tok | undefined) => !!t && ('op' in t ? t.op === '<' || t.op === '>' : BINARY.has(t.word));
  const opText = (t: Tok) => ('op' in t ? t.op : t.word);
  const fail = (): never => {
    const t = peek();
    throw new DbSyntaxError(t ? `syntax error near \`${opText(t)}'` : 'unexpected end of expression');
  };

  const or = (): DbNode => {
    let a = and();
    while (isOp(peek(), '||')) { pos++; a = { t: 'or', a, b: and() }; }
    return a;
  };
  const and = (): DbNode => {
    let a = not();
    while (isOp(peek(), '&&')) { pos++; a = { t: 'and', a, b: not() }; }
    return a;
  };
  const not = (): DbNode => {
    if (word(peek()) === '!' && toks[pos + 1] && !isBinary(toks[pos + 1])) { pos++; return { t: 'not', a: not() }; }
    return primary();
  };
  const primary = (): DbNode => {
    const t = peek();
    if (!t) return fail();
    if (isOp(t, '(')) {
      pos++;
      const e = or();
      if (!isOp(peek(), ')')) fail();
      pos++;
      return e;
    }
    const w = word(t);
    if (w === null) return fail();
    pos++;
    // binary
    const n = peek();
    if (n && isBinary(n)) {
      pos++;
      const r = word(peek());
      if (r === null) fail();
      pos++;
      return { t: 'binary', op: opText(n), l: w, r: r! };
    }
    if (DB_UNARY.has(w)) {
      const arg = word(peek());
      if (arg === null) fail();
      pos++;
      return { t: 'unary', op: w, w: arg! };
    }
    return { t: 'word', w };
  };

  const e = or();
  if (pos < toks.length) fail();
  return e;
}

/**
 * If s at i (in command position) starts a `[[ … ]]` command, the index just
 * past its `]]`; else -1. Quotes and $(…) inside are skipped.
 */
export function doubleBracketEnd(s: string, i: number): number {
  if (!s.startsWith('[[', i) || !(i + 2 >= s.length || /\s/.test(s[i + 2]))) return -1;
  let j = i + 2;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'" || c === '"' || (c === '$' && s[j + 1] === "'")) { const e = skipQuote(s, j); if (e < 0) return -1; j = e; continue; }
    if (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
      const e = skipNested(s, j + 1, s[j + 1], s[j + 1] === '(' ? ')' : '}');
      if (e < 0) return -1;
      j = e;
      continue;
    }
    if (c === ']' && s[j + 1] === ']' && (j + 2 >= s.length || /[\s;&|)]/.test(s[j + 2]))) return j + 2;
    j++;
  }
  return -1;
}

/** The value of a $'…' body (ANSI-C escapes) */
export function decodeAnsiC(body: string): string {
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  // \xHH and \NNN are bytes, decoded a run at a time (\xc3\xa9 is é; \xff one byte)
  const bytes = new EscapedBytes();
  let out = '';
  let last = 0;
  for (const mm of body.matchAll(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)/gs)) {
    const [m, e] = mm;
    if (mm.index! > last) out += bytes.flush() + body.slice(last, mm.index);
    last = mm.index! + m.length;
    if (e[0] === 'x' && e.length > 1) { bytes.push(parseInt(e.slice(1), 16)); continue; }
    if (/^[0-7]/.test(e)) { bytes.push(parseInt(e, 8) & 0xff); continue; }
    out += bytes.flush();
    if (simple[e] !== undefined) out += simple[e];
    else if (/^[uU]/.test(e) && e.length > 1) out += String.fromCodePoint(parseInt(e.slice(1), 16));
    else if (e[0] === 'c' && e.length === 2) out += String.fromCharCode(e.charCodeAt(1) & 0x1f);
    else out += m;
  }
  return out + bytes.flush() + body.slice(last);
}

/** Index just past the `'` closing the $' at s[i] */
export function ansiCEnd(s: string, i: number): number {
  for (let j = i + 2; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === "'") return j + 1;
  }
  return s.length;
}
