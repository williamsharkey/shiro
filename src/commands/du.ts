import type { Command, CommandContext } from './index';

/**
 * du — GNU coreutils-compatible.
 * Usage is st_blocks * 512 (or the size with --apparent-size / -b), shown in
 * 1K blocks by default, -k -m -B SIZE -b, -h/--si human-readable (rounded up
 * like GNU). -a -s -c -d/--max-depth -S -L -P -H -D -0 -x -l --exclude.
 */

const UNITS = ['', 'K', 'M', 'G', 'T', 'P', 'E'];

function human(bytes: number, base: number): string {
  if (bytes < base) return String(Math.ceil(bytes));
  let v = bytes;
  let u = 0;
  while (v >= base && u < UNITS.length - 1) { v /= base; u++; }
  if (v < 10) {
    let r = Math.ceil(v * 10 - 1e-9) / 10;
    if (r >= 10) return `${Math.ceil(r)}${UNITS[u]}`;
    return `${r.toFixed(1)}${UNITS[u]}`;
  }
  let r = Math.ceil(v - 1e-9);
  if (r >= base && u < UNITS.length - 1) { u++; r = 1; return `${(1).toFixed(1)}${UNITS[u]}`; }
  return `${r}${UNITS[u]}`;
}

function parseBlockSize(s: string): number | null {
  const m = /^(\d*)([KMGTPE]?)(i?B?)$/i.exec(s);
  if (!m) return null;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  const unit = m[2].toUpperCase();
  const base = m[3].toUpperCase() === 'B' && !m[3].startsWith('i') ? 1000 : 1024;
  const pow = unit ? 'KMGTPE'.indexOf(unit) + 1 : 0;
  return n * Math.pow(base, pow);
}

function globRe(p: string): RegExp {
  let re = '';
  for (const c of p) re += c === '*' ? '.*' : c === '?' ? '.' : /[.+^${}()|[\]\\/]/.test(c) ? '\\' + c : c;
  return new RegExp(`^${re}$`);
}

