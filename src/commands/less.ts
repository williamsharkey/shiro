
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const less: Command = {
  name: "less",
  description: "View file contents with pagination",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);

    try {
      const { content } = await readInput(
        positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath
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
      ctx.stdout += output;
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `less: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
