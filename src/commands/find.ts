import { Command, CommandContext } from './index';

type Predicate =
  | { type: 'name'; re: RegExp }
  | { type: 'iname'; re: RegExp }
  | { type: 'path'; re: RegExp }
  | { type: 'type'; filter: string }
  | { type: 'size'; fn: (size: number) => boolean }
  | { type: 'empty' }
  | { type: 'mtime'; days: number; sign: string }
  | { type: 'not'; pred: Predicate }
  | { type: 'and'; left: Predicate; right: Predicate }
  | { type: 'or'; left: Predicate; right: Predicate }
  | { type: 'true' };

function evalPredicate(pred: Predicate, name: string, fullPath: string, stat: any, isDir: boolean): boolean {
  switch (pred.type) {
    case 'name': return pred.re.test(name);
    case 'iname': return pred.re.test(name);
    case 'path': return pred.re.test(fullPath);
    case 'type': return pred.filter === 'f' ? !isDir : pred.filter === 'd' ? isDir : true;
    case 'size': return pred.fn(stat.size ?? 0);
    case 'empty': return isDir ? false : (stat.size ?? 0) === 0;
    case 'mtime': {
      const now = Date.now();
      const mtime = stat.mtime ?? now;
      const diffDays = (now - mtime) / (1000 * 60 * 60 * 24);
      if (pred.sign === '+') return diffDays > Math.abs(pred.days);
      if (pred.sign === '-') return diffDays < Math.abs(pred.days);
      return Math.floor(diffDays) === Math.abs(pred.days);
    }
    case 'not': return !evalPredicate(pred.pred, name, fullPath, stat, isDir);
    case 'and': return evalPredicate(pred.left, name, fullPath, stat, isDir) && evalPredicate(pred.right, name, fullPath, stat, isDir);
    case 'or': return evalPredicate(pred.left, name, fullPath, stat, isDir) || evalPredicate(pred.right, name, fullPath, stat, isDir);
    case 'true': return true;
  }
}

