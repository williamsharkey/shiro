
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const wc: Command = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);
    const showLines = flags.l;
    const showWords = flags.w;
    const showChars = flags.c;
    const showAll = !showLines && !showWords && !showChars;

    try {
      const { content, files } = await readInput(
        positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath
      );
      const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      const words = content.split(/\s+/).filter(Boolean).length;
      const chars = content.length;

      const parts: string[] = [];
      if (showAll || showLines) parts.push(String(lines).padStart(6));
      if (showAll || showWords) parts.push(String(words).padStart(6));
      if (showAll || showChars) parts.push(String(chars).padStart(6));
      if (files.length === 1) parts.push(" " + positional[0]);

      ctx.stdout += parts.join(" ") + "\n";
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `wc: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
