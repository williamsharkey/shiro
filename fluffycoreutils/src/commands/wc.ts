import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const wc: FluffyCommand = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const showLines = flags.l;
    const showWords = flags.w;
    const showChars = flags.c;
    const showAll = !showLines && !showWords && !showChars;

    try {
      const { content, files } = await readInput(
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
      );
      const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      const words = content.split(/\s+/).filter(Boolean).length;
      const chars = content.length;

      const parts: string[] = [];
      if (showAll || showLines) parts.push(String(lines).padStart(6));
      if (showAll || showWords) parts.push(String(words).padStart(6));
      if (showAll || showChars) parts.push(String(chars).padStart(6));
      if (files.length === 1) parts.push(" " + positional[0]);

      return { stdout: parts.join(" ") + "\n", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `wc: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
