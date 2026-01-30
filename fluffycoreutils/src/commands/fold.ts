import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const fold: FluffyCommand = {
  name: "fold",
  description: "Wrap each input line to fit in specified width",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["w", "width"]);

    const width = parseInt(values.w || values.width || "80", 10);
    const bytes = flags.b;
    const spaces = flags.s;

    if (isNaN(width) || width <= 0) {
      return {
        stdout: "",
        stderr: `fold: invalid width: '${values.w || values.width}'\n`,
        exitCode: 1
      };
    }

    try {
      const { content } = await readInput(
        positional,
        io.stdin,
        io.fs,
        io.cwd,
        io.fs.resolvePath
      );

      const lines = content.split("\n");
      const output: string[] = [];

      for (const line of lines) {
        if (line.length <= width) {
          output.push(line);
          continue;
        }

        // Wrap the line
        let remaining = line;
        while (remaining.length > width) {
          let breakPoint = width;

          if (spaces) {
            // Break at spaces if possible
            const lastSpace = remaining.substring(0, width).lastIndexOf(" ");
            if (lastSpace > 0) {
              breakPoint = lastSpace + 1; // Include the space in the first part
            }
          }

          output.push(remaining.substring(0, breakPoint));
          remaining = remaining.substring(breakPoint);
        }

        if (remaining.length > 0) {
          output.push(remaining);
        }
      }

      return {
        stdout: output.join("\n") + (content.endsWith("\n") ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `fold: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};
