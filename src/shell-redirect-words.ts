/**
 * The file words of a simple command's redirections (`> $f`, `< a-*`), found in
 * the command's text before it is expanded: bash expands each one on its own,
 * to one word (globbing included), or fails with "ambiguous redirect", where a
 * command expanded as a whole would split `> $f` into a target and arguments.
 */

/** A redirection's file word in a command's text: [start, end) */
export interface RedirectWordSpan { start: number; end: number; word: string }

const GLOB_OR_SPLIT = /[$`*?[{]|[@!+](?=\()/;

/**
 * The redirection file words of `text` (one simple command or pipeline segment)
 * that need expanding on their own: those with an unquoted $, `, a glob
 * character or a brace. Empty when there are none, or for text this can't
 * read safely ([[ … ]], (( … )), a here-document).
 */
export function redirectWordSpans(text: string): RedirectWordSpan[] {
  if (!/[<>]/.test(text) || text.includes('[[') || text.includes('<<') || /(^|[^$])\(\(/.test(text)) return [];
  const spans: RedirectWordSpan[] = [];
  let i = 0;
  const n = text.length;
  // Skip a quoted string or substitution starting at i; returns the index after it
  const skipNested = (j: number): number => {
    const c = text[j];
    if (c === "'") { const e = text.indexOf("'", j + 1); return e < 0 ? n : e + 1; }
    if (c === '`') { let k = j + 1; while (k < n && text[k] !== '`') k += text[k] === '\\' ? 2 : 1; return k + 1; }
    if (c === '"') {
      let k = j + 1;
      while (k < n && text[k] !== '"') {
        if (text[k] === '\\') k += 2;
        else if (text[k] === '$' && (text[k + 1] === '(' || text[k + 1] === '{')) k = skipNested(k);
        else if (text[k] === '`') k = skipNested(k);
        else k++;
      }
      return k + 1;
    }
    if (c === '$' && (text[j + 1] === '(' || text[j + 1] === '{')) {
      const open = text[j + 1], close = open === '(' ? ')' : '}';
      let depth = 1, k = j + 2;
      while (k < n && depth > 0) {
        const d = text[k];
        if (d === '\\') { k += 2; continue; }
        if (d === "'" || d === '"' || d === '`' || (d === '$' && (text[k + 1] === '(' || text[k + 1] === '{'))) { k = skipNested(k); continue; }
        if (d === open) depth++;
        else if (d === close) depth--;
        k++;
      }
      return k;
    }
    return j + 1;
  };
  while (i < n) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'" || c === '"' || c === '`' || (c === '$' && (text[i + 1] === '(' || text[i + 1] === '{'))) { i = skipNested(i); continue; }
    // <(…) / >(…): a process substitution, not a file word
    if ((c === '<' || c === '>') && text[i + 1] === '(') { i = skipParens(text, i); continue; }
    if (c !== '<' && c !== '>') { i++; continue; }
    // the operator: <, >, >>, >|, <>, &>, &>> (an fd number before it is part of it)
    let j = i + 1;
    if (c === '>' && (text[j] === '>' || text[j] === '|')) j++;
    else if (c === '<' && text[j] === '>') j++;
    // >&N, <&N, >&-: a descriptor, not a file
    if (text[j] === '&') { i = j + 1; continue; }
    while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
    const start = j;
    let needs = false;
    while (j < n) {
      const d = text[j];
      if (/[\s;&|<>]/.test(d)) break;
      if (d === '(' && /[@!+*?]/.test(text[j - 1] ?? '')) { needs = true; j = skipParens(text, j); continue; }
      if (d === '(' || d === ')') break;
      if (d === '\\') { j += 2; continue; }
      if (d === "'" || d === '"' || d === '`' || (d === '$' && (text[j + 1] === '(' || text[j + 1] === '{'))) {
        if (d !== "'" && d !== '"') needs = true; // (a quoted word is one word already)
        j = skipNested(j);
        continue;
      }
      if (GLOB_OR_SPLIT.test(d)) needs = true;
      j++;
    }
    if (j > start && needs) spans.push({ start, end: j, word: text.slice(start, j) });
    i = Math.max(j, i + 1);
  }
  return spans;
}

/** The index after the ( … ) group opening at i */
function skipParens(text: string, i: number): number {
  while (i < text.length && text[i] !== '(') i++;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}
