import { Command } from './index';

export const iconvCmd: Command = {
  name: 'iconv',
  description: 'Convert text encoding (passthrough)',
  async exec(ctx) {
    let i = 0;
    let inputFile = '';
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-l' || arg === '--list') {
        ctx.stdout = 'UTF-8\nASCII\nISO-8859-1\nUTF-16\nUTF-32\n';
        return 0;
      } else if ((arg === '-f' || arg === '-t') && ctx.args[i + 1]) {
        i++; // skip encoding name, browser is UTF-8 native
      } else if (arg === '-c' || arg === '-s' || arg === '--silent') {
        // ignore silently discard / silent flags
      } else if (arg === '-o' && ctx.args[i + 1]) {
        i++; // skip output file (we write to stdout)
      } else if (!arg.startsWith('-')) {
        inputFile = arg;
      }
      i++;
    }

    // Passthrough: browser handles all text as UTF-8
    if (inputFile) {
      try {
        const resolved = ctx.fs.resolvePath(inputFile, ctx.cwd);
        const data = await ctx.fs.readFile(resolved);
        ctx.stdout = typeof data === 'string' ? data : new TextDecoder().decode(data);
      } catch (e: any) {
        ctx.stderr = `iconv: ${inputFile}: ${e.message}\n`;
        return 1;
      }
    } else {
      ctx.stdout = ctx.stdin;
    }
    return 0;
  },
};
