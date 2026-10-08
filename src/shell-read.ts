/**
 * The `read` builtin's input handling: take one record from the input
 * (up to the delimiter, or -n/-N characters), process backslashes unless -r,
 * and split it into fields with IFS the way bash does.
 */

export interface ReadOptions {
  raw: boolean;
  /** Record delimiter; '' means NUL (read -d '') */
  delim: string;
  /** -n N (stop at the delimiter or after N chars), -1 for none */
  nchars: number;
  /** -N N: exactly N chars, the delimiter is ordinary and nothing is split */
  exact: boolean;
}

/** A character of the record, and whether a backslash quoted it */
type RChar = { c: string; q: boolean };

export interface ReadRecord {
  chars: RChar[];
  /** Input characters used up */
  consumed: number;
  /** The record ended at the delimiter or the -n/-N count (status 0); else EOF (status 1) */
  complete: boolean;
}

export function readRecord(input: string, o: ReadOptions): ReadRecord {
  const delim = o.delim === '' ? '\0' : o.delim[0];
  const chars: RChar[] = [];
  let i = 0;
  while (i < input.length) {
    if (o.nchars >= 0 && chars.length >= o.nchars) return { chars, consumed: i, complete: true };
    const c = input[i];
    if (c === delim && !o.exact) return { chars, consumed: i + 1, complete: true };
    if (c === '\\' && !o.raw) {
      if (i + 1 >= input.length) { i++; break; }
      const n = input[i + 1];
      i += 2;
      // backslash-newline continues the line (and counts as nothing)
      if (n === '\n') continue;
      chars.push({ c: n, q: true });
      continue;
    }
    chars.push({ c, q: false });
    i++;
  }
  const complete = o.nchars >= 0 && chars.length >= o.nchars && o.nchars > 0;
  return { chars, consumed: i, complete };
}

/** The record as one string (REPLY, -N) */
export function recordText(r: ReadRecord): string {
  return r.chars.map((x) => x.c).join('');
}

/**
 * Split a record into at most `max` fields (Infinity for read -a): IFS
 * whitespace is trimmed, other IFS characters separate fields, and the last
 * field gets the rest of the line.
 */
export function splitRecord(chars: RChar[], ifs: string, max: number): string[] {
  const isWs = (x: RChar) => !x.q && (x.c === ' ' || x.c === '\t' || x.c === '\n') && ifs.includes(x.c);
  const isSep = (x: RChar) => !x.q && ifs.includes(x.c);
  const n = chars.length;
  const text = (a: number, b: number) => chars.slice(a, b).map((x) => x.c).join('');
  const fields: string[] = [];
  let i = 0;
  while (i < n && isWs(chars[i])) i++;
  /** Index after the separator at j (blanks, one other IFS char, blanks) */
  const skipSep = (j: number) => {
    while (j < n && isWs(chars[j])) j++;
    if (j < n && isSep(chars[j])) { j++; while (j < n && isWs(chars[j])) j++; }
    return j;
  };
  while (i < n) {
    if (fields.length === max - 1) {
      // The last variable: the rest, less trailing IFS blanks; a lone field
      // followed only by a separator loses that separator too
      let end = n;
      while (end > i && isWs(chars[end - 1])) end--;
      let j = i;
      while (j < end && !isSep(chars[j])) j++;
      if (j < end && skipSep(j) >= end) end = j;
      fields.push(text(i, end));
      return fields;
    }
    const start = i;
    while (i < n && !isSep(chars[i])) i++;
    fields.push(text(start, i));
    i = skipSep(i);
  }
  return fields;
}
