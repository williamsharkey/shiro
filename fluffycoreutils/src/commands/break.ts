import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const breakCmd: FluffyCommand = {
  name: "break",
  description: "Exit from a for, while, or until loop",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    // Optional argument: number of enclosing loops to break out of
    const n = positional.length > 0 ? parseInt(positional[0]) : 1;

    if (isNaN(n) || n < 1) {
      return {
        stdout: "",
        stderr: "break: numeric argument required\n",
        exitCode: 1
      };
    }

    // In a real shell, this would break out of n enclosing loops
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};
