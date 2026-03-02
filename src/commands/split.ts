/**
 * split — split a file into pieces
 */

import type { Command } from './index';
import { parseArgs, readInput } from './flags';

function suffixFor(index: number): string {
  const a = String.fromCharCode(97 + Math.floor(index / 26));
  const b = String.fromCharCode(97 + (index % 26));
  return a + b;
}

export const splitCmd: Command = {
  name: 'split',
  description: 'Split a file into pieces',
  async exec(ctx) {
    try {
      const { values, positional, flags } = parseArgs(ctx.args, ['l', 'b', 'n']);

      const lineCount = values.l ? parseInt(values.l, 10) : (values.b || values.n ? 0 : 1000);
      const byteCount = values.b ? parseSplitSize(values.b) : 0;
      const chunkCount = values.n ? parseInt(values.n, 10) : 0;

      const inputFile = positional[0] && positional[0] !== '-' ? positional[0] : '';
      const prefix = positional[1] || 'x';

      let content: string;
      if (inputFile) {
        const resolved = ctx.fs.resolvePath(inputFile, ctx.cwd);
        content = await ctx.fs.readFile(resolved, 'utf8') as string;
      } else {
        content = ctx.stdin;
      }

      if (!content) return 0;

      const pieces: string[] = [];

      if (byteCount > 0) {
        // Split by bytes
        for (let i = 0; i < content.length; i += byteCount) {
          pieces.push(content.substring(i, i + byteCount));
        }
      } else if (chunkCount > 0) {
        // Split into N equal chunks
        const chunkSize = Math.ceil(content.length / chunkCount);
        for (let i = 0; i < content.length; i += chunkSize) {
          pieces.push(content.substring(i, i + chunkSize));
        }
      } else {
        // Split by lines (default)
        const lines = content.split('\n');
        // If content ends with newline, last element is empty — keep it attached
        for (let i = 0; i < lines.length; i += lineCount) {
          const chunk = lines.slice(i, i + lineCount);
          const text = chunk.join('\n');
          // Don't write empty trailing chunks
          if (text || i === 0) pieces.push(text);
        }
      }

      // Write pieces
      for (let i = 0; i < pieces.length; i++) {
        const suffix = suffixFor(i);
        const outPath = ctx.fs.resolvePath(prefix + suffix, ctx.cwd);
        await ctx.fs.writeFile(outPath, pieces[i]);
      }

      return 0;
    } catch (e: unknown) {
      ctx.stderr += `split: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

function parseSplitSize(s: string): number {
  const m = s.match(/^(\d+)([bkKmMgG]?)$/);
  if (!m) return parseInt(s, 10) || 0;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'b': return n * 512;
    case 'k': case 'K': return n * 1024;
    case 'm': case 'M': return n * 1024 * 1024;
    case 'g': case 'G': return n * 1024 * 1024 * 1024;
    default: return n;
  }
}
