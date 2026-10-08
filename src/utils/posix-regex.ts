/**
 * POSIX basic (BRE) and extended (ERE) regular expressions, with the GNU
 * extensions grep/sed users rely on, translated to JavaScript RegExp source.
 *
 * BRE: \( \) \{m,n\} groups/intervals, \| \+ \? (GNU), * literal at the
 *      start of an expression, ^ and $ anchors only at the ends of an
 *      expression or group, ( ) { } | + ? literal.
 * ERE: ( ) { } | + ? special; \( etc literal.
 * Both: bracket expressions with [:class:], [=c=], [.c.]; \1-\9; \< \> \b \B
 *      \w \W \s \S \` \'; \n \t; . matches any character (including newline,
 *      as in sed's pattern space).
 */

const CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: '0-9a-zA-Z', upper: 'A-Z', lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~',
  print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f', word: '\\w',
};

export class RegexSyntaxError extends Error {}

/** Escape a character for use outside a JS character class */
function lit(c: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(c) ? '\\' + c : c === '\n' ? '\\n' : c;
}

/** Escape a character for use inside a JS character class */
function classLit(c: string): string {
  return /[\\\]\[^-]/.test(c) ? '\\' + c : c === '\n' ? '\\n' : c;
}

/** Parse a bracket expression starting at src[i] === '['; returns [jsClass, nextIndex] */
function bracket(src: string, i: number, ignoreCase: boolean): [string, number] {
  let j = i + 1;
  let negate = false;
  if (src[j] === '^') { negate = true; j++; }
  let body = '';
  let first = true;
  while (j < src.length) {
    const c = src[j];
    if (c === ']' && !first) {
      void ignoreCase;
      return [`[${negate ? '^' : ''}${body}]`, j + 1];
    }
    first = false;
    if (c === '[' && (src[j + 1] === ':' || src[j + 1] === '=' || src[j + 1] === '.')) {
      const kind = src[j + 1];
      const end = src.indexOf(kind + ']', j + 2);
      if (end < 0) throw new RegexSyntaxError('unterminated character class');
      const name = src.slice(j + 2, end);
      if (kind === ':') {
        if (!(name in CLASSES)) throw new RegexSyntaxError(`invalid character class: ${name}`);
        body += CLASSES[name];
      } else {
        body += [...name].map(classLit).join('');
      }
      j = end + 2;
      continue;
    }
    // A range a-z, or a literal character (backslash is literal in POSIX brackets)
    if (src[j + 1] === '-' && src[j + 2] !== undefined && src[j + 2] !== ']') {
      body += classLit(c) + '-' + classLit(src[j + 2]);
      j += 3;
      continue;
    }
    body += classLit(c);
    j++;
  }
  throw new RegexSyntaxError('unterminated [');
}

export interface PosixRegexOptions {
  extended?: boolean;
}

