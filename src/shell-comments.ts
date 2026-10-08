/**
 * Remove shell comments from source text, as the POSIX tokenizer does: a `#`
 * that begins a word, outside quotes, starts a comment that runs to the end
 * of the line. `#` inside a word (`a#b`, `$#`, `${#x}`, `${x#y}`), inside
 * quotes or backticks, escaped (`\#`), or inside a here-document body is
 * kept. Newlines are kept, so line numbers don't move.
 *
 * 'interactive' mode (lines typed at the prompt or run through
 * shell.execute()) only treats `# ` / a trailing `#` as a comment, because
 * Shiro commands take bare `#id` CSS selectors.
 */
export function stripComments(src: string, mode: 'posix' | 'interactive' = 'posix'): string {
  if (!src.includes('#')) return src;
  let out = '';
  let i = 0;
  const n = src.length;
  // Here-documents opened on the current line, read after its newline
  let pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') {
      out += ch;
      i++;
      // Copy here-document bodies verbatim
      for (const h of pendingHeredocs) {
        while (i < n) {
          let end = src.indexOf('\n', i);
          if (end === -1) end = n;
          const line = src.slice(i, end);
          out += src.slice(i, Math.min(end + 1, n));
          i = end + 1;
          const cmp = h.stripTabs ? line.replace(/^\t+/, '') : line;
          if (cmp === h.delim || cmp.trim() === h.delim) break;
        }
      }
      pendingHeredocs = [];
      continue;
    }
    if (ch === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if (ch === "'") {
      // $'...' honors backslash escapes; '...' doesn't
      const ansi = i > 0 && src[i - 1] === '$';
      let j = i + 1;
      while (j < n && src[j] !== "'") j += ansi && src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"' || ch === '`') {
      const j = ch === '"' ? skipDouble(src, i + 1) : skipBacktick(src, i + 1);
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '(' && src[i + 1] === '(') {
      // Arithmetic (( … )) / $(( … )): `<<` there is a shift, not a here-doc
      const j = skipParen(src, i + 1);
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|()<>]+))/.exec(src.slice(i));
      if (m) {
        const delim = m[2] ?? m[3] ?? m[4].replace(/\\/g, '');
        pendingHeredocs.push({ delim, stripTabs: m[1] === '-' });
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (ch === '#') {
      const prev = i > 0 ? src[i - 1] : '\n';
      // At the prompt, `#` must also be followed by a blank, so CSS selectors
      // (`page click #btn`) and URLs fragments typed bare keep working
      const next = src[i + 1];
      if (/[\s;&|(]/.test(prev) && (mode === 'posix' || next === undefined || /\s/.test(next))) {
        // Comment: skip to end of line (keep the newline)
        let end = src.indexOf('\n', i);
        if (end === -1) end = n;
        // Drop the whitespace before the comment too
        let k = out.length;
        while (k > 0 && (out[k - 1] === ' ' || out[k - 1] === '\t')) k--;
        if (k < out.length) out = out.slice(0, k);
        i = end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Index just past the `"` closing a double-quoted string whose body starts at j. */
function skipDouble(src: string, j: number): number {
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '"') return j + 1;
    if (c === '`') { j = skipBacktick(src, j + 1); continue; }
    if (c === '$' && src[j + 1] === '(') { j = skipParen(src, j + 2); continue; }
    j++;
  }
  return j;
}

function skipBacktick(src: string, j: number): number {
  while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** Index just past the `)` closing a `$(` whose body starts at j. */
function skipParen(src: string, j: number): number {
  let depth = 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", j + 1); j = e === -1 ? src.length : e + 1; continue; }
    if (c === '"') { j = skipDouble(src, j + 1); continue; }
    if (c === '`') { j = skipBacktick(src, j + 1); continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j + 1;
    j++;
  }
  return j;
}
