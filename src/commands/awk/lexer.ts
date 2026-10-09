/**
 * awk lexer. `/` starts a regex unless the previous token ends an operand;
 * a name directly followed by `(` is a FUNC_NAME (a call), otherwise NAME.
 * Backslash-newline is removed everywhere, including inside strings.
 */

export type TokType =
  | 'NUMBER' | 'STRING' | 'ERE' | 'NAME' | 'FUNC_NAME' | 'BUILTIN' | 'NEWLINE' | 'EOF'
  | 'BEGIN' | 'END' | 'BEGINFILE' | 'ENDFILE' | 'function' | 'if' | 'else' | 'while' | 'for' | 'do'
  | 'break' | 'continue' | 'next' | 'nextfile' | 'exit' | 'return' | 'delete' | 'in'
  | 'getline' | 'print' | 'printf'
  | '{' | '}' | '(' | ')' | '[' | ']' | ';' | ',' | '+' | '-' | '*' | '/' | '%' | '^'
  | '!' | '>' | '<' | '|' | '?' | ':' | '~' | '$' | '=' | '+=' | '-=' | '*=' | '/=' | '%='
  | '^=' | '==' | '<=' | '>=' | '!=' | '++' | '--' | '&&' | '||' | '>>' | '!~' | '|&';

export interface Token {
  t: TokType;
  /** text of names/strings/regexes; numeric value for NUMBER */
  s: string;
  n: number;
  line: number;
}

export class AwkSyntaxError extends Error {
  constructor(msg: string, public line: number) { super(msg); }
}

const KEYWORDS: Record<string, TokType> = {
  BEGIN: 'BEGIN', END: 'END', BEGINFILE: 'BEGINFILE', ENDFILE: 'ENDFILE',
  function: 'function', func: 'function', if: 'if', else: 'else', while: 'while', for: 'for', do: 'do',
  break: 'break', continue: 'continue', next: 'next', nextfile: 'nextfile', exit: 'exit', return: 'return',
  delete: 'delete', in: 'in', getline: 'getline', print: 'print', printf: 'printf',
};

export const BUILTINS = new Set([
  'length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf', 'sin', 'cos', 'atan2', 'exp',
  'log', 'sqrt', 'int', 'rand', 'srand', 'tolower', 'toupper', 'system', 'close', 'fflush', 'gensub',
  'and', 'or', 'xor', 'lshift', 'rshift', 'compl', 'systime', 'strftime', 'mktime', 'asort', 'asorti',
  'typeof', 'isarray',
]);

/** Tokens after which `/` is division (they end an operand) */
const OPERAND_END = new Set<TokType>(['NAME', 'NUMBER', 'STRING', 'ERE', ')', ']', 'BUILTIN', '$', '++', '--']);

/** Process string escapes (also used for -v assignments and -F) */
export function unescapeString(s: string, i = 0, end = s.length): string {
  let out = '';
  while (i < end) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= end) { out += c; i++; continue; }
    const d = s[i + 1];
    i += 2;
    switch (d) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case '/': out += '/'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '\n': break;
      case 'x': {
        let j = i;
        let v = 0;
        while (j < end && j < i + 2 && /[0-9a-fA-F]/.test(s[j])) v = v * 16 + parseInt(s[j++], 16);
        if (j === i) out += '\\x';
        else out += String.fromCharCode(v);
        i = j;
        break;
      }
      default:
        if (d >= '0' && d <= '7') {
          let j = i - 1;
          let v = 0;
          while (j < end && j < i + 2 && s[j] >= '0' && s[j] <= '7') v = v * 8 + (s.charCodeAt(j++) - 48);
          out += String.fromCharCode(v & 0xff);
          i = j;
        } else {
          // gawk: unknown escape is the plain character
          out += d;
        }
    }
  }
  return out;
}

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const push = (t: TokType, s = '', num = 0) => { toks.push({ t, s, n: num, line }); };
  const prev = () => (toks.length ? toks[toks.length - 1].t : 'NEWLINE');
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
      i += src[i + 1] === '\n' ? 2 : 3;
      line++;
      continue;
    }
    if (c === '\n') { push('NEWLINE'); i++; line++; continue; }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let raw = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          if (src[j + 1] === '\n') { j += 2; line++; continue; }
          raw += src[j] + src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '\n') throw new AwkSyntaxError('unterminated string', line);
        raw += src[j++];
      }
      if (j >= n) throw new AwkSyntaxError('unterminated string', line);
      push('STRING', unescapeString(raw));
      i = j + 1;
      continue;
    }
    if (c === '/' && !OPERAND_END.has(prev())) {
      // regex literal
      let j = i + 1;
      let raw = '';
      let inBr = false;
      while (j < n) {
        const d = src[j];
        if (d === '\n') throw new AwkSyntaxError('unterminated regexp', line);
        if (d === '\\' && j + 1 < n) {
          if (src[j + 1] === '\n') { j += 2; line++; continue; }
          // \/ is a plain slash
          raw += src[j + 1] === '/' ? '/' : d + src[j + 1];
          j += 2;
          continue;
        }
        if (inBr) {
          if (d === ']' ) inBr = false;
          raw += d; j++;
          continue;
        }
        if (d === '[') {
          inBr = true;
          raw += d; j++;
          if (src[j] === '^') { raw += '^'; j++; }
          if (src[j] === ']') { raw += ']'; j++; }
          continue;
        }
        if (d === '/') break;
        raw += d;
        j++;
      }
      if (j >= n) throw new AwkSyntaxError('unterminated regexp', line);
      push('ERE', raw);
      i = j + 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const hex = /^0[xX][0-9a-fA-F]+/.exec(src.slice(i, i + 40));
      if (hex) { push('NUMBER', hex[0], parseInt(hex[0], 16)); i += hex[0].length; continue; }
      const m = /^(\d*\.?\d*)([eE][-+]?\d+)?/.exec(src.slice(i, i + 400))!;
      let text = m[0];
      let val: number;
      if (/^0[0-7]+$/.test(text)) val = parseInt(text, 8);
      else val = Number(text);
      if (Number.isNaN(val)) { text = m[1]; val = Number(text); }
      push('NUMBER', text, val);
      i += text.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      i = j;
      const kw = KEYWORDS[word];
      if (kw) { push(kw, word); continue; }
      if (BUILTINS.has(word)) { push('BUILTIN', word); continue; }
      push(src[i] === '(' ? 'FUNC_NAME' : 'NAME', word);
      continue;
    }
    const three = src.substr(i, 3);
    if (three === '**=') { push('^='); i += 3; continue; }
    const two = src.substr(i, 2);
    switch (two) {
      case '+=': case '-=': case '*=': case '/=': case '%=': case '^=': case '==': case '<=': case '>=':
      case '!=': case '++': case '--': case '&&': case '||': case '>>': case '!~': case '|&':
        push(two as TokType);
        i += 2;
        continue;
      case '**':
        push('^');
        i += 2;
        continue;
    }
    if ('{}()[];,+-*/%^!><|?:~$='.includes(c)) {
      push(c as TokType);
      i++;
      continue;
    }
    throw new AwkSyntaxError(`invalid char '${c}' in expression`, line);
  }
  push('NEWLINE');
  push('EOF');
  return toks;
}
