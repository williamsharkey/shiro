/**
 * csplit — context split at regex/line boundaries
 */

import type { Command } from './index';
import { parseArgs, readInput } from './flags';

export const csplitCmd: Command = {
  name: 'csplit',
  description: 'Split a file into sections determined by context lines',
  async exec(ctx) {
    try {
      const { values, positional, flags } = parseArgs(ctx.args, ['f', 'n']);
      const prefix = values.f || 'xx';
      const digits = values.n ? parseInt(values.n, 10) : 2;
      const quiet = flags.s || flags.silent;
      const removeEmpty = flags.z;

      if (positional.length < 2) {
        ctx.stderr += 'csplit: missing operand\n';
        return 1;
      }

      const fileName = positional[0];
      const patterns = positional.slice(1);

      let content: string;
      if (fileName === '-') {
        content = ctx.stdin;
      } else {
        const path = ctx.fs.resolvePath(fileName, ctx.cwd);
        content = await ctx.fs.readFile(path, 'utf8') as string;
      }

      const lines = content.split('\n');
      // Remove trailing empty from final newline
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

      const pieces: string[] = [];
      let currentLine = 0;

      for (let pi = 0; pi < patterns.length; pi++) {
        let pat = patterns[pi];

        // Check for repeat: {N} or {*}
        let repeat = 1;
        let repeatForever = false;
        if (pi + 1 < patterns.length && /^\{\d+\}$/.test(patterns[pi + 1])) {
          repeat = parseInt(patterns[pi + 1].slice(1, -1), 10);
          pi++;
        } else if (pi + 1 < patterns.length && patterns[pi + 1] === '{*}') {
          repeatForever = true;
          pi++;
        }

        let count = 0;
        while (repeatForever || count < repeat) {
          if (currentLine >= lines.length) break;

          if (/^\/.*\/$/.test(pat)) {
            // Regex pattern: split before match
            const regex = new RegExp(pat.slice(1, -1));
            let found = -1;
            // On first pass from start of file, search from line 0; on subsequent repeats,
            // search from currentLine+1 to avoid matching the same line
            const searchStart = (count === 0 && pieces.length === 0) ? 0 : currentLine + 1;
            for (let i = searchStart; i < lines.length; i++) {
              if (regex.test(lines[i])) { found = i; break; }
            }
            if (found === -1) {
              if (repeatForever) {
                // Remaining lines become last piece
                if (currentLine < lines.length) {
                  pieces.push(lines.slice(currentLine).join('\n') + '\n');
                  currentLine = lines.length;
                }
                break;
              }
              ctx.stderr += `csplit: '${pat}': match not found\n`;
              return 1;
            }
            pieces.push(lines.slice(currentLine, found).join('\n') + '\n');
            currentLine = found;
          } else if (/^%.*%$/.test(pat)) {
            // Suppress pattern: skip until match (discard lines)
            const regex = new RegExp(pat.slice(1, -1));
            let found = -1;
            for (let i = currentLine; i < lines.length; i++) {
              if (regex.test(lines[i])) { found = i; break; }
            }
            if (found === -1) {
              if (repeatForever) break;
              ctx.stderr += `csplit: '${pat}': match not found\n`;
              return 1;
            }
            currentLine = found;
          } else {
            // Line number
            const lineNum = parseInt(pat, 10);
            if (isNaN(lineNum)) {
              ctx.stderr += `csplit: invalid pattern: ${pat}\n`;
              return 1;
            }
            const idx = lineNum - 1; // 1-based to 0-based
            if (idx <= currentLine) {
              if (repeatForever) break;
              ctx.stderr += `csplit: '${lineNum}': line number out of range\n`;
              return 1;
            }
            if (idx > lines.length) {
              if (repeatForever) break;
              pieces.push(lines.slice(currentLine).join('\n') + '\n');
              currentLine = lines.length;
              break;
            }
            pieces.push(lines.slice(currentLine, idx).join('\n') + '\n');
            currentLine = idx;
          }
          count++;
        }
      }

      // Remaining lines
      if (currentLine < lines.length) {
        pieces.push(lines.slice(currentLine).join('\n') + '\n');
      }

      // Filter empty pieces if -z
      const finalPieces = removeEmpty ? pieces.filter(p => p !== '\n' && p !== '') : pieces;

      // Write pieces
      for (let i = 0; i < finalPieces.length; i++) {
        const suffix = String(i).padStart(digits, '0');
        const outPath = ctx.fs.resolvePath(prefix + suffix, ctx.cwd);
        await ctx.fs.writeFile(outPath, finalPieces[i]);
        if (!quiet) {
          const encoder = new TextEncoder();
          ctx.stdout += `${encoder.encode(finalPieces[i]).length}\n`;
        }
      }

      return 0;
    } catch (e: unknown) {
      ctx.stderr += `csplit: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
