import type { Command } from './index';
import { physicalPath } from './shell-builtins';

/** pwd [-L|-P]: the logical directory cd went to (symlinks kept), or the physical one */
export const pwd: Command = {
  name: "pwd",
  description: "Print working directory",
  async exec(ctx) {
    let physical = false;
    for (const a of ctx.args) {
      if (a === '-P') physical = true;
      else if (a === '-L') physical = false;
      else if (a === '--') break;
      else if (a.startsWith('-')) { ctx.stderr += `pwd: ${a}: invalid option\n`; return 2; }
    }
    if (physical) { ctx.stdout += await physicalPath(ctx.fs, ctx.cwd) + "\n"; return 0; }
    // The logical directory cd went to, while it is still where we are
    const logical = ctx.shell?.logicalPwd;
    let out = ctx.cwd;
    if (logical && logical !== ctx.cwd && await physicalPath(ctx.fs, logical).catch(() => null) === ctx.cwd) out = logical;
    ctx.stdout += out + "\n";
    return 0;
  },
};
