import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const cat: FluffyCommand = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    try {
      const { content } = await readInput(
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
      );
      if (flags.n) {
        const lines = content.split("\n");
        const numbered = lines
          .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
          .join("\n");
        return { stdout: numbered, stderr: "", exitCode: 0 };
      }
      return { stdout: content, stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `cat: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
