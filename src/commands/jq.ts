import { Command } from './index';

type JqValue = any;

class JqError extends Error {
  constructor(msg: string) { super(msg); this.name = 'JqError'; }
}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('.[],:|(){}?'.includes(c)) {
      tokens.push(c);
      i++;
    } else if (c === '/' && expr[i + 1] === '/') {
      tokens.push('//');
      i += 2;
    } else if (c === '=' && expr[i + 1] === '=') {
      tokens.push('==');
      i += 2;
    } else if (c === '!' && expr[i + 1] === '=') {
      tokens.push('!=');
      i += 2;
    } else if (c === '<' && expr[i + 1] === '=') {
      tokens.push('<=');
      i += 2;
    } else if (c === '>' && expr[i + 1] === '=') {
      tokens.push('>=');
      i += 2;
    } else if (c === '<') {
      tokens.push('<');
      i++;
    } else if (c === '>') {
      tokens.push('>');
      i++;
    } else if (c === '+') {
      tokens.push('+');
      i++;
    } else if (c === '-' && (tokens.length === 0 || ['|', '(', ',', '[', ':', '+', '-', '*', '/', '%', '==', '!=', '<', '>', '<=', '>='].includes(tokens[tokens.length - 1]))) {
      // Negative number
      let num = '-';
      i++;
      while (i < expr.length && /[\d.]/.test(expr[i])) num += expr[i++];
      tokens.push(num);
    } else if (c === '-') {
      tokens.push('-');
      i++;
    } else if (c === '*') {
      tokens.push('*');
      i++;
    } else if (c === '%') {
      tokens.push('%');
      i++;
    } else if (c === '"') {
      let s = '"';
      i++;
      while (i < expr.length && expr[i] !== '"') {
        if (expr[i] === '\\') { s += expr[i++]; }
        s += expr[i++];
      }
      s += '"';
      i++;
      tokens.push(s);
    } else if (/\d/.test(c)) {
      let num = '';
      while (i < expr.length && /[\d.]/.test(expr[i])) num += expr[i++];
      tokens.push(num);
    } else if (/[a-zA-Z_$]/.test(c)) {
      let word = '';
      while (i < expr.length && /[a-zA-Z_$\d]/.test(expr[i])) word += expr[i++];
      tokens.push(word);
    } else {
      i++;
    }
  }
  return tokens;
}

type JqFilter = (input: JqValue) => JqValue[];

function parse(tokens: string[]): { filter: JqFilter; rest: string[] } {
  return parsePipe(tokens);
}

function parsePipe(tokens: string[]): { filter: JqFilter; rest: string[] } {
  let { filter: left, rest } = parseComma(tokens);
  while (rest[0] === '|') {
    rest = rest.slice(1);
    const { filter: right, rest: r2 } = parseComma(rest);
    const l = left, r = right;
    left = (input) => {
      const results: JqValue[] = [];
      for (const v of l(input)) {
        for (const v2 of r(v)) results.push(v2);
      }
      return results;
    };
    rest = r2;
  }
  return { filter: left, rest };
}

function parseComma(tokens: string[]): { filter: JqFilter; rest: string[] } {
  let { filter: left, rest } = parseOr(tokens);
  while (rest[0] === ',') {
    rest = rest.slice(1);
    const { filter: right, rest: r2 } = parseOr(rest);
    const l = left, r = right;
    left = (input) => [...l(input), ...r(input)];
    rest = r2;
  }
  return { filter: left, rest };
}

function parseOr(tokens: string[]): { filter: JqFilter; rest: string[] } {
  let { filter: left, rest } = parseAnd(tokens);
  while (rest[0] === 'or') {
    rest = rest.slice(1);
    const { filter: right, rest: r2 } = parseAnd(rest);
    const l = left, r = right;
    left = (input) => {
      const lv = l(input);
      const rv = r(input);
      return [lv[0] || rv[0]];
    };
    rest = r2;
  }
  return { filter: left, rest };
}

function parseAnd(tokens: string[]): { filter: JqFilter; rest: string[] } {
  let { filter: left, rest } = parseComparison(tokens);
  while (rest[0] === 'and') {
    rest = rest.slice(1);
    const { filter: right, rest: r2 } = parseComparison(rest);
    const l = left, r = right;
    left = (input) => {
      const lv = l(input);
      const rv = r(input);
      return [lv[0] && rv[0]];
    };
    rest = r2;
  }
  return { filter: left, rest };
}

