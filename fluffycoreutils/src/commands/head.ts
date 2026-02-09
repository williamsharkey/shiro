import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const head: FluffyCommand = {
  name: "head",
  description: "Output the first part of files",
  async exec(args, io) {
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
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
      );
      if (byteMode) {
        // -c: output first N bytes (characters)
        return { stdout: content.slice(0, count), stderr: "", exitCode: 0 };
      }
      const lines = content.split("\n").slice(0, count);
      return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `head: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
