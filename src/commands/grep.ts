import { Command, CommandContext } from './index';

export const grepCmd: Command = {
  name: 'grep',
  description: 'Search for patterns in files',
  async exec(ctx: CommandContext) {
    let ignoreCase = false;
    let invertMatch = false;
    let lineNumbers = false;
    let countOnly = false;
    let filesOnly = false;
    let recursive = false;
    let pattern = '';
    const files: string[] = [];

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-i') { ignoreCase = true; }
      else if (arg === '-v') { invertMatch = true; }
      else if (arg === '-n') { lineNumbers = true; }
      else if (arg === '-c') { countOnly = true; }
      else if (arg === '-l') { filesOnly = true; }
      else if (arg === '-r' || arg === '-R') { recursive = true; }
      else if (arg === '-e' && i + 1 < ctx.args.length) { pattern = ctx.args[++i]; }
      else if (arg.startsWith('-') && arg.length > 1) {
        // Combined flags like -in
        for (const ch of arg.slice(1)) {
          if (ch === 'i') ignoreCase = true;
          else if (ch === 'v') invertMatch = true;
          else if (ch === 'n') lineNumbers = true;
          else if (ch === 'c') countOnly = true;
          else if (ch === 'l') filesOnly = true;
          else if (ch === 'r' || ch === 'R') recursive = true;
        }
      } else if (!pattern) {
        pattern = arg;
      } else {
        files.push(arg);
      }
      i++;
    }

    if (!pattern) {
      ctx.stderr = 'grep: missing pattern\n';
      return 2;
    }

    const flags = ignoreCase ? 'i' : '';
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
      ctx.stderr = `grep: invalid pattern '${pattern}'\n`;
      return 2;
    }

    let found = false;

    const searchFile = async (filePath: string, displayPath: string, multiFile: boolean) => {
      let content: string;
      try {
        content = await ctx.fs.readFile(filePath, 'utf8') as string;
      } catch {
        ctx.stderr += `grep: ${displayPath}: No such file or directory\n`;
        return;
      }
      const lines = content.split('\n');
      let matchCount = 0;
      for (let ln = 0; ln < lines.length; ln++) {
        const match = regex.test(lines[ln]);
        if (match !== invertMatch) {
          found = true;
          matchCount++;
          if (filesOnly) {
            ctx.stdout += displayPath + '\n';
            return;
          }
          if (!countOnly) {
            const prefix = multiFile ? displayPath + ':' : '';
            const lineNum = lineNumbers ? (ln + 1) + ':' : '';
            ctx.stdout += prefix + lineNum + lines[ln] + '\n';
          }
        }
      }
      if (countOnly) {
        const prefix = multiFile ? displayPath + ':' : '';
        ctx.stdout += prefix + matchCount + '\n';
      }
    };

    const searchDir = async (dirPath: string) => {
      const entries = await ctx.fs.readdir(dirPath);
      for (const entry of entries) {
        const childPath = dirPath === '/' ? '/' + entry : dirPath + '/' + entry;
        const stat = await ctx.fs.stat(childPath);
        if (stat.isDirectory()) {
          await searchDir(childPath);
        } else {
          await searchFile(childPath, childPath, true);
        }
      }
    };

    if (files.length === 0 && !recursive) {
      // Read from stdin
      const lines = ctx.stdin.split('\n');
      let matchCount = 0;
      for (let ln = 0; ln < lines.length; ln++) {
        const match = regex.test(lines[ln]);
        if (match !== invertMatch) {
          found = true;
          matchCount++;
          if (!countOnly) {
            const lineNum = lineNumbers ? (ln + 1) + ':' : '';
            ctx.stdout += lineNum + lines[ln] + '\n';
          }
        }
      }
      if (countOnly) ctx.stdout += matchCount + '\n';
    } else if (recursive && files.length === 0) {
      await searchDir(ctx.cwd);
    } else {
      const multiFile = files.length > 1 || recursive;
      for (const f of files) {
        const resolved = ctx.fs.resolvePath(f, ctx.cwd);
        const stat = await ctx.fs.stat(resolved).catch(() => null);
        if (stat?.isDirectory() && recursive) {
          await searchDir(resolved);
        } else if (stat?.isDirectory()) {
          ctx.stderr += `grep: ${f}: Is a directory\n`;
        } else {
          await searchFile(resolved, f, multiFile);
        }
      }
    }

    return found ? 0 : 1;
  },
};
