import type { Command } from './index';

/**
 * sort, as GNU coreutils in the C locale (sort.c): -k keys with per-key
 * ordering options (a key with none inherits the global ones), fields
 * begin at their leading blanks unless -b, the whole line breaks ties
 * (reversed by a global -r) unless -s or -u, -n/-g/-h/-M/-V/-R/-d/-f/-i,
 * -c/-C, -m, -o (may name an input), -t, -u, -z, obsolete +POS1 -POS2.
 */

interface Key {
  /** 0-based start field; -1 = start of line */
  sword: number;
  schar: number;
  /** 0-based end field; -1 = end of line */
  eword: number;
  /** 0 = end of the field */
  echar: number;
  skipsblanks: boolean;
  skipeblanks: boolean;
  ignore: null | 'd' | 'i';
  translate: boolean;
  numeric: boolean;
  general: boolean;
  human: boolean;
  month: boolean;
  version: boolean;
  random: boolean;
  reverse: boolean;
}

const newKey = (): Key => ({
  sword: -1, schar: 0, eword: -1, echar: 0, skipsblanks: false, skipeblanks: false, ignore: null,
  translate: false, numeric: false, general: false, human: false, month: false, version: false, random: false, reverse: false,
});

const isBlank = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n';
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isAlpha = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

/** Apply ordering letters; returns the rest of the string */
function setOrdering(s: string, key: Key, start: boolean): string {
  let i = 0;
  for (; i < s.length; i++) {
    switch (s[i]) {
      case 'b': if (start) key.skipsblanks = true; else key.skipeblanks = true; break;
      case 'd': key.ignore = 'd'; break;
      case 'f': key.translate = true; break;
      case 'g': key.general = true; break;
      case 'h': key.human = true; break;
      case 'i': if (!key.ignore) key.ignore = 'i'; break;
      case 'M': key.month = true; break;
      case 'n': key.numeric = true; break;
      case 'R': key.random = true; break;
      case 'r': key.reverse = true; break;
      case 'V': key.version = true; break;
      default: return s.slice(i);
    }
  }
  return '';
}

const hasOrdering = (k: Key) => k.ignore !== null || k.translate || k.skipsblanks || k.skipeblanks || k.month
  || k.numeric || k.version || k.general || k.human || k.random || k.reverse;

/** strnumcmp: [blanks][-]digits[.digits], no thousands separator */
function numCompare(a: string, b: string): number {
  const parse = (s: string) => {
    let i = 0;
    while (isBlank(s[i])) i++;
    let neg = false;
    if (s[i] === '-') { neg = true; i++; }
    let int = '';
    while (isDigit(s[i])) int += s[i++];
    let frac = '';
    if (s[i] === '.') { i++; while (isDigit(s[i])) frac += s[i++]; }
    int = int.replace(/^0+/, '');
    frac = frac.replace(/0+$/, '');
    if (!int && !frac) neg = false;
    return { neg, int, frac };
  };
  const x = parse(a), y = parse(b);
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  let mag = 0;
  if (x.int.length !== y.int.length) mag = x.int.length - y.int.length;
  else if (x.int !== y.int) mag = x.int < y.int ? -1 : 1;
  else {
    const n = Math.max(x.frac.length, y.frac.length);
    const fa = x.frac.padEnd(n, '0'), fb = y.frac.padEnd(n, '0');
    mag = fa === fb ? 0 : fa < fb ? -1 : 1;
  }
  return x.neg ? -mag : mag;
}

