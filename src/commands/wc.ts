
import type { Command } from './index';
import { parseArgs } from './flags';

interface Counts { lines: number; words: number; chars: number; bytes: number; maxLine: number }

/** Count like GNU wc: lines are newline characters, bytes are UTF-8 bytes. */
function count(bytes: Uint8Array): Counts {
  const text = new TextDecoder().decode(bytes);
  let lines = 0, maxLine = 0, lineLen = 0, chars = 0;
  for (const ch of text) {
    chars++;
    if (ch === '\n') {
      lines++;
      if (lineLen > maxLine) maxLine = lineLen;
      lineLen = 0;
    } else {
      lineLen += ch === '\t' ? 8 - (lineLen % 8) : 1;
    }
  }
  if (lineLen > maxLine) maxLine = lineLen;
  const words = text.split(/\s+/).filter(Boolean).length;
  return { lines, words, chars, bytes: bytes.length, maxLine };
}

export const wc: Command = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(ctx) {
    const { flags, positional } = parseArgs(ctx.args);
    const showLines = flags.l || flags.lines;
    const showWords = flags.w || flags.words;
    const showChars = flags.m || flags.chars;
    const showBytes = flags.c || flags.bytes;
    const showMax = flags.L || flags['max-line-length'];
    const showDefault = !showLines && !showWords && !showChars && !showBytes && !showMax;

    const columns = [showDefault || showLines, showDefault || showWords, showChars, showDefault || showBytes, showMax]
      .filter(Boolean).length;
    // GNU widths: one count of one input is printed bare; otherwise columns
    // are as wide as the largest file size, or 7 when reading stdin
    let width = 1;
    const format = (c: Counts, name?: string) => {
      const parts: string[] = [];
      const col = (n: number) => parts.push(String(n).padStart(width));
      if (showDefault || showLines) col(c.lines);
      if (showDefault || showWords) col(c.words);
      if (showChars) col(c.chars);
      if (showDefault || showBytes) col(c.bytes);
      if (showMax) col(c.maxLine);
      return parts.join(" ") + (name !== undefined ? " " + name : "") + "\n";
    };

    if (positional.length === 0) {
      width = columns > 1 ? 7 : 1;
      ctx.stdout += format(count(new TextEncoder().encode(ctx.stdin)));
      return 0;
    }

    let exitCode = 0;
    const total: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, maxLine: 0 };
    const results: { c: Counts; name: string }[] = [];
    for (const name of positional) {
      let data: Uint8Array;
      try {
        if (name === '-') {
          data = new TextEncoder().encode(ctx.stdin);
        } else {
          const raw = await ctx.fs.readFile(ctx.fs.resolvePath(name, ctx.cwd));
          data = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
        }
      } catch (e: unknown) {
        ctx.stderr += `wc: ${name}: ${e instanceof Error ? e.message : e}\n`;
        exitCode = 1;
        continue;
      }
      const c = count(data);
      total.lines += c.lines;
      total.words += c.words;
      total.chars += c.chars;
      total.bytes += c.bytes;
      total.maxLine = Math.max(total.maxLine, c.maxLine);
      results.push({ c, name });
    }
    if (columns > 1 || results.length > 1) {
      width = positional.includes('-') ? 7 : Math.max(1, String(Math.max(total.bytes, total.chars, total.lines, total.words, total.maxLine)).length);
    }
    for (const { c, name } of results) ctx.stdout += format(c, name);
    if (positional.length > 1) ctx.stdout += format(total, 'total');
    return exitCode;
  },
};
