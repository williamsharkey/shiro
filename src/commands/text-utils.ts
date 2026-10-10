/**
 * Small coreutils: rev, tac, shuf, cmp
 */

import { encodeText } from '../utils/byte-text';
import type { Command } from './index';
import { parseArgs, readInput } from './flags';

export const revCmd: Command = {
  name: 'rev',
  description: 'Reverse each line of input',
  async exec(ctx) {
    try {
      const { positional } = parseArgs(ctx.args, []);
      const { content } = await readInput(positional, () => ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
      if (!content) return 0;
      const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
      const reversed = lines.map(l => l.split('').reverse().join(''));
      ctx.stdout += reversed.join('\n') + '\n';
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `rev: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

export const tacCmd: Command = {
  name: 'tac',
  description: 'Print file in reverse line order',
  async exec(ctx) {
    try {
      const { positional } = parseArgs(ctx.args, []);
      const { content } = await readInput(positional, () => ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
      if (!content) return 0;
      const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
      ctx.stdout += lines.reverse().join('\n') + '\n';
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `tac: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

export const shufCmd: Command = {
  name: 'shuf',
  description: 'Shuffle lines of input',
  async exec(ctx) {
    try {
      const { values, positional, flags } = parseArgs(ctx.args, ['n', 'i']);

      let lines: string[];

      if (flags.e) {
        // -e: treat remaining args as input lines
        const eIdx = ctx.args.indexOf('-e');
        lines = ctx.args.slice(eIdx + 1);
      } else if (values.i) {
        // -i LO-HI: generate range
        const match = values.i.match(/^(\d+)-(\d+)$/);
        if (!match) {
          ctx.stderr += 'shuf: invalid input range\n';
          return 1;
        }
        const lo = parseInt(match[1], 10);
        const hi = parseInt(match[2], 10);
        lines = [];
        for (let n = lo; n <= hi; n++) lines.push(String(n));
      } else {
        const { content } = await readInput(positional, () => ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
        if (!content) return 0;
        lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
      }

      // Fisher-Yates shuffle
      for (let i = lines.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lines[i], lines[j]] = [lines[j], lines[i]];
      }

      const count = values.n ? Math.min(parseInt(values.n, 10), lines.length) : lines.length;
      ctx.stdout += lines.slice(0, count).join('\n') + '\n';
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `shuf: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

/** A cmp size operand: digits with an optional k/K/M/G/T/P/E suffix (B = powers of 1000, iB or none = 1024) */
function parseCmpSize(s: string): number | null {
  const m = /^(\d+)(?:([kKMGTPE])(B|iB)?)?$/.exec(s);
  if (!m) return null;
  let n = parseInt(m[1], 10);
  if (m[2]) n *= Math.pow(m[3] === 'B' ? 1000 : 1024, 'kKMGTPE'.indexOf(m[2]) <= 1 ? 1 : 'kKMGTPE'.indexOf(m[2]));
  return n;
}

/** A byte as cmp -b shows it (cat -v notation) */
function cmpShowByte(b: number): string {
  let s = '';
  if (b >= 128) { s = 'M-'; b -= 128; }
  if (b < 32) return s + '^' + String.fromCharCode(b + 64);
  if (b === 127) return s + '^?';
  return s + String.fromCharCode(b);
}

/**
 * cmp, as GNU diffutils: `-` (or a missing FILE2) is stdin; -b/--print-bytes,
 * -l/--verbose, -s/--quiet/--silent, -n/--bytes LIMIT, -i/--ignore-initial
 * SKIP[:SKIP2] and SKIP1 SKIP2 operands; status 0 same, 1 different, 2 trouble.
 */
export const cmpCmd: Command = {
  name: 'cmp',
  description: 'Compare two files byte by byte',
  async exec(ctx) {
    const usage = (msg: string) => { ctx.stderr += `cmp: ${msg}\ncmp: Try 'cmp --help' for more information.\n`; return 2; };
    let printBytes = false, listAll = false, silent = false;
    let limit = Infinity;
    const skip = [0, 0];
    const operands: string[] = [];
    const args = ctx.args;
    const setBytes = (v: string | undefined) => {
      const n = v === undefined ? null : parseCmpSize(v);
      if (n === null) { usage(`invalid --bytes value '${v ?? ''}'`); return false; }
      limit = Math.min(limit, n);
      return true;
    };
    const setSkip = (v: string | undefined) => {
      const parts = (v ?? '').split(':');
      if (parts.length > 2) { usage(`invalid --ignore-initial value '${v}'`); return false; }
      const a = parseCmpSize(parts[0]);
      const b = parts.length > 1 ? parseCmpSize(parts[1]) : a;
      if (a === null || b === null) { usage(`invalid --ignore-initial value '${a === null ? parts[0] : parts[1]}'`); return false; }
      skip[0] = a; skip[1] = b;
      return true;
    };
    let opts = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (opts && a === '--') { opts = false; continue; }
      if (opts && a.startsWith('--') && a.length > 2) {
        const eq = a.indexOf('=');
        const name = eq < 0 ? a : a.slice(0, eq);
        const val = () => (eq < 0 ? args[++i] : a.slice(eq + 1));
        if (name === '--print-bytes') printBytes = true;
        else if (name === '--verbose') listAll = true;
        else if (name === '--quiet' || name === '--silent') silent = true;
        else if (name === '--bytes') { if (!setBytes(val())) return 2; }
        else if (name === '--ignore-initial') { if (!setSkip(val())) return 2; }
        else return usage(`unrecognized option '${a}'`);
        continue;
      }
      if (opts && a.startsWith('-') && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const f = a[j];
          if (f === 'b') printBytes = true;
          else if (f === 'l') listAll = true;
          else if (f === 's') silent = true;
          else if (f === 'n' || f === 'i') {
            const v = a.slice(j + 1) || args[++i];
            if (!(f === 'n' ? setBytes(v) : setSkip(v))) return 2;
            break;
          } else return usage(`invalid option -- '${f}'`);
        }
        continue;
      }
      operands.push(a);
    }
    if (listAll && silent) return usage('options -l and -s are incompatible');
    if (operands.length === 0) return usage("missing operand after 'cmp'");
    if (operands.length > 4) return usage(`extra operand '${operands[4]}'`);
    for (let k = 2; k < operands.length; k++) {
      const n = parseCmpSize(operands[k]);
      if (n === null) return usage(`invalid --ignore-initial value '${operands[k]}'`);
      skip[k - 2] = n;
    }
    const names = [operands[0], operands[1] ?? '-'];

    // Read both inputs as bytes; stdin is read once
    let stdinBytes: Uint8Array | null = null;
    const data: Uint8Array[] = [];
    const regular: boolean[] = [];
    for (const name of names) {
      if (name === '-') {
        stdinBytes ??= encodeText(ctx.stdin);
        data.push(stdinBytes);
        regular.push(false);
        continue;
      }
      try {
        const p = ctx.fs.resolvePath(name, ctx.cwd);
        const st = await ctx.fs.stat(p);
        if (st.isDirectory()) { if (!silent) ctx.stderr += `cmp: ${name}: Is a directory\n`; return 2; }
        const raw = await ctx.fs.readFile(p);
        data.push(typeof raw === 'string' ? new TextEncoder().encode(raw) : raw);
        regular.push(!p.startsWith('/dev/') && !p.startsWith('/proc/'));
      } catch {
        if (!silent) ctx.stderr += `cmp: ${name}: No such file or directory\n`;
        return 2;
      }
    }
    // The same file (or stdin twice) compares equal
    if (names[0] === names[1] && skip[0] === skip[1]) return 0;

    const d1 = data[0].subarray(Math.min(skip[0], data[0].length));
    const d2 = data[1].subarray(Math.min(skip[1], data[1].length));
    const common = Math.min(d1.length, d2.length, limit);

    let differ = false;
    let width = 1;
    if (listAll) {
      let max = limit;
      if (regular[0]) max = Math.min(max, d1.length);
      if (regular[1]) max = Math.min(max, d2.length);
      width = Number.isFinite(max) ? String(max).length : 19;
    }
    let lines = 0;
    for (let i = 0; i < common; i++) {
      const a = d1[i], b = d2[i];
      if (a !== b) {
        differ = true;
        if (silent) return 1;
        if (!listAll) {
          ctx.stdout += printBytes
            ? `${names[0]} ${names[1]} differ: byte ${i + 1}, line ${lines + 1} is ${a.toString(8).padStart(3)} ${cmpShowByte(a)} ${b.toString(8).padStart(3)} ${cmpShowByte(b)}\n`
            : `${names[0]} ${names[1]} differ: char ${i + 1}, line ${lines + 1}\n`;
          return 1;
        }
        ctx.stdout += printBytes
          ? `${String(i + 1).padStart(width)} ${a.toString(8).padStart(3)} ${cmpShowByte(a).padEnd(4)} ${b.toString(8).padStart(3)} ${cmpShowByte(b)}\n`
          : `${String(i + 1).padStart(width)} ${a.toString(8).padStart(3)} ${b.toString(8).padStart(3)}\n`;
      }
      if (a === 10) lines++;
    }
    if (common < limit && d1.length !== d2.length) {
      if (!silent) {
        const k = d1.length < d2.length ? 0 : 1;
        const short = k === 0 ? d1 : d2;
        if (short.length === 0) ctx.stderr += `cmp: EOF on ${names[k]} which is empty\n`;
        else if (listAll) ctx.stderr += `cmp: EOF on ${names[k]} after byte ${short.length}\n`;
        else ctx.stderr += `cmp: EOF on ${names[k]} after byte ${short.length}, ${short[short.length - 1] === 10 ? `line ${lines}` : `in line ${lines + 1}`}\n`;
      }
      return 1;
    }
    return differ ? 1 : 0;
  },
};
