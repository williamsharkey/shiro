/**
 * readlink [-f|-e|-m] [-n] [-z] [-q|-s] [-v] FILE... (GNU coreutils).
 * Without -f/-e/-m: a symlink's target. -f: the canonical path, every
 * component but the last must exist; -e: all must exist; -m: none need to.
 */
import type { Command, CommandContext } from './index';

async function exists(ctx: CommandContext, p: string): Promise<boolean> {
  return ctx.fs.lstat(p).then(() => true, () => false);
}

/** Canonical form of the absolute path `p`; `missing` is how many trailing components may be missing (Infinity for -m) */
async function canonical(ctx: CommandContext, p: string, missing: number, depth = 0): Promise<string | null> {
  if (depth > 40) return null; // a symlink loop
  const parts = p.split('/').filter(Boolean);
  let cur = '/';
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (part === '.') continue;
    if (part === '..') { cur = cur.slice(0, cur.lastIndexOf('/')) || '/'; continue; }
    const next = cur === '/' ? `/${part}` : `${cur}/${part}`;
    const st = await ctx.fs.lstat(next).catch(() => null);
    if (!st) {
      // Missing: allowed only for the last `missing` components
      if (parts.length - k > missing) return null;
      cur = next;
      continue;
    }
    if (st.isSymbolicLink()) {
      const target = await ctx.fs.readlink(next);
      const rest = parts.slice(k + 1).join('/');
      const base = target.startsWith('/') ? target : `${cur}/${target}`;
      return canonical(ctx, rest ? `${base}/${rest}` : base, missing, depth + 1);
    }
    if (k < parts.length - 1 && !st.isDirectory()) return null; // a file in the middle
    cur = next;
  }
  return cur;
}

export const readlink: Command = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(ctx) {
    let mode: 'f' | 'e' | 'm' | '' = '';
    let noNewline = false, zero = false, verbose = false;
    const files: string[] = [];
    let opts = true;
    for (const a of ctx.args) {
      if (opts && a === '--') { opts = false; continue; }
      if (opts && a.startsWith('--')) {
        if (a === '--canonicalize') mode = 'f';
        else if (a === '--canonicalize-existing') mode = 'e';
        else if (a === '--canonicalize-missing') mode = 'm';
        else if (a === '--no-newline') noNewline = true;
        else if (a === '--zero') zero = true;
        else if (a === '--verbose') verbose = true;
        else if (a === '--quiet' || a === '--silent') verbose = false;
        else { ctx.stderr += `readlink: unrecognized option '${a}'\n`; return 1; }
        continue;
      }
      if (opts && a.length > 1 && a[0] === '-') {
        for (const c of a.slice(1)) {
          if (c === 'f' || c === 'e' || c === 'm') mode = c;
          else if (c === 'n') noNewline = true;
          else if (c === 'z') zero = true;
          else if (c === 'v') verbose = true;
          else if (c === 'q' || c === 's') verbose = false;
          else { ctx.stderr += `readlink: invalid option -- '${c}'\n`; return 1; }
        }
        continue;
      }
      files.push(a);
    }
    if (files.length === 0) { ctx.stderr += "readlink: missing operand\n"; return 1; }
    // -n only applies to a single operand
    const end = zero ? '\0' : noNewline && files.length === 1 ? '' : '\n';
    let rc = 0;
    for (const f of files) {
      const resolved = ctx.fs.resolvePath(f, ctx.cwd);
      if (mode) {
        const out = await canonical(ctx, resolved, mode === 'e' ? 0 : mode === 'f' ? 1 : Infinity);
        if (out === null || (mode === 'e' && !(await exists(ctx, out)))) {
          if (verbose) ctx.stderr += `readlink: ${f}: No such file or directory\n`;
          rc = 1;
          continue;
        }
        ctx.stdout += out + end;
        continue;
      }
      try {
        ctx.stdout += (await ctx.fs.readlink(resolved)) + end;
      } catch {
        if (verbose) ctx.stderr += `readlink: ${f}: Invalid argument\n`;
        rc = 1;
      }
    }
    return rc;
  },
};
