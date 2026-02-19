
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
export const expand: Command = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(ctx) {
    const args = ctx.args;
    const { values, positional, flags } = parseArgs(args, ["t", "tabs"]);

    // Tab stop interval (default 8)
    const tabStops = values.t || values.tabs || "8";
    const tabWidth = parseInt(tabStops, 10);

    if (isNaN(tabWidth) || tabWidth <= 0) {
      ctx.stderr += `expand: invalid tab size: '${tabStops}'\n`;
      return 1;
    }

    const initialTabs = flags.i || flags["initial"];

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
        let expanded = "";
        let column = 0;

        for (let i = 0; i < line.length; i++) {
          const char = line[i];

          if (char === "\t") {
            // Only expand tabs if not in "initial tabs only" mode, or if we're still in the initial whitespace
            if (!initialTabs || (initialTabs && expanded.trim() === "")) {
              // Calculate spaces needed to reach next tab stop
              const spacesToAdd = tabWidth - (column % tabWidth);
              expanded += " ".repeat(spacesToAdd);
              column += spacesToAdd;
            } else {
              // Keep tab as-is
              expanded += char;
              column++;
            }
          } else {
            expanded += char;
            column++;
          }
        }

        output.push(expanded);
      }

      ctx.stdout += output.join("\n") + (content.endsWith("\n") ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `expand: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
