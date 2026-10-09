import type { Command, CommandContext } from './index';

/**
 * realpath — GNU coreutils-compatible.
 *   -e  all components must exist      -m  no component needs to exist
 *   (default) all but the last must exist
 *   -s/--strip/--no-symlinks  don't expand symlinks    -L  resolve '..' before symlinks
 *   -q  quiet   -z  NUL-terminated   --relative-to=DIR  --relative-base=DIR
 */

type Mode = 'e' | 'E' | 'm';

class PathError extends Error {}

function normalize(abs: string): string {
  const out: string[] = [];
  for (const c of abs.split('/')) {
    if (c === '' || c === '.') continue;
    if (c === '..') out.pop(); else out.push(c);
  }
  return '/' + out.join('/');
}

/** canonicalize_filename_mode() */
async function canonicalize(ctx: CommandContext, path: string, mode: Mode, symlinks: boolean, logical: boolean): Promise<string> {
  let abs = path.startsWith('/') ? path : (ctx.cwd.replace(/\/+$/, '') + '/' + path);
  if (logical) abs = normalize(abs);
  let todo = abs.split('/').filter((c) => c !== '');
  const resolved: string[] = [];
  let links = 0;
  let missing = false; // a component did not exist (-m): stop looking things up
  while (todo.length) {
    const c = todo.shift()!;
    if (c === '.') continue;
    if (c === '..') { resolved.pop(); continue; }
    const cand = '/' + [...resolved, c].join('/');
    const rest = todo.some((t) => t !== '.' && t !== '');
    if (missing) { resolved.push(c); continue; }
    let st: any = null;
    // With -s links stay unexpanded but are still looked through
    try { st = symlinks ? await ctx.fs.lstat(cand) : await ctx.fs.stat(cand); } catch { st = null; }
    if (!st) {
      if (mode === 'e' || (mode === 'E' && rest)) throw new PathError('No such file or directory');
      if (mode === 'm') missing = true;
      resolved.push(c);
      continue;
    }
    if (symlinks && st.isSymbolicLink()) {
      if (++links > 40) throw new PathError('Too many levels of symbolic links');
      const target = await ctx.fs.readlink(cand);
      const parts = target.split('/').filter((t) => t !== '');
      if (target.startsWith('/')) resolved.length = 0;
      todo = [...parts, ...todo];
      continue;
    }
    if (!st.isDirectory() && rest && mode !== 'm') throw new PathError('Not a directory');
    resolved.push(c);
  }
  return '/' + resolved.join('/');
}

function relativeTo(path: string, base: string): string {
  const a = path.split('/').filter(Boolean);
  const b = base.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = b.slice(i).map(() => '..');
  const rel = [...up, ...a.slice(i)].join('/');
  return rel || '.';
}

export const realpath: Command = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(ctx) {
    const args = ctx.args;
    let mode: Mode = 'E';
    let symlinks = true;
    let logical = false;
    let quiet = false;
    let zero = false;
    let relTo: string | null = null;
    let relBase: string | null = null;
    const names: string[] = [];
    let opts = true;
    const bad = (msg: string) => { ctx.stderr += `realpath: ${msg}\nTry 'realpath --help' for more information.\n`; return 1; };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (opts && a === '--') { opts = false; continue; }
      if (opts && a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = () => (eq >= 0 ? a.slice(eq + 1) : args[++i]);
        switch (name) {
          case 'canonicalize-existing': mode = 'e'; break;
          case 'canonicalize-missing': mode = 'm'; break;
          case 'logical': logical = true; break;
          case 'physical': logical = false; break;
          case 'quiet': quiet = true; break;
          case 'strip': case 'no-symlinks': symlinks = false; break;
          case 'zero': zero = true; break;
          case 'relative-to': relTo = val(); if (relTo === undefined) return bad(`option '--relative-to' requires an argument`); break;
          case 'relative-base': relBase = val(); if (relBase === undefined) return bad(`option '--relative-base' requires an argument`); break;
          default: return bad(`unrecognized option '${a}'`);
        }
        continue;
      }
      if (opts && a.startsWith('-') && a.length > 1) {
        for (const c of a.slice(1)) {
          if (c === 'e') mode = 'e';
          else if (c === 'm') mode = 'm';
          else if (c === 'L') logical = true;
          else if (c === 'P') logical = false;
          else if (c === 'q') quiet = true;
          else if (c === 's') symlinks = false;
          else if (c === 'z') zero = true;
          else return bad(`invalid option -- '${c}'`);
        }
        continue;
      }
      names.push(a);
    }
    if (names.length === 0) return bad('missing operand');

    let status = 0;
    const canon = async (p: string) => canonicalize(ctx, p, mode, symlinks, logical);
    let relToAbs: string | null = null;
    let relBaseAbs: string | null = null;
    try {
      if (relTo !== null) relToAbs = await canon(relTo);
      if (relBase !== null) relBaseAbs = await canon(relBase);
    } catch (e: any) {
      ctx.stderr += `realpath: ${relTo !== null && relToAbs === null ? relTo : relBase}: ${e.message}\n`;
      return 1;
    }
    if (relToAbs !== null && relBaseAbs !== null && !(relToAbs + '/').startsWith(relBaseAbs === '/' ? '/' : relBaseAbs + '/')) {
      relToAbs = null; // GNU: relative-to outside relative-base disables both
      relBaseAbs = null;
    }
    const within = (p: string, base: string) => base === '/' || p === base || p.startsWith(base + '/');
    for (const n of names) {
      if (n === '') {
        if (!quiet) ctx.stderr += `realpath: '': No such file or directory\n`;
        status = 1;
        continue;
      }
      try {
        let r = await canon(n);
        if (relToAbs !== null || relBaseAbs !== null) {
          const base = relToAbs ?? relBaseAbs!;
          if (relBaseAbs === null || (within(r, relBaseAbs))) r = relativeTo(r, base);
        }
        ctx.stdout += r + (zero ? '\0' : '\n');
      } catch (e: any) {
        if (!quiet) ctx.stderr += `realpath: ${n}: ${e.message}\n`;
        status = 1;
      }
    }
    return status;
  },
};
