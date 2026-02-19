
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const tail: Command = {
  name: "tail",
  description: "Output the last part of files",
  async exec(ctx) {
    const args = ctx.args;
    // Rewrite POSIX shorthand -N to -n N
    const rewritten = args.flatMap(a => {
      const m = a.match(/^-(\d+)$/);
      return m ? ["-n", m[1]] : [a];
    });
    const { values, positional } = parseArgs(rewritten, ["n", "c"]);
    const byteMode = values.c !== undefined;
    const nStr = byteMode ? values.c : (values.n ?? "10");
    try {
      const { content } = await readInput(
        positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath
      );
      if (byteMode) {
        // -c: output last N bytes (characters)
        const count = parseInt(nStr, 10);
        ctx.stdout += content.slice(-count);
        return 0;
      }
      const lines = content.split("\n");
      // Remove trailing empty line from split (files ending with \n)
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      let result: string[];
      if (nStr.startsWith("+")) {
        // tail -n +N: output starting from line N (1-based)
        const startLine = parseInt(nStr.slice(1), 10);
        result = lines.slice(Math.max(0, startLine - 1));
      } else {
        const n = parseInt(nStr, 10);
        result = n >= lines.length ? lines : lines.slice(-n);
      }
      ctx.stdout += result.join("\n") + "\n";
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `tail: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
