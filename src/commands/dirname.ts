import type { Command } from './index';

/** GNU dirname: the NAME with its last non-slash component and trailing slashes removed */
export function gnuDirname(path: string): string {
  let end = path.length;
  // trailing slashes
  while (end > 1 && path[end - 1] === '/') end--;
  // last component
  while (end > 0 && path[end - 1] !== '/') end--;
  if (end === 0) return path[0] === '/' ? '/' : '.';
  // slashes before it
  while (end > 1 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

export const dirname: Command = {
  name: "dirname",
  description: "Strip last component from file name",
  async exec(ctx) {
    let zero = false;
    const names: string[] = [];
    let opts = true;
    for (const a of ctx.args) {
      if (opts && a === '--') { opts = false; continue; }
      if (opts && (a === '-z' || a === '--zero')) { zero = true; continue; }
      if (opts && a.startsWith('-') && a !== '-') {
        ctx.stderr += `dirname: invalid option -- '${a.replace(/^-+/, '')}'\nTry 'dirname --help' for more information.\n`;
        return 1;
      }
      names.push(a);
    }
    if (names.length === 0) {
      ctx.stderr += "dirname: missing operand\nTry 'dirname --help' for more information.\n";
      return 1;
    }
    for (const n of names) ctx.stdout += gnuDirname(n) + (zero ? '\0' : '\n');
    return 0;
  },
};
