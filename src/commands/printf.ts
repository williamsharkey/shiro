import type { Command } from './index';
import { printfFormat } from '../utils/printf';

export const printf: Command = {
  name: "printf",
  description: "Format and print data",
  async exec(ctx) {
    let args = ctx.args;
    if (args[0] === '--') args = args.slice(1);
    if (args.length === 0) {
      ctx.stderr += 'printf: usage: printf format [arguments]\n';
      return 1;
    }
    const r = printfFormat(args[0], args.slice(1));
    ctx.stdout += r.out;
    for (const e of r.errors) ctx.stderr += e + '\n';
    return r.errors.length ? 1 : 0;
  },
};
