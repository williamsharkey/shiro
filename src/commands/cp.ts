import type { Command, CommandContext } from './index';

/**
 * cp — GNU coreutils-compatible.
 *
 * Copies bytes (binary-safe) and the source's permission bits. Symlinks:
 * followed by default without -R, copied as links with -R/-d/-P/-a, -L
 * follows all, -H only command-line ones. Supports -a -d -f -i -n -l -s -p
 * --preserve -r/-R -t -T -u -v --parents --remove-destination -b.
 * The filesystem has no hard links, so -l (and preserving links) copies.
 */

interface Opts {
  recursive: boolean;
  deref: 'never' | 'always' | 'cmdline' | 'default';
  force: boolean;
  interactive: boolean;
  noClobber: boolean;
  link: boolean;
  symbolic: boolean;
  preserveMode: boolean;
  preserveTime: boolean;
  /** -a, -d, --preserve=links: names of one file copied together stay one file */
  preserveLinks: boolean;
  update: boolean;
  verbose: boolean;
  parents: boolean;
  removeDest: boolean;
  backup: boolean;
  suffix: string;
  noTargetDir: boolean;
  targetDir: string | null;
  attributesOnly: boolean;
}

const UMASK = 0o022;

function q(s: string): string {
  // GNU quotes names with shell-escape style; plain names get '…'
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

export const cp: Command = {
  name: "cp",
  description: "Copy files and directories",
  async exec(ctx) {
    const o: Opts = {
      recursive: false, deref: 'default', force: false, interactive: false, noClobber: false,
      link: false, symbolic: false, preserveMode: false, preserveTime: false, preserveLinks: false, update: false,
      verbose: false, parents: false, removeDest: false, backup: false, suffix: '~',
      noTargetDir: false, targetDir: null, attributesOnly: false,
    };
    const args = ctx.args;
    const operands: string[] = [];
    const usage = (msg: string) => { ctx.stderr += `cp: ${msg}\nTry 'cp --help' for more information.\n`; return 1; };
    /** --preserve=links: the copy made of each multiply-linked source inode */
    const copiedInodes = new Map<number, string>();
    const preserve = (list: string, on: boolean) => {
      for (const it of list.split(',')) {
        if (it === 'mode' || it === 'all') o.preserveMode = on;
        if (it === 'timestamps' || it === 'all') o.preserveTime = on;
        if (it === 'links' || it === 'all') o.preserveLinks = on;
      }
    };
    let opts = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!opts || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
      if (a === '--') { opts = false; continue; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = eq >= 0 ? a.slice(eq + 1) : undefined;
        const need = () => (val !== undefined ? val : args[++i]);
        switch (name) {
          case 'archive': o.recursive = true; o.deref = 'never'; o.preserveMode = o.preserveTime = o.preserveLinks = true; break;
          case 'no-dereference': o.deref = 'never'; break;
          case 'dereference': o.deref = 'always'; break;
          case 'force': o.force = true; break;
          case 'interactive': o.interactive = true; o.noClobber = false; break;
          case 'no-clobber': o.noClobber = true; o.interactive = false; break;
          case 'link': o.link = true; break;
          case 'symbolic-link': o.symbolic = true; break;
          case 'preserve': preserve(val ?? 'mode,ownership,timestamps', true); break;
          case 'no-preserve': preserve(need() ?? '', false); break;
          case 'recursive': o.recursive = true; break;
          case 'target-directory': o.targetDir = need() ?? null; if (o.targetDir === null) return usage(`option '--target-directory' requires an argument`); break;
          case 'no-target-directory': o.noTargetDir = true; break;
          case 'update': o.update = val !== 'none' && val !== 'all' ? true : val === 'none' ? (o.noClobber = true, false) : false; break;
          case 'verbose': o.verbose = true; break;
          case 'parents': o.parents = true; break;
          case 'remove-destination': o.removeDest = true; break;
          case 'backup': o.backup = true; break;
          case 'suffix': o.suffix = need() ?? '~'; o.backup = true; break;
          case 'attributes-only': o.attributesOnly = true; break;
          case 'one-file-system': case 'strip-trailing-slashes': case 'debug': break;
          case 'sparse': case 'reflink': case 'context': break;
          default: return usage(`unrecognized option '${a}'`);
        }
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        switch (c) {
          case 'a': o.recursive = true; o.deref = 'never'; o.preserveMode = o.preserveTime = o.preserveLinks = true; break;
          case 'd': o.deref = 'never'; o.preserveLinks = true; break;
          case 'P': o.deref = 'never'; break;
          case 'L': o.deref = 'always'; break;
          case 'H': o.deref = 'cmdline'; break;
          case 'f': o.force = true; break;
          case 'i': o.interactive = true; o.noClobber = false; break;
          case 'n': o.noClobber = true; o.interactive = false; break;
          case 'l': o.link = true; break;
          case 's': o.symbolic = true; break;
          case 'p': o.preserveMode = o.preserveTime = true; break;
          case 'r': case 'R': o.recursive = true; break;
          case 'u': o.update = true; break;
          case 'v': o.verbose = true; break;
          case 'x': break;
          case 'b': o.backup = true; break;
          case 'T': o.noTargetDir = true; break;
          case 'S': case 't': {
            const rest = a.slice(j + 1);
            const v = rest || args[++i];
            if (v === undefined) return usage(`option requires an argument -- '${c}'`);
            if (c === 't') o.targetDir = v; else { o.suffix = v; o.backup = true; }
            j = a.length;
            break;
          }
          case 'Z': break;
          default: return usage(`invalid option -- '${c}'`);
        }
      }
    }

    // Resolve sources and destination
    let sources: string[];
    let dest: string;
    let destIsDir: boolean;
    if (o.targetDir !== null) {
      if (o.noTargetDir) return usage('cannot combine --target-directory (-t) and --no-target-directory (-T)');
      sources = operands;
      dest = o.targetDir;
      const st = await tryStat(ctx, ctx.fs.resolvePath(dest, ctx.cwd));
      if (!st) { ctx.stderr += `cp: target directory ${q(dest)}: No such file or directory\n`; return 1; }
      if (!st.isDirectory()) { ctx.stderr += `cp: target directory ${q(dest)}: Not a directory\n`; return 1; }
      destIsDir = true;
      if (!sources.length) return usage(`missing file operand`);
    } else {
      if (operands.length === 0) return usage('missing file operand');
      if (operands.length === 1) return usage(`missing destination file operand after ${q(operands[0])}`);
      dest = operands[operands.length - 1];
      sources = operands.slice(0, -1);
      const st = await tryStat(ctx, ctx.fs.resolvePath(dest, ctx.cwd));
      if (o.noTargetDir) {
        if (sources.length > 1) return usage(`extra operand ${q(operands[2])}`);
        destIsDir = false;
      } else {
        destIsDir = !!st && st.isDirectory();
        if (sources.length > 1 && !destIsDir) {
          ctx.stderr += st ? `cp: target ${q(dest)} is not a directory\n` : `cp: target ${q(dest)}: No such file or directory\n`;
          return 1;
        }
        if (o.parents && !destIsDir) return usage(`with --parents, the destination must be a directory`);
      }
    }

    let status = 0;
    let stdinPos = 0;
    const err = (msg: string) => { ctx.stderr += `cp: ${msg}\n`; status = 1; };
    const ask = (prompt: string): boolean => {
      ctx.stderr += prompt;
      const rest = (ctx.stdin || '').slice(stdinPos);
      const nl = rest.indexOf('\n');
      const ans = nl < 0 ? rest : rest.slice(0, nl);
      stdinPos += nl < 0 ? rest.length : nl + 1;
      return /^\s*[yY]/.test(ans);
    };
    // directories created by this run, to refuse copying a directory into itself
    const fs = ctx.fs;

    const copyOne = async (srcName: string, srcAbs: string, dstName: string, dstAbs: string, top: boolean): Promise<void> => {
      const follow = o.deref === 'always' || (top && o.deref === 'cmdline') || (o.deref === 'default' && !o.recursive);
      let st = follow ? await tryStat(ctx, srcAbs) : await tryLstat(ctx, srcAbs);
      if (!st && follow) {
        // dangling symlink: GNU reports the stat failure
        st = null;
      }
      if (!st) { err(`cannot stat ${q(srcName)}: No such file or directory`); return; }
      const dst = await tryLstat(ctx, dstAbs);

      if (st.isDirectory()) {
        if (!o.recursive) {
          err(`-r not specified; omitting directory ${q(srcName)}`);
          return;
        }
        const srcReal = await fs.realpath(srcAbs).catch(() => srcAbs);
        const dstParentReal = await fs.realpath(dstAbs.slice(0, dstAbs.lastIndexOf('/')) || '/').catch(() => dstAbs);
        const dstReal = joinPath(dstParentReal, baseName(dstAbs));
        if (dstReal === srcReal || dstReal.startsWith(srcReal === '/' ? '/' : srcReal + '/')) {
          // GNU has already made the (empty) destination directory by then
          if (!dst) await fs.mkdir(dstAbs).catch(() => {});
          err(`cannot copy a directory, ${q(srcName)}, into itself, ${q(dstName)}`);
          return;
        }
        let dstSt = dst;
        if (dstSt && dstSt.isSymbolicLink()) dstSt = await tryStat(ctx, dstAbs);
        if (dstSt && !dstSt.isDirectory()) {
          err(`cannot overwrite non-directory ${q(dstName)} with directory ${q(srcName)}`);
          return;
        }
        if (!dstSt) {
          try { await fs.mkdir(dstAbs); } catch (e: any) {
            err(`cannot create directory ${q(dstName)}: ${errText(e)}`);
            return;
          }
          if (o.verbose) ctx.stdout += `${q(srcName)} -> ${q(dstName)}\n`;
        }
        let names: string[] = [];
        try { names = await fs.readdir(await fs.realpath(srcAbs).catch(() => srcAbs)); } catch (e: any) { err(`cannot access ${q(srcName)}: ${errText(e)}`); return; }
        for (const n of names) {
          await copyOne(joinPath(srcName, n), joinPath(srcAbs, n), joinPath(dstName, n), joinPath(dstAbs, n), false);
        }
        // directories get the source's mode (masked unless preserving) once filled
        const mode = o.preserveMode ? st.mode & 0o7777 : (st.mode & 0o777 & ~UMASK);
        if (!dstSt) await fs.chmod(dstAbs, mode | (o.preserveMode ? 0 : 0o700)).catch(() => {});
        if (o.preserveTime) await fs.utimes(dstAbs, st.mtime.getTime(), st.mtime.getTime()).catch(() => {});
        return;
      }

      // Non-directory source
      if (dst) {
        let dstSt = dst;
        if (dst.isSymbolicLink()) dstSt = (await tryStat(ctx, dstAbs)) ?? dst;
        if (dstSt.isDirectory() && !dst.isSymbolicLink()) {
          err(`cannot overwrite directory ${q(dstName)} with non-directory`);
          return;
        }
        const sReal = await fs.realpath(srcAbs).catch(() => srcAbs);
        const dReal = await fs.realpath(dstAbs).catch(() => dstAbs);
        if (sReal === dReal && !(st.isSymbolicLink() && !follow)) {
          err(`${q(srcName)} and ${q(dstName)} are the same file`);
          return;
        }
        if (o.noClobber) return;
        if (o.update && dstSt.mtime && st.mtime && dstSt.mtime.getTime() >= st.mtime.getTime()) return;
        if (o.interactive && !ask(`cp: overwrite ${q(dstName)}? `)) return;
        if (o.backup) {
          await fs.rename(dstAbs, dstAbs + o.suffix).catch(() => {});
        } else if (o.removeDest || st.isSymbolicLink() || o.symbolic) {
          await fs.unlink(dstAbs).catch(() => {});
        }
      }
      // A regular file is written through a destination symlink
      let writeAbs = dstAbs;
      const dstNow = await tryLstat(ctx, dstAbs);
      if (dstNow && dstNow.isSymbolicLink() && !st.isSymbolicLink() && !o.symbolic) {
        if (!(await tryStat(ctx, dstAbs))) { err(`not writing through dangling symlink ${q(dstName)}`); return; }
        writeAbs = await fs.realpath(dstAbs).catch(() => dstAbs);
      }

      if (o.symbolic) {
        if (!srcName.startsWith('/') && dstName.includes('/')) {
          err(`${q(dstName)}: can make relative symbolic links only in current directory`);
          return;
        }
        try { await fs.symlink(srcName, dstAbs); } catch (e: any) { err(`cannot create symbolic link ${q(dstName)}: ${errText(e)}`); return; }
        if (o.verbose) ctx.stdout += `${q(srcName)} -> ${q(dstName)}\n`;
        return;
      }
      if (st.isSymbolicLink()) {
        const target = await fs.readlink(srcAbs);
        try { await fs.symlink(target, dstAbs); } catch (e: any) { err(`cannot create symbolic link ${q(dstName)}: ${errText(e)}`); return; }
        if (o.verbose) ctx.stdout += `${q(srcName)} -> ${q(dstName)}\n`;
        return;
      }
      if (o.link) {
        // -l: a hard link to the file instead of a copy (-f replaces an existing name)
        if (await tryLstat(ctx, dstAbs)) {
          if (!o.force && !o.removeDest) { err(`cannot create hard link ${q(dstName)} to ${q(srcName)}: File exists`); return; }
          await fs.unlink(dstAbs).catch(() => {});
        }
        try { await fs.link(srcAbs, dstAbs); } catch (e: any) { err(`cannot create hard link ${q(dstName)} to ${q(srcName)}: ${errText(e)}`); return; }
        if (o.verbose) ctx.stdout += `${q(srcName)} -> ${q(dstName)}\n`;
        return;
      }
      // Another name of a file already copied in this run: link to that copy
      if (o.preserveLinks && (st.nlink ?? 1) > 1 && st.ino) {
        const first = copiedInodes.get(st.ino);
        if (first !== undefined) {
          await fs.unlink(dstAbs).catch(() => {});
          try { await fs.link(first, dstAbs); } catch (e: any) { err(`cannot create hard link ${q(dstName)} to ${q(first)}: ${errText(e)}`); return; }
          if (o.verbose) ctx.stdout += `${q(srcName)} -> ${q(dstName)}\n`;
          return;
        }
        copiedInodes.set(st.ino, dstAbs);
      }
      if (!(st.mode & 0o400) && !o.link) {
        err(`cannot open ${q(srcName)} for reading: Permission denied`);
        return;
      }
      let data: Uint8Array | string = new Uint8Array(0);
      if (!o.attributesOnly) {
        try { data = await fs.readFile(srcAbs); } catch (e: any) { err(`cannot open ${q(srcName)} for reading: ${errText(e)}`); return; }
      }
      const existing = await tryStat(ctx, writeAbs);
      // An existing destination keeps its mode unless preserving
      const mode = o.preserveMode ? st.mode & 0o7777 : existing && !o.removeDest && !o.backup ? existing.mode & 0o7777 : st.mode & 0o777 & ~UMASK;
      try {
        if (o.attributesOnly) {
          if (!existing) await fs.writeFile(writeAbs, new Uint8Array(0), { mode });
        } else {
          await fs.writeFile(writeAbs, data, { mode });
        }
        await fs.chmod(writeAbs, mode).catch(() => {});
      } catch (e: any) {
        err(`cannot create regular file ${q(dstName)}: ${errText(e)}`);
        return;
      }
      if (o.preserveTime) await fs.utimes(writeAbs, st.mtime.getTime(), st.mtime.getTime()).catch(() => {});
      if (o.verbose) ctx.stdout += `${q(srcName)} -> ${q(dstName)}\n`;
    };

    for (const src of sources) {
      const srcAbs = ctx.fs.resolvePath(src, ctx.cwd);
      let dstName: string;
      if (o.parents) {
        const rel = src.replace(/^\/+/, '');
        dstName = joinPath(dest, rel);
        // create intermediate directories
        const parts = rel.split('/').filter(Boolean);
        let cur = ctx.fs.resolvePath(dest, ctx.cwd);
        let ok = true;
        for (const part of parts.slice(0, -1)) {
          cur = joinPath(cur, part);
          const s = await tryStat(ctx, cur);
          if (!s) {
            try { await fs.mkdir(cur); } catch (e: any) { err(`cannot make directory ${q(cur)}: ${errText(e)}`); ok = false; break; }
          } else if (!s.isDirectory()) {
            err(`${q(cur)} exists but is not a directory`); ok = false; break;
          }
        }
        if (!ok) continue;
      } else {
        dstName = destIsDir ? joinPath(dest, baseName(src)) : dest;
      }
      await copyOne(src, srcAbs, dstName, ctx.fs.resolvePath(dstName, ctx.cwd), true);
    }
    return status;
  },
};

function errText(e: any): string {
  const m = String(e?.message ?? e);
  if (/ENOENT/.test(m)) return 'No such file or directory';
  if (/EEXIST/.test(m)) return 'File exists';
  if (/ENOTDIR/.test(m)) return 'Not a directory';
  if (/EISDIR/.test(m)) return 'Is a directory';
  if (/EACCES|EPERM/.test(m)) return 'Permission denied';
  return m;
}
