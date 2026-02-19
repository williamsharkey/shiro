
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const fold: Command = {
  name: "fold",
  description: "Wrap each input line to fit in specified width",
  async exec(ctx) {
    const args = ctx.args;
    const { values, positional, flags } = parseArgs(args, ["w", "width"]);

    const width = parseInt(values.w || values.width || "80", 10);
    const bytes = flags.b;
    const spaces = flags.s;

    if (isNaN(width) || width <= 0) {
      ctx.stderr += `fold: invalid width: '${values.w || values.width}'\n`;
      return 1;
    }

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

      ctx.stdout += output.join("\n") + (content.endsWith("\n") ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `fold: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
