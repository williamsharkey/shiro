/**
 * Here-documents as input redirections.
 *
 * Before a statement runs, each `<<DELIM` / `<<-DELIM` and its body (the
 * lines after the operator's line, up to DELIM) are replaced by `< MARKER`,
 * where MARKER names the body in a HeredocStore. Every `<` reader in the
 * shell resolves markers (Shell.readInputRedirect), expanding an unquoted
 * body when it is read. So a here-doc works wherever `< file` does: after
 * `done`/`fi`/`}`, in conditions, loop bodies, functions and $(…), and a
 * loop re-reads it with the current variables on every iteration.
 */

const MARK_START = '\uE010';
const MARK_END = '\uE011';

export interface HeredocBody {
  body: string;
  /** Unquoted delimiter: $var, $(cmd), $((expr)) and \ escapes apply */
  expand: boolean;
}

export class HeredocStore {
  private bodies: HeredocBody[] = [];
  private index = new Map<string, number>();

  /** A marker for this body (identical bodies share one, so re-running a loop doesn't grow the store) */
  marker(body: string, expand: boolean): string {
    const key = (expand ? '1' : '0') + body;
    let id = this.index.get(key);
    if (id === undefined) {
      id = this.bodies.length;
      this.bodies.push({ body, expand });
      this.index.set(key, id);
    }
    return `${MARK_START}${id}${MARK_END}`;
  }

  lookup(target: string): HeredocBody | null {
    const m = /^\uE010(\d+)\uE011$/.exec(target);
    return m ? this.bodies[Number(m[1])] ?? null : null;
  }
}

export function hasHeredoc(text: string): boolean {
  return text.includes('<<') && text.includes('\n');
}

/**
 * Replace here-documents in `src` by `< MARKER` redirections. Text without a
 * here-doc operator followed by a body is returned unchanged.
 */
export function extractHeredocs(src: string, store: HeredocStore): string {
  if (!hasHeredoc(src)) return src;
  let out = '';
  let i = 0;
  const n = src.length;
  let pending: { delim: string; stripTabs: boolean; expand: boolean; slot: number }[] = [];
  const slots: string[] = []; // markers, filled in once each body is read
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') {
      out += ch;
      i++;
      for (const h of pending) {
        const lines: string[] = [];
        let found = false;
        while (i < n) {
          let end = src.indexOf('\n', i);
          if (end === -1) end = n;
          let line = src.slice(i, end);
          i = Math.min(end + 1, n);
          if (h.stripTabs) line = line.replace(/^\t+/, '');
          if (line === h.delim) { found = true; break; }
          lines.push(line);
        }
        void found; // an unterminated here-doc runs to the end of input, like bash
        const body = lines.length ? lines.join('\n') + '\n' : '';
        slots[h.slot] = store.marker(body, h.expand);
      }
      pending = [];
      continue;
    }
    if (ch === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if (ch === "'") {
      const ansi = i > 0 && src[i - 1] === '$';
      let j = i + 1;
      while (j < n && src[j] !== "'") j += ansi && src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '(' && src[i + 1] === '(') {
      // (( … )) / $(( … )): `<<` is a shift
      let depth = 0;
      let j = i;
      for (; j < n; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
        else if (src[j] === '\n') break;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|()<>'"\\])+)/.exec(src.slice(i));
      if (m) {
        const word = m[2];
        const expand = !/['"\\]/.test(word);
        const delim = word.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_a, s1, s2, s3) => s1 ?? s2 ?? s3);
        const slot = slots.length;
        slots.push('');
        pending.push({ delim, stripTabs: m[1] === '-', expand, slot });
        out += `< \uE012${slot}\uE012`;
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  // Bodies are only known after their lines are read: fill the slots in
  return out.replace(/\uE012(\d+)\uE012/g, (_a, k) => slots[Number(k)] || store.marker('', false));
}
