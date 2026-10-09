/**
 * Number formatting for awk: C printf conversions (%d %i %o %x %X %u %c %s
 * %e %E %f %F %g %G %%) with flags, width, precision and `*`, done with exact
 * decimal arithmetic so rounding matches C (round half to even on exact ties).
 */

/** Exact decimal value of a finite double: N / 10^scale (N >= 0) */
function exactDecimal(v: number): { n: bigint; scale: number } {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(v));
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2: number;
  if (exp === 0) e2 = -1074;
  else { mant |= 1n << 52n; e2 = exp - 1075; }
  if (mant === 0n) return { n: 0n, scale: 0 };
  if (e2 >= 0) return { n: mant << BigInt(e2), scale: 0 };
  // strip common factors of two to keep the numbers small
  while (e2 < 0 && (mant & 1n) === 0n) { mant >>= 1n; e2++; }
  if (e2 >= 0) return { n: mant << BigInt(e2), scale: 0 };
  return { n: mant * 5n ** BigInt(-e2), scale: -e2 };
}

const POW10: bigint[] = [];
function pow10(k: number): bigint {
  if (k < 64) {
    let p = POW10[k];
    if (p === undefined) p = POW10[k] = 10n ** BigInt(k);
    return p;
  }
  return 10n ** BigInt(k);
}

/** Divide by 10^k rounding half to even */
function roundDiv(n: bigint, k: number): bigint {
  if (k <= 0) return n * pow10(-k);
  const d = pow10(k);
  const q = n / d;
  const r = n - q * d;
  const twice = r * 2n;
  if (twice > d || (twice === d && (q & 1n) === 1n)) return q + 1n;
  return q;
}

/** Digits of |v| rounded to `frac` decimals */
function fixedDigits(v: number, frac: number): string {
  // JS rounds the exact value to nearest like C, except on exact ties (C: to even)
  if (v < 1e21 && frac <= 96) {
    const t = v.toFixed(frac + 3);
    if (!t.endsWith('500')) return v.toFixed(frac);
  }
  const { n, scale } = exactDecimal(v);
  const q = roundDiv(n, scale - frac);
  let s = q.toString();
  if (frac > 0) {
    if (s.length <= frac) s = '0'.repeat(frac - s.length + 1) + s;
    s = s.slice(0, s.length - frac) + '.' + s.slice(s.length - frac);
  }
  return s;
}

/** |v| rounded to `sig` significant digits: digit string (length sig) and decimal exponent */
function sigDigits(v: number, sig: number): { digits: string; exp: number } {
  if (v !== 0 && sig <= 96) {
    const t = v.toExponential(sig + 2);
    const e = t.indexOf('e');
    if (t.slice(e - 3, e) !== '500') {
      const r = v.toExponential(sig - 1);
      const k = r.indexOf('e');
      return { digits: r.slice(0, k).replace('.', ''), exp: Number(r.slice(k + 1)) };
    }
  }
  const { n, scale } = exactDecimal(v);
  if (n === 0n) return { digits: '0'.repeat(sig), exp: 0 };
  const len = n.toString().length;
  let exp = len - 1 - scale;
  let q = roundDiv(n, len - sig);
  let s = q.toString();
  if (s.length > sig) { q = q / 10n; s = q.toString(); exp++; }
  return { digits: s, exp };
}

function expString(digits: string, exp: number, prec: number, alt: boolean, upper: boolean): string {
  let m = digits[0];
  if (prec > 0 || alt) m += '.';
  m += digits.slice(1);
  const ae = Math.abs(exp);
  return m + (upper ? 'E' : 'e') + (exp < 0 ? '-' : '+') + (ae < 10 ? '0' + ae : String(ae));
}

function fmtE(v: number, prec: number, alt: boolean, upper: boolean): string {
  const { digits, exp } = sigDigits(v, prec + 1);
  return expString(digits, exp, prec, alt, upper);
}

