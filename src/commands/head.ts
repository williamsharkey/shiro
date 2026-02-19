
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const head: Command = {
  name: "head",
  description: "Output the first part of files",
  async exec(ctx) {
    const args = ctx.args;
    // Rewrite POSIX shorthand -N to -n N
    const rewritten = args.flatMap(a => {
      const m = a.match(/^-(\d+)$/);
      return m ? ["-n", m[1]] : [a];
    });
    const { values, positional } = parseArgs(rewritten, ["n", "c"]);
    const byteMode = values.c !== undefined;
    const count = parseInt(byteMode ? values.c : (values.n ?? "10"), 10);
    try {
      const { content } = await readInput(
        positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath
      );
      if (byteMode) {
        // -c: output first N bytes (characters)
        ctx.stdout += content.slice(0, count);
        return 0;
      }
      const lines = content.split("\n").slice(0, count);
      ctx.stdout += lines.join("\n") + "\n";
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `head: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
