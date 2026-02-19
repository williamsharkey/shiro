
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const unexpand: Command = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(ctx) {
    const args = ctx.args;
    const { values, positional, flags } = parseArgs(args, ["t", "tabs"]);

    // Tab stop interval (default 8)
    const tabStops = values.t || values.tabs || "8";
    const tabWidth = parseInt(tabStops, 10);

    if (isNaN(tabWidth) || tabWidth <= 0) {
      ctx.stderr += `unexpand: invalid tab size: '${tabStops}'\n`;
      return 1;
    }

    const allSpaces = flags.a || flags.all;

    try {
      const { content } = await readInput(
        positional,
        ctx.stdin,
        ctx.fs,
        ctx.cwd,
        ctx.fs.resolvePath
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

      ctx.stdout += output.join("\n") + (content.endsWith("\n") ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `unexpand: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
