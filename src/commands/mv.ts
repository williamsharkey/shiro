
import type { Command } from './index';
import { parseArgs, statEntry } from './flags';
export const mv: Command = {
  name: "mv",
  description: "Move or rename files",
  async exec(ctx) {
    const args = ctx.args;
    const { positional } = parseArgs(args);

    if (positional.length < 2) {
      ctx.stderr += "mv: missing operand\n";
      return 1;
    }

    const dest = ctx.fs.resolvePath(positional[positional.length - 1], ctx.cwd);
    const sources = positional.slice(0, -1);

    let destIsDir = false;
    try {
      const stat = await statEntry(ctx.fs, dest);
      destIsDir = stat.type === "dir";
    } catch { /* doesn't exist */ }

    if (sources.length > 1 && !destIsDir) {
      ctx.stderr += "mv: target is not a directory\n";
      return 1;
    }

    try {
      for (const src of sources) {
        const srcResolved = ctx.fs.resolvePath(src, ctx.cwd);
        const name = src.split("/").pop()!;
        const target = destIsDir ? dest + "/" + name : dest;
        await ctx.fs.rename(srcResolved, target);
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `mv: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
