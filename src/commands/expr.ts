import type { Command } from './index';
import { posixRegExp } from '../utils/posix-regex';

/**
 * expr — GNU coreutils-compatible expression evaluator.
 *
 * Grammar (lowest precedence first): | & (< <= = == != >= >) (+ -) (* / %) :
 * plus match/substr/index/length, `+ TOKEN` quoting and parentheses.
 * Integers are arbitrary precision (BigInt); comparisons are numeric when
 * both sides are integers. Exit status: 0 non-null result, 1 null or zero,
 * 2 invalid expression.
 */

type Val = string | bigint;

class ExprError extends Error {}

const INT_RE = /^-?\d+$/;

function toInt(v: Val): bigint {
  if (typeof v === 'bigint') return v;
  if (!INT_RE.test(v)) throw new ExprError('non-integer argument');
  return BigInt(v);
}

function isNull(v: Val): boolean {
  if (typeof v === 'bigint') return v === 0n;
  return v === '' || /^-?0+$/.test(v);
}

function str(v: Val): string {
  return typeof v === 'bigint' ? v.toString() : v;
}

/** Characters of a string (code points) */
function chars(s: string): string[] {
  return Array.from(s);
}

export const expr: Command = {
  name: "expr",
  description: "Evaluate expressions",
  async exec(ctx) {
    let toks = ctx.args;
    if (toks[0] === '--') toks = toks.slice(1);
    if (toks.length === 0) {
      ctx.stderr += "expr: missing operand\nTry 'expr --help' for more information.\n";
      return 2;
    }
    let p = 0;
    const peek = () => toks[p];
    const missing = () => new ExprError(`syntax error: missing argument after '${toks[p - 1]}'`);

    const primary = (): Val => {
      if (p >= toks.length) throw missing();
      const t = toks[p++];
      if (t === '(') {
        const v = orExpr();
        if (toks[p] !== ')') {
          if (p >= toks.length) throw new ExprError(`syntax error: expecting ')' after '${toks[p - 1]}'`);
          throw new ExprError(`syntax error: expecting ')' instead of '${toks[p]}'`);
        }
        p++;
        return v;
      }
      if (t === '+') {
        if (p >= toks.length) throw missing();
        return toks[p++];
      }
      if (t === 'length') {
        if (p >= toks.length) throw missing();
        return BigInt(chars(str(primary())).length);
      }
      if (t === 'match') {
        const s = primary();
        const r = primary();
        return matchOp(str(s), str(r));
      }
      if (t === 'substr') {
        const s = chars(str(primary()));
        const pos = primary();
        const len = primary();
        let ip: bigint, il: bigint;
        try { ip = toInt(pos); il = toInt(len); } catch { return ''; }
        if (ip < 1n || il < 1n || ip > BigInt(s.length)) return '';
        const start = Number(ip) - 1;
        return s.slice(start, start + Number(il > BigInt(s.length) ? BigInt(s.length) : il)).join('');
      }
      if (t === 'index') {
        const s = chars(str(primary()));
        const set = new Set(chars(str(primary())));
        const i = s.findIndex((c) => set.has(c));
        return BigInt(i + 1);
      }
      if (t === ')') throw new ExprError(`syntax error: unexpected ')'`);
      return t;
    };
    const colon = (): Val => {
      let l = primary();
      while (peek() === ':') {
        p++;
        const r = primary();
        l = matchOp(str(l), str(r));
      }
      return l;
    };
    const mul = (): Val => {
      let l = colon();
      for (;;) {
        const op = peek();
        if (op !== '*' && op !== '/' && op !== '%') return l;
        p++;
        const r = colon();
        const a = toInt(l), b = toInt(r);
        if (op === '*') l = a * b;
        else {
          if (b === 0n) throw new ExprError('division by zero');
          l = op === '/' ? a / b : a % b;
        }
      }
    };
    const add = (): Val => {
      let l = mul();
      for (;;) {
        const op = peek();
        if (op !== '+' && op !== '-') return l;
        p++;
        const r = mul();
        const a = toInt(l), b = toInt(r);
        l = op === '+' ? a + b : a - b;
      }
    };
    const cmp = (): Val => {
      let l = add();
      for (;;) {
        const op = peek();
        if (!['<', '<=', '=', '==', '!=', '>=', '>'].includes(op)) return l;
        p++;
        const r = add();
        let c: number;
        const ls = str(l), rs = str(r);
        if (INT_RE.test(ls) && INT_RE.test(rs)) {
          const a = BigInt(ls), b = BigInt(rs);
          c = a < b ? -1 : a > b ? 1 : 0;
        } else {
          c = ls < rs ? -1 : ls > rs ? 1 : 0;
        }
        const res = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '=' || op === '==' ? c === 0 : op === '!=' ? c !== 0 : op === '>=' ? c >= 0 : c > 0;
        l = res ? 1n : 0n;
      }
    };
    const andExpr = (): Val => {
      let l = cmp();
      while (peek() === '&') {
        p++;
        const r = cmp();
        l = isNull(l) || isNull(r) ? 0n : l;
      }
      return l;
    };
    const orExpr = (): Val => {
      let l = andExpr();
      while (peek() === '|') {
        p++;
        const r = andExpr();
        l = !isNull(l) ? l : !isNull(r) ? r : 0n;
      }
      return l;
    };

    try {
      const v = orExpr();
      if (p < toks.length) throw new ExprError(`syntax error: unexpected argument '${toks[p]}'`);
      ctx.stdout += str(v) + '\n';
      return isNull(v) ? 1 : 0;
    } catch (e: unknown) {
      if (e instanceof ExprError) {
        ctx.stderr += `expr: ${e.message}\n`;
        return 2;
      }
      ctx.stderr += `expr: ${e instanceof Error ? e.message : e}\n`;
      return 3;
    }
  },
};

/** STRING : REGEX — anchored BRE; \(…\) yields the group, else the match length */
function matchOp(s: string, re: string): Val {
  let rx: RegExp;
  try {
    rx = posixRegExp(re, { extended: false });
  } catch (e: any) {
    throw new ExprError(`${e?.message ?? 'invalid regular expression'}`);
  }
  const anchored = new RegExp('^(?:' + rx.source + ')', rx.flags);
  const m = anchored.exec(s);
  const hasGroup = /\\\(/.test(re);
  if (hasGroup) return m ? (m[1] ?? '') : '';
  return BigInt(m ? chars(m[0]).length : 0);
}