function parseComparison(tokens: string[]): { filter: JqFilter; rest: string[] } {
  let { filter: left, rest } = parseAddSub(tokens);
  const ops = ['==', '!=', '<', '>', '<=', '>='];
  while (ops.includes(rest[0])) {
    const op = rest[0];
    rest = rest.slice(1);
    const { filter: right, rest: r2 } = parseAddSub(rest);
    const l = left, r = right;
    left = (input) => {
      const a = l(input)[0], b = r(input)[0];
      switch (op) {
        case '==': return [JSON.stringify(a) === JSON.stringify(b)];
        case '!=': return [JSON.stringify(a) !== JSON.stringify(b)];
        case '<': return [a < b];
        case '>': return [a > b];
        case '<=': return [a <= b];
        case '>=': return [a >= b];
        default: return [false];
      }
    };
    rest = r2;
  }
  return { filter: left, rest };
}

function parseAddSub(tokens: string[]): { filter: JqFilter; rest: string[] } {
  let { filter: left, rest } = parseMulDiv(tokens);
  while (rest[0] === '+' || rest[0] === '-') {
    const op = rest[0];
    rest = rest.slice(1);
    const { filter: right, rest: r2 } = parseMulDiv(rest);
    const l = left, r = right;
    left = (input) => {
      const a = l(input)[0], b = r(input)[0];
      if (op === '+') {
        if (typeof a === 'string' && typeof b === 'string') return [a + b];
        if (Array.isArray(a) && Array.isArray(b)) return [[...a, ...b]];
        if (typeof a === 'object' && a && typeof b === 'object' && b) return [{ ...a, ...b }];
        return [(a as number) + (b as number)];
      }
      return [(a as number) - (b as number)];
    };
    rest = r2;
  }
  return { filter: left, rest };
}

function parseMulDiv(tokens: string[]): { filter: JqFilter; rest: string[] } {
  let { filter: left, rest } = parseNot(tokens);
  while (rest[0] === '*' || rest[0] === '/' || rest[0] === '%') {
    const op = rest[0];
    rest = rest.slice(1);
    const { filter: right, rest: r2 } = parseNot(rest);
    const l = left, r = right;
    left = (input) => {
      const a = l(input)[0] as number, b = r(input)[0] as number;
      if (op === '*') return [a * b];
      if (op === '/') return [a / b];
      return [a % b];
    };
    rest = r2;
  }
  return { filter: left, rest };
}

function parseNot(tokens: string[]): { filter: JqFilter; rest: string[] } {
  if (tokens[0] === 'not') {
    const { filter: inner, rest } = parseNot(tokens.slice(1));
    return { filter: (input) => inner(input).map(v => !v), rest };
  }
  return parsePostfix(tokens);
}

function parsePostfix(tokens: string[]): { filter: JqFilter; rest: string[] } {
  let { filter, rest } = parseAtom(tokens);

  while (true) {
    if (rest[0] === '.' && rest[1] && /^[a-zA-Z_]/.test(rest[1])) {
      const key = rest[1];
      rest = rest.slice(2);
      const prev = filter;
      // Check for ?
      const optional = rest[0] === '?';
      if (optional) rest = rest.slice(1);
      filter = (input) => {
        const results: JqValue[] = [];
        for (const v of prev(input)) {
          if (v == null) { if (optional) results.push(null); else results.push(null); }
          else results.push(v[key]);
        }
        return results;
      };
    } else if (rest[0] === '[') {
      if (rest[1] === ']') {
        // .[] — iterate
        rest = rest.slice(2);
        const prev = filter;
        const optional = rest[0] === '?';
        if (optional) rest = rest.slice(1);
        filter = (input) => {
          const results: JqValue[] = [];
          for (const v of prev(input)) {
            if (v == null) continue;
            if (Array.isArray(v)) results.push(...v);
            else if (typeof v === 'object') results.push(...Object.values(v));
          }
          return results;
        };
      } else {
        // [N] or [N:M]
        rest = rest.slice(1); // skip [
        const { filter: indexExpr, rest: r2 } = parsePipe(rest);
        if (r2[0] === ':') {
          // Slice [N:M]
          const r3 = r2.slice(1);
          let endExpr: JqFilter | null = null;
          let r4: string[];
          if (r3[0] === ']') {
            r4 = r3;
          } else {
            const parsed = parsePipe(r3);
            endExpr = parsed.filter;
            r4 = parsed.rest;
          }
          if (r4[0] === ']') r4 = r4.slice(1);
          rest = r4;
          const prev = filter;
          const ie = indexExpr, ee = endExpr;
          filter = (input) => {
            const results: JqValue[] = [];
            for (const v of prev(input)) {
              const start = ie(input)[0] as number;
              const end = ee ? ee(input)[0] as number : undefined;
              if (typeof v === 'string' || Array.isArray(v)) {
                results.push(v.slice(start, end));
              }
            }
            return results;
          };
        } else {
          if (r2[0] === ']') rest = r2.slice(1);
          else rest = r2;
          const prev = filter;
          const ie = indexExpr;
          filter = (input) => {
            const results: JqValue[] = [];
            for (const v of prev(input)) {
              const idx = ie(input)[0];
              if (v == null) results.push(null);
              else results.push(v[idx]);
            }
            return results;
          };
        }
      }
    } else {
      break;
    }
  }

  return { filter, rest };
}

