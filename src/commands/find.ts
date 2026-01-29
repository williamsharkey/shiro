import { Command, CommandContext } from './index';

export const findCmd: Command = {
  name: 'find',
  description: 'Search for files in a directory hierarchy',
  async exec(ctx: CommandContext) {
    let searchDir = '.';
    let namePattern = '';
    let typeFilter = ''; // 'f' for file, 'd' for directory
    let maxDepth = Infinity;

    let i = 0;
    // First non-flag argument is the directory
    if (ctx.args.length > 0 && !ctx.args[0].startsWith('-')) {
      searchDir = ctx.args[0];
      i = 1;
    }

    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '-name' && ctx.args[i + 1]) {
        namePattern = ctx.args[++i];
      } else if (arg === '-type' && ctx.args[i + 1]) {
        typeFilter = ctx.args[++i];
      } else if (arg === '-maxdepth' && ctx.args[i + 1]) {
        maxDepth = parseInt(ctx.args[++i]);
      }
      i++;
    }

    const resolved = ctx.fs.resolvePath(searchDir, ctx.cwd);
    const nameRegex = namePattern ? globToRegex(namePattern) : null;

    const results: string[] = [];

    const walk = async (dir: string, depth: number) => {
      if (depth > maxDepth) return;

      // Check the directory itself
      const dirName = dir.split('/').pop() || '';
      if (depth > 0 || searchDir !== '.') {
        const dirStat = await ctx.fs.stat(dir);
        if (matchesFilters(dirName, dirStat, nameRegex, typeFilter, true)) {
          results.push(formatPath(dir, resolved, searchDir));
        }
      }

      try {
        const entries = await ctx.fs.readdir(dir);
        for (const entry of entries) {
          const childPath = dir === '/' ? '/' + entry : dir + '/' + entry;
          const stat = await ctx.fs.stat(childPath);

          if (stat.isDirectory()) {
            if (matchesFilters(entry, stat, nameRegex, typeFilter, true)) {
              results.push(formatPath(childPath, resolved, searchDir));
            }
            await walk(childPath, depth + 1);
          } else {
            if (matchesFilters(entry, stat, nameRegex, typeFilter, false)) {
              results.push(formatPath(childPath, resolved, searchDir));
            }
          }
        }
      } catch {
        // Permission denied or not a directory
      }
    };

    await walk(resolved, 0);

    if (results.length > 0) {
      ctx.stdout = results.join('\n') + '\n';
    }
    return 0;
  },
};

function matchesFilters(
  name: string,
  stat: any,
  nameRegex: RegExp | null,
  typeFilter: string,
  isDir: boolean
): boolean {
  if (typeFilter === 'f' && isDir) return false;
  if (typeFilter === 'd' && !isDir) return false;
  if (nameRegex && !nameRegex.test(name)) return false;
  return true;
}

function formatPath(fullPath: string, baseResolved: string, searchDir: string): string {
  if (searchDir === '.') {
    const rel = fullPath.slice(baseResolved.length);
    return '.' + rel;
  }
  if (searchDir.startsWith('/')) {
    return fullPath;
  }
  const rel = fullPath.slice(baseResolved.length);
  return searchDir + rel;
}

function globToRegex(pattern: string): RegExp {
  let regex = '^';
  for (const ch of pattern) {
    if (ch === '*') regex += '.*';
    else if (ch === '?') regex += '.';
    else if (ch === '.') regex += '\\.';
    else regex += ch;
  }
  regex += '$';
  return new RegExp(regex);
}
