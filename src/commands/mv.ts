import type { Command, CommandContext } from './index';

/**
 * mv — GNU coreutils-compatible: -f -i -n -u -v -b/-S -t -T, moving into a
 * directory, refusing to move a directory into itself, and replacing an
 * existing empty directory with a directory.
 */

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function baseName(p: string): string {
  const s = p.replace(/\/+$/, '');
  if (s === '') return '/';
  return s.slice(s.lastIndexOf('/') + 1);
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

async function tryLstat(ctx: CommandContext, abs: string): Promise<any | null> {
  try { return await ctx.fs.lstat(abs); } catch { return null; }
}
async function tryStat(ctx: CommandContext, abs: string): Promise<any | null> {
  try { return await ctx.fs.stat(abs); } catch { return null; }
}

function errText(e: any): string {
  const m = String(e?.message ?? e);
  if (/ENOENT/.test(m)) return 'No such file or directory';
  if (/EEXIST/.test(m)) return 'File exists';
  if (/ENOTDIR/.test(m)) return 'Not a directory';
  if (/EISDIR/.test(m)) return 'Is a directory';
  if (/ENOTEMPTY/.test(m)) return 'Directory not empty';
  if (/EACCES|EPERM/.test(m)) return 'Permission denied';
  return m;
}

export const mv: Command = {
  name: "mv",
  description: "Move or rename files",
  async exec(ctx) {
    const args = ctx.args;
    let force = false, interactive = false, noClobber = false, update = false, verbose = false;
    let backup = false, suffix = '~', noTargetDir = false;
    let targetDir: string | null = null;
    const operands: string[] = [];
    const usage = (msg: string) => { ctx.stderr += `mv: ${msg}\nTry 'mv --help' for more information.\n`; return 1; };
    let opts = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!opts || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
      if (a === '--') { opts = false; continue; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = eq >= 0 ? a.slice(eq + 1) : undefined;
        switch (name) {
          case 'force': force = true; interactive = noClobber = false; break;
          case 'interactive': interactive = true; force = noClobber = false; break;
          case 'no-clobber': noClobber = true; force = interactive = false; break;
          case 'update': if (val === 'none') noClobber = true; else if (val !== 'all') update = true; break;
          case 'verbose': verbose = true; break;
          case 'backup': backup = true; break;
          case 'suffix': suffix = val ?? args[++i] ?? '~'; backup = true; break;
          case 'target-directory': targetDir = val ?? args[++i] ?? null; if (targetDir === null) return usage(`option '--target-directory' requires an argument`); break;
          case 'no-target-directory': noTargetDir = true; break;
          case 'strip-trailing-slashes': case 'no-copy': case 'context': case 'debug': case 'exchange': break;
          default: return usage(`unrecognized option '${a}'`);
        }
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        switch (c) {
          case 'f': force = true; interactive = noClobber = false; break;
          case 'i': interactive = true; force = noClobber = false; break;
          case 'n': noClobber = true; force = interactive = false; break;
          case 'u': update = true; break;
          case 'v': verbose = true; break;
          case 'b': backup = true; break;
          case 'T': noTargetDir = true; break;
          case 'Z': break;
          case 'S': case 't': {
            const v = a.slice(j + 1) || args[++i];
            if (v === undefined) return usage(`option requires an argument -- '${c}'`);
            if (c === 't') targetDir = v; else { suffix = v; backup = true; }
            j = a.length;
            break;
          }
          default: return usage(`invalid option -- '${c}'`);
        }
      }
    }
    void force;

    let sources: string[];
    let dest: string;
    let destIsDir: boolean;
    if (targetDir !== null) {
      if (noTargetDir) return usage('cannot combine --target-directory (-t) and --no-target-directory (-T)');
      sources = operands;
      dest = targetDir;
      const st = await tryStat(ctx, ctx.fs.resolvePath(dest, ctx.cwd));
      if (!st) { ctx.stderr += `mv: target directory ${q(dest)}: No such file or directory\n`; return 1; }
      if (!st.isDirectory()) { ctx.stderr += `mv: target directory ${q(dest)}: Not a directory\n`; return 1; }
      if (!sources.length) return usage('missing file operand');
      destIsDir = true;
    } else {
      if (operands.length === 0) return usage('missing file operand');
      if (operands.length === 1) return usage(`missing destination file operand after ${q(operands[0])}`);
      dest = operands[operands.length - 1];
      sources = operands.slice(0, -1);
      const st = await tryStat(ctx, ctx.fs.resolvePath(dest, ctx.cwd));
      if (noTargetDir) {
        if (sources.length > 1) return usage(`extra operand ${q(operands[2])}`);
        destIsDir = false;
      } else {
        destIsDir = !!st && st.isDirectory();
        if (sources.length > 1 && !destIsDir) {
          ctx.stderr += st ? `mv: target ${q(dest)} is not a directory\n` : `mv: target ${q(dest)}: No such file or directory\n`;
          return 1;
        }
      }
    }

    const fs = ctx.fs;
    let status = 0;
    let stdinPos = 0;
    const err = (msg: string) => { ctx.stderr += `mv: ${msg}\n`; status = 1; };
    const ask = (prompt: string): boolean => {
      ctx.stderr += prompt;
      const rest = (ctx.stdin || '').slice(stdinPos);
      const nl = rest.indexOf('\n');
      const ans = nl < 0 ? rest : rest.slice(0, nl);
      stdinPos += nl < 0 ? rest.length : nl + 1;
      return /^\s*[yY]/.test(ans);
    };

    for (const src of sources) {
      const srcAbs = fs.resolvePath(src, ctx.cwd);
      const dstName = destIsDir ? joinPath(dest, baseName(src)) : dest;
      const dstAbs = fs.resolvePath(dstName, ctx.cwd);
      const st = await tryLstat(ctx, srcAbs);
      if (!st) { err(`cannot stat ${q(src)}: No such file or directory`); continue; }
      if (srcAbs === '/' ) { err(`cannot move ${q(src)} to ${q(dstName)}: Device or resource busy`); continue; }
      const dst = await tryLstat(ctx, dstAbs);
      if (dst) {
        const sReal = st.isSymbolicLink() ? srcAbs : await fs.realpath(srcAbs).catch(() => srcAbs);
        const dReal = dst.isSymbolicLink() ? dstAbs : await fs.realpath(dstAbs).catch(() => dstAbs);
        if (sReal === dReal) {
          err(`${q(src)} and ${q(dstName)} are the same file`);
          continue;
        }
      }
      if (st.isDirectory()) {
        const srcReal = await fs.realpath(srcAbs).catch(() => srcAbs);
        const parentReal = await fs.realpath(dstAbs.slice(0, dstAbs.lastIndexOf('/')) || '/').catch(() => '');
        const dstReal = joinPath(parentReal, baseName(dstAbs));
        if (dstReal.startsWith(srcReal === '/' ? '/' : srcReal + '/')) {
          err(`cannot move ${q(src)} to a subdirectory of itself, ${q(dstName)}`);
          continue;
        }
      }
      if (dst) {
        if (noClobber) continue;
        if (update && !dst.isDirectory() && dst.mtime && st.mtime && dst.mtime.getTime() >= st.mtime.getTime()) continue;
        if (interactive && !ask(`mv: overwrite ${q(dstName)}? `)) continue;
        if (dst.isDirectory()) {
          if (!st.isDirectory()) { err(`cannot overwrite directory ${q(dstName)} with non-directory`); continue; }
          let entries: string[] = [];
          try { entries = await fs.readdir(dstAbs); } catch {}
          if (entries.length) { err(`cannot overwrite ${q(dstName)}: Directory not empty`); continue; }
          try { await fs.rmdir(dstAbs); } catch (e: any) { err(`cannot move ${q(src)} to ${q(dstName)}: ${errText(e)}`); continue; }
        } else {
          if (st.isDirectory()) { err(`cannot overwrite non-directory ${q(dstName)} with directory ${q(src)}`); continue; }
          try {
            if (backup) await fs.rename(dstAbs, dstAbs + suffix);
            else await fs.unlink(dstAbs);
          } catch (e: any) { err(`cannot move ${q(src)} to ${q(dstName)}: ${errText(e)}`); continue; }
        }
      }
      const parent = dstAbs.slice(0, dstAbs.lastIndexOf('/')) || '/';
      const pst = await tryStat(ctx, parent);
      if (!pst) { err(`cannot move ${q(src)} to ${q(dstName)}: No such file or directory`); continue; }
      if (!pst.isDirectory()) { err(`cannot move ${q(src)} to ${q(dstName)}: Not a directory`); continue; }
      try {
        await fs.rename(srcAbs, dstAbs);
      } catch (e: any) {
        err(`cannot move ${q(src)} to ${q(dstName)}: ${errText(e)}`);
        continue;
      }
      if (verbose) ctx.stdout += `renamed ${q(src)} -> ${q(dstName)}\n`;
    }
    return status;
  },
};
