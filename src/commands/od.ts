import type { Command } from './index';
import { encodeText } from '../utils/byte-text';

/**
 * od — dump files in octal and other formats, as GNU coreutils od:
 * -t TYPE[SIZE][z] (repeatable) and the traditional letters, little-endian
 * multi-byte units, -A/-j/-N/-w/-v, `*` for repeated lines, and fields of
 * every format aligned to the widest one.
 */

/** A shell string as bytes: one byte per char (an older-style byte string), unless it holds chars past 0xff (then byte-exact text, src/utils/byte-text.ts) */
function toBytes(s: string): Uint8Array {
  if (/[^\x00-\xff]/.test(s)) return encodeText(s);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

interface Spec {
  type: 'a' | 'c' | 'd' | 'u' | 'o' | 'x' | 'f';
  size: number;
  width: number;
  pad: number;
  trailer: boolean;
}

const INT_WIDTH: Record<string, Record<number, number>> = {
  d: { 1: 4, 2: 6, 4: 11, 8: 20 },
  u: { 1: 3, 2: 5, 4: 10, 8: 20 },
  o: { 1: 3, 2: 6, 4: 11, 8: 22 },
  x: { 1: 2, 2: 4, 4: 8, 8: 16 },
};

/** Parse one -t argument (may hold several specs, e.g. "x1z" or "o2c") */
function parseType(arg: string, specs: Spec[]): string | null {
  let i = 0;
  while (i < arg.length) {
    const t = arg[i++];
    if (t === 'a' || t === 'c') {
      const spec: Spec = { type: t, size: 1, width: 3, pad: 0, trailer: false };
      if (arg[i] === 'z') { spec.trailer = true; i++; }
      specs.push(spec);
      continue;
    }
    if ('duox'.includes(t)) {
      let size = 4;
      const c = arg[i];
      if (c === 'C') { size = 1; i++; }
      else if (c === 'S') { size = 2; i++; }
      else if (c === 'I') { size = 4; i++; }
      else if (c === 'L') { size = 8; i++; }
      else {
        const m = /^\d+/.exec(arg.slice(i));
        if (m) {
          size = parseInt(m[0], 10);
          i += m[0].length;
          if (![1, 2, 4, 8].includes(size)) return `invalid type string '${arg}';\nthis system doesn't provide a ${size}-byte integral type`;
        }
      }
      const spec: Spec = { type: t as Spec['type'], size, width: INT_WIDTH[t][size], pad: 0, trailer: false };
      if (arg[i] === 'z') { spec.trailer = true; i++; }
      specs.push(spec);
      continue;
    }
    if (t === 'f') {
      let size = 8;
      const c = arg[i];
      if (c === 'F') { size = 4; i++; }
      else if (c === 'D' || c === 'L') { size = 8; i++; }
      else {
        const m = /^\d+/.exec(arg.slice(i));
        if (m) {
          size = parseInt(m[0], 10);
          i += m[0].length;
          if (size !== 4 && size !== 8) return `invalid type string '${arg}';\nthis system doesn't provide a ${size}-byte floating point type`;
        }
      }
      const spec: Spec = { type: 'f', size, width: size === 4 ? 15 : 24, pad: 0, trailer: false };
      if (arg[i] === 'z') { spec.trailer = true; i++; }
      specs.push(spec);
      continue;
    }
    return `invalid character '${t}' in type string '${arg}'`;
  }
  return null;
}

/** BYTES argument: 0x hex, leading 0 octal, suffixes b/K/KB/KiB/M/... */
function parseBytes(s: string): number {
  const m = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)(.*)$/.exec(s);
  if (!m) return NaN;
  let n = m[1].startsWith('0x') || m[1].startsWith('0X') ? parseInt(m[1].slice(2), 16)
    : m[1].length > 1 && m[1][0] === '0' ? parseInt(m[1], 8) : parseInt(m[1], 10);
  const suf = m[2];
  if (!suf) return n;
  if (suf === 'b') return n * 512;
  const sm = /^([kKMGTPEZY])(B|iB)?$/.exec(suf);
  if (!sm) return NaN;
  const pow = 'KMGTPEZY'.indexOf(sm[1].toUpperCase()) + 1;
  n *= Math.pow(sm[2] === 'B' ? 1000 : 1024, pow);
  return n;
}

/** Traditional offset operand: [+]OFFSET[.][b] (octal unless '.', 0x hex) */
function parseOffset(s: string): number {
  const m = /^\+?(0[xX][0-9a-fA-F]+|\d+)(\.)?(b)?$/.exec(s);
  if (!m) return NaN;
  let n = /^0[xX]/.test(m[1]) ? parseInt(m[1].slice(2), 16) : m[2] ? parseInt(m[1], 10) : parseInt(m[1], 8);
  if (m[3]) n *= 512;
  return n;
}

const NAMES = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si',
  'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp'];

