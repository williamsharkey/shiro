import type { Command } from './index';

/**
 * tr, as GNU coreutils in the C locale: escapes (\NNN octal too), ranges,
 * [:class:] in C-locale order, [=c=], [c*n] / [c*] in SET2, -c/-C, -d, -s,
 * -t; SET2 is padded with its last character; [:lower:]/[:upper:] pairs
 * convert case.
 */

const range = (a: number, b: number) => { let s = ''; for (let c = a; c <= b; c++) s += String.fromCharCode(c); return s; };
const filterChars = (f: (c: number) => boolean) => { let s = ''; for (let c = 0; c < 256; c++) if (f(c)) s += String.fromCharCode(c); return s; };
const isAlnumC = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

const CLASSES: Record<string, string> = {
  alnum: range(48, 57) + range(65, 90) + range(97, 122),
  alpha: range(65, 90) + range(97, 122),
  blank: '\t ',
  cntrl: range(0, 31) + '\x7f',
  digit: range(48, 57),
  graph: range(33, 126),
  lower: range(97, 122),
  print: range(32, 126),
  punct: filterChars((c) => c >= 33 && c <= 126 && !isAlnumC(c)),
  space: '\t\n\v\f\r ',
  upper: range(65, 90),
  xdigit: range(48, 57) + 'ABCDEF' + 'abcdef',
};

type Elem =
  | { kind: 'chars'; s: string }
  | { kind: 'class'; name: string }
  | { kind: 'repeat'; c: string; n: number | null };

class TrError extends Error {}

/** Unescape one character at s[i] (after a backslash); returns [char, nextIndex] */
function unescape(s: string, i: number): [string, number] {
  const c = s[i];
  const map: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
  if (c in map) return [map[c], i + 1];
  if (c >= '0' && c <= '7') {
    let j = i;
    let v = 0;
    while (j < s.length && j < i + 3 && s[j] >= '0' && s[j] <= '7') {
      const nv = v * 8 + (s.charCodeAt(j) - 48);
      if (nv > 255) break;
      v = nv;
      j++;
    }
    return [String.fromCharCode(v), j];
  }
  return [c, i + 1];
}

/** Parse a SET operand into elements */
function parseSet(s: string, isSet2: boolean): Elem[] {
  // First pass: tokens with escape info, so `\-` and `\[` are literal
  const toks: { c: string; lit: boolean }[] = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === '\\') {
      if (i + 1 >= s.length) { toks.push({ c: '\\', lit: true }); i++; continue; }
      const [c, n] = unescape(s, i + 1);
      toks.push({ c, lit: true });
      i = n;
    } else {
      toks.push({ c: s[i], lit: false });
      i++;
    }
  }
  const out: Elem[] = [];
  const pushChars = (str: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === 'chars') last.s += str;
    else out.push({ kind: 'chars', s: str });
  };
  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    if (t.c === '[' && !t.lit && i + 1 < toks.length) {
      const rest = toks.slice(i + 1).map((x) => (x.lit ? '\0' : x.c)).join('');
      // [:class:]
      const m = /^:([a-z]+):\]/.exec(rest);
      if (m) {
        if (!CLASSES[m[1]]) throw new TrError(`invalid character class '${m[1]}'`);
        out.push({ kind: 'class', name: m[1] });
        i += m[0].length + 1;
        continue;
      }
      // [=c=]
      if (i + 4 < toks.length && toks[i + 1].c === '=' && !toks[i + 1].lit && toks[i + 3].c === '=' && !toks[i + 3].lit && toks[i + 4].c === ']' && !toks[i + 4].lit) {
        pushChars(toks[i + 2].c);
        i += 5;
        continue;
      }
      // [c*n] / [c*]
      if (i + 3 < toks.length && toks[i + 2].c === '*' && !toks[i + 2].lit) {
        let j = i + 3;
        let digits = '';
        while (j < toks.length && /\d/.test(toks[j].c) && !toks[j].lit) digits += toks[j++].c;
        if (j < toks.length && toks[j].c === ']' && !toks[j].lit) {
          if (!isSet2) throw new TrError('the [c*] repeat construct may not appear in string1');
          let n: number | null = null;
          if (digits) {
            n = digits[0] === '0' ? parseInt(digits, 8) : parseInt(digits, 10);
            if (Number.isNaN(n) || (digits[0] === '0' && /[89]/.test(digits))) throw new TrError(`invalid repeat count '${digits}' in [c*n] construct`);
            if (n === 0) n = null;
          }
          out.push({ kind: 'repeat', c: toks[i + 1].c, n });
          i = j + 1;
          continue;
        }
      }
    }
    // Range c1-c2
    if (i + 2 < toks.length && toks[i + 1].c === '-' && !toks[i + 1].lit) {
      const a = t.c.charCodeAt(0), b = toks[i + 2].c.charCodeAt(0);
      if (b < a) {
        const show = (x: string) => (x === '\\' ? '\\\\' : x);
        throw new TrError(`range-endpoints of '${show(t.c)}-${show(toks[i + 2].c)}' are in reverse collating sequence order`);
      }
      pushChars(range(a, b));
      i += 3;
      continue;
    }
    pushChars(t.c);
    i++;
  }
  return out;
}