function parseAtom(tokens: string[]): { filter: JqFilter; rest: string[] } {
  if (tokens.length === 0) return { filter: (input) => [input], rest: [] };

  const t = tokens[0];

  // Parenthesized expression
  if (t === '(') {
    const { filter, rest } = parsePipe(tokens.slice(1));
    const r = rest[0] === ')' ? rest.slice(1) : rest;
    return { filter, rest: r };
  }

  // Identity
  if (t === '.') {
    // Check if next token is a field name
    if (tokens[1] && /^[a-zA-Z_]/.test(tokens[1])) {
      const key = tokens[1];
      let rest = tokens.slice(2);
      const optional = rest[0] === '?';
      if (optional) rest = rest.slice(1);
      return { filter: (input) => [input == null ? null : input[key]], rest };
    }
    if (tokens[1] === '[') {
      return { filter: (input) => [input], rest: tokens.slice(1) };
    }
    return { filter: (input) => [input], rest: tokens.slice(1) };
  }

  // String literal
  if (t.startsWith('"')) {
    const s = JSON.parse(t);
    return { filter: () => [s], rest: tokens.slice(1) };
  }

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    return { filter: () => [n], rest: tokens.slice(1) };
  }

  // Boolean / null
  if (t === 'true') return { filter: () => [true], rest: tokens.slice(1) };
  if (t === 'false') return { filter: () => [false], rest: tokens.slice(1) };
  if (t === 'null') return { filter: () => [null], rest: tokens.slice(1) };
  if (t === 'empty') return { filter: () => [], rest: tokens.slice(1) };

  // Not (postfix)
  if (t === 'not') {
    return { filter: (input) => [!input], rest: tokens.slice(1) };
  }

  // Array construction [...]
  if (t === '[') {
    if (tokens[1] === ']') {
      return { filter: () => [[]], rest: tokens.slice(2) };
    }
    const { filter: inner, rest } = parsePipe(tokens.slice(1));
    const r = rest[0] === ']' ? rest.slice(1) : rest;
    return { filter: (input) => [inner(input)], rest: r };
  }

  // Object construction {...}
  if (t === '{') {
    return parseObjectConstruction(tokens);
  }

  // if-then-else
  if (t === 'if') {
    const { filter: cond, rest: r1 } = parsePipe(tokens.slice(1));
    // skip 'then'
    const r2 = r1[0] === 'then' ? r1.slice(1) : r1;
    const { filter: thenExpr, rest: r3 } = parsePipe(r2);
    let elseExpr: JqFilter = (input) => [input];
    let rest = r3;
    // Handle elif chains
    while (rest[0] === 'elif') {
      const { filter: elifCond, rest: r4 } = parsePipe(rest.slice(1));
      const r5 = r4[0] === 'then' ? r4.slice(1) : r4;
      const { filter: elifThen, rest: r6 } = parsePipe(r5);
      const prevElse = elseExpr;
      const ec = elifCond, et = elifThen;
      elseExpr = (input) => {
        const cv = ec(input)[0];
        if (cv && cv !== false && cv !== null) return et(input);
        return prevElse(input);
      };
      rest = r6;
    }
    if (rest[0] === 'else') {
      const { filter: elseE, rest: r7 } = parsePipe(rest.slice(1));
      elseExpr = elseE;
      rest = r7;
    }
    if (rest[0] === 'end') rest = rest.slice(1);
    const c = cond, th = thenExpr, el = elseExpr;
    return {
      filter: (input) => {
        const cv = c(input)[0];
        if (cv && cv !== false && cv !== null) return th(input);
        return el(input);
      },
      rest,
    };
  }

  // Builtins
  return parseBuiltin(tokens);
}

