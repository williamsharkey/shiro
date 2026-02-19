
import type { Command } from './index';
import { parseArgs } from './flags';
export const unalias: Command = {
  name: "unalias",
  description: "Remove alias definitions",
  async exec(ctx) {
    const args = ctx.args;
    const { positional, flags } = parseArgs(args);

    if (positional.length === 0 && !flags.a) {
      ctx.stderr += "unalias: usage: unalias [-a] name [name ...]\n";
      return 2;
    }

    // In a real shell, this would remove aliases from shell context
    // -a: remove all aliases

    return 0;
  },
};
