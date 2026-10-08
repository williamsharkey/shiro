/**
 * sum — checksum and count the blocks in a file, as GNU coreutils: BSD
 * algorithm (-r, default; 1K blocks) or System V (-s, --sysv; 512-byte
 * blocks). Names are printed when FILE operands are given.
 */

import type { Command } from './index';

/** A shell string as bytes: one byte per char, unless it holds chars past 0xff (then UTF-8) */
function toBytes(s: string): Uint8Array {
  if (/[^\x00-\xff]/.test(s)) return new TextEncoder().encode(s);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bsdSum(data: Uint8Array): string {
  let ck = 0;
  for (const b of data) {
    ck = (ck >> 1) + ((ck & 1) << 15);
    ck = (ck + b) & 0xffff;
  }
  const blocks = Math.ceil(data.length / 1024);
  return `${String(ck).padStart(5, '0')} ${String(blocks).padStart(5, ' ')}`;
}

function sysvSum(data: Uint8Array): string {
  let s = 0;
  for (const b of data) s = (s + b) >>> 0;
  const r = (s & 0xffff) + (s >>> 16);
  const ck = (r & 0xffff) + (r >>> 16);
  return `${ck} ${Math.ceil(data.length / 512)}`;
}

export const sumCmd: Command = {
  name: 'sum',
  description: 'Checksum and count the blocks in a file',
  async exec(ctx) {
    let sysv = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a === '--sysv') { sysv = true; continue; }
      if (a.startsWith('--')) {
        ctx.stderr += `sum: unrecognized option '${a}'\nTry 'sum --help' for more information.\n`;
        return 1;
      }
      if (a.length > 1 && a[0] === '-') {
        for (const ch of a.slice(1)) {
          if (ch === 'r') sysv = false;
          else if (ch === 's') sysv = true;
          else {
            ctx.stderr += `sum: invalid option -- '${ch}'\nTry 'sum --help' for more information.\n`;
            return 1;
          }
        }
        continue;
      }
      files.push(a);
    }

    const named = files.length > 0;
    let status = 0;
    for (const f of named ? files : ['-']) {
      let data: Uint8Array;
      if (f === '-') data = toBytes(ctx.stdin);
      else {
        try {
          // Shiro files hold the UTF-8 form of shell strings (one char per byte)
          data = toBytes(await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          ctx.stderr += `sum: ${f}: ${/EISDIR/.test(msg) ? 'Is a directory' : 'No such file or directory'}\n`;
          status = 1;
          continue;
        }
      }
      ctx.stdout += (sysv ? sysvSum(data) : bsdSum(data)) + (named ? ` ${f}` : '') + '\n';
    }
    return status;
  },
};
