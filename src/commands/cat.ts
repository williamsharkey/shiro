
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const cat: Command = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);
    try {
      const { content } = await readInput(
        positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath
      );
      if (flags.n) {
        const lines = content.split("\n");
        const numbered = lines
          .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
          .join("\n");
        ctx.stdout += numbered;
        return 0;
      }
      ctx.stdout += content;
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `cat: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
