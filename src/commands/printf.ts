import type { Command } from './index';
import { formatPrintf } from '../shell';

export const printf: Command = {
  name: "printf",
  description: "Format and print data",
  async exec(ctx) {
    const args = ctx.args;
    if (args.length === 0) {
      ctx.stderr += 'printf: usage: printf format [arguments]\n';
      return 1;
    }
    ctx.stdout += formatPrintf(args[0], args.slice(1));
    return 0;
  },
};
