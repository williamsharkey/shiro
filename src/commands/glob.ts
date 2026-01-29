import { Command } from './index';

export const globCmd: Command = {
  name: 'glob',
  description: 'Match files using glob patterns (e.g., **/*.ts)',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stderr = 'glob: missing pattern\n';
      return 1;
    }

    const pattern = ctx.args[0];
    const base = ctx.args[1] ? ctx.fs.resolvePath(ctx.args[1], ctx.cwd) : ctx.cwd;

    const matches = await ctx.fs.glob(pattern, base);
    if (matches.length > 0) {
      ctx.stdout = matches.join('\n') + '\n';
    }
    return matches.length > 0 ? 0 : 1;
  },
};
