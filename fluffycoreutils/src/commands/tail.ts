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
    const n = parseInt(values.n ?? "10", 10);
    try {
      const { content } = await readInput(
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
      );
      const lines = content.split("\n");
      const result = lines.slice(-n);
      return { stdout: result.join("\n") + "\n", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `tail: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