/** Expand elements to a string; [c*] fill is sized to `fillTo` */
function expand(elems: Elem[], fillTo: number): string {
  let fixed = 0;
  for (const e of elems) {
    if (e.kind === 'chars') fixed += e.s.length;
    else if (e.kind === 'class') fixed += CLASSES[e.name].length;
    else if (e.n !== null) fixed += e.n;
  }
  let s = '';
  for (const e of elems) {
    if (e.kind === 'chars') s += e.s;
    else if (e.kind === 'class') s += CLASSES[e.name];
    else s += e.c.repeat(e.n ?? Math.max(0, fillTo - fixed));
  }
  return s;
}

export const tr: Command = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(ctx) {
    let complement = false, del = false, squeeze = false, truncate = false;
    const ops: string[] = [];
    const usage = (msg: string) => { ctx.stderr += `tr: ${msg}\nTry 'tr --help' for more information.\n`; return 1; };
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { ops.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) {
        if (a === '--complement') complement = true;
        else if (a === '--delete') del = true;
        else if (a === '--squeeze-repeats') squeeze = true;
        else if (a === '--truncate-set1') truncate = true;
        else return usage(`unrecognized option '${a}'`);
        continue;
      }
      if (a.length > 1 && a[0] === '-') {
        for (const ch of a.slice(1)) {
          if (ch === 'c' || ch === 'C') complement = true;
          else if (ch === 'd') del = true;
          else if (ch === 's') squeeze = true;
          else if (ch === 't') truncate = true;
          else return usage(`invalid option -- '${ch}'`);
        }
        continue;
      }
      ops.push(a);
    }

    const translating = !del && ops.length >= 2;
    const need = del && squeeze ? 2 : del || (squeeze && ops.length < 2) ? 1 : 2;
    if (ops.length === 0) return usage('missing operand');
    if (ops.length < need) {
      return usage(`missing operand after '${ops[ops.length - 1]}'\n${del ? 'Two strings must be given when both deleting and squeezing repeats.' : 'Two strings must be given when translating.'}`);
    }
    if (ops.length > need) {
      return usage(`extra operand '${ops[need]}'${need === 1 && del ? '\nOnly one string may be given when deleting without squeezing repeats.' : ''}`);
    }

    let set1: string, set2 = '';
    let e1: Elem[], e2: Elem[] = [];
    try {
      e1 = parseSet(ops[0], false);
      if (ops.length > 1) e2 = parseSet(ops[1], true);
      set1 = expand(e1, 0);
      if (translating) {
        if (e2.some((e) => e.kind === 'class' && e.name !== 'upper' && e.name !== 'lower')) {
          throw new TrError("when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'");
        }
        if (e2.filter((e) => e.kind === 'repeat' && e.n === null).length > 1) throw new TrError('only one [c*] repeat construct may appear in string2');
      }
    } catch (e) {
      if (e instanceof TrError) { ctx.stderr += `tr: ${e.message}\n`; return 1; }
      throw e;
    }

    const inSet1 = new Set(set1);
    const member1 = (c: string) => (complement ? !inSet1.has(c) : inSet1.has(c));
    if (complement) set1 = filterChars((c) => !inSet1.has(String.fromCharCode(c)));
    if (ops.length > 1) set2 = expand(e2, set1.length);

    const input = ctx.stdin;
    let result = '';
    if (del) {
      for (const c of input) if (!member1(c)) result += c;
    } else if (translating) {
      if (set2.length === 0) {
        if (!truncate && set1.length) { ctx.stderr += 'tr: when not truncating set1, string2 must be non-empty\n'; return 1; }
      }
      if (complement && e2.some((e) => e.kind === 'class')) {
        ctx.stderr += 'tr: when translating with complemented character classes,\nstring2 must map all characters in the domain to one\n';
        return 1;
      }
      const map = new Map<string, string>();
      const n = truncate ? Math.min(set1.length, set2.length) : set1.length;
      for (let i = 0; i < n; i++) map.set(set1[i], set2[Math.min(i, set2.length - 1)]);
      const last = set2[set2.length - 1];
      for (const c of input) {
        const m = map.get(c);
        if (m !== undefined) result += m;
        // Characters past 0xff are outside the byte domain; complemented, they map like the rest
        else if (complement && c.charCodeAt(0) > 255 && !inSet1.has(c) && last !== undefined && (!truncate || set1.length <= set2.length)) result += last;
        else result += c;
      }
    } else {
      result = input;
    }

    if (squeeze) {
      const sq = del || translating ? new Set(set2) : null;
      const isSq = (c: string) => (sq ? sq.has(c) : member1(c));
      let out = '';
      let prev = '';
      for (const c of result) {
        if (c === prev && isSq(c)) continue;
        out += c;
        prev = c;
      }
      result = out;
    }

    ctx.stdout += result;
    return 0;
  },
};