/** C's %.{p}g */
function fmtG(v: number, p: number): string {
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  let s = v.toExponential(p - 1);
  const exp = parseInt(s.slice(s.indexOf('e') + 1), 10);
  if (exp < -4 || exp >= p) {
    let [mant, ex] = s.split('e');
    if (mant.includes('.')) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
    const sign = ex[0] === '-' ? '-' : '+';
    ex = ex.replace(/^[+-]/, '');
    return `${mant}e${sign}${ex.padStart(2, '0')}`;
  }
  s = v.toFixed(Math.max(0, p - 1 - exp));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Shortest %g that reads back as the same float (GNU ftoastr) */
function fmtFloat(v: number, single: boolean): string {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v < 0 ? '-inf' : 'inf';
  const maxP = single ? 9 : 17;
  for (let p = 1; p <= maxP; p++) {
    const s = fmtG(v, p);
    const back = Number(s);
    if (single ? Math.fround(back) === v : back === v) return s;
  }
  return fmtG(v, maxP);
}

function formatValue(spec: Spec, bytes: Uint8Array, off: number): string {
  const n = spec.size;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + off, n);
  switch (spec.type) {
    case 'a': {
      const c = bytes[off] & 0x7f;
      return c <= 32 ? NAMES[c] : c === 127 ? 'del' : String.fromCharCode(c);
    }
    case 'c': {
      const c = bytes[off];
      const esc: Record<number, string> = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
      if (esc[c]) return esc[c];
      if (c >= 32 && c < 127) return String.fromCharCode(c);
      return c.toString(8).padStart(3, '0');
    }
    case 'f':
      return n === 4 ? fmtFloat(dv.getFloat32(0, true), true) : fmtFloat(dv.getFloat64(0, true), false);
    default: {
      let v: bigint;
      if (n === 1) v = spec.type === 'd' ? BigInt(dv.getInt8(0)) : BigInt(dv.getUint8(0));
      else if (n === 2) v = spec.type === 'd' ? BigInt(dv.getInt16(0, true)) : BigInt(dv.getUint16(0, true));
      else if (n === 4) v = spec.type === 'd' ? BigInt(dv.getInt32(0, true)) : BigInt(dv.getUint32(0, true));
      else v = spec.type === 'd' ? dv.getBigInt64(0, true) : dv.getBigUint64(0, true);
      if (spec.type === 'o') return v.toString(8).padStart(spec.width, '0');
      if (spec.type === 'x') return v.toString(16).padStart(spec.width, '0');
      return v.toString(10);
    }
  }
}

