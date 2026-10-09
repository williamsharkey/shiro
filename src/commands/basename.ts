import type { Command } from './index';

/** GNU basename: last component, trailing slashes removed; SUFFIX removed unless it is the whole name */
function gnuBasename(path: string, suffix?: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  if (end === 1 && path[0] === '/') return '/';
  let start = end;
  while (start > 0 && path[start - 1] !== '/') start--;
  let name = path.slice(start, end);
  if (suffix && name.length > suffix.length && name.endsWith(suffix)) name = name.slice(0, -suffix.length);
  return name;
}

export const basename: Command = {
  name: "basename",
  description: "Strip directory and suffix from filenames",
  async exec(ctx) {
    const args = ctx.args;
    let multiple = false;
    let suffix: string | undefined;
    let zero = false;
    const names: string[] = [];
    let opts = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (opts && a === '--') { opts = false; continue; }
      if (opts && a.startsWith('--') && a.length > 2) {
        if (a === '--multiple') multiple = true;
        else if (a === '--zero') zero = true;
        else if (a.startsWith('--suffix=')) { suffix = a.slice(9); multiple = true; }
        else if (a === '--suffix' && i + 1 < args.length) { suffix = args[++i]; multiple = true; }
        else {
          ctx.stderr += `basename: unrecognized option '${a}'\nTry 'basename --help' for more information.\n`;
          return 1;
        }
        continue;
      }
      if (opts && a.startsWith('-') && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (c === 'a') multiple = true;
          else if (c === 'z') zero = true;
          else if (c === 's') {
            const rest = a.slice(j + 1);
            if (rest) suffix = rest;
            else if (i + 1 < args.length) suffix = args[++i];
            else {
              ctx.stderr += `basename: option requires an argument -- 's'\nTry 'basename --help' for more information.\n`;
              return 1;
            }
            multiple = true;
            break;
          } else {
            ctx.stderr += `basename: invalid option -- '${c}'\nTry 'basename --help' for more information.\n`;
            return 1;
          }
        }
        continue;
      }
      names.push(a);
    }
    if (names.length === 0) {
      ctx.stderr += "basename: missing operand\nTry 'basename --help' for more information.\n";
      return 1;
    }
    const end = zero ? '\0' : '\n';
    if (!multiple) {
      if (names.length > 2) {
        ctx.stderr += `basename: extra operand '${names[2]}'\nTry 'basename --help' for more information.\n`;
        return 1;
      }
      ctx.stdout += gnuBasename(names[0], names[1]) + end;
      return 0;
    }
    for (const n of names) ctx.stdout += gnuBasename(n, suffix) + end;
    return 0;
  },
};