/** strtold prefix: null when nothing converts */
function strtod(s: string): number | null {
  const m = /^[ \t\n\v\f\r]*([+-]?)(?:(0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(inf(?:inity)?)|(nan(?:\([0-9a-zA-Z_]*\))?))/i.exec(s);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  if (m[2]) {
    const hm = /^0[xX]([0-9a-fA-F]*)\.?([0-9a-fA-F]*)(?:[pP]([+-]?\d+))?$/.exec(m[2])!;
    let v = parseInt(hm[1] || '0', 16);
    for (let k = 0; k < hm[2].length; k++) v += parseInt(hm[2][k], 16) / Math.pow(16, k + 1);
    return sign * v * Math.pow(2, hm[3] ? parseInt(hm[3], 10) : 0);
  }
  if (m[3]) return sign * parseFloat(m[3]);
  if (m[4]) return sign * Infinity;
  return NaN;
}

function generalCompare(a: string, b: string): number {
  const x = strtod(a), y = strtod(b);
  if (x === null) return y === null ? 0 : -1;
  if (y === null) return 1;
  if (x < y) return -1;
  if (x > y) return 1;
  if (x === y) return 0;
  if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : -1;
  return 1;
}

const UNIT_ORDER: Record<string, number> = { K: 1, k: 1, M: 2, G: 3, T: 4, P: 5, E: 6, Z: 7, Y: 8, R: 9, Q: 10 };

function unitOrder(s: string): number {
  let i = 0;
  const neg = s[i] === '-';
  if (neg) i++;
  let nonzero = false;
  while (isDigit(s[i])) { if (s[i] !== '0') nonzero = true; i++; }
  if (s[i] === '.') { i++; while (isDigit(s[i])) { if (s[i] !== '0') nonzero = true; i++; } }
  if (!nonzero) return 0;
  const o = UNIT_ORDER[s[i]] ?? 0;
  return neg ? -o : o;
}

function humanCompare(a: string, b: string): number {
  let i = 0, j = 0;
  while (isBlank(a[i])) i++;
  while (isBlank(b[j])) j++;
  a = a.slice(i); b = b.slice(j);
  return unitOrder(a) - unitOrder(b) || numCompare(a, b);
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function getMonth(s: string): number {
  let i = 0;
  while (isBlank(s[i])) i++;
  const p = s.slice(i, i + 3).toUpperCase();
  return MONTHS.indexOf(p) + 1;
}

/** gnulib filenvercmp */
function verrevcmp(a: string, alen: number, b: string, blen: number): number {
  const order = (s: string, pos: number, len: number): number => {
    if (pos === len) return 0;
    const c = s[pos];
    if (isDigit(c)) return 0;
    if (isAlpha(c)) return c.charCodeAt(0);
    if (c === '~') return -1;
    return c.charCodeAt(0) + 256;
  };
  let i = 0, j = 0;
  while (i < alen || j < blen) {
    let firstDiff = 0;
    while ((i < alen && !isDigit(a[i])) || (j < blen && !isDigit(b[j]))) {
      const ac = order(a, i, alen), bc = order(b, j, blen);
      if (ac !== bc) return ac - bc;
      i++; j++;
    }
    while (i < alen && a[i] === '0') i++;
    while (j < blen && b[j] === '0') j++;
    while (i < alen && j < blen && isDigit(a[i]) && isDigit(b[j])) {
      if (!firstDiff) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
      i++; j++;
    }
    if (i < alen && isDigit(a[i])) return 1;
    if (j < blen && isDigit(b[j])) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}

function filePrefixLen(s: string): number {
  const n = s.length;
  let prefix = 0;
  for (let i = 0; ;) {
    if (i === n) return prefix;
    i++;
    prefix = i;
    while (i + 1 < n && s[i] === '.' && (isAlpha(s[i + 1]) || s[i + 1] === '~')) {
      for (i += 2; i < n && (isAlpha(s[i]) || isDigit(s[i]) || s[i] === '~'); i++) { /* suffix */ }
    }
  }
}

function versionCompare(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a[0] === '.') {
    if (b[0] !== '.') return -1;
    if (a === '.') return -1;
    if (b === '.') return 1;
    if (a === '..') return -1;
    if (b === '..') return 1;
  } else if (b[0] === '.') return 1;
  const ap = filePrefixLen(a), bp = filePrefixLen(b);
  const onePass = ap === a.length && bp === b.length;
  const r = verrevcmp(a, ap, b, bp);
  return r || onePass ? r : verrevcmp(a, a.length, b, b.length);
}

/** FNV-1a of the key with a per-run salt, for -R */
function hashKey(s: string, salt: number): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const sort: Command = {
  name: "sort",
  description: "Sort lines of text",
  async exec(ctx) {
    const keys: Key[] = [];
    const g = newKey();
    let tab: string | null = null;
    let unique = false, stable = false, zero = false, merge = false;
    let check: null | 'diagnose' | 'quiet' = null;
    let output: string | null = null;
    const files: string[] = [];
    const usage = (msg: string) => { ctx.stderr += `sort: ${msg}\nTry 'sort --help' for more information.\n`; return 2; };
    const badField = (spec: string, msg: string) => { ctx.stderr += `sort: ${msg}: invalid field specification '${spec}'\n`; return 2; };

    const parseKey = (spec: string): Key | number => {
      const key = newKey();
      let m = /^\d+/.exec(spec);
      if (!m) return badField(spec, 'invalid number at field start');
      let s = spec.slice(m[0].length);
      const sw = parseInt(m[0], 10);
      if (sw === 0) return badField(spec, 'field number is zero');
      key.sword = sw - 1;
      if (s[0] === '.') {
        m = /^\d+/.exec(s.slice(1));
        if (!m) return badField(spec, "invalid number after '.'");
        const sc = parseInt(m[0], 10);
        if (sc === 0) return badField(spec, 'character offset is zero');
        key.schar = sc - 1;
        s = s.slice(1 + m[0].length);
      }
      if (!(key.sword || key.schar)) key.sword = -1;
      s = setOrdering(s, key, true);
      if (s[0] === ',') {
        m = /^\d+/.exec(s.slice(1));
        if (!m) return badField(spec, "invalid number after ','");
        const ew = parseInt(m[0], 10);
        if (ew === 0) return badField(spec, 'field number is zero');
        key.eword = ew - 1;
        s = s.slice(1 + m[0].length);
        if (s[0] === '.') {
          m = /^\d+/.exec(s.slice(1));
          if (!m) return badField(spec, "invalid number after '.'");
          key.echar = parseInt(m[0], 10);
          s = s.slice(1 + m[0].length);
        }
        s = setOrdering(s, key, false);
      }
      if (s) return badField(spec, 'stray character in field spec');
      return key;
    };

    const SORTS: Record<string, string> = { 'general-numeric': 'g', 'human-numeric': 'h', month: 'M', numeric: 'n', random: 'R', version: 'V' };
    const LONG_FLAGS: Record<string, string> = {
      'ignore-leading-blanks': 'b', 'dictionary-order': 'd', 'ignore-case': 'f', 'general-numeric-sort': 'g',
      'ignore-nonprinting': 'i', 'month-sort': 'M', 'human-numeric-sort': 'h', 'numeric-sort': 'n', 'random-sort': 'R',
      reverse: 'r', 'version-sort': 'V', merge: 'm', stable: 's', unique: 'u', 'zero-terminated': 'z',
    };
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      // Obsolete +POS1 [-POS2]
      if (/^\+\d/.test(a)) {
        const key = newKey();
        const m = /^\+(\d+)(?:\.(\d+))?(.*)$/.exec(a)!;
        key.sword = parseInt(m[1], 10);
        key.schar = m[2] ? parseInt(m[2], 10) : 0;
        if (!(key.sword || key.schar)) key.sword = -1;
        if (setOrdering(m[3], key, true) === '') {
          const next = args[i + 1];
          if (next && /^-\d/.test(next)) {
            i++;
            const e = /^-(\d+)(?:\.(\d+))?(.*)$/.exec(next)!;
            key.eword = parseInt(e[1], 10);
            key.echar = e[2] ? parseInt(e[2], 10) : 0;
            if (!key.echar && key.eword) key.eword--;
            if (setOrdering(e[3], key, false) !== '') return badField(next, 'stray character in field spec');
          }
          keys.push(key);
          continue;
        }
      }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = () => (eq >= 0 ? a.slice(eq + 1) : args[++i]);
        if (LONG_FLAGS[name]) { setOrdering(LONG_FLAGS[name], g, true); handleFlag(LONG_FLAGS[name]); continue; }
        switch (name) {
          case 'key': { const k = parseKey(val() ?? ''); if (typeof k === 'number') return k; keys.push(k); break; }
          case 'output': output = val() ?? ''; break;
          case 'field-separator': { const t = val() ?? ''; const e = setTab(t); if (e) return e; break; }
          case 'check': {
            const v = eq >= 0 ? a.slice(eq + 1) : null;
            if (v === null || v === 'diagnose-first') check = 'diagnose';
            else if (v === 'quiet' || v === 'silent') check = 'quiet';
            else return usage(`invalid argument '${v}' for '--check'`);
            break;
          }
          case 'sort': {
            const v = val() ?? '';
            if (!SORTS[v]) {
              ctx.stderr += `sort: invalid argument '${v}' for '--sort'\nValid arguments are:\n${Object.keys(SORTS).map((s) => `  - '${s}'`).join('\n')}\nTry 'sort --help' for more information.\n`;
              return 2;
            }
            setOrdering(SORTS[v], g, true);
            break;
          }
          case 'buffer-size': case 'temporary-directory': case 'parallel': case 'batch-size':
          case 'compress-program': case 'random-source':
            if (eq < 0) i++;
            break;
          case 'debug': break;
          default: return usage(`unrecognized option '${a}'`);
        }
        continue;
      }
      if (a.length > 1 && a[0] === '-') {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if ('koStT'.includes(ch)) {
            const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
            if (v === undefined) return usage(`option requires an argument -- '${ch}'`);
            if (ch === 'k') { const k = parseKey(v); if (typeof k === 'number') return k; keys.push(k); }
            else if (ch === 'o') output = v;
            else if (ch === 't') { const e = setTab(v); if (e) return e; }
            break;
          }
          if (ch === 'c') { check = 'diagnose'; continue; }
          if (ch === 'C') { check = 'quiet'; continue; }
          if ('bdfghiMnRrV'.includes(ch)) { setOrdering(ch, g, true); if (ch === 'b') g.skipeblanks = true; continue; }
          if ('msuz'.includes(ch)) { handleFlag(ch); continue; }
          return usage(`invalid option -- '${ch}'`);
        }
        continue;
      }
      files.push(a);
    }

    function handleFlag(ch: string) {
      if (ch === 'm') merge = true;
      else if (ch === 's') stable = true;
      else if (ch === 'u') unique = true;
      else if (ch === 'z') zero = true;
      else if (ch === 'b') g.skipeblanks = true;
    }
    function setTab(t: string): number | null {
      let c = t;
      if (t === '\\0') c = '\0';
      else if (t.length !== 1) {
        if (t === '') { ctx.stderr += 'sort: empty tab\n'; return 2; }
        ctx.stderr += `sort: multi-character tab '${t}'\n`;
        return 2;
      }
      if (tab !== null && tab !== c) { ctx.stderr += 'sort: incompatible tabs\n'; return 2; }
      tab = c;
      return null;
    }

    // Keys with no ordering options inherit the global ones
    for (const k of keys) {
      if (!hasOrdering(k)) {
        k.ignore = g.ignore; k.translate = g.translate; k.skipsblanks = g.skipsblanks; k.skipeblanks = g.skipeblanks;
        k.month = g.month; k.numeric = g.numeric; k.general = g.general; k.human = g.human; k.version = g.version;
        k.random = g.random; k.reverse = g.reverse;
      }
    }
    const gDefault = !(g.ignore !== null || g.translate || g.skipsblanks || g.skipeblanks || g.month || g.numeric
      || g.version || g.general || g.human || g.random);
    if (!keys.length && !gDefault) keys.push(g);
    const reverse = g.reverse;
    if (check && files.length > 1) return usage(`extra operand '${files[1]}' not allowed with -${check === 'quiet' ? 'C' : 'c'}`);

    // Read the input
    const eol = zero ? '\0' : '\n';
    const inputs = files.length ? files : ['-'];
    const lines: string[] = [];
    const perFile: string[][] = [];
    for (const f of inputs) {
      let text: string;
      if (f === '-') text = ctx.stdin;
      else {
        try {
          text = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string;
        } catch {
          ctx.stderr += `sort: cannot read: ${f}: No such file or directory\n`;
          return 2;
        }
      }
      const parts = text === '' ? [] : text.split(eol);
      if (text.endsWith(eol)) parts.pop();
      for (const p of parts) lines.push(p);
      perFile.push(parts);
    }

    const salt = (Math.random() * 0x7fffffff) | 0;
    const begField = (line: string, key: Key): number => {
      const lim = line.length;
      let p = 0;
      if (key.sword < 0) {
        if (key.skipsblanks) while (p < lim && isBlank(line[p])) p++;
        return p;
      }
      let sword = key.sword;
      if (tab !== null) {
        while (p < lim && sword--) {
          while (p < lim && line[p] !== tab) p++;
          if (p < lim) p++;
        }
      } else {
        while (p < lim && sword--) {
          while (p < lim && isBlank(line[p])) p++;
          while (p < lim && !isBlank(line[p])) p++;
        }
      }
      if (key.skipsblanks) while (p < lim && isBlank(line[p])) p++;
      return Math.min(lim, p + key.schar);
    };
    const limField = (line: string, key: Key): number => {
      const lim = line.length;
      if (key.eword < 0) return lim;
      let eword = key.eword;
      const echar = key.echar;
      if (echar === 0) eword++;
      let p = 0;
      if (tab !== null) {
        while (p < lim && eword--) {
          while (p < lim && line[p] !== tab) p++;
          if (p < lim && (eword || echar)) p++;
        }
      } else {
        while (p < lim && eword--) {
          while (p < lim && isBlank(line[p])) p++;
          while (p < lim && !isBlank(line[p])) p++;
        }
      }
      if (echar !== 0) {
        if (key.skipeblanks) while (p < lim && isBlank(line[p])) p++;
        p = Math.min(lim, p + echar);
      }
      return p;
    };
    const ignored = (c: string, mode: 'd' | 'i') => mode === 'd'
      ? !(isBlank(c) || isAlpha(c) || isDigit(c))
      : !(c >= ' ' && c <= '~');
    const transform = (s: string, key: Key): string => {
      if (key.ignore) { let o = ''; for (const c of s) if (!ignored(c, key.ignore)) o += c; s = o; }
      if (key.translate) s = s.replace(/[a-z]+/g, (x) => x.toUpperCase());
      return s;
    };

    const keyCompare = (a: string, b: string): number => {
      for (const key of keys) {
        const la = limField(a, key), lb = limField(b, key);
        const ba = begField(a, key), bb = begField(b, key);
        let ta = a.slice(ba, Math.max(ba, la));
        let tb = b.slice(bb, Math.max(bb, lb));
        let diff: number;
        if (key.numeric || key.general || key.human || key.month || key.random || key.version) {
          ta = transform(ta, key);
          tb = transform(tb, key);
          if (key.numeric) diff = numCompare(ta, tb);
          else if (key.general) diff = generalCompare(ta, tb);
          else if (key.human) diff = humanCompare(ta, tb);
          else if (key.month) diff = getMonth(ta) - getMonth(tb);
          else if (key.random) {
            const ha = hashKey(ta, salt), hb = hashKey(tb, salt);
            diff = ha < hb ? -1 : ha > hb ? 1 : cmpStr(ta, tb);
          } else diff = versionCompare(ta, tb);
        } else {
          diff = cmpStr(transform(ta, key), transform(tb, key));
        }
        if (diff) return key.reverse ? -diff : diff;
      }
      return 0;
    };
    const compare = (a: string, b: string): number => {
      if (keys.length) {
        const d = keyCompare(a, b);
        if (d || unique || stable) return d;
      }
      const d = cmpStr(a, b);
      return reverse ? -d : d;
    };

    if (check) {
      for (let j = 1; j < lines.length; j++) {
        const d = compare(lines[j - 1], lines[j]);
        if (d > 0 || (unique && d === 0)) {
          if (check === 'diagnose') ctx.stderr += `sort: ${inputs[0]}:${j + 1}: disorder: ${lines[j]}\n`;
          return 1;
        }
      }
      return 0;
    }

    let sorted: string[];
    if (merge) {
      // Merge already-sorted inputs; on ties the earlier input goes first
      sorted = [];
      const pos = perFile.map(() => 0);
      for (;;) {
        let best = -1;
        for (let f = 0; f < perFile.length; f++) {
          if (pos[f] >= perFile[f].length) continue;
          if (best < 0 || compare(perFile[f][pos[f]], perFile[best][pos[best]]) < 0) best = f;
        }
        if (best < 0) break;
        sorted.push(perFile[best][pos[best]++]);
      }
    } else {
      sorted = lines.slice().sort(compare);
    }
    if (unique) sorted = sorted.filter((l, k) => k === 0 || compare(sorted[k - 1], l) !== 0);
    const out = sorted.map((l) => l + eol).join('');

    if (output !== null && output !== '-') {
      try {
        await ctx.fs.writeFile(ctx.fs.resolvePath(output, ctx.cwd), out);
      } catch {
        ctx.stderr += `sort: open failed: ${output}: No such file or directory\n`;
        return 2;
      }
    } else {
      ctx.stdout += out;
    }
    return 0;
  },
};
