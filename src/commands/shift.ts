
import type { Command } from './index';
import { parseArgs } from './flags';
export const shift: Command = {
  name: "shift",
  description: "Shift positional parameters",
  async exec(ctx) {
    const args = ctx.args;
    const { positional } = parseArgs(args);

    // In a real shell, this would shift the positional parameters ($1, $2, etc.)
    // The optional argument specifies how many positions to shift
    const n = positional.length > 0 ? parseInt(positional[0]) : 1;

    if (isNaN(n) || n < 0) {
      ctx.stderr += "shift: numeric argument required\n";
      return 1;
    }

    return 0;
  },
};
