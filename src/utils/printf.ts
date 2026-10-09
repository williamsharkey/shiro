/**
 * printf(1) formatting, as in GNU coreutils / bash's builtin: the format is
 * reused until every argument is consumed; `\c` (in the format or a %b
 * argument) stops all output. Shared by the `printf` command, the shell's
 * `printf -v`, and anything else that needs it.
 */

export interface PrintfResult {
  out: string;
  /** Diagnostics for invalid numeric arguments (the exit status is then 1) */
  errors: string[];
}

class Stop { }

/** Backslash escapes of a printf format (`octalMax` 3) or a %b argument (`\0NNN`, `\NNN`) */
function escapes(s: string, forB: boolean): { text: string; stop: boolean } {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) { out += c; continue; }
    const n = s[++i];
    switch (n) {
      case 'a': out += '\x07'; continue;
      case 'b': out += '\b'; continue;
      case 'c': return { text: out, stop: true };
      case 'e': case 'E': out += '\x1b'; continue;
      case 'f': out += '\f'; continue;
      case 'n': out += '\n'; continue;
      case 'r': out += '\r'; continue;
      case 't': out += '\t'; continue;
      case 'v': out += '\v'; continue;
      case '\\': out += '\\'; continue;
      case '"': if (!forB) { out += '"'; continue; } break;
      case "'": if (!forB) { out += "'"; continue; } break;
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
        if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; continue; }
        break;
      }
      case 'u': case 'U': {
        const m = (n === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(s.slice(i + 1));
        if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; continue; }
        break;
      }
      default:
        if (n >= '0' && n <= '7') {
          // format: \NNN; %b: \0NNN (and \NNN)
          const rest = forB && n === '0' ? s.slice(i + 1) : s.slice(i);
          const m = /^[0-7]{0,3}/.exec(rest)![0];
          out += String.fromCharCode(parseInt(m || '0', 8) & 0xff);
          i += forB && n === '0' ? m.length : m.length - 1;
          continue;
        }
    }
    out += '\\' + n;
  }
  return { text: out, stop: false };
}

/** Shell-quote for %q */
function shellQuote(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\-.,/:=@%+]+$/.test(s)) return s;
  if (/[\x00-\x1f\x7f]/.test(s)) {
    return "$'" + s.replace(/[\\']/g, (c) => '\\' + c).replace(/[\x00-\x1f\x7f]/g, (c) => {
      const map: Record<string, string> = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\x1b': '\\E' };
      return map[c] ?? '\\' + c.charCodeAt(0).toString(8).padStart(3, '0');
    }) + "'";
  }
  return s.replace(/[^A-Za-z0-9_\-.,/:=@%+]/g, (c) => '\\' + c);
}

