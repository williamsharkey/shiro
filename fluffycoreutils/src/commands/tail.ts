import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const tail: FluffyCommand = {
  name: "tail",
  description: "Output the last part of files",
  async exec(args, io) {
    // Rewrite POSIX shorthand -N to -n N
    const rewritten = args.flatMap(a => {
      const m = a.match(/^-(\d+)$/);
      return m ? ["-n", m[1]] : [a];
    });
    const { values, positional } = parseArgs(rewritten, ["n"]);
    const nStr = values.n ?? "10";
    try {
      const { content } = await readInput(
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
      );
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
      return { stdout: result.join("\n") + "\n", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `tail: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
