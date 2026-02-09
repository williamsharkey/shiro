import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const less: FluffyCommand = {
  name: "less",
  description: "View file contents with pagination",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);

    try {
      const { content } = await readInput(
        positional, io.stdin, io.fs, io.cwd, io.fs.resolvePath
      );

      // Since we're in a browser environment without interactive terminal,
      // we'll output the content with line numbers and pagination hints
      const lines = content.split("\n");
      const numbered = flags.N || flags.n;

      let output = "";

      if (numbered) {
        output = lines
          .map((line, i) => `${String(i + 1).padStart(6)}  ${line}`)
          .join("\n");
      } else {
        output = content;
      }

      // Add helpful footer for browser context
      if (output && !output.endsWith("\n")) {
        output += "\n";
      }

      // In a real terminal, less would be interactive.
      // For browser-based systems, we just output everything.
      // The shell can handle scrolling in its terminal emulator.
      return { stdout: output, stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `less: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};
