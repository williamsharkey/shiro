import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const continueCmd: FluffyCommand = {
  name: "continue",
  description: "Continue to next iteration of a for, while, or until loop",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    // Optional argument: number of enclosing loops to continue
    const n = positional.length > 0 ? parseInt(positional[0]) : 1;

    if (isNaN(n) || n < 1) {
      return {
        stdout: "",
        stderr: "continue: numeric argument required\n",
        exitCode: 1
      };
    }

    // In a real shell, this would continue the n-th enclosing loop
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};