/** Integer value of a numeric argument: 'c / "c is the character code; 0x, 0 prefixes */
function intArg(a: string, errors: string[]): bigint {
  if (a === undefined || a === '') return 0n;
  if (/^['"]/.test(a)) return BigInt(a.length > 1 ? a.codePointAt(1)! : 0);
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)(.*)$/.exec(a);
  if (!m) { errors.push(`printf: ${a}: invalid number`); return 0n; }
  let v = BigInt(m[2].length > 1 && m[2][0] === '0' && !/[xX]/.test(m[2]) ? '0o' + m[2].slice(1) : m[2]);
  if (m[1] === '-') v = -v;
  if (m[3]) errors.push(`printf: ${a}: invalid number`);
  return v;
}

function floatArg(a: string, errors: string[]): number {
  if (a === undefined || a === '') return 0;
  if (/^['"]/.test(a)) return a.length > 1 ? a.codePointAt(1)! : 0;
  const t = a.trim();
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(t)) return Number(t.replace(/^([+-]?)0[xX]/, '$10x'));
  const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(t);
  if (!m) { errors.push(`printf: ${a}: invalid number`); return 0; }
  if (m[0].length !== t.length) errors.push(`printf: ${a}: invalid number`);
  return Number(m[0]);
}

/** C %e of |x| with `prec` digits: mantissa and two-digit exponent */
function cExp(x: number, prec: number, upper: boolean): string {
  let s = x.toExponential(prec); // 1.5e+0
  s = s.replace(/e([+-])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}

/** C %g */
function cGeneral(x: number, prec: number, alt: boolean, upper: boolean): string {
  const p = prec === 0 ? 1 : prec;
  if (x === 0) return alt ? (0).toFixed(p - 1) : '0';
  const exp = Math.floor(Math.log10(Math.abs(x)));
  // Round first: the exponent after rounding decides the style
  const e = Number(x.toExponential(p - 1).split('e')[1]);
  void exp;
  let s: string;
  if (e < -4 || e >= p) {
    s = cExp(x, p - 1, upper);
    if (!alt) s = s.replace(/\.?0+(?=[eE])/, '');
  } else {
    s = x.toFixed(Math.max(0, p - 1 - e));
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return s;
}

function formatOne(spec: string, flags: string, width: number | null, prec: number | null, arg: string | undefined, errors: string[]): string {
  const left = flags.includes('-');
  const zero = flags.includes('0') && !left;
  const plus = flags.includes('+');
  const space = flags.includes(' ');
  const alt = flags.includes('#');
  const sign = (neg: boolean) => (neg ? '-' : plus ? '+' : space ? ' ' : '');
  const pad = (body: string, signStr: string, numeric: boolean) => {
    const full = signStr + body;
    if (width === null || full.length >= width) return full;
    if (left) return full.padEnd(width);
    if (zero && numeric) return signStr + body.padStart(width - signStr.length, '0');
    return full.padStart(width);
  };
  switch (spec) {
    case 's': case 'q': {
      let s = arg ?? '';
      if (spec === 'q') s = shellQuote(s);
      if (prec !== null) s = s.slice(0, prec);
      return pad(s, '', false);
    }
    case 'c': return pad((arg ?? '').slice(0, 1), '', false);
    case 'd': case 'i': {
      const v = intArg(arg ?? '', errors);
      let digits = (v < 0n ? -v : v).toString();
      if (prec !== null) digits = prec === 0 && v === 0n ? '' : digits.padStart(prec, '0');
      return pad(digits, sign(v < 0n), prec === null);
    }
    case 'u': case 'o': case 'x': case 'X': {
      let v = intArg(arg ?? '', errors);
      if (v < 0n) v = BigInt.asUintN(64, v);
      let digits = spec === 'u' ? v.toString() : spec === 'o' ? v.toString(8) : v.toString(16);
      if (spec === 'X') digits = digits.toUpperCase();
      if (prec !== null) digits = prec === 0 && v === 0n ? '' : digits.padStart(prec, '0');
      let prefix = '';
      if (alt && v !== 0n) prefix = spec === 'o' ? (digits.startsWith('0') ? '' : '0') : spec === 'x' ? '0x' : spec === 'X' ? '0X' : '';
      return pad(digits, prefix, prec === null);
    }
    case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': case 'a': case 'A': {
      const v = floatArg(arg ?? '', errors);
      const p = prec ?? 6;
      const neg = v < 0 || Object.is(v, -0);
      const a = Math.abs(v);
      let body: string;
      if (!Number.isFinite(a)) body = Number.isNaN(a) ? 'nan' : 'inf';
      else if (spec === 'f' || spec === 'F') body = a.toFixed(Math.min(p, 100));
      else if (spec === 'e' || spec === 'E') body = cExp(a, Math.min(p, 100), spec === 'E');
      else if (spec === 'g' || spec === 'G') body = cGeneral(a, p, alt, spec === 'G');
      else body = a.toString(16);
      if (alt && p === 0 && /^[fFeE]$/.test(spec) && !body.includes('.')) body = body.replace(/^(\d+)/, '$1.');
      if (/[FEGA]/.test(spec)) body = body.toUpperCase();
      return pad(body, sign(neg && !Number.isNaN(v)), Number.isFinite(a));
    }
  }
  return '';
}

export function printfFormat(fmt: string, args: string[]): PrintfResult {
  const errors: string[] = [];
  let out = '';
  let argIdx = 0;
  const next = () => (argIdx < args.length ? args[argIdx++] : undefined);
  try {
    do {
      const start = argIdx;
      let i = 0;
      while (i < fmt.length) {
        const c = fmt[i];
        if (c === '\\') {
          // One escape at a time (\c stops everything)
          let j = i + 2;
          if (/[0-7]/.test(fmt[i + 1] ?? '')) { const m = /^[0-7]{1,3}/.exec(fmt.slice(i + 1))!; j = i + 1 + m[0].length; }
          else if (fmt[i + 1] === 'x') { const m = /^[0-9a-fA-F]{0,2}/.exec(fmt.slice(i + 2))!; j = i + 2 + m[0].length; }
          else if (fmt[i + 1] === 'u') { const m = /^[0-9a-fA-F]{0,4}/.exec(fmt.slice(i + 2))!; j = i + 2 + m[0].length; }
          else if (fmt[i + 1] === 'U') { const m = /^[0-9a-fA-F]{0,8}/.exec(fmt.slice(i + 2))!; j = i + 2 + m[0].length; }
          const e = escapes(fmt.slice(i, j), false);
          out += e.text;
          if (e.stop) throw new Stop();
          i = j;
          continue;
        }
        if (c !== '%') { out += c; i++; continue; }
        if (fmt[i + 1] === '%') { out += '%'; i += 2; continue; }
        const m = /^%([-+ #0']*)(\*|\d+)?(?:\.(\*|\d*))?(hh|h|ll|l|L|j|z|t)?([diouxXfFeEgGaAcsbq]|\((?:[^)]*)\)T)?/.exec(fmt.slice(i));
        if (!m || !m[5]) {
          // (like bash: nothing more is printed)
          errors.push(`printf: ${fmt.slice(i, i + 2)}: invalid conversion specification`);
          throw new Stop();
        }
        i += m[0].length;
        const flags = m[1];
        let width: number | null = null;
        let prec: number | null = null;
        let leftFlag = '';
        if (m[2] === '*') {
          width = Number(intArg(next() ?? '', errors));
          if (width < 0) { leftFlag = '-'; width = -width; }
        } else if (m[2]) width = parseInt(m[2], 10);
        if (m[3] !== undefined) {
          if (m[3] === '*') {
            prec = Number(intArg(next() ?? '', errors));
            if (prec < 0) prec = null; // a negative precision is as if omitted
          } else prec = parseInt(m[3] || '0', 10);
        }
        const conv = m[5];
        if (conv === 'b') {
          const e = escapes(next() ?? '', true);
          let s = e.text;
          if (prec !== null) s = s.slice(0, prec);
          out += formatOne('s', flags + leftFlag, width, null, s, errors);
          if (e.stop) throw new Stop();
          continue;
        }
        if (conv.startsWith('(')) {
          // %(strftime)T
          const a = next();
          const ts = a === undefined || a === '' || a === '-1' ? Date.now() : Number(intArg(a, errors)) * 1000;
          // Shiro has always read %%Y here as %Y (an existing test relies on it)
          const tf = conv.slice(1, -2).replace(/%%(?=[A-Za-z])/g, '%');
          out += formatOne('s', flags + leftFlag, width, prec, strftime(tf, new Date(ts)), errors);
          continue;
        }
        out += formatOne(conv, flags + leftFlag, width, prec, next(), errors);
      }
      if (argIdx === start) break; // the format consumes no arguments
    } while (argIdx < args.length);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  return { out, errors };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A strftime subset for %(…)T */
export function strftime(f: string, d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return f.replace(/%([a-zA-Z%])/g, (_a, k: string) => {
    switch (k) {
      case 'Y': return String(d.getFullYear());
      case 'y': return p2(d.getFullYear() % 100);
      case 'm': return p2(d.getMonth() + 1);
      case 'd': return p2(d.getDate());
      case 'e': return String(d.getDate()).padStart(2);
      case 'H': return p2(d.getHours());
      case 'I': return p2(((d.getHours() + 11) % 12) + 1);
      case 'M': return p2(d.getMinutes());
      case 'S': return p2(d.getSeconds());
      case 'p': return d.getHours() < 12 ? 'AM' : 'PM';
      case 'a': return DAYS[d.getDay()].slice(0, 3);
      case 'A': return DAYS[d.getDay()];
      case 'b': case 'h': return MONTHS[d.getMonth()].slice(0, 3);
      case 'B': return MONTHS[d.getMonth()];
      case 'j': return String(Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000) + 1).padStart(3, '0');
      case 's': return String(Math.floor(d.getTime() / 1000));
      case 'F': return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      case 'T': return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
      case 'D': return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${p2(d.getFullYear() % 100)}`;
      case 'n': return '\n';
      case 't': return '\t';
      case '%': return '%';
      default: return '%' + k;
    }
  });
}
