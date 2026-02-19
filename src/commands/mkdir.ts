
import type { Command } from './index';
import { parseArgs } from './flags';
export const mkdir: Command = {
  name: "mkdir",
  description: "Make directories",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);
    const parents = flags.p;

    if (positional.length === 0) {
      ctx.stderr += "mkdir: missing operand\n";
      return 1;
    }

    try {
      for (const p of positional) {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        await ctx.fs.mkdir(resolved, { recursive: parents });
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `mkdir: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
