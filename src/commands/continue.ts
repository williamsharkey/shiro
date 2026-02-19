
import type { Command } from './index';
import { parseArgs } from './flags';
export const continueCmd: Command = {
  name: "continue",
  description: "Continue to next iteration of a for, while, or until loop",
  async exec(ctx) {
    const args = ctx.args;
    const { positional } = parseArgs(args);

    // Optional argument: number of enclosing loops to continue
    const n = positional.length > 0 ? parseInt(positional[0]) : 1;

    if (isNaN(n) || n < 1) {
      ctx.stderr += "continue: numeric argument required\n";
      return 1;
    }

    // In a real shell, this would continue the n-th enclosing loop
    return 0;
  },
};
