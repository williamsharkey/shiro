import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const expand: FluffyCommand = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["t", "tabs"]);

    // Tab stop interval (default 8)
    const tabStops = values.t || values.tabs || "8";
    const tabWidth = parseInt(tabStops, 10);

    if (isNaN(tabWidth) || tabWidth <= 0) {
      return {
        stdout: "",
        stderr: `expand: invalid tab size: '${tabStops}'\n`,
        exitCode: 1
      };
    }

    const initialTabs = flags.i || flags["initial"];

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

      return {
        stdout: output.join("\n") + (content.endsWith("\n") ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `expand: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};
