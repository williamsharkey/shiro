import type { Command, CommandContext } from './index';

/**
 * ls — GNU coreutils-compatible listing.
 *
 * Into a pipe or file it prints one name per line (like coreutils); on the
 * terminal it keeps Shiro's compact style (names on one line, directories
 * marked with '/'). Long (-l -g -o -n), sizes (-s -h --si -k), sorting
 * (-t -S -X -v -U -f -r, --group-directories-first), -a -A -d -R -F -p -i
 * -1 -m -Q -L -H -I/--ignore --hide --full-time --time-style -c -u, and
 * GNU's error handling (exit 2 for a missing operand).
 */

// Color codes for ls --color (Shiro's palette)
const COLORS: Record<string, string> = {
  dir: '\x1b[1;34m',     // bold blue
  symlink: '\x1b[1;36m', // bold cyan
  exec: '\x1b[1;32m',    // bold green
  archive: '\x1b[1;31m', // bold red
  image: '\x1b[1;35m',   // bold magenta
  source: '\x1b[0;33m',  // yellow
  reset: '\x1b[0m',
};

const ARCHIVE_EXTS = new Set(['.tar', '.gz', '.bz2', '.xz', '.zip', '.rar', '.7z', '.tgz', '.zst']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico']);
const SOURCE_EXTS = new Set(['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.css', '.html', '.json', '.yaml', '.yml', '.toml', '.sh', '.rb', '.php']);

interface Item {
  /** name as displayed (operand text or directory entry name) */
  name: string;
  abs: string;
  st: any;
  type: 'file' | 'dir' | 'symlink';
  target?: string;
  /** symlink target's stat (for -F/-L/color) */
  tst?: any;
}

function getExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

function colorize(name: string, it: Item, useColor: boolean): string {
  if (!useColor) return name;
  if (it.type === 'dir') return COLORS.dir + name + COLORS.reset;
  if (it.type === 'symlink') return COLORS.symlink + name + COLORS.reset;
  const ext = getExt(name);
  if (ARCHIVE_EXTS.has(ext)) return COLORS.archive + name + COLORS.reset;
  if (IMAGE_EXTS.has(ext)) return COLORS.image + name + COLORS.reset;
  if (SOURCE_EXTS.has(ext)) return COLORS.source + name + COLORS.reset;
  if (((it.st?.mode ?? 0) & 0o111) !== 0) return COLORS.exec + name + COLORS.reset;
  return name;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

function human(bytes: number, base: number): string {
  const units = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
  if (bytes < base) return String(bytes);
  let v = bytes;
  let u = 0;
  while (v >= base && u < units.length - 1) { v /= base; u++; }
  if (v < 10) {
    const r = Math.ceil(v * 10 - 1e-9) / 10;
    return r >= 10 ? `${Math.ceil(r)}${units[u]}` : `${r.toFixed(1)}${units[u]}`;
  }
  const r = Math.ceil(v - 1e-9);
  if (r >= base && u < units.length - 1) return `1.0${units[u + 1]}`;
  return `${r}${units[u]}`;
}

function modeString(it: Item): string {
  const t = it.type === 'dir' ? 'd' : it.type === 'symlink' ? 'l' : it.st?.isFIFO?.() ? 'p' : '-';
  const m = it.type === 'symlink' ? 0o777 : (it.st?.mode ?? 0o644);
  const rwx = (b: number, s: boolean, sc: string) => `${b & 4 ? 'r' : '-'}${b & 2 ? 'w' : '-'}${s ? (b & 1 ? sc : sc.toUpperCase()) : b & 1 ? 'x' : '-'}`;
  return t + rwx((m >> 6) & 7, !!(m & 0o4000), 's') + rwx((m >> 3) & 7, !!(m & 0o2000), 's') + rwx(m & 7, !!(m & 0o1000), 't');
}

/** Natural ("version") comparison for -v */
function versionCmp(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) ?? [], pb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d) return d;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

function globRe(p: string): RegExp {
  let re = '';
  for (const c of p) re += c === '*' ? '.*' : c === '?' ? '.' : /[.+^${}()|[\]\\/]/.test(c) ? '\\' + c : c;
  return new RegExp(`^${re}$`);
}

/** Shell-style quoting for names with special characters, as GNU ls does on a terminal */
function quoteName(name: string, style: string): string {
  if (style === 'c') return '"' + name.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
  if (style === 'escape') return name.replace(/[\\ ]/g, '\\$&').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return name;
}

export const ls: Command = {
  name: "ls",
  description: "List directory contents",
  async exec(ctx: CommandContext) {
    const args = ctx.args;
    let colorMode = 'never';
    // Without a terminal (scripts, captured output) stdout is not a tty either
    const isTTY = ctx.stdoutIsTTY !== false && !!ctx.terminal;
    let format: 'one' | 'long' | 'tty' | 'commas' = isTTY ? 'tty' : 'one';
    let all: 'none' | 'almost' | 'all' = 'none';
    let sort: 'name' | 'size' | 'time' | 'ext' | 'version' | 'none' = 'name';
    let reverse = false, dirsOnly = false, recursive = false, groupDirsFirst = false;
    let classify: 'none' | 'all' | 'slash' = 'none';
    let showSize = false, showInode = false, numeric = false, noOwner = false, noGroup = false;
    let humanBase = 0;
    let blockSize = 1024;
    let timeField: 'm' | 'c' | 'a' = 'm';
    let timeStyle = 'locale';
    let deref: 'none' | 'all' | 'cmdline' = 'none';
    let derefSet = false;
    let quoting = 'literal';
    const ignores: RegExp[] = [];
    const hides: RegExp[] = [];
    const operands: string[] = [];
    const usage = (msg: string) => { ctx.stderr += `ls: ${msg}\nTry 'ls --help' for more information.\n`; return 2; };
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
          case 'color': case 'colour': colorMode = val === undefined || val === 'always' || val === 'yes' || val === 'force' ? 'always' : val === 'auto' || val === 'tty' || val === 'if-tty' ? 'auto' : 'never'; break;
          case 'group-directories-first': groupDirsFirst = true; break;
          case 'all': all = 'all'; break;
          case 'almost-all': all = 'almost'; break;
          case 'directory': dirsOnly = true; break;
          case 'recursive': recursive = true; break;
          case 'reverse': reverse = true; break;
          case 'size': showSize = true; break;
          case 'inode': showInode = true; break;
          case 'human-readable': humanBase = 1024; break;
          case 'si': humanBase = 1000; break;
          case 'kibibytes': blockSize = 1024; break;
          case 'block-size': { const v = need() ?? ''; const m = /^(\d*)([KMG]?)/i.exec(v)!; blockSize = (m[1] ? parseInt(m[1], 10) : 1) * (m[2] ? Math.pow(1024, 'KMG'.indexOf(m[2].toUpperCase()) + 1) : 1) || 1024; break; }
          case 'classify': case 'F': classify = 'all'; break;
          case 'indicator-style': { const v = need(); classify = v === 'classify' || v === 'file-type' ? 'all' : v === 'slash' ? 'slash' : 'none'; break; }
          case 'numeric-uid-gid': numeric = true; format = 'long'; break;
          case 'dereference': deref = 'all'; derefSet = true; break;
          case 'dereference-command-line': deref = 'cmdline'; derefSet = true; break;
          case 'dereference-command-line-symlink-to-dir': break;
          case 'full-time': format = 'long'; timeStyle = 'full-iso'; break;
          case 'time-style': timeStyle = (need() ?? 'locale').replace(/^posix-/, ''); break;
          case 'time': { const v = need(); timeField = v === 'ctime' || v === 'status' ? 'c' : v === 'atime' || v === 'access' || v === 'use' ? 'a' : 'm'; if (v === 'birth' || v === 'creation') timeField = 'c'; break; }
          case 'sort': { const v = need(); sort = v === 'size' ? 'size' : v === 'time' ? 'time' : v === 'extension' ? 'ext' : v === 'version' ? 'version' : v === 'none' ? 'none' : 'name'; break; }
          case 'ignore': ignores.push(globRe(need() ?? '')); break;
          case 'hide': hides.push(globRe(need() ?? '')); break;
          case 'format': { const v = need(); format = v === 'long' || v === 'verbose' ? 'long' : v === 'single-column' ? 'one' : v === 'commas' ? 'commas' : format; break; }
          case 'quote-name': quoting = 'c'; break;
          case 'escape': quoting = 'escape'; break;
          case 'literal': case 'show-control-chars': case 'hide-control-chars': quoting = 'literal'; break;
          case 'quoting-style': { const v = need(); quoting = v === 'c' ? 'c' : v === 'escape' ? 'escape' : 'literal'; break; }
          case 'width': case 'tabsize': need(); break;
          case 'ignore-backups': hides.push(/~$/); break;
          case 'author': case 'context': case 'hyperlink': break;
          default: return usage(`unrecognized option '${a}'`);
        }
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        switch (c) {
          case 'a': all = 'all'; break;
          case 'A': all = 'almost'; break;
          case 'l': format = 'long'; break;
          case 'g': format = 'long'; noOwner = true; break;
          case 'o': format = 'long'; noGroup = true; break;
          case 'n': format = 'long'; numeric = true; break;
          case '1': format = 'one'; break;
          case 'C': case 'x': if (format !== 'long') format = isTTY ? 'tty' : 'one'; break;
          case 'm': format = 'commas'; break;
          case 's': showSize = true; break;
          case 'h': humanBase = 1024; break;
          case 'k': blockSize = 1024; break;
          case 'i': showInode = true; break;
          case 'R': recursive = true; break;
          case 'd': dirsOnly = true; break;
          case 'r': reverse = true; break;
          case 't': sort = 'time'; break;
          case 'S': sort = 'size'; break;
          case 'X': sort = 'ext'; break;
          case 'v': sort = 'version'; break;
          case 'U': sort = 'none'; break;
          case 'f': sort = 'none'; all = 'all'; break;
          case 'c': timeField = 'c'; break;
          case 'u': timeField = 'a'; break;
          case 'F': classify = 'all'; break;
          case 'p': classify = 'slash'; break;
          case 'L': deref = 'all'; derefSet = true; break;
          case 'H': deref = 'cmdline'; derefSet = true; break;
          case 'Q': quoting = 'c'; break;
          case 'b': quoting = 'escape'; break;
          case 'N': case 'q': quoting = 'literal'; break;
          case 'B': hides.push(/~$/); break;
          case 'G': noGroup = true; break;
          case 'Z': case 'T': case 'w': case 'D':
            if (c === 'T' || c === 'w') { if (!a.slice(j + 1)) i++; j = a.length; }
            break;
          case 'I': {
            const v = a.slice(j + 1) || args[++i];
            if (v === undefined) return usage(`option requires an argument -- 'I'`);
            ignores.push(globRe(v));
            j = a.length;
            break;
          }
          default: return usage(`invalid option -- '${c}'`);
        }
      }
    }
    const useColor = colorMode === 'always' || (colorMode === 'auto' && isTTY);
    const tty = format === 'tty';
    const long = format === 'long';
    // Command-line symlinks are followed unless listing them long, -d or -F (GNU)
    if (!derefSet && !dirsOnly && !long && classify !== 'all') deref = 'cmdline';
    const locale = ctx.env.LC_ALL || ctx.env.LC_COLLATE || ctx.env.LANG || '';
    const cLocale = locale === 'C' || locale === 'POSIX' || locale.startsWith('C.');
    // A Collator with default locale and options orders exactly like localeCompare(y), without per-call setup
    const collate = cLocale ? null : new Intl.Collator().compare;
    const nameCmp = (x: string, y: string) => (collate ? collate(x, y) : x < y ? -1 : x > y ? 1 : 0);
    const fs = ctx.fs;
    const now = Date.now();
    let status = 0;
    const out: string[] = [];

    const timeOf = (st: any) => {
      const d = timeField === 'c' ? st.ctime : timeField === 'a' ? (st.atime ?? st.mtime) : st.mtime;
      return d instanceof Date ? d : new Date(d ?? 0);
    };
    // Allocated bytes; symlinks take none (they live in the inode)
    const allocated = (it: Item) => (it.type === 'symlink' ? 0 : (it.st.blocks ?? Math.ceil((it.st.size ?? 0) / 512)) * 512);
    const blocksOf = (it: Item) => Math.ceil(allocated(it) / blockSize);
    const sizeText = (it: Item) => {
      const bytes = allocated(it);
      return humanBase ? human(bytes, humanBase) : String(blocksOf(it));
    };

    const mkItem = async (name: string, abs: string, follow: boolean): Promise<Item | null> => {
      let st: any;
      try { st = await fs.lstat(abs); } catch { return null; }
      let it: Item = { name, abs, st, type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file' };
      if (it.type === 'symlink') {
        try { it.target = await fs.readlink(abs); } catch {}
        try { it.tst = await fs.stat(abs); } catch {}
        if (follow && it.tst) it = { name, abs, st: it.tst, type: it.tst.isDirectory() ? 'dir' : 'file' };
      }
      return it;
    };

    const indicator = (it: Item) => {
      if (classify === 'none') return '';
      if (it.type === 'dir') return '/';
      if (classify === 'slash') return '';
      if (it.type === 'symlink') return '@';
      return ((it.st.mode ?? 0) & 0o111) ? '*' : '';
    };

    const sortItems = (items: Item[]) => {
      if (sort !== 'none') {
        items.sort((x, y) => {
          let d = 0;
          if (sort === 'size') d = (y.st.size ?? 0) - (x.st.size ?? 0);
          else if (sort === 'time') d = timeOf(y.st).getTime() - timeOf(x.st).getTime();
          else if (sort === 'ext') d = nameCmp(getExt(x.name), getExt(y.name));
          else if (sort === 'version') d = versionCmp(x.name, y.name);
          return d || nameCmp(x.name, y.name);
        });
        if (reverse) items.reverse();
      }
      if (groupDirsFirst) {
        const isDir = (it: Item) => it.type === 'dir' || (it.type === 'symlink' && it.tst?.isDirectory());
        const dirs = items.filter(isDir);
        const rest = items.filter((it) => !isDir(it));
        items.splice(0, items.length, ...dirs, ...rest);
      }
      return items;
    };

    const fmtTime = (d: Date) => {
      if (timeStyle === 'full-iso') {
        const off = -d.getTimezoneOffset();
        const ao = Math.abs(off);
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}000000 ${off >= 0 ? '+' : '-'}${p2(Math.floor(ao / 60))}${p2(ao % 60)}`;
      }
      if (timeStyle === 'long-iso') return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      if (timeStyle === 'iso') {
        return Math.abs(now - d.getTime()) < 15778476000 ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}` : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `;
      }
      if (timeStyle.startsWith('+')) {
        return timeStyle.slice(1).replace(/%([YmdHMSbe%])/g, (_m, k) => ({
          Y: String(d.getFullYear()), m: p2(d.getMonth() + 1), d: p2(d.getDate()), H: p2(d.getHours()),
          M: p2(d.getMinutes()), S: p2(d.getSeconds()), b: MONTHS[d.getMonth()], e: String(d.getDate()).padStart(2), '%': '%',
        } as Record<string, string>)[k]);
      }
      const recent = d.getTime() <= now + 60000 && now - d.getTime() < 15778476000; // six months
      return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${recent ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : ` ${d.getFullYear()}`}`;
    };

    /** Lines for a set of items (one directory's entries, or the file operands) */
    const render = (items: Item[], withTotal: boolean): string[] => {
      const lines: string[] = [];
      const display = (it: Item) => colorize(quoteName(it.name, quoting), it, useColor);
      if (withTotal && (long || showSize)) {
        const total = items.reduce((n, it) => n + allocated(it), 0);
        lines.push(`total ${humanBase ? human(total, humanBase) : Math.ceil(total / blockSize)}`);
      }
      const inodeW = Math.max(0, ...items.map((it) => String(it.st.ino ?? 0).length));
      const sizeW = Math.max(0, ...items.map((it) => sizeText(it).length));
      const prefix = (it: Item) => (showInode ? String(it.st.ino ?? 0).padStart(inodeW) + ' ' : '') + (showSize ? sizeText(it).padStart(sizeW) + ' ' : '');
      if (long) {
        const user = ctx.env.USER || 'user';
        const rows = items.map((it) => {
          const owner = numeric ? String(it.st.uid ?? 1000) : user;
          const group = numeric ? String(it.st.gid ?? 1000) : user;
          const size = humanBase ? human(it.st.size ?? 0, humanBase) : String(it.st.size ?? 0);
          return { it, mode: modeString(it), links: String(it.st.nlink ?? 1), owner, group, size, time: fmtTime(timeOf(it.st)) };
        });
        const w = (k: 'links' | 'owner' | 'group' | 'size') => Math.max(0, ...rows.map((r) => r[k].length));
        const lw = w('links'), ow = w('owner'), gw = w('group'), sw = w('size');
        for (const r of rows) {
          let line = `${prefix(r.it)}${r.mode} ${r.links.padStart(lw)} `;
          if (!noOwner) line += `${r.owner.padEnd(ow)} `;
          if (!noGroup) line += `${r.group.padEnd(gw)} `;
          line += `${r.size.padStart(sw)} ${r.time} ${display(r.it)}`;
          if (r.it.type === 'symlink' && r.it.target !== undefined) line += ` -> ${r.it.target}`;
          else line += indicator(r.it);
          lines.push(line);
        }
      } else if (format === 'commas') {
        if (items.length) lines.push(items.map((it) => prefix(it) + display(it) + indicator(it)).join(', '));
      } else if (tty) {
        // Shiro's terminal style: one line, directories marked with '/'
        if (items.length) {
          lines.push(items.map((it) => prefix(it) + display(it) + (classify === 'none' && it.type === 'dir' ? '/' : indicator(it))).join('  '));
        }
      } else {
        for (const it of items) lines.push(prefix(it) + display(it) + indicator(it));
      }
      return lines;
    };

    const visible = (name: string) => {
      if (all === 'none' && name.startsWith('.')) return false;
      if (ignores.some((re) => re.test(name))) return false;
      if (all === 'none' && hides.some((re) => re.test(name))) return false;
      return true;
    };

    const listDir = async (label: string, abs: string, showLabel: boolean, first: boolean) => {
      let names: string[];
      const real = await fs.realpath(abs).catch(() => abs);
      try {
        names = await fs.readdir(real);
      } catch {
        ctx.stderr += `ls: cannot open directory '${label}': Permission denied\n`;
        status = 2;
        return;
      }
      if (!first) out.push('');
      if (showLabel) out.push(`${label}:`);
      if (all === 'all') names = ['.', '..', ...names];
      const items: Item[] = [];
      for (const n of names) {
        if (!visible(n)) continue;
        // . and .. are the real directory and its parent, never a symlink
        // (/proc/self/fd/.. is /proc/PID, not the /proc/self link)
        const dot = n === '.' || n === '..';
        const childAbs = n === '.' ? real : n === '..' ? (real.slice(0, real.lastIndexOf('/')) || '/') : abs === '/' ? `/${n}` : `${abs}/${n}`;
        const it = await mkItem(n, childAbs, dot || deref === 'all');
        if (it) items.push(it);
      }
      sortItems(items);
      out.push(...render(items, true));
      if (recursive) {
        for (const it of items) {
          if (it.type !== 'dir' || it.name === '.' || it.name === '..') continue;
          const sub = label.endsWith('/') ? label + it.name : `${label}/${it.name}`;
          await listDir(sub, it.abs, true, false);
        }
      }
    };

    const ops = operands.length ? operands : ['.'];
    const files: Item[] = [];
    const dirs: Item[] = [];
    for (const op of ops) {
      const abs = fs.resolvePath(op, ctx.cwd);
      const it = await mkItem(op, abs, deref !== 'none');
      if (!it) {
        ctx.stderr += `ls: cannot access '${op}': No such file or directory\n`;
        status = 2;
        continue;
      }
      if (it.type === 'dir' && !dirsOnly) dirs.push(it);
      else files.push(it);
    }
    sortItems(files);
    sortItems(dirs);
    out.push(...render(files, false));
    const showLabels = ops.length > 1 || recursive;
    let first = files.length === 0;
    for (const d of dirs) {
      await listDir(d.name, d.abs, showLabels, first);
      first = false;
    }
    if (out.length) ctx.stdout += out.join('\n') + '\n';
    return status;
  },
};
