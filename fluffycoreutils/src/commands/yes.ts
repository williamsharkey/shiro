import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const yes: FluffyCommand = {
  name: "yes",
  description: "Output a string repeatedly until killed",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    // Default to "y" if no argument provided
    const output = positional.length > 0 ? positional.join(" ") : "y";

    // In a browser environment, we can't output infinitely
    // Instead, output a reasonable number of lines (1000)
    // Real shells would have to handle Ctrl+C to stop this
    const lines: string[] = [];
    const maxLines = 1000;

    for (let i = 0; i < maxLines; i++) {
      lines.push(output);
    }

    return {
      stdout: lines.join("\n") + "\n",
      stderr: "",
      exitCode: 0
    };
  },
};
