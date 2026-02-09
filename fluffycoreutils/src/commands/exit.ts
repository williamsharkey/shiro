import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const exit: FluffyCommand = {
  name: "exit",
  description: "Exit the shell with a status code",
  async exec(args, io) {
    const { positional } = parseArgs(args);

    const code = positional.length > 0 ? parseInt(positional[0]) : 0;
    const exitCode = isNaN(code) ? 2 : code;

    // In a real shell, this would terminate the shell process
    // Here we just return the exit code
    return {
      stdout: "",
      stderr: "",
      exitCode: exitCode
    };
  },
};
