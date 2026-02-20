import { Command, CommandContext } from './index';

export const findCmd: Command = {
  name: 'find',
  description: 'Search for files in a directory hierarchy',
  async exec(ctx: CommandContext) {
    let searchDir = '.';
    let namePattern = '';
    let inamePattern = '';
    let pathPattern = '';
    let typeFilter = ''; // 'f' for file, 'd' for directory
    let maxDepth = Infinity;
    let minDepth = 0;
    let print0 = false;
    let sizeSpec = ''; // e.g. '+100k', '-1M'
    let execArgs: string[] | null = null; // -exec template args (with {} placeholders)

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
      } else if (arg === '-iname' && ctx.args[i + 1]) {
        inamePattern = ctx.args[++i];
      } else if (arg === '-path' && ctx.args[i + 1]) {
        pathPattern = ctx.args[++i];
      } else if (arg === '-type' && ctx.args[i + 1]) {
        typeFilter = ctx.args[++i];
      } else if (arg === '-maxdepth' && ctx.args[i + 1]) {
        maxDepth = parseInt(ctx.args[++i]);
      } else if (arg === '-mindepth' && ctx.args[i + 1]) {
        minDepth = parseInt(ctx.args[++i]);
      } else if (arg === '-size' && ctx.args[i + 1]) {
        sizeSpec = ctx.args[++i];
      } else if (arg === '-print0') {
        print0 = true;
      } else if (arg === '-exec') {
        // Collect args until ';' or '+'
        execArgs = [];
        i++;
        while (i < ctx.args.length) {
          const ea = ctx.args[i];
          if (ea === ';' || ea === '+') break;
          execArgs.push(ea);
          i++;
        }
      }
      i++;
    }

    const resolved = ctx.fs.resolvePath(searchDir, ctx.cwd);
    const nameRegex = namePattern ? globToRegex(namePattern, false) : null;
    const inameRegex = inamePattern ? globToRegex(inamePattern, true) : null;
    const pathRegex = pathPattern ? globToRegex(pathPattern, false) : null;
    const sizeFilter = sizeSpec ? parseSizeSpec(sizeSpec) : null;

    const results: string[] = [];

    const runExec = async (displayPath: string) => {
      if (!execArgs || !ctx.shell) return;
      const cmdLine = execArgs.map(a => a === '{}' ? displayPath : a).join(' ');
      let out = '';
      let err = '';
      await ctx.shell.execute(
        cmdLine,
        (s: string) => { out += s; },
        (s: string) => { err += s; },
      );
      if (out) ctx.stdout = (ctx.stdout || '') + out;
      if (err) ctx.stderr = (ctx.stderr || '') + err;
    };

    const walk = async (dir: string, depth: number) => {
      if (depth > maxDepth) return;

      // Check the directory itself
      const dirName = dir.split('/').pop() || '';
      if (depth > 0 || searchDir !== '.') {
        if (depth >= minDepth) {
          const dirStat = await ctx.fs.stat(dir);
          const displayPath = formatPath(dir, resolved, searchDir);
          if (matchesFilters(dirName, displayPath, dirStat, nameRegex, inameRegex, pathRegex, typeFilter, true, sizeFilter)) {
            if (execArgs) {
              await runExec(displayPath);
            } else {
              results.push(displayPath);
            }
          }
        }
      }

      try {
        const entries = await ctx.fs.readdir(dir);
        for (const entry of entries) {
          if (entry === '.git' || entry === 'node_modules') continue;
          const childPath = dir === '/' ? '/' + entry : dir + '/' + entry;
          const stat = await ctx.fs.stat(childPath);
          const displayPath = formatPath(childPath, resolved, searchDir);

          if (stat.isDirectory()) {
            if (depth + 1 >= minDepth) {
              if (matchesFilters(entry, displayPath, stat, nameRegex, inameRegex, pathRegex, typeFilter, true, sizeFilter)) {
                if (execArgs) {
                  await runExec(displayPath);
                } else {
                  results.push(displayPath);
                }
              }
            }
            await walk(childPath, depth + 1);
          } else {
            if (depth + 1 >= minDepth) {
              if (matchesFilters(entry, displayPath, stat, nameRegex, inameRegex, pathRegex, typeFilter, false, sizeFilter)) {
                if (execArgs) {
                  await runExec(displayPath);
                } else {
                  results.push(displayPath);
                }
              }
            }
          }
        }
      } catch {
        // Permission denied or not a directory
      }
    };

    await walk(resolved, 0);

    if (!execArgs && results.length > 0) {
      const sep = print0 ? '\0' : '\n';
      ctx.stdout = (ctx.stdout || '') + results.join(sep) + (print0 ? '\0' : '\n');
    }
    return 0;
  },
};

function matchesFilters(
  name: string,
  fullDisplayPath: string,
  stat: any,
  nameRegex: RegExp | null,
  inameRegex: RegExp | null,
  pathRegex: RegExp | null,
  typeFilter: string,
  isDir: boolean,
  sizeFilter: ((size: number) => boolean) | null,
): boolean {
  if (typeFilter === 'f' && isDir) return false;
  if (typeFilter === 'd' && !isDir) return false;
  if (nameRegex && !nameRegex.test(name)) return false;
  if (inameRegex && !inameRegex.test(name)) return false;
  if (pathRegex && !pathRegex.test(fullDisplayPath)) return false;
  if (sizeFilter && !sizeFilter(stat.size ?? 0)) return false;
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

function globToRegex(pattern: string, caseInsensitive: boolean): RegExp {
  let regex = '^';
  for (const ch of pattern) {
    if (ch === '*') regex += '.*';
    else if (ch === '?') regex += '.';
    else if (/[.+^${}()|[\]\\]/.test(ch)) regex += '\\' + ch;
    else regex += ch;
  }
  regex += '$';
  return new RegExp(regex, caseInsensitive ? 'i' : '');
}

function parseSizeSpec(spec: string): (size: number) => boolean {
  const m = spec.match(/^([+-]?)(\d+)([ckMG]?)$/);
  if (!m) return () => true;
  const [, prefix, numStr, unit] = m;
  let bytes = parseInt(numStr, 10);
  switch (unit) {
    case 'c': break; // bytes
    case 'k': bytes *= 1024; break;
    case 'M': bytes *= 1024 * 1024; break;
    case 'G': bytes *= 1024 * 1024 * 1024; break;
    default: bytes *= 512; break; // 512-byte blocks (default)
  }
  if (prefix === '+') return (s) => s > bytes;
  if (prefix === '-') return (s) => s < bytes;
  return (s) => s === bytes;
}
