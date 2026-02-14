import { Command } from './index';

export const mkTempCmd: Command = {
  name: 'mktemp',
  description: 'Create temporary file or directory',
  async exec(ctx) {
    let makeDir = false;
    let parentDir = '/tmp';
    let template = 'tmp.XXXXXX';

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-d') {
        makeDir = true;
      } else if (arg === '-p' && ctx.args[i + 1]) {
        parentDir = ctx.args[++i];
      } else if (arg === '-t' && ctx.args[i + 1]) {
        template = ctx.args[++i];
      } else if (!arg.startsWith('-')) {
        template = arg;
      }
      i++;
    }

    const suffix = Math.random().toString(36).slice(2, 8);
    const name = template.replace(/X{3,}/, suffix);
    const resolvedParent = ctx.fs.resolvePath(parentDir, ctx.cwd);
    const fullPath = resolvedParent + '/' + name;

    try {
      await ctx.fs.mkdir(resolvedParent, { recursive: true });
      if (makeDir) {
        await ctx.fs.mkdir(fullPath, { recursive: true });
      } else {
        await ctx.fs.writeFile(fullPath, '');
      }
      ctx.stdout = fullPath + '\n';
      return 0;
    } catch (e: any) {
      ctx.stderr = `mktemp: ${e.message}\n`;
      return 1;
    }
  },
};
