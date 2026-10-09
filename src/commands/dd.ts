/**
 * dd — copy and convert data (GNU coreutils-compatible).
 *
 * Operands: if= of= bs= ibs= obs= cbs= count= skip= seek= conv= iflag= oflag=
 * status=. Sizes take GNU suffixes (c w b kB K MB M GB G, xM products).
 * conv: notrunc ucase lcase swab sync noerror excl nocreat fsync fdatasync.
 * iflag: count_bytes skip_bytes fullblock; oflag: seek_bytes append.
 * Data is handled as bytes; the transfer summary goes to stderr like GNU's.
 */

import type { Command, CommandContext } from './index';

class DdError extends Error {}

/** GNU dd number: N[suffix] optionally multiplied with 'x' */
function parseNumber(s: string, what: string): number {
  if (s === '') throw new DdError(`invalid number: '${s}'`);
  let total = 1;
  for (const part of s.split('x')) {
    const m = /^(\d+)(c|w|b|kB|KB|K|k|KiB|MB|M|MiB|GB|G|GiB|TB|T|TiB|PB|P|EB|E)?$/.exec(part);
    if (!m) throw new DdError(`invalid number: '${s}'`);
    const n = parseInt(m[1], 10);
    const mult: Record<string, number> = {
      '': 1, c: 1, w: 2, b: 512, kB: 1000, KB: 1000, K: 1024, k: 1024, KiB: 1024,
      MB: 1e6, M: 1048576, MiB: 1048576, GB: 1e9, G: 1073741824, GiB: 1073741824,
      TB: 1e12, T: 1024 ** 4, TiB: 1024 ** 4, PB: 1e15, P: 1024 ** 5, EB: 1e18, E: 1024 ** 6,
    };
    total *= n * mult[m[2] ?? ''];
  }
  void what;
  return total;
}

function humanBytes(n: number, base: number): string {
  const units = base === 1000 ? ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] : ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = n;
  let u = 0;
  while (v >= base && u < units.length - 1) { v /= base; u++; }
  if (u === 0) return `${n} ${units[0]}`;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

function bytesToText(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
    return s;
  }
}

async function readSource(ctx: CommandContext, path: string, need: number): Promise<Uint8Array> {
  if (path === '/dev/zero') return new Uint8Array(need);
  if (path === '/dev/random' || path === '/dev/urandom') {
    const out = new Uint8Array(need);
    for (let i = 0; i < need; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(need, i + 65536)));
    return out;
  }
  if (path === '/dev/null') return new Uint8Array(0);
  if (path === '/dev/stdin' || path === '-') return new TextEncoder().encode(ctx.stdin || '');
  const abs = ctx.fs.resolvePath(path, ctx.cwd);
  let st: any = null;
  try { st = await ctx.fs.stat(abs); } catch {}
  if (!st) throw new DdError(`failed to open '${path}': No such file or directory`);
  if (st.isDirectory()) throw new DdError(`error reading '${path}': Is a directory`);
  if (!(st.mode & 0o400) && st.isFile?.()) throw new DdError(`failed to open '${path}': Permission denied`);
  const d = await ctx.fs.readFile(abs);
  return typeof d === 'string' ? new TextEncoder().encode(d) : d;
}

