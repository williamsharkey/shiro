
import type { Command } from './index';
import { parseArgs } from './flags';
export const printenv: Command = {
  name: "printenv",
  description: "Print all or part of environment",
  async exec(ctx) {
    const args = ctx.args;
    const { positional, flags } = parseArgs(args);

    const null0 = flags["0"] || flags.null;

    if (positional.length === 0) {
      // Print all environment variables
      const output: string[] = [];
      for (const [key, value] of Object.entries(ctx.env)) {
        output.push(`${key}=${value}`);
      }

      const separator = null0 ? "\0" : "\n";
      ctx.stdout += output.join(separator) + (output.length > 0 ? separator : "");
      return 0;
    } else {
      // Print specific environment variables
      const output: string[] = [];
      for (const varName of positional) {
        if (varName in ctx.env) {
          output.push(ctx.env[varName]);
        } else {
          return 1;
        }
      }

      const separator = null0 ? "\0" : "\n";
      ctx.stdout += output.join(separator) + (output.length > 0 ? separator : "");
      return 0;
    }
  },
};