export const od: Command = {
  name: "od",
  description: "Dump files in octal and other formats",
  async exec(ctx) {
    const args = ctx.args;
    const specs: Spec[] = [];
    let radix = 'o';
    let skip = 0;
    let limit = Infinity;
    let lineWidth = 16;
    let verbose = false;
    let traditional = false;
    const operands: string[] = [];
    const err = (m: string) => { ctx.stderr += `od: ${m}\n`; return 1; };
    const TRAD: Record<string, string> = {
      a: 'a', b: 'o1', c: 'c', B: 'o2', o: 'o2', d: 'u2', D: 'u4', e: 'fD', F: 'fD', f: 'fF',
      H: 'x4', X: 'x4', h: 'x2', x: 'x2', i: 'dI', I: 'dL', L: 'dL', l: 'dL', O: 'o4', s: 'd2',
    };

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { operands.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const needVal = ['address-radix', 'skip-bytes', 'read-bytes', 'format', 'endian'];
        let val: string | undefined = eq >= 0 ? a.slice(eq + 1) : undefined;
        if (val === undefined && needVal.includes(name)) val = args[++i];
        switch (name) {
          case 'address-radix': radix = val ?? ''; break;
          case 'skip-bytes': skip = parseBytes(val ?? ''); if (Number.isNaN(skip)) return err(`invalid --skip-bytes argument '${val}'`); break;
          case 'read-bytes': limit = parseBytes(val ?? ''); if (Number.isNaN(limit)) return err(`invalid --read-bytes argument '${val}'`); break;
          case 'format': { const e = parseType(val ?? '', specs); if (e) return err(e); break; }
          case 'output-duplicates': verbose = true; break;
          case 'width': lineWidth = val === undefined ? 32 : parseBytes(val); break;
          case 'traditional': traditional = true; break;
          case 'endian': break;
          default: return err(`unrecognized option '${a}'`);
        }
        continue;
      }
      if (a.length > 1 && a[0] === '-') {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if ('AjNtwS'.includes(ch)) {
            let val: string | undefined = a.slice(j + 1);
            if (!val) val = ch === 'w' ? undefined : args[++i];
            if (val === undefined && ch !== 'w') return err(`option requires an argument -- '${ch}'`);
            if (ch === 'A') radix = val!;
            else if (ch === 'j') { skip = parseBytes(val!); if (Number.isNaN(skip)) return err(`invalid -j argument '${val}'`); }
            else if (ch === 'N') { limit = parseBytes(val!); if (Number.isNaN(limit)) return err(`invalid -N argument '${val}'`); }
            else if (ch === 't') { const e = parseType(val!, specs); if (e) return err(e); }
            else if (ch === 'w') lineWidth = val === undefined ? 32 : parseBytes(val);
            break;
          }
          if (ch === 'v') { verbose = true; continue; }
          if (TRAD[ch]) { parseType(TRAD[ch], specs); continue; }
          return err(`invalid option -- '${ch}'`);
        }
        continue;
      }
      operands.push(a);
    }
    if (!['o', 'd', 'x', 'n'].includes(radix)) return err(`invalid output address radix '${radix}'; it must be one character from [doxn]`);
    if (!specs.length) parseType('o2', specs);
    if (!(lineWidth > 0)) return err(`invalid -w argument`);

    // Traditional offset operand: `od [FILE] [+]OFFSET`
    let label: number | null = null;
    if (traditional || operands.length === 2 || (operands.length === 1 && operands[0].startsWith('+'))) {
      const last = operands[operands.length - 1];
      if (operands.length >= 1 && (last.startsWith('+') || (operands.length >= 2 && /^\d/.test(last)))) {
        if (traditional && operands.length === 3) {
          const o = parseOffset(operands[1]);
          const l = parseOffset(operands[2]);
          if (!Number.isNaN(o) && !Number.isNaN(l)) { skip = o; label = l; operands.splice(1, 2); }
        } else {
          const o = parseOffset(last);
          if (!Number.isNaN(o)) { skip = o; operands.pop(); }
        }
      }
    }

    // Read the input
    const chunks: Uint8Array[] = [];
    const files = operands.length ? operands : ['-'];
    let status = 0;
    for (const f of files) {
      if (f === '-') { chunks.push(toBytes(ctx.stdin)); continue; }
      const dev = ctx.fs.resolvePath(f, ctx.cwd);
      if (/^\/dev\/(zero|u?random)$/.test(dev) && Number.isFinite(limit)) {
        // An endless device: read just what -j/-N need
        const need = Math.max(0, skip + limit - chunks.reduce((n, c) => n + c.length, 0));
        const buf = new Uint8Array(need);
        if (dev !== '/dev/zero') for (let i = 0; i < need; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(need, i + 65536)));
        chunks.push(buf);
        continue;
      }
      try {
        // Shiro files hold the UTF-8 form of shell strings (one char per byte)
        chunks.push(toBytes(await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string));
      } catch {
        ctx.stderr += `od: ${f}: No such file or directory\n`;
        status = 1;
      }
    }
    if (status && !chunks.length) return status;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { all.set(c, p); p += c.length; }
    if (skip > total) {
      ctx.stderr += 'od: cannot skip past end of combined input\n';
      return 1;
    }
    const data = all.subarray(skip, Math.min(total, skip + limit));

    // Line width must be a multiple of every unit size
    const lcm = specs.reduce((m, s) => { let a = m, b = s.size; while (b) [a, b] = [b, a % b]; return m * s.size / a; }, 1);
    if (lineWidth % lcm !== 0) lineWidth = lcm;
    let widthPerBlock = 0;
    for (const s of specs) widthPerBlock = Math.max(widthPerBlock, (s.width + 1) * (lineWidth / s.size));
    for (const s of specs) s.pad = widthPerBlock - s.width * (lineWidth / s.size);

    const addrBase = label ?? skip;
    const fmtAddr = (n: number) => radix === 'o' ? n.toString(8).padStart(7, '0')
      : radix === 'd' ? n.toString(10).padStart(7, '0')
      : radix === 'x' ? n.toString(16).padStart(6, '0') : '';
    const addrPad = radix === 'n' ? 0 : radix === 'x' ? 6 : 7;

    const out: string[] = [];
    let prev: Uint8Array | null = null;
    let starred = false;
    for (let off = 0; off < data.length; off += lineWidth) {
      const n = Math.min(lineWidth, data.length - off);
      const line = data.subarray(off, off + n);
      if (!verbose && prev && n === lineWidth && prev.length === n && line.every((b, k) => b === prev![k])) {
        if (!starred) out.push('*\n');
        starred = true;
        continue;
      }
      starred = false;
      prev = line;
      // Partial units are zero-padded
      const buf = new Uint8Array(lineWidth);
      buf.set(line);
      specs.forEach((s, si) => {
        let row = si === 0 ? fmtAddr(addrBase + off) : ' '.repeat(addrPad);
        const fields = lineWidth / s.size;
        const blank = Math.floor((lineWidth - n) / s.size);
        let padRemaining = s.pad;
        for (let k = fields, idx = 0; k > blank; k--, idx++) {
          const nextPad = Math.floor(s.pad * (k - 1) / fields);
          const w = padRemaining - nextPad + s.width;
          row += formatValue(s, buf, idx * s.size).padStart(w, ' ');
          padRemaining = nextPad;
        }
        if (s.trailer) {
          row += ' '.repeat(blank * s.width + Math.floor(s.pad * blank / fields));
          let t = '';
          for (let k = 0; k < n; k++) t += line[k] >= 32 && line[k] < 127 ? String.fromCharCode(line[k]) : '.';
          row += `  >${t}<`;
        }
        out.push(row + '\n');
      });
    }
    if (radix !== 'n') out.push(fmtAddr(addrBase + data.length) + '\n');
    ctx.stdout += out.join('');
    return status;
  },
};
