import { Command } from './index';

export const mkTempCmd: Command = {
  name: 'mktemp',
  description: 'Create temporary file or directory',
  async exec(ctx) {
    let makeDir = false;
    let parentDir = '';
    let template = 'tmp.XXXXXX';
    let suffix = '';

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-d') {
        makeDir = true;
      } else if (arg === '-p' && ctx.args[i + 1]) {
        parentDir = ctx.args[++i];
      } else if (arg === '-t' && ctx.args[i + 1]) {
        template = ctx.args[++i];
      } else if (arg === '--suffix' && ctx.args[i + 1]) {
        suffix = ctx.args[++i];
      } else if (arg.startsWith('--suffix=')) {
        suffix = arg.slice('--suffix='.length);
      } else if (!arg.startsWith('-')) {
        template = arg;
      }
      i++;
    }

    // If template contains '/', extract directory part from template path
    let dir: string;
    let baseName: string;
    const lastSlash = template.lastIndexOf('/');
    if (lastSlash >= 0) {
      dir = template.slice(0, lastSlash) || '/';
      baseName = template.slice(lastSlash + 1);
    } else {
      dir = parentDir || '/tmp';
      baseName = template;
    }

    const randomChars = Math.random().toString(36).slice(2, 8);
    const name = baseName.replace(/X{3,}/, randomChars) + suffix;
    const resolvedDir = ctx.fs.resolvePath(dir, ctx.cwd);
    const fullPath = resolvedDir + '/' + name;

    try {
      await ctx.fs.mkdir(resolvedDir, { recursive: true });
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
