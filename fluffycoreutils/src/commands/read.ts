import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const read: FluffyCommand = {
  name: "read",
  description: "Read a line from stdin",
  async exec(args, io) {
    const { positional, flags } = parseArgs(args, ["p", "n"]);

    // In a real shell, this would read from stdin and set variables
    // For now, we'll just consume stdin
    const input = io.stdin || "";

    // -p prompt (would prompt user in interactive shell)
    // -n nchars (read only n characters)
    // varname (variable to read into)

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};
