/**
 * POSIX ERE (with the gawk extensions \y \B \< \> \` \' \w \W \s \S) to a
 * JavaScript RegExp source. `.` matches newline (the `s` flag), unknown
 * escapes are the literal character, and a brace that does not start a valid
 * interval is literal (gawk accepts `a{`).
 */

const CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: '0-9a-zA-Z',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  print: ' -~',
  graph: '!-~',
  cntrl: '\\x00-\\x1f\\x7f',
  xdigit: '0-9A-Fa-f',
  word: '0-9a-zA-Z_',
};

function hex2(n: number): string {
  return '\\x' + n.toString(16).padStart(2, '0');
}

function codeEsc(code: number): string {
  if (code < 256) return hex2(code);
  return '\\u' + code.toString(16).padStart(4, '0');
}

/** A literal character, escaped for use outside brackets */
function litOutside(ch: string): string {
  return /[\\^$.|?*+()[\]{}\/-]/.test(ch) ? '\\' + ch : ch;
}

/** A literal character, escaped for use inside brackets */
function litInside(ch: string): string {
  return /[\\\]\[^-]/.test(ch) ? '\\' + ch : ch;
}

/** Decode a simple escape (after the backslash) at re[i]; returns [char, length] or null */
function simpleEscape(re: string, i: number): [string, number] | null {
  const c = re[i];
  switch (c) {
    case 'n': return ['\n', 1];
    case 't': return ['\t', 1];
    case 'r': return ['\r', 1];
    case 'f': return ['\f', 1];
    case 'v': return ['\v', 1];
    case 'a': return ['\x07', 1];
    case 'b': return ['\b', 1];
  }
  if (c >= '0' && c <= '7') {
    let j = i;
    let v = 0;
    while (j < re.length && j < i + 3 && re[j] >= '0' && re[j] <= '7') v = v * 8 + (re.charCodeAt(j++) - 48);
    return [String.fromCharCode(v & 0xff), j - i];
  }
  if (c === 'x' && /[0-9a-fA-F]/.test(re[i + 1] ?? '')) {
    let j = i + 1;
    let v = 0;
    while (j < re.length && j < i + 3 && /[0-9a-fA-F]/.test(re[j])) v = v * 16 + parseInt(re[j++], 16);
    return [String.fromCharCode(v), j - i];
  }
  return null;
}

export function ereToJs(re: string): string {
  let out = '';
  let i = 0;
  const n = re.length;
  // can the next quantifier apply to something?
  let canQuant = false;
  while (i < n) {
    const c = re[i];
    if (c === '\\') {
      i++;
      if (i >= n) { out += '\\\\'; canQuant = true; break; }
      const d = re[i];
      const se = simpleEscape(re, i);
      if (se) { out += codeEsc(se[0].charCodeAt(0)); i += se[1]; canQuant = true; continue; }
      i++;
      switch (d) {
        case 'y': out += '\\b'; canQuant = false; continue;
        case 'B': out += '\\B'; canQuant = false; continue;
        case '<': out += '\\b(?=\\w)'; canQuant = false; continue;
        case '>': out += '\\b(?<=\\w)'; canQuant = false; continue;
        case '`': out += '(?<![\\s\\S])'; canQuant = false; continue;
        case "'": out += '(?![\\s\\S])'; canQuant = false; continue;
        case 'w': case 'W': case 's': case 'S': out += '\\' + d; canQuant = true; continue;
      }
      out += litOutside(d);
      canQuant = true;
      continue;
    }
    if (c === '[') {
      const r = bracket(re, i);
      if (r) { out += r[0]; i = r[1]; canQuant = true; continue; }
      out += '\\[';
      i++;
      canQuant = true;
      continue;
    }
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(re.slice(i));
      if (m && canQuant) { out += m[0]; i += m[0].length; continue; }
      out += '\\{';
      i++;
      canQuant = true;
      continue;
    }
    if (c === '}') { out += '\\}'; i++; canQuant = true; continue; }
    if (c === '*' || c === '+' || c === '?') {
      if (!canQuant) { out += '\\' + c; i++; canQuant = true; continue; }
      out += c;
      i++;
      // a following quantifier stacks (a** is a*); JS rejects a**, so drop repeats
      while (i < n && (re[i] === '*' || re[i] === '+' || re[i] === '?')) i++;
      continue;
    }
    if (c === '(') {
      if (re[i + 1] === ')') { out += '(?:)'; i += 2; canQuant = true; continue; }
      out += '(';
      i++;
      canQuant = false;
      continue;
    }
    if (c === ')') { out += ')'; i++; canQuant = true; continue; }
    if (c === '|') { out += '|'; i++; canQuant = false; continue; }
    if (c === '^') { out += '^'; i++; canQuant = false; continue; }
    if (c === '$') { out += '$'; i++; canQuant = false; continue; }
    if (c === '.') { out += '.'; i++; canQuant = true; continue; }
    if (c === '/' || c === ']') { out += '\\' + c; i++; canQuant = true; continue; }
    const code = c.charCodeAt(0);
    out += code < 32 ? hex2(code) : c;
    i++;
    canQuant = true;
  }
  return out;
}

