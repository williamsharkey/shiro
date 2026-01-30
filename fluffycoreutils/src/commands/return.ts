import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const returnCmd: FluffyCommand = {
  name: "return",
  description: "Return from a shell function",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    const code = positional.length > 0 ? parseInt(positional[0]) : 0;
    const exitCode = isNaN(code) ? 2 : code;

    // In a real shell, this would return from a function with the given status
    return {
      stdout: "",
      stderr: "",
      exitCode: exitCode
    };
  },
};