function parseObjectConstruction(tokens: string[]): { filter: JqFilter; rest: string[] } {
  let rest = tokens.slice(1); // skip {
  const pairs: { key: JqFilter | string; value: JqFilter }[] = [];

  while (rest[0] !== '}' && rest.length > 0) {
    if (rest[0] === ',') { rest = rest.slice(1); continue; }

    let key: JqFilter | string;
    let value: JqFilter;

    if (rest[0]?.startsWith('"')) {
      key = JSON.parse(rest[0]);
      rest = rest.slice(1);
    } else if (rest[0] === '(') {
      const { filter: kf, rest: r } = parsePipe(rest.slice(1));
      key = kf;
      rest = r[0] === ')' ? r.slice(1) : r;
    } else if (/^[a-zA-Z_]/.test(rest[0] || '')) {
      key = rest[0];
      rest = rest.slice(1);
    } else {
      rest = rest.slice(1);
      continue;
    }

    if (rest[0] === ':') {
      rest = rest.slice(1);
      const { filter: vf, rest: r } = parseOr(rest);
      value = vf;
      rest = r;
    } else {
      // Shorthand: {name} means {name: .name}
      const k = key as string;
      value = (input) => [input?.[k]];
    }

    pairs.push({ key, value });
  }

  if (rest[0] === '}') rest = rest.slice(1);

  return {
    filter: (input) => {
      const obj: Record<string, any> = {};
      for (const { key, value } of pairs) {
        const k = typeof key === 'function' ? key(input)[0] : key;
        const v = value(input)[0];
        obj[k] = v;
      }
      return [obj];
    },
    rest,
  };
}

