
import type { Command } from './index';
import { parseArgs } from './flags';
export const exit: Command = {
  name: "exit",
  description: "Exit the shell with a status code",
  async exec(ctx) {
    const args = ctx.args;
    const { positional } = parseArgs(args);

    const code = positional.length > 0 ? parseInt(positional[0]) : 0;
    const exitCode = isNaN(code) ? 2 : code;

    // In a real shell, this would terminate the shell process
    // Here we just return the exit code
    return exitCode;
  },
};
