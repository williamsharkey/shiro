
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const sort: Command = {
  name: "sort",
  description: "Sort lines of text",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);
    try {
      const { content } = await readInput(
        positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath
      );
      let lines = content.split("\n").filter(Boolean);

      if (flags.n) {
        lines.sort((a, b) => parseFloat(a) - parseFloat(b));
      } else {
        lines.sort();
      }

      if (flags.u) {
        lines = [...new Set(lines)];
      }

      if (flags.r) {
        lines.reverse();
      }

      ctx.stdout += lines.join("\n") + "\n";
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `sort: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