/** JavaScript RegExp source for a POSIX regular expression */
export function posixToJsSource(src: string, opts: PosixRegexOptions = {}): string {
  const ere = !!opts.extended;
  let out = '';
  let i = 0;
  // Positions where `*` is literal and `^` is an anchor: start, after ( or |
  let atStart = true;
  const groupStack: number[] = [];
  while (i < src.length) {
    const c = src[i];
    const startHere = atStart;
    atStart = false;
    if (c === '\\') {
      const n = src[i + 1];
      i += 2;
      if (n === undefined) { out += '\\\\'; break; }
      if (!ere && n === '(') { out += '('; groupStack.push(out.length); atStart = true; continue; }
      if (!ere && n === ')') { out += ')'; groupStack.pop(); continue; }
      if (!ere && n === '{') {
        const m = /^(\d*)(,?)(\d*)\\\}/.exec(src.slice(i));
        if (!m) throw new RegexSyntaxError('invalid \\{ interval');
        out += `{${m[1] || '0'}${m[2]}${m[3]}}`;
        i += m[0].length;
        continue;
      }
      if (!ere && n === '|') { out += '|'; atStart = true; continue; }
      if (!ere && (n === '+' || n === '?')) { out += startHere ? '\\' + n : n; continue; }
      if (n >= '1' && n <= '9') { out += '\\' + n; continue; }
      if (n === '<') { out += '\\b(?=\\w)'; continue; }
      if (n === '>') { out += '\\b(?<=\\w)'; continue; }
      if ('bBwWsS'.includes(n)) { out += '\\' + n; continue; }
      if (n === '`') { out += '^'; continue; }
      if (n === "'") { out += '$'; continue; }
      if (n === 'n') { out += '\\n'; continue; }
      if (n === 't') { out += '\\t'; continue; }
      if (n === 'r') { out += '\\r'; continue; }
      if (n === 'f') { out += '\\f'; continue; }
      if (n === 'v') { out += '\\v'; continue; }
      if (n === 'a') { out += '\\x07'; continue; }
      // \xHH \dNNN \oNNN \cX (GNU): a character by code
      const code = n === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(src.slice(i)) : n === 'd' ? /^\d{1,3}/.exec(src.slice(i)) : n === 'o' ? /^[0-7]{1,3}/.exec(src.slice(i)) : null;
      if (code) {
        out += lit(String.fromCharCode(parseInt(code[0], n === 'x' ? 16 : n === 'd' ? 10 : 8)));
        i += code[0].length;
        continue;
      }
      if (n === 'c' && i < src.length) { out += lit(String.fromCharCode(src[i].toUpperCase().charCodeAt(0) ^ 0x40)); i++; continue; }
      out += lit(n);
      continue;
    }
    if (c === '[') {
      const [cls, next] = bracket(src, i, false);
      out += cls;
      i = next;
      continue;
    }
    if (c === '.') { out += '[\\s\\S]'; i++; continue; }
    if (c === '*') {
      out += startHere ? '\\*' : '*';
      i++;
      continue;
    }
    if (c === '^') {
      // BRE: an anchor only at the start of an expression (or group / alternative)
      out += ere || startHere ? '^' : '\\^';
      if (!ere && startHere) atStart = true;
      if (ere) atStart = true;
      i++;
      continue;
    }
    if (c === '$') {
      // BRE: an anchor only at the end of an expression (or before \) / \|)
      const rest = src.slice(i + 1);
      const atEnd = ere || rest === '' || rest.startsWith('\\)') || rest.startsWith('\\|');
      out += atEnd ? '$' : '\\$';
      i++;
      continue;
    }
    if (ere) {
      if (c === '(') { out += '('; groupStack.push(out.length); atStart = true; i++; continue; }
      if (c === ')') {
        if (!groupStack.length) { out += '\\)'; i++; continue; }
        groupStack.pop(); out += ')'; i++; continue;
      }
      if (c === '|') { out += '|'; atStart = true; i++; continue; }
      if (c === '+' || c === '?') { out += startHere ? '\\' + c : c; i++; continue; }
      if (c === '{') {
        const m = /^\{(\d+)(,?)(\d*)\}/.exec(src.slice(i));
        if (m && !startHere) { out += m[0]; i += m[0].length; continue; }
        out += '\\{'; i++; continue;
      }
      if (c === '}') { out += '\\}'; i++; continue; }
    }
    out += lit(c);
    i++;
  }
  if (groupStack.length) throw new RegexSyntaxError('unmatched ( or \\(');
  return out;
}

/** Compile a POSIX regular expression */
export function posixRegExp(src: string, opts: PosixRegexOptions & { flags?: string } = {}): RegExp {
  try {
    return new RegExp(posixToJsSource(src, opts), opts.flags ?? '');
  } catch (e) {
    if (e instanceof RegexSyntaxError) throw e;
    throw new RegexSyntaxError((e as Error).message);
  }
}
