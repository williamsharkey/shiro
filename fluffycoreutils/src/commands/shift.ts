import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const shift: FluffyCommand = {
  name: "shift",
  description: "Shift positional parameters",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    // In a real shell, this would shift the positional parameters ($1, $2, etc.)
    // The optional argument specifies how many positions to shift
    const n = positional.length > 0 ? parseInt(positional[0]) : 1;

    if (isNaN(n) || n < 0) {
      return {
        stdout: "",
        stderr: "shift: numeric argument required\n",
        exitCode: 1
      };
    }

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};
