
import type { Command } from './index';
import { parseArgs } from './flags';
export const returnCmd: Command = {
  name: "return",
  description: "Return from a shell function",
  async exec(ctx) {
    const args = ctx.args;
    const { positional } = parseArgs(args);

    const code = positional.length > 0 ? parseInt(positional[0]) : 0;
    const exitCode = isNaN(code) ? 2 : code;

    // In a real shell, this would return from a function with the given status
    return exitCode;
  },
};
