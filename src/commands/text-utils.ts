/**
 * Small coreutils: rev, tac, shuf, cmp
 */

import type { Command } from './index';
import { parseArgs, readInput } from './flags';

export const revCmd: Command = {
  name: 'rev',
  description: 'Reverse each line of input',
  async exec(ctx) {
    try {
      const { positional } = parseArgs(ctx.args, []);
      const { content } = await readInput(positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
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
      const { content } = await readInput(positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
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
        const { content } = await readInput(positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
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

export const cmpCmd: Command = {
  name: 'cmp',
  description: 'Compare two files byte by byte',
  async exec(ctx) {
    try {
      const { positional, flags } = parseArgs(ctx.args, []);
      if (positional.length < 2) {
        ctx.stderr += 'cmp: missing operand\n';
        return 2;
      }

      const silent = flags.s;
      const listAll = flags.l;

      const path1 = ctx.fs.resolvePath(positional[0], ctx.cwd);
      const path2 = ctx.fs.resolvePath(positional[1], ctx.cwd);
      const data1 = await ctx.fs.readFile(path1, 'utf8') as string;
      const data2 = await ctx.fs.readFile(path2, 'utf8') as string;

      const len = Math.min(data1.length, data2.length);
      let diffFound = false;

      for (let i = 0; i < len; i++) {
        if (data1[i] !== data2[i]) {
          diffFound = true;
          if (silent) return 1;
          if (listAll) {
            const byte = i + 1;
            ctx.stdout += `${byte} ${data1.charCodeAt(i).toString(8)} ${data2.charCodeAt(i).toString(8)}\n`;
          } else {
            ctx.stdout += `${positional[0]} ${positional[1]} differ: byte ${i + 1}, line ${countLines(data1, i)}\n`;
            return 1;
          }
        }
      }

      if (data1.length !== data2.length) {
        diffFound = true;
        if (!silent) {
          const shorter = data1.length < data2.length ? positional[0] : positional[1];
          ctx.stderr += `cmp: EOF on ${shorter}\n`;
        }
        return 1;
      }

      return diffFound ? 1 : 0;
    } catch (e: unknown) {
      ctx.stderr += `cmp: ${e instanceof Error ? e.message : e}\n`;
      return 2;
    }
  },
};

function countLines(str: string, upTo: number): number {
  let lines = 1;
  for (let i = 0; i < upTo; i++) {
    if (str[i] === '\n') lines++;
  }
  return lines;
}
