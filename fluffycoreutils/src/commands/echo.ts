import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const echo: FluffyCommand = {
  name: "echo",
  description: "Display text",
  async exec(args) {
    const { flags } = parseArgs(args);
    const noNewline = flags.n;
    // Filter out the -n flag from output, reconstruct text
    const text = args.filter((a) => a !== "-n" && a !== "-e").join(" ");
    let output = flags.e
      ? text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\")
      : text;
    if (!noNewline) output += "\n";
    return { stdout: output, stderr: "", exitCode: 0 };
  },
};
