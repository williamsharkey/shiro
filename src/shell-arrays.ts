/**
 * Bash arrays. Indexed arrays are JS arrays with holes (sparse, like bash's):
 * unset elements are absent, not ''. These helpers read them in index order,
 * and split raw `name=(…)` statements into words before any expansion, so
 * that quoting inside the parentheses is kept per element.
 */

/** Set elements in index order */
export function arrayValues(arr: string[]): string[] {
  return Object.values(arr);
}

/** Set indices in order */
export function arrayIndices(arr: string[]): number[] {
  return Object.keys(arr).map(Number);
}

/** One past the highest set index (what negative subscripts count back from) */
export function arrayTop(arr: string[]): number {
  const keys = Object.keys(arr);
  return keys.length ? Number(keys[keys.length - 1]) + 1 : 0;
}

/** A copy that keeps the holes ([...arr] would fill them with undefined) */
export function copyArray(arr: string[]): string[] {
  const out: string[] = [];
  for (const k of Object.keys(arr)) out[Number(k)] = arr[Number(k)];
  return out;
}

/** Index just past the `)` matching the `(` at s[i], or -1 */
function skipParen(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) return -1; i = e; continue; }
    if (c === '"') { const e = skipDouble(s, i); if (e < 0) return -1; i = e - 1; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Index just past the `"` closing the one at s[i], or -1 */
function skipDouble(s: string, i: number): number {
  for (i++; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') return i + 1;
    if (s[i] === '$' && s[i + 1] === '(') { const e = skipParen(s, i + 1); if (e < 0) return -1; i = e - 1; continue; }
    if (s[i] === '`') { const e = s.indexOf('`', i + 1); if (e < 0) return -1; i = e; }
  }
  return -1;
}

/** Index just past the `}` closing the `${` at s[i] */
function skipBrace(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) return -1; i = e; continue; }
    if (c === '"') { const e = skipDouble(s, i); if (e < 0) return -1; i = e - 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Split raw command text into words (quotes, $(…), ${…}, `…` and a
 * `name=(…)` list kept whole). Returns null when the text has anything but
 * words (operators, redirections, a stray paren), so callers leave it alone.
 */
export function splitRawWords(s: string): string[] | null {
  const words: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    const start = i;
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) return null; i = e + 1; continue; }
      if (c === '"') { const e = skipDouble(s, i); if (e < 0) return null; i = e; continue; }
      if (c === '`') { const e = s.indexOf('`', i + 1); if (e < 0) return null; i = e + 1; continue; }
      if (c === '$' && s[i + 1] === '(') { const e = skipParen(s, i + 1); if (e < 0) return null; i = e; continue; }
      if (c === '$' && s[i + 1] === '{') { const e = skipBrace(s, i + 1); if (e < 0) return null; i = e; continue; }
      if (c === '(' && s[i - 1] === '=' && i - 1 > start) { const e = skipParen(s, i); if (e < 0) return null; i = e; continue; }
      if (c === '[' && i > start && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.slice(start, i))) {
        // a[sub]=…: the subscript may hold blanks and parens
        let depth = 0, j = i;
        for (; j < s.length; j++) {
          if (s[j] === '[') depth++;
          else if (s[j] === ']' && --depth === 0) break;
        }
        if (j >= s.length) return null;
        i = j + 1;
        continue;
      }
      if (/[;&|<>()]/.test(c)) return null;
      i++;
    }
    words.push(s.slice(start, i));
  }
  return words;
}

export interface AssignWord {
  name: string;
  /** Raw subscript text of name[sub]=… */
  sub?: string;
  append: boolean;
  /** Raw value text (for a list, without the parentheses) */
  value: string;
  list: boolean;
}

/** Parse a raw `name=value`, `name+=value`, `name[sub]=value` or `name=(list)` word */
export function parseAssignWord(word: string): AssignWord | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(word);
  if (!m) return null;
  let i = m[0].length;
  let sub: string | undefined;
  if (word[i] === '[') {
    let depth = 0, j = i;
    for (; j < word.length; j++) {
      if (word[j] === '[') depth++;
      else if (word[j] === ']' && --depth === 0) break;
    }
    if (j >= word.length) return null;
    sub = word.slice(i + 1, j);
    i = j + 1;
  }
  let append = false;
  if (word[i] === '+') { append = true; i++; }
  if (word[i] !== '=') return null;
  const value = word.slice(i + 1);
  const list = value.startsWith('(') && value.endsWith(')');
  return { name: m[1], sub, append, value: list ? value.slice(1, -1) : value, list };
}

/**
 * Words of an array literal's inside: blank- and newline-separated (comments
 * are gone already). `[sub]=value` elements are returned with their subscript.
 */
export function splitListWords(body: string): { sub?: string; word: string }[] | null {
  const words = splitRawWords(body);
  if (!words) return null;
  return words.map((w) => {
    if (w.startsWith('[')) {
      let depth = 0, j = 0;
      for (; j < w.length; j++) {
        if (w[j] === '[') depth++;
        else if (w[j] === ']' && --depth === 0) break;
      }
      if (j < w.length && w[j + 1] === '=') return { sub: w.slice(1, j), word: w.slice(j + 2) };
      if (j < w.length && w[j + 1] === '+' && w[j + 2] === '=') return { sub: w.slice(1, j), word: w.slice(j + 3) };
    }
    return { word: w };
  });
}