export const ddCmd: Command = {
  name: 'dd',
  description: 'Copy and convert data',
  async exec(ctx) {
    const start = Date.now();
    try {
      let ifPath: string | null = null;
      let ofPath: string | null = null;
      let ibs = 512, obs = 512;
      let count = -1, skip = 0, seek = 0;
      const conv = new Set<string>();
      const iflag = new Set<string>();
      const oflag = new Set<string>();
      let status = 'default';
      for (const arg of ctx.args) {
        const eq = arg.indexOf('=');
        if (eq < 0) throw new DdError(`unrecognized operand '${arg}'\nTry 'dd --help' for more information.`);
        const key = arg.slice(0, eq);
        const val = arg.slice(eq + 1);
        switch (key) {
          case 'if': ifPath = val; break;
          case 'of': ofPath = val; break;
          case 'bs': ibs = obs = parseNumber(val, key); break;
          case 'ibs': ibs = parseNumber(val, key); break;
          case 'obs': obs = parseNumber(val, key); break;
          case 'cbs': parseNumber(val, key); break;
          case 'count': count = parseNumber(val, key); break;
          case 'skip': case 'iseek': skip = parseNumber(val, key); break;
          case 'seek': case 'oseek': seek = parseNumber(val, key); break;
          case 'conv': for (const c of val.split(',')) {
            if (!['ascii', 'ebcdic', 'ibm', 'block', 'unblock', 'lcase', 'ucase', 'sparse', 'swab', 'sync', 'excl', 'nocreat', 'notrunc', 'noerror', 'fdatasync', 'fsync'].includes(c)) throw new DdError(`invalid conversion: '${c}'`);
            conv.add(c);
          } break;
          case 'iflag': for (const f of val.split(',')) iflag.add(f); break;
          case 'oflag': for (const f of val.split(',')) oflag.add(f); break;
          case 'status':
            if (!['none', 'noxfer', 'progress'].includes(val)) throw new DdError(`invalid status level: '${val}'`);
            status = val;
            break;
          default: throw new DdError(`unrecognized operand '${arg}'\nTry 'dd --help' for more information.`);
        }
      }
      if (ibs <= 0 || obs <= 0) throw new DdError('invalid number: \'0\'');
      if (conv.has('ucase') && conv.has('lcase')) throw new DdError('cannot combine lcase and ucase');
      if (conv.has('excl') && conv.has('nocreat')) throw new DdError('cannot combine excl and nocreat');

      const skipBytes = iflag.has('skip_bytes') ? skip : skip * ibs;
      const countBytes = count < 0 ? -1 : iflag.has('count_bytes') ? count : count * ibs;
      const seekBytes = oflag.has('seek_bytes') ? seek : seek * obs;

      // Input bytes
      let input: Uint8Array;
      if (ifPath === null) {
        input = new TextEncoder().encode(ctx.stdin || '');
      } else {
        const want = countBytes >= 0 ? skipBytes + countBytes : (ifPath === '/dev/zero' || /random$/.test(ifPath) ? -1 : 0);
        if (want < 0) throw new DdError(`${ifPath}: reading an endless device needs count=`);
        input = await readSource(ctx, ifPath, want);
      }
      if (skipBytes > input.length) {
        ctx.stderr += `dd: '${ifPath ?? 'standard input'}': cannot skip to specified offset\n`;
      }
      let data = input.subarray(Math.min(skipBytes, input.length));
      if (countBytes >= 0) data = data.subarray(0, countBytes);

      // Records in: full and partial input blocks
      const fullIn = Math.floor(data.length / ibs);
      const partIn = data.length % ibs ? 1 : 0;

      let out = new Uint8Array(data);
      if (conv.has('sync') && partIn) {
        // a partial input block is padded with NULs to ibs
        const padded = new Uint8Array(Math.ceil(data.length / ibs) * ibs);
        padded.set(data);
        out = padded;
      }
      if (conv.has('swab')) {
        for (let i = 0; i + 1 < out.length; i += 2) { const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t; }
      }
      if (conv.has('ucase') || conv.has('lcase')) {
        for (let i = 0; i < out.length; i++) {
          const c = out[i];
          if (conv.has('ucase') && c >= 0x61 && c <= 0x7a) out[i] = c - 32;
          if (conv.has('lcase') && c >= 0x41 && c <= 0x5a) out[i] = c + 32;
        }
      }

      // Output
      if (ofPath === null || ofPath === '/dev/stdout') {
        ctx.stdout += bytesToText(out);
      } else if (ofPath === '/dev/null') {
        // discard
      } else if (ofPath === '/dev/stderr') {
        ctx.stderr += bytesToText(out);
      } else {
        const abs = ctx.fs.resolvePath(ofPath, ctx.cwd);
        let existing: Uint8Array | null = null;
        let est: any = null;
        try { est = await ctx.fs.stat(abs); } catch {}
        if (est?.isDirectory()) throw new DdError(`failed to open '${ofPath}': Is a directory`);
        if (est && conv.has('excl')) throw new DdError(`failed to open '${ofPath}': File exists`);
        if (!est && conv.has('nocreat')) throw new DdError(`failed to open '${ofPath}': No such file or directory`);
        if (est) {
          const d = await ctx.fs.readFile(abs);
          existing = typeof d === 'string' ? new TextEncoder().encode(d) : d;
        }
        let result: Uint8Array;
        if (oflag.has('append')) {
          const base = existing ?? new Uint8Array(0);
          result = new Uint8Array(base.length + out.length);
          result.set(base);
          result.set(out, base.length);
        } else {
          const base = existing ?? new Uint8Array(0);
          const end = seekBytes + out.length;
          const len = conv.has('notrunc') ? Math.max(base.length, end) : end;
          result = new Uint8Array(len);
          result.set(base.subarray(0, Math.min(base.length, conv.has('notrunc') ? len : seekBytes)));
          result.set(out, seekBytes);
        }
        try {
          await ctx.fs.writeFile(abs, result);
        } catch (e: any) {
          throw new DdError(`failed to open '${ofPath}': ${/ENOENT/.test(e?.message) ? 'No such file or directory' : e?.message}`);
        }
      }

      const fullOut = Math.floor(out.length / obs);
      const partOut = out.length % obs ? 1 : 0;
      if (status !== 'none') {
        ctx.stderr += `${fullIn}+${partIn} records in\n${fullOut}+${partOut} records out\n`;
        if (status !== 'noxfer') {
          const secs = Math.max((Date.now() - start) / 1000, 0.000001);
          const n = out.length;
          const sizes = n >= 1000 ? `${n} bytes (${humanBytes(n, 1000)}, ${humanBytes(n, 1024)}) copied` : `${n} ${n === 1 ? 'byte' : 'bytes'} copied`;
          ctx.stderr += `${sizes}, ${secs.toPrecision(2)} s, ${humanBytes(Math.round(n / secs), 1000)}/s\n`;
        }
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `dd: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