function parseBuiltin(tokens: string[]): { filter: JqFilter; rest: string[] } {
  const name = tokens[0];
  let rest = tokens.slice(1);

  // Check if next token is ( for builtins that take args
  const hasArgs = rest[0] === '(';
  let argFilter: JqFilter | null = null;
  let argFilter2: JqFilter | null = null;

  if (hasArgs) {
    rest = rest.slice(1); // skip (
    const parsed = parsePipe(rest);
    argFilter = parsed.filter;
    rest = parsed.rest;
    if (rest[0] === ';') {
      rest = rest.slice(1);
      const parsed2 = parsePipe(rest);
      argFilter2 = parsed2.filter;
      rest = parsed2.rest;
    }
    if (rest[0] === ')') rest = rest.slice(1);
  }

  switch (name) {
    case 'length':
      return { filter: (input) => {
        if (input == null) return [0];
        if (typeof input === 'string' || Array.isArray(input)) return [input.length];
        if (typeof input === 'object') return [Object.keys(input).length];
        return [0];
      }, rest };

    case 'keys': case 'keys_unsorted':
      return { filter: (input) => {
        if (Array.isArray(input)) return [input.map((_, i) => i)];
        if (typeof input === 'object' && input) {
          const k = Object.keys(input);
          return [name === 'keys' ? k.sort() : k];
        }
        return [[]];
      }, rest };

    case 'values':
      return { filter: (input) => {
        if (Array.isArray(input)) return [input];
        if (typeof input === 'object' && input) return [Object.values(input)];
        return [[]];
      }, rest };

    case 'type':
      return { filter: (input) => {
        if (input === null) return ['null'];
        if (Array.isArray(input)) return ['array'];
        return [typeof input];
      }, rest };

    case 'map':
      return { filter: (input) => {
        if (!Array.isArray(input) || !argFilter) return [[]];
        const results: JqValue[] = [];
        for (const item of input) results.push(...argFilter(item));
        return [results];
      }, rest };

    case 'map_values':
      return { filter: (input) => {
        if (!argFilter) return [input];
        if (Array.isArray(input)) return [input.map(v => argFilter!(v)[0])];
        if (typeof input === 'object' && input) {
          const result: Record<string, any> = {};
          for (const [k, v] of Object.entries(input)) result[k] = argFilter!(v)[0];
          return [result];
        }
        return [input];
      }, rest };

    case 'select':
      return { filter: (input) => {
        if (!argFilter) return [input];
        const v = argFilter(input)[0];
        return (v && v !== false && v !== null) ? [input] : [];
      }, rest };

    case 'sort':
      return { filter: (input) => {
        if (!Array.isArray(input)) return [input];
        return [[...input].sort((a, b) => {
          if (typeof a === 'number' && typeof b === 'number') return a - b;
          return String(a).localeCompare(String(b));
        })];
      }, rest };

    case 'sort_by':
      return { filter: (input) => {
        if (!Array.isArray(input) || !argFilter) return [input];
        const af = argFilter;
        return [[...input].sort((a, b) => {
          const va = af(a)[0], vb = af(b)[0];
          if (typeof va === 'number' && typeof vb === 'number') return va - vb;
          return String(va).localeCompare(String(vb));
        })];
      }, rest };

    case 'group_by':
      return { filter: (input) => {
        if (!Array.isArray(input) || !argFilter) return [input];
        const groups = new Map<string, JqValue[]>();
        for (const item of input) {
          const key = JSON.stringify(argFilter(item)[0]);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(item);
        }
        return [Array.from(groups.values())];
      }, rest };

    case 'unique':
      return { filter: (input) => {
        if (!Array.isArray(input)) return [input];
        const seen = new Set<string>();
        const result: JqValue[] = [];
        for (const item of input) {
          const k = JSON.stringify(item);
          if (!seen.has(k)) { seen.add(k); result.push(item); }
        }
        return [result];
      }, rest };

    case 'unique_by':
      return { filter: (input) => {
        if (!Array.isArray(input) || !argFilter) return [input];
        const seen = new Set<string>();
        const result: JqValue[] = [];
        for (const item of input) {
          const k = JSON.stringify(argFilter(item)[0]);
          if (!seen.has(k)) { seen.add(k); result.push(item); }
        }
        return [result];
      }, rest };

    case 'flatten':
      return { filter: (input) => {
        if (!Array.isArray(input)) return [input];
        const depth = argFilter ? argFilter(input)[0] : Infinity;
        return [input.flat(depth)];
      }, rest };

    case 'add':
      return { filter: (input) => {
        if (!Array.isArray(input) || input.length === 0) return [null];
        return [input.reduce((a, b) => {
          if (typeof a === 'string') return a + b;
          if (Array.isArray(a)) return [...a, ...b];
          if (typeof a === 'number') return a + b;
          if (typeof a === 'object' && a) return { ...a, ...b };
          return b;
        })];
      }, rest };

    case 'any':
      return { filter: (input) => {
        if (!Array.isArray(input)) return [false];
        if (argFilter) return [input.some(v => { const r = argFilter!(v)[0]; return r && r !== false && r !== null; })];
        return [input.some(v => v && v !== false && v !== null)];
      }, rest };

    case 'all':
      return { filter: (input) => {
        if (!Array.isArray(input)) return [false];
        if (argFilter) return [input.every(v => { const r = argFilter!(v)[0]; return r && r !== false && r !== null; })];
        return [input.every(v => v && v !== false && v !== null)];
      }, rest };

    case 'has':
      return { filter: (input) => {
        if (!argFilter) return [false];
        const key = argFilter(input)[0];
        if (Array.isArray(input)) return [key >= 0 && key < input.length];
        if (typeof input === 'object' && input) return [key in input];
        return [false];
      }, rest };

    case 'in':
      return { filter: (input) => {
        if (!argFilter) return [false];
        const obj = argFilter(input)[0];
        if (typeof obj === 'object' && obj) return [input in obj];
        return [false];
      }, rest };

    case 'contains':
      return { filter: (input) => {
        if (!argFilter) return [false];
        const val = argFilter(input)[0];
        if (typeof input === 'string') return [input.includes(val)];
        if (Array.isArray(input)) return [JSON.stringify(input).includes(JSON.stringify(val))];
        return [false];
      }, rest };

    case 'to_entries':
      return { filter: (input) => {
        if (typeof input !== 'object' || input === null) return [[]];
        return [Object.entries(input).map(([key, value]) => ({ key, value }))];
      }, rest };

    case 'from_entries':
      return { filter: (input) => {
        if (!Array.isArray(input)) return [{}];
        const obj: Record<string, any> = {};
        for (const entry of input) {
          const k = entry.key ?? entry.name;
          obj[k] = entry.value;
        }
        return [obj];
      }, rest };

    case 'with_entries':
      return { filter: (input) => {
        if (typeof input !== 'object' || input === null || !argFilter) return [input];
        const entries = Object.entries(input).map(([key, value]) => ({ key, value }));
        const mapped = entries.map(e => argFilter!(e)[0]);
        const obj: Record<string, any> = {};
        for (const entry of mapped) obj[entry.key ?? entry.name] = entry.value;
        return [obj];
      }, rest };

    case 'tostring':
      return { filter: (input) => [typeof input === 'string' ? input : JSON.stringify(input)], rest };

    case 'tonumber':
      return { filter: (input) => [Number(input)], rest };

    case 'ascii_downcase':
      return { filter: (input) => [typeof input === 'string' ? input.toLowerCase() : input], rest };

    case 'ascii_upcase':
      return { filter: (input) => [typeof input === 'string' ? input.toUpperCase() : input], rest };

    case 'ltrimstr':
      return { filter: (input) => {
        if (typeof input !== 'string' || !argFilter) return [input];
        const prefix = argFilter(input)[0];
        return [input.startsWith(prefix) ? input.slice(prefix.length) : input];
      }, rest };

    case 'rtrimstr':
      return { filter: (input) => {
        if (typeof input !== 'string' || !argFilter) return [input];
        const suffix = argFilter(input)[0];
        return [input.endsWith(suffix) ? input.slice(0, -suffix.length) : input];
      }, rest };

    case 'test':
      return { filter: (input) => {
        if (typeof input !== 'string' || !argFilter) return [false];
        const pattern = argFilter(input)[0];
        const flags = argFilter2 ? argFilter2(input)[0] : '';
        return [new RegExp(pattern, flags).test(input)];
      }, rest };

    case 'match':
      return { filter: (input) => {
        if (typeof input !== 'string' || !argFilter) return [null];
        const pattern = argFilter(input)[0];
        const flags = argFilter2 ? argFilter2(input)[0] : '';
        const m = input.match(new RegExp(pattern, flags));
        if (!m) return [null];
        return [{ offset: m.index, length: m[0].length, string: m[0], captures: (m.slice(1) || []).map((s, i) => ({ offset: (m.index || 0) + (m[0].indexOf(s) >= 0 ? m[0].indexOf(s) : 0), length: s?.length || 0, string: s, name: null })) }];
      }, rest };

    case 'capture':
      return { filter: (input) => {
        if (typeof input !== 'string' || !argFilter) return [{}];
        const pattern = argFilter(input)[0];
        const m = input.match(new RegExp(pattern));
        if (!m || !m.groups) return [{}];
        return [m.groups];
      }, rest };

    case 'split':
      return { filter: (input) => {
        if (typeof input !== 'string' || !argFilter) return [input];
        return [input.split(argFilter(input)[0])];
      }, rest };

    case 'join':
      return { filter: (input) => {
        if (!Array.isArray(input) || !argFilter) return [input];
        return [input.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(argFilter(input)[0])];
      }, rest };

    case 'gsub':
      return { filter: (input) => {
        if (typeof input !== 'string' || !argFilter || !argFilter2) return [input];
        const pattern = argFilter(input)[0];
        const replacement = argFilter2(input)[0];
        return [input.replace(new RegExp(pattern, 'g'), replacement)];
      }, rest };

    case 'sub':
      return { filter: (input) => {
        if (typeof input !== 'string' || !argFilter || !argFilter2) return [input];
        const pattern = argFilter(input)[0];
        const replacement = argFilter2(input)[0];
        return [input.replace(new RegExp(pattern), replacement)];
      }, rest };

    case 'startswith':
      return { filter: (input) => {
        if (typeof input !== 'string' || !argFilter) return [false];
        return [input.startsWith(argFilter(input)[0])];
      }, rest };

    case 'endswith':
      return { filter: (input) => {
        if (typeof input !== 'string' || !argFilter) return [false];
        return [input.endsWith(argFilter(input)[0])];
      }, rest };

    case 'first':
      return { filter: (input) => {
        if (argFilter) { const r = argFilter(input); return r.length > 0 ? [r[0]] : []; }
        if (Array.isArray(input) && input.length > 0) return [input[0]];
        return [];
      }, rest };

    case 'last':
      return { filter: (input) => {
        if (argFilter) { const r = argFilter(input); return r.length > 0 ? [r[r.length - 1]] : []; }
        if (Array.isArray(input) && input.length > 0) return [input[input.length - 1]];
        return [];
      }, rest };

    case 'nth':
      return { filter: (input) => {
        if (!argFilter) return [];
        const n = argFilter(input)[0] as number;
        if (Array.isArray(input)) return n < input.length ? [input[n]] : [];
        return [];
      }, rest };

    case 'range':
      return { filter: (input) => {
        if (!argFilter) return [];
        const from = argFilter(input)[0] as number;
        const to = argFilter2 ? argFilter2(input)[0] as number : from;
        const start = argFilter2 ? from : 0;
        const results: number[] = [];
        for (let n = start; n < to; n++) results.push(n);
        return results;
      }, rest };

    case 'min': return { filter: (input) => [Array.isArray(input) ? Math.min(...input) : input], rest };
    case 'max': return { filter: (input) => [Array.isArray(input) ? Math.max(...input) : input], rest };

    case 'min_by':
      return { filter: (input) => {
        if (!Array.isArray(input) || !argFilter || input.length === 0) return [null];
        return [input.reduce((min, v) => argFilter!(v)[0] < argFilter!(min)[0] ? v : min)];
      }, rest };

    case 'max_by':
      return { filter: (input) => {
        if (!Array.isArray(input) || !argFilter || input.length === 0) return [null];
        return [input.reduce((max, v) => argFilter!(v)[0] > argFilter!(max)[0] ? v : max)];
      }, rest };

    case 'indices': case 'index':
      return { filter: (input) => {
        if (!argFilter) return [null];
        const val = argFilter(input)[0];
        if (typeof input === 'string') {
          if (name === 'indices') {
            const idxs: number[] = [];
            let pos = 0;
            while ((pos = input.indexOf(val, pos)) !== -1) { idxs.push(pos); pos++; }
            return [idxs];
          }
          return [input.indexOf(val) >= 0 ? input.indexOf(val) : null];
        }
        if (Array.isArray(input)) {
          const idx = input.findIndex(v => JSON.stringify(v) === JSON.stringify(val));
          return [idx >= 0 ? idx : null];
        }
        return [null];
      }, rest };

    case 'reverse':
      return { filter: (input) => {
        if (typeof input === 'string') return [input.split('').reverse().join('')];
        if (Array.isArray(input)) return [[...input].reverse()];
        return [input];
      }, rest };

    case 'limit':
      return { filter: (input) => {
        if (!argFilter || !argFilter2) return [];
        const n = argFilter(input)[0] as number;
        return argFilter2(input).slice(0, n);
      }, rest };

    case 'recurse':
      return { filter: (input) => {
        const results: JqValue[] = [];
        const walk = (v: JqValue) => {
          results.push(v);
          if (Array.isArray(v)) v.forEach(walk);
          else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
        };
        walk(input);
        return results;
      }, rest };

    case 'env':
      return { filter: () => [{}], rest };

    case 'paths':
      return { filter: (input) => {
        const results: JqValue[] = [];
        const walk = (v: JqValue, path: (string | number)[]) => {
          if (Array.isArray(v)) v.forEach((item, i) => { results.push([...path, i]); walk(item, [...path, i]); });
          else if (typeof v === 'object' && v !== null) Object.keys(v).forEach(k => { results.push([...path, k]); walk(v[k], [...path, k]); });
        };
        walk(input, []);
        return results;
      }, rest };

    case 'getpath':
      return { filter: (input) => {
        if (!argFilter) return [null];
        const path = argFilter(input)[0] as (string | number)[];
        let v = input;
        for (const k of path) { if (v == null) return [null]; v = v[k]; }
        return [v];
      }, rest };

    case 'del':
      return { filter: (input) => {
        if (!argFilter) return [input];
        // Simple implementation: del(.key) or del(.[0])
        const result = JSON.parse(JSON.stringify(input));
        // Evaluate the filter to find what to delete
        // For simple cases, we delete the path
        const tokens2 = tokenize(tokens.slice(1).join(' ').replace(/^\(/, '').replace(/\).*$/, ''));
        if (tokens2[0] === '.' && tokens2[1] && /^[a-zA-Z_]/.test(tokens2[1])) {
          delete result[tokens2[1]];
        }
        return [result];
      }, rest };

    case 'input': case 'inputs':
      return { filter: () => [], rest };

    case 'debug':
      return { filter: (input) => { console.error('["DEBUG:",', JSON.stringify(input), ']'); return [input]; }, rest };

    case 'error':
      return { filter: (input) => { throw new JqError(typeof input === 'string' ? input : JSON.stringify(input)); }, rest };

    case 'try':
      // try-catch: try E (catch F)?
      if (rest.length > 0) {
        const { filter: tryExpr, rest: r2 } = parsePostfix(rest);
        let catchExpr: JqFilter = () => [];
        let r3 = r2;
        if (r3[0] === 'catch') {
          const parsed = parsePostfix(r3.slice(1));
          catchExpr = parsed.filter;
          r3 = parsed.rest;
        }
        const te = tryExpr, ce = catchExpr;
        return { filter: (input) => { try { return te(input); } catch { return ce(input); } }, rest: r3 };
      }
      return { filter: (input) => [input], rest };

    default:
      // Unknown builtin — treat as identity and skip
      if (hasArgs) return { filter: (input) => [input], rest };
      // Might be a variable reference like $name
      if (name.startsWith('$')) {
        return { filter: () => [null], rest };
      }
      throw new JqError(`Unknown function: ${name}`);
  }
}

