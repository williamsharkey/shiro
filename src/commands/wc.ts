
import type { Command } from './index';
import { parseArgs } from './flags';
import { encodeText } from '../utils/byte-text';

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

    const columns = (c: Counts): number[] => {
      const v: number[] = [];
      if (showDefault || showLines) v.push(c.lines);
      if (showDefault || showWords) v.push(c.words);
      if (showChars) v.push(c.chars);
      if (showDefault || showBytes) v.push(c.bytes);
      if (showMax) v.push(c.maxLine);
      return v;
    };

    // Read every input first: GNU pads all columns to one width (digits of the
    // total size; at least 7 when reading a pipe), or not at all for a single count
    const rows: { c: Counts; name?: string }[] = [];
    let exitCode = 0;
    let fromPipe = false;
    const total: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, maxLine: 0 };
    const inputs = positional.length ? positional : [undefined];
    for (const name of inputs) {
      let data: Uint8Array;
      try {
        if (name === undefined || name === '-') {
          data = encodeText(ctx.stdin);
          fromPipe = true;
        } else {
          const raw = await ctx.fs.readFile(ctx.fs.resolvePath(name, ctx.cwd));
          data = typeof raw === 'string' ? encodeText(raw) : raw;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.stderr += `wc: ${name}: ${/ENOENT|no such/i.test(msg) ? 'No such file or directory' : /EISDIR|directory/i.test(msg) ? 'Is a directory' : msg}\n`;
        exitCode = 1;
        continue;
      }
      const c = count(data);
      total.lines += c.lines;
      total.words += c.words;
      total.chars += c.chars;
      total.bytes += c.bytes;
      total.maxLine = Math.max(total.maxLine, c.maxLine);
      rows.push({ c, name });
    }
    if (positional.length > 1) rows.push({ c: total, name: 'total' });
    const single = columns(total).length === 1 && inputs.length === 1;
    const width = single ? 1 : Math.max(String(total.bytes).length, String(total.chars).length, fromPipe ? 7 : 1);
    for (const r of rows) {
      ctx.stdout += columns(r.c).map((n) => String(n).padStart(width)).join(' ') + (r.name !== undefined ? ' ' + r.name : '') + '\n';
    }
    return exitCode;
  },
};