export const findCmd: Command = {
  name: 'find',
  description: 'Search for files in a directory hierarchy',
  async exec(ctx: CommandContext) {
    let searchDir = '.';
    let maxDepth = Infinity;
    let minDepth = 0;
    let print0 = false;
    let execArgs: string[] | null = null;
    let doDelete = false;
    let prune = false;
    const predicates: Predicate[] = [];
    const operators: string[] = []; // 'and', 'or'

    let i = 0;
    // First non-flag argument is the directory
    if (ctx.args.length > 0 && !ctx.args[0].startsWith('-') && ctx.args[0] !== '!' && ctx.args[0] !== '(') {
      searchDir = ctx.args[0];
      i = 1;
    }

    // Parse expression tree
    while (i < ctx.args.length) {
      const arg = ctx.args[i];

      if (arg === '-name' && ctx.args[i + 1]) {
        predicates.push({ type: 'name', re: globToRegex(ctx.args[++i], false) });
      } else if (arg === '-iname' && ctx.args[i + 1]) {
        predicates.push({ type: 'iname', re: globToRegex(ctx.args[++i], true) });
      } else if (arg === '-path' && ctx.args[i + 1]) {
        predicates.push({ type: 'path', re: globToRegex(ctx.args[++i], false) });
      } else if (arg === '-type' && ctx.args[i + 1]) {
        predicates.push({ type: 'type', filter: ctx.args[++i] });
      } else if (arg === '-maxdepth' && ctx.args[i + 1]) {
        maxDepth = parseInt(ctx.args[++i]);
      } else if (arg === '-mindepth' && ctx.args[i + 1]) {
        minDepth = parseInt(ctx.args[++i]);
      } else if (arg === '-size' && ctx.args[i + 1]) {
        predicates.push({ type: 'size', fn: parseSizeSpec(ctx.args[++i]) });
      } else if (arg === '-empty') {
        predicates.push({ type: 'empty' });
      } else if (arg === '-mtime' && ctx.args[i + 1]) {
        const spec = ctx.args[++i];
        const sign = spec.startsWith('+') ? '+' : spec.startsWith('-') ? '-' : '';
        const days = parseInt(spec.replace(/^[+-]/, ''), 10) || 0;
        predicates.push({ type: 'mtime', days, sign });
      } else if (arg === '-print0') {
        print0 = true;
      } else if (arg === '-delete') {
        doDelete = true;
      } else if (arg === '-prune') {
        prune = true;
      } else if (arg === '!' || arg === '-not') {
        operators.push('not');
      } else if (arg === '-o' || arg === '-or') {
        operators.push('or');
      } else if (arg === '-a' || arg === '-and') {
        operators.push('and');
      } else if (arg === '-exec') {
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

    // Build expression tree
    let expr: Predicate = { type: 'true' };
    if (predicates.length > 0) {
      // Apply NOT operators (they're prefix)
      const processedPreds: Predicate[] = [];
      let j = 0;
      let pendingNot = false;
      for (const pred of predicates) {
        if (pendingNot) {
          processedPreds.push({ type: 'not', pred });
          pendingNot = false;
        } else {
          processedPreds.push(pred);
        }
      }

      // Check for NOT in operators
      const finalPreds: Predicate[] = [];
      let opIdx = 0;
      for (let k = 0; k < predicates.length; k++) {
        // Check if there's a 'not' operator before this predicate
        if (opIdx < operators.length && operators[opIdx] === 'not') {
          finalPreds.push({ type: 'not', pred: predicates[k] });
          opIdx++;
        } else {
          finalPreds.push(predicates[k]);
          // Consume 'and' or 'or' operators between predicates
          if (opIdx < operators.length && (operators[opIdx] === 'and' || operators[opIdx] === 'or')) {
            opIdx++;
          }
        }
      }

      // Combine with OR operators first, then AND
      if (operators.includes('or')) {
        // Build OR tree
        let orGroups: Predicate[][] = [[]];
        let predIdx = 0;
        let opI = 0;
        for (const pred of finalPreds) {
          orGroups[orGroups.length - 1].push(pred);
          if (opI < operators.length) {
            if (operators[opI] === 'or') {
              orGroups.push([]);
            }
            if (operators[opI] !== 'not') opI++;
          }
        }
        // Each group is ANDed, groups are ORed
        const andGroups = orGroups.map(group => {
          if (group.length === 0) return { type: 'true' } as Predicate;
          return group.reduce((acc, p) => ({ type: 'and', left: acc, right: p }) as Predicate);
        });
        expr = andGroups.reduce((acc, p) => ({ type: 'or', left: acc, right: p }) as Predicate);
      } else {
        // All AND (implicit or explicit)
        expr = finalPreds.reduce((acc, p) => ({ type: 'and', left: acc, right: p }) as Predicate);
      }
    }

    const resolved = ctx.fs.resolvePath(searchDir, ctx.cwd);
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

    const walk = async (dir: string, depth: number): Promise<boolean> => {
      if (depth > maxDepth) return false;

      try {
        const entries = await ctx.fs.readdir(dir);
        for (const entry of entries) {
          if (entry === '.git' || entry === 'node_modules') continue;
          const childPath = dir === '/' ? '/' + entry : dir + '/' + entry;
          const stat = await ctx.fs.stat(childPath);
          const displayPath = formatPath(childPath, resolved, searchDir);
          const isDir = stat.isDirectory();

          if (depth + 1 >= minDepth) {
            const matches = evalPredicate(expr, entry, displayPath, stat, isDir);

            if (matches) {
              if (prune && isDir) {
                // Don't output, don't descend
                if (!doDelete) results.push(displayPath);
                continue;
              }
              if (doDelete) {
                try {
                  if (isDir) {
                    await ctx.fs.rmdir(childPath);
                  } else {
                    await ctx.fs.unlink(childPath);
                  }
                } catch {}
              } else if (execArgs) {
                await runExec(displayPath);
              } else {
                results.push(displayPath);
              }
            }
          }

          if (isDir && depth + 1 <= maxDepth) {
            await walk(childPath, depth + 1);
          }
        }
      } catch {
        // Permission denied or not a directory
      }
      return true;
    };

    // Check the search directory itself
    if (minDepth === 0) {
      const stat = await ctx.fs.stat(resolved);
      const displayPath = formatPath(resolved, resolved, searchDir);
      const isDir = stat.isDirectory();
      if (predicates.length === 0 || evalPredicate(expr, resolved.split('/').pop() || '', displayPath, stat, isDir)) {
        if (!doDelete && !execArgs) results.push(displayPath);
        else if (execArgs) await runExec(displayPath);
      }
    }

    await walk(resolved, 0);

    if (!execArgs && !doDelete && results.length > 0) {
      const sep = print0 ? '\0' : '\n';
      ctx.stdout = (ctx.stdout || '') + results.join(sep) + (print0 ? '\0' : '\n');
    }
    return 0;
  },
};

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
    case 'c': break;
    case 'k': bytes *= 1024; break;
    case 'M': bytes *= 1024 * 1024; break;
    case 'G': bytes *= 1024 * 1024 * 1024; break;
    default: bytes *= 512; break;
  }
  if (prefix === '+') return (s) => s > bytes;
  if (prefix === '-') return (s) => s < bytes;
  return (s) => s === bytes;
}