function fmtG(v: number, prec: number, alt: boolean, upper: boolean): string {
  if (prec === 0) prec = 1;
  if (v === 0) {
    return alt ? '0.' + '0'.repeat(prec - 1) : '0';
  }
  const { digits, exp } = sigDigits(v, prec);
  let s: string;
  if (exp < -4 || exp >= prec) {
    let d = digits;
    if (!alt) d = d.replace(/0+$/, '') || '0';
    s = expString(d.length < 1 ? '0' : d, exp, d.length - 1, alt, upper);
  } else {
    s = fixedDigits(v, prec - 1 - exp);
    if (!alt && s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    else if (alt && !s.includes('.')) s += '.';
  }
  return s;
}

function nonFinite(v: number, upper: boolean): string {
  const s = Number.isNaN(v) ? 'nan' : 'inf';
  return upper ? s.toUpperCase() : s;
}

/** Format a number for %d-style output (truncated integer, exact) */
export function intString(v: number): string {
  const t = Math.trunc(v);
  if (Math.abs(t) < 1e15) return String(t === 0 ? 0 : t);
  return BigInt(t).toString();
}

function pad(s: string, width: number, left: boolean, zero: boolean, signLen = 0): string {
  if (s.length >= width) return s;
  if (left) return s + ' '.repeat(width - s.length);
  if (zero) return s.slice(0, signLen) + '0'.repeat(width - s.length) + s.slice(signLen);
  return ' '.repeat(width - s.length) + s;
}

export interface FmtArgs {
  /** next argument as number (undefined args count as 0) */
  num(): number;
  /** next argument as string */
  str(): string;
  /** next argument: true if it is a number (not a string) — for %c */
  peekIsNum(): boolean;
  /** are there arguments left */
  more(): boolean;
}

/** Apply one numeric conversion */
export function formatNumber(conv: string, v: number, flags: string, width: number, prec: number | undefined): string {
  const left = flags.includes('-');
  const plus = flags.includes('+');
  const space = flags.includes(' ');
  const alt = flags.includes('#');
  let zero = flags.includes('0') && !left;
  let body: string;
  let sign = '';
  const upper = conv === 'E' || conv === 'G' || conv === 'F' || conv === 'X';
  switch (conv) {
    case 'd': case 'i': {
      if (!Number.isFinite(v)) {
        body = nonFinite(v, false);
        sign = Number.isNaN(v) ? '+' : v < 0 ? '-' : '+';
        zero = false;
        break;
      }
      const t = Math.trunc(v);
      sign = t < 0 ? '-' : plus ? '+' : space ? ' ' : '';
      body = intString(Math.abs(t));
      if (prec !== undefined) {
        zero = false;
        if (prec === 0 && t === 0) body = '';
        else if (body.length < prec) body = '0'.repeat(prec - body.length) + body;
      }
      break;
    }
    case 'o': case 'x': case 'X': case 'u': {
      if (!Number.isFinite(v)) { body = nonFinite(v, false); zero = false; break; }
      let t = BigInt(Math.trunc(v));
      if (t < 0n) t = t & ((1n << 64n) - 1n);
      const radix = conv === 'o' ? 8 : conv === 'u' ? 10 : 16;
      body = t.toString(radix);
      if (conv === 'X') body = body.toUpperCase();
      if (prec !== undefined) {
        zero = false;
        if (prec === 0 && t === 0n) body = '';
        else if (body.length < prec) body = '0'.repeat(prec - body.length) + body;
      }
      if (alt && conv === 'o' && !body.startsWith('0')) body = '0' + body;
      if (alt && t !== 0n && (conv === 'x' || conv === 'X')) sign = conv === 'x' ? '0x' : '0X';
      break;
    }
    default: {
      // e E f F g G
      const p = prec === undefined ? 6 : prec;
      sign = v < 0 || Object.is(v, -0) ? '-' : plus ? '+' : space ? ' ' : '';
      if (Number.isNaN(v)) sign = plus ? '+' : space ? ' ' : '-';
      if (!Number.isFinite(v)) { body = nonFinite(v, upper); zero = false; break; }
      const a = Math.abs(v);
      if (conv === 'f' || conv === 'F') {
        body = fixedDigits(a, p);
        if (alt && p === 0) body += '.';
      } else if (conv === 'e' || conv === 'E') body = fmtE(a, p, alt, upper);
      else body = fmtG(a, p, alt, upper);
    }
  }
  return pad(sign + body, width, left, zero, sign.length);
}

/** sprintf/printf */
export function awkSprintf(fmt: string, args: FmtArgs, charOf: (n: number) => string): string {
  let out = '';
  let i = 0;
  const n = fmt.length;
  while (i < n) {
    const c = fmt[i];
    if (c !== '%') {
      const j = fmt.indexOf('%', i);
      if (j < 0) { out += fmt.slice(i); break; }
      out += fmt.slice(i, j);
      i = j;
      continue;
    }
    const start = i;
    i++;
    if (fmt[i] === '%') { out += '%'; i++; continue; }
    {
      // `%5%` prints a plain % (gawk)
      const pct = /^[-+ #0]*(\d+|\*)?(\.(\d+|\*)?)?%/.exec(fmt.slice(i, i + 40));
      if (pct) { out += '%'; i += pct[0].length; continue; }
    }
    let flags = '';
    while (i < n && '-+ #0'.includes(fmt[i])) flags += fmt[i++];
    let width = 0;
    if (fmt[i] === '*') {
      i++;
      width = Math.trunc(args.num());
      if (width < 0) { flags += '-'; width = -width; }
    } else {
      while (i < n && fmt[i] >= '0' && fmt[i] <= '9') width = width * 10 + (fmt.charCodeAt(i++) - 48);
    }
    let prec: number | undefined;
    if (fmt[i] === '.') {
      i++;
      prec = 0;
      if (fmt[i] === '*') {
        i++;
        prec = Math.trunc(args.num());
        if (prec < 0) prec = undefined;
      } else {
        while (i < n && fmt[i] >= '0' && fmt[i] <= '9') prec = prec * 10 + (fmt.charCodeAt(i++) - 48);
      }
    }
    // length modifiers are accepted and ignored
    while (i < n && 'hlLqjzt'.includes(fmt[i])) i++;
    if (i >= n) { out += fmt.slice(start); break; }
    const conv = fmt[i++];
    const left = flags.includes('-');
    switch (conv) {
      case 'd': case 'i': case 'o': case 'x': case 'X': case 'u':
      case 'e': case 'E': case 'f': case 'F': case 'g': case 'G':
        out += formatNumber(conv, args.num(), flags, width, prec);
        break;
      case 'c': {
        let s: string;
        if (!args.more()) s = '';
        else if (args.peekIsNum()) s = charOf(args.num());
        else s = [...args.str()][0] ?? '\0';
        out += pad(s, width, left, false);
        break;
      }
      case 's': {
        let s = args.str();
        if (prec !== undefined) s = s.slice(0, prec);
        out += pad(s, width, left, false);
        break;
      }
      default:
        // unknown conversion: print as is
        out += fmt.slice(start, i);
    }
  }
  return out;
}

/** Number to string with a CONVFMT/OFMT-style format (integers print as integers) */
export function numToString(v: number, fmt: string): string {
  if (Number.isInteger(v)) {
    if (Math.abs(v) < 1e16) return String(v === 0 ? 0 : v);
    return BigInt(v).toString();
  }
  if (Number.isNaN(v)) return '-nan';
  if (!Number.isFinite(v)) return v < 0 ? '-inf' : '+inf';
  if (fmt === '%.6g') {
    const a = Math.abs(v);
    if (a >= 1e-4 && a < 1e5) {
      // toPrecision rounds like C except on exact ties
      const t = v.toPrecision(9);
      if (!t.endsWith('500')) {
        const r = v.toPrecision(6);
        if (!r.includes('e')) return r.includes('.') ? r.replace(/\.?0+$/, '') : r;
      }
    }
    return formatNumber('g', v, '', 0, 6);
  }
  let k = 0;
  return awkSprintf(fmt, {
    num: () => (k++ === 0 ? v : 0),
    str: () => (k++ === 0 ? String(v) : ''),
    peekIsNum: () => true,
    more: () => k === 0,
  }, (c) => String.fromCharCode(c));
}