function formatOutput(value: JqValue, raw: boolean, compact: boolean): string {
  if (value === undefined) return '';
  if (raw && typeof value === 'string') return value;
  if (compact) return JSON.stringify(value);
  return JSON.stringify(value, null, 2);
}

export const jqCmd: Command = {
  name: 'jq',
  description: 'JSON processor',
  async exec(ctx) {
    let raw = false;
    let compact = false;
    let slurp = false;
    let nullInput = false;
    let exitStatus = false;
    let filterExpr = '.';
    const jqArgs: Record<string, string> = {};
    const files: string[] = [];

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-r' || arg === '--raw-output') raw = true;
      else if (arg === '-R' || arg === '--raw-input') { /* treat input as strings */ }
      else if (arg === '-c' || arg === '--compact-output') compact = true;
      else if (arg === '-s' || arg === '--slurp') slurp = true;
      else if (arg === '-n' || arg === '--null-input') nullInput = true;
      else if (arg === '-e' || arg === '--exit-status') exitStatus = true;
      else if (arg === '-S' || arg === '--sort-keys') { /* we sort by default in keys */ }
      else if (arg === '-j' || arg === '--join-output') { raw = true; }
      else if (arg === '--arg' && ctx.args[i + 1] && ctx.args[i + 2]) {
        jqArgs['$' + ctx.args[i + 1]] = ctx.args[i + 2];
        i += 2;
      } else if (arg === '--argjson' && ctx.args[i + 1] && ctx.args[i + 2]) {
        jqArgs['$' + ctx.args[i + 1]] = JSON.parse(ctx.args[i + 2]);
        i += 2;
      } else if (!arg.startsWith('-') || i === 0 || (ctx.args[i - 1] !== '--arg' && ctx.args[i - 1] !== '--argjson')) {
        if (filterExpr === '.' && !arg.startsWith('-')) {
          filterExpr = arg;
        } else if (!arg.startsWith('-')) {
          files.push(arg);
        }
      }
      i++;
    }

    // Read input
    let inputText = ctx.stdin;
    if (files.length > 0) {
      const parts: string[] = [];
      for (const file of files) {
        const resolved = ctx.fs.resolvePath(file, ctx.cwd);
        const data = await ctx.fs.readFile(resolved);
        parts.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
      }
      inputText = parts.join('\n');
    }

    try {
      const tokens = tokenize(filterExpr);
      const { filter } = parse(tokens);

      // Inject --arg variables by wrapping the filter
      const wrappedFilter: JqFilter = (input) => {
        // For now, $var references resolve to null — simple approach
        return filter(input);
      };

      let inputs: JqValue[];
      if (nullInput) {
        inputs = [null];
      } else if (slurp) {
        // Parse all JSON values and slurp into array
        const values: JqValue[] = [];
        for (const line of inputText.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {
            try { values.push(JSON.parse(trimmed)); } catch {}
          }
        }
        inputs = [values];
      } else {
        // Parse potentially multiple JSON values (newline-delimited)
        inputs = [];
        // Try parsing as a single JSON value first
        const trimmed = inputText.trim();
        if (trimmed) {
          try {
            inputs.push(JSON.parse(trimmed));
          } catch {
            // Try line-by-line
            for (const line of inputText.split('\n')) {
              const t = line.trim();
              if (t) {
                try { inputs.push(JSON.parse(t)); } catch {}
              }
            }
          }
        }
      }

      if (inputs.length === 0 && !nullInput) {
        inputs = [null];
      }

      const outputParts: string[] = [];
      let hasNull = false;
      let hasFalse = false;

      for (const input of inputs) {
        const results = wrappedFilter(input);
        for (const result of results) {
          if (result === null) hasNull = true;
          if (result === false) hasFalse = true;
          const formatted = formatOutput(result, raw, compact);
          if (formatted !== '') outputParts.push(formatted);
        }
      }

      ctx.stdout = outputParts.join('\n') + (outputParts.length > 0 ? '\n' : '');

      if (exitStatus && (hasNull || hasFalse)) return 1;
      return 0;
    } catch (e: any) {
      ctx.stderr = `jq: ${e.message}\n`;
      return 2;
    }
  },
};