export const du: Command = {
  name: "du",
  description: "Estimate file space usage",
  async exec(ctx: CommandContext) {
    const args = ctx.args;
    let all = false, summarize = false, total = false, apparent = false, separate = false, zero = false;
    let humanBase = 0;
    let block = 1024;
    let blockSuffix = '';
    let countLinks = false;
    const visited = new Set<string>();
    let maxDepth = Infinity;
    let deref: 'P' | 'L' | 'H' = 'P';
    const excludes: RegExp[] = [];
    const targets: string[] = [];
    const usage = (msg: string) => { ctx.stderr += `du: ${msg}\nTry 'du --help' for more information.\n`; return 1; };
    let opts = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!opts || a === '-' || !a.startsWith('-')) { targets.push(a); continue; }
      if (a === '--') { opts = false; continue; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = () => (eq >= 0 ? a.slice(eq + 1) : args[++i]);
        switch (name) {
          case 'all': all = true; break;
          case 'summarize': summarize = true; break;
          case 'total': total = true; break;
          case 'apparent-size': apparent = true; break;
          case 'bytes': apparent = true; block = 1; humanBase = 0; break;
          case 'human-readable': humanBase = 1024; break;
          case 'si': humanBase = 1000; break;
          case 'kilobytes': block = 1024; humanBase = 0; break;
          case 'megabytes': block = 1048576; humanBase = 0; break;
          case 'block-size': {
            const v = val() ?? '';
            const b = parseBlockSize(v);
            if (!b) return usage(`invalid --block-size argument '${v}'`);
            block = b; humanBase = 0;
            blockSuffix = /^[A-Za-z]/.test(v) ? v.replace(/^([KMGTPE]).*/i, '$1').toUpperCase() : '';
            break;
          }
          case 'max-depth': { const v = val(); if (!/^\d+$/.test(v ?? '')) return usage(`invalid maximum depth '${v}'`); maxDepth = parseInt(v!, 10); break; }
          case 'separate-dirs': separate = true; break;
          case 'dereference': deref = 'L'; break;
          case 'no-dereference': deref = 'P'; break;
          case 'dereference-args': deref = 'H'; break;
          case 'null': zero = true; break;
          case 'exclude': excludes.push(globRe(val() ?? '')); break;
          case 'count-links': countLinks = true; break;
          case 'one-file-system': break;
          default: return usage(`unrecognized option '${a}'`);
        }
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        switch (c) {
          case 'a': all = true; break;
          case 's': summarize = true; break;
          case 'c': total = true; break;
          case 'b': apparent = true; block = 1; humanBase = 0; blockSuffix = ''; break;
          case 'h': humanBase = 1024; break;
          case 'k': block = 1024; humanBase = 0; blockSuffix = ''; break;
          case 'm': block = 1048576; humanBase = 0; blockSuffix = ''; break;
          case 'S': separate = true; break;
          case 'L': deref = 'L'; break;
          case 'P': deref = 'P'; break;
          case 'H': case 'D': deref = 'H'; break;
          case '0': zero = true; break;
          case 'l': countLinks = true; break;
          case 'x': break;
          case 'B': case 'd': {
            const v = a.slice(j + 1) || args[++i];
            if (v === undefined) return usage(`option requires an argument -- '${c}'`);
            if (c === 'd') {
              if (!/^\d+$/.test(v)) return usage(`invalid maximum depth '${v}'`);
              maxDepth = parseInt(v, 10);
            } else {
              const b = parseBlockSize(v);
              if (!b) return usage(`invalid -B argument '${v}'`);
              block = b; humanBase = 0;
              blockSuffix = /^[A-Za-z]/.test(v) ? v.replace(/^([KMGTPE]).*/i, '$1').toUpperCase() : '';
            }
            j = a.length;
            break;
          }
          default: return usage(`invalid option -- '${c}'`);
        }
      }
    }
    if (summarize && maxDepth !== Infinity && maxDepth !== 0) {
      ctx.stderr += `du: warning: summarizing conflicts with --max-depth=${maxDepth}\nTry 'du --help' for more information.\n`;
      return 1;
    }
    if (summarize) maxDepth = 0;
    if (!targets.length) targets.push('.');

    const fs = ctx.fs;
    const end = zero ? '\0' : '\n';
    const fmt = (bytes: number) => (humanBase ? human(bytes, humanBase) : String(Math.ceil(bytes / block)) + blockSuffix);
    let status = 0;
    let grand = 0;
    const usageOf = (st: any) => (apparent ? (st.isDirectory() ? 0 : st.size ?? 0) : (st.blocks ?? Math.ceil((st.size ?? 0) / 512)) * 512);

    /** Usage of PATH (recursively); whether it is a directory */
    const walk = async (path: string, abs: string, depth: number, top: boolean): Promise<[number, boolean]> => {
      let st: any;
      try {
        st = (deref === 'L' || (top && deref === 'H')) ? await fs.stat(abs) : await fs.lstat(abs);
      } catch {
        try { st = await fs.lstat(abs); } catch {
          ctx.stderr += `du: cannot access '${path}': No such file or directory\n`;
          status = 1;
          return [0, false];
        }
      }
      // Like GNU, an entry reached twice (e.g. `du d d/sub`) counts once
      if (!countLinks) {
        const key = st.isSymbolicLink()
          ? (await fs.realpath(abs.slice(0, abs.lastIndexOf('/')) || '/').catch(() => '')) + '\0' + abs.slice(abs.lastIndexOf('/') + 1)
          : await fs.realpath(abs).catch(() => abs);
        if (visited.has(key)) return [0, st.isDirectory()];
        visited.add(key);
      }
      const size = usageOf(st);
      if (!st.isDirectory()) {
        if (top || (all && depth <= maxDepth)) ctx.stdout += `${fmt(size)}\t${path}${end}`;
        return [size, false];
      }
      let names: string[] = [];
      try { names = await fs.readdir(await fs.realpath(abs).catch(() => abs)); } catch {
        ctx.stderr += `du: cannot read directory '${path}': Permission denied\n`;
        status = 1;
      }
      let sub = 0;
      let files = 0;
      for (const n of names) {
        if (excludes.some((re) => re.test(n))) continue;
        const childPath = path.endsWith('/') ? path + n : `${path}/${n}`;
        const childAbs = abs === '/' ? `/${n}` : `${abs}/${n}`;
        const [s, isDir] = await walk(childPath, childAbs, depth + 1, false);
        sub += s;
        if (!isDir) files += s;
      }
      // -S: a directory's own usage plus its files, not its subdirectories
      const shown = separate ? size + files : size + sub;
      if (depth <= maxDepth) ctx.stdout += `${fmt(shown)}\t${path}${end}`;
      return [size + sub, true];
    };

    for (const t of targets) {
      grand += (await walk(t, fs.resolvePath(t, ctx.cwd), 0, true))[0];
    }
    if (total) ctx.stdout += `${fmt(grand)}\ttotal${end}`;
    return status;
  },
};
