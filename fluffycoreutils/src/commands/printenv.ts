import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const printenv: FluffyCommand = {
  name: "printenv",
  description: "Print all or part of environment",
  async exec(args, io) {
    const { positional, flags } = parseArgs(args);

    const null0 = flags["0"] || flags.null;

    if (positional.length === 0) {
      // Print all environment variables
      const output: string[] = [];
      for (const [key, value] of Object.entries(io.env)) {
        output.push(`${key}=${value}`);
      }

      const separator = null0 ? "\0" : "\n";
      return {
        stdout: output.join(separator) + (output.length > 0 ? separator : ""),
        stderr: "",
        exitCode: 0
      };
    } else {
      // Print specific environment variables
      const output: string[] = [];
      for (const varName of positional) {
        if (varName in io.env) {
          output.push(io.env[varName]);
        } else {
          return {
            stdout: "",
            stderr: "",
            exitCode: 1
          };
        }
      }

      const separator = null0 ? "\0" : "\n";
      return {
        stdout: output.join(separator) + (output.length > 0 ? separator : ""),
        stderr: "",
        exitCode: 0
      };
    }
  },
};
