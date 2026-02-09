import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const sort: FluffyCommand = {
  name: "sort",
  description: "Sort lines of text",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    try {
      const { content } = await readInput(
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
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

      return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `sort: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