/** Translate a bracket expression starting at re[i] === '['; null if unterminated */
function bracket(re: string, i: number): [string, number] | null {
  const n = re.length;
  let j = i + 1;
  let out = '[';
  if (re[j] === '^') { out += '^'; j++; }
  let first = true;
  let any = false;
  while (j < n) {
    const c = re[j];
    if (c === ']' && !first) {
      // `[^]` / `[]` can't happen here (first ] is literal)
      if (!any) out += '\\s\\S';
      return [out + ']', j + 1];
    }
    first = false;
    any = true;
    if (c === '[' && (re[j + 1] === ':' || re[j + 1] === '=' || re[j + 1] === '.')) {
      const kind = re[j + 1];
      const end = re.indexOf(kind + ']', j + 2);
      if (end >= 0) {
        const name = re.slice(j + 2, end);
        if (kind === ':') out += CLASSES[name] ?? '';
        else out += [...name].map(litInside).join('');
        j = end + 2;
        continue;
      }
    }
    if (c === '\\' && j + 1 < n) {
      const se = simpleEscape(re, j + 1);
      if (se) { out += codeEsc(se[0].charCodeAt(0)); j += 1 + se[1]; continue; }
      const d = re[j + 1];
      if ('wWsS'.includes(d)) out += '\\' + d;
      else out += litInside(d);
      j += 2;
      continue;
    }
    if (c === '-') {
      // a dash at the start or end is literal
      out += (re[j + 1] === ']' || out.endsWith('[') || out.endsWith('[^')) ? '\\-' : '-';
      j++;
      continue;
    }
    const code = c.charCodeAt(0);
    out += code < 32 ? hex2(code) : litInside(c);
    j++;
  }
  return null;
}

const cache = new Map<string, RegExp>();
const gcache = new Map<string, RegExp>();

/** Compile an ERE (cached) */
export function compileEre(re: string): RegExp {
  let r = cache.get(re);
  if (r) return r;
  try {
    r = new RegExp(ereToJs(re), 's');
  } catch {
    // last resort: match the text literally
    r = new RegExp(re.replace(/[\\^$.|?*+()[\]{}\/]/g, '\\$&'), 's');
  }
  if (cache.size > 500) cache.clear();
  cache.set(re, r);
  return r;
}

/** The same regex with the g flag, for scanning with lastIndex */
export function compileEreGlobal(re: string): RegExp {
  let r = gcache.get(re);
  if (r) return r;
  const base = compileEre(re);
  r = new RegExp(base.source, 'gs');
  if (gcache.size > 500) gcache.clear();
  gcache.set(re, r);
  return r;
}
