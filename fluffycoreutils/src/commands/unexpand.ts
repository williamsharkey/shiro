import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const unexpand: FluffyCommand = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["t", "tabs"]);

    // Tab stop interval (default 8)
    const tabStops = values.t || values.tabs || "8";
    const tabWidth = parseInt(tabStops, 10);

    if (isNaN(tabWidth) || tabWidth <= 0) {
      return {
        stdout: "",
        stderr: `unexpand: invalid tab size: '${tabStops}'\n`,
        exitCode: 1
      };
    }

    const allSpaces = flags.a || flags.all;

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
        let result = "";
        let column = 0;
        let spaces = 0;

        for (let i = 0; i < line.length; i++) {
          const char = line[i];

          if (char === " ") {
            spaces++;
            column++;

            // Check if we've reached a tab stop
            if (column % tabWidth === 0) {
              // Only convert to tab if:
              // 1. We're in "all spaces" mode, OR
              // 2. We haven't encountered non-whitespace yet (initial whitespace only)
              if (allSpaces || result.trim() === "") {
                // Convert accumulated spaces to tab
                if (spaces >= tabWidth) {
                  result += "\t".repeat(Math.floor(spaces / tabWidth));
                  spaces = spaces % tabWidth;
                }
                if (spaces > 0) {
                  result += " ".repeat(spaces);
                  spaces = 0;
                }
              } else {
                // Keep spaces as-is
                result += " ".repeat(spaces);
                spaces = 0;
              }
            }
          } else {
            // Non-space character
            if (spaces > 0) {
              result += " ".repeat(spaces);
              spaces = 0;
            }
            result += char;
            column++;
          }
        }

        // Add any remaining spaces
        if (spaces > 0) {
          result += " ".repeat(spaces);
        }

        output.push(result);
      }

      return {
        stdout: output.join("\n") + (content.endsWith("\n") ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `unexpand: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};
