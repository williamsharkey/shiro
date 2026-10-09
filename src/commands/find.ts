import { Command, CommandContext } from './index';
import { quoteArgsForShell } from '../shell';
import { posixRegExp } from '../utils/posix-regex';

/**
 * find — GNU findutils-compatible.
 *
 *   find [-H] [-L] [-P] [STARTING-POINT...] [EXPRESSION]
 *
 * Expressions use GNU precedence: ( ) ! -not, implicit/explicit -a, -o, and
 * the comma operator. Tests: -name -iname -path -ipath -wholename -regex
 * -iregex -lname -ilname -type -xtype -size -empty -mtime -atime -ctime -mmin
 * -amin -cmin -newer -anewer -cnewer -perm -user -group -uid -gid -nouser
 * -nogroup -links -inum -samefile -readable -writable -executable -true
 * -false. Actions: -print -print0 -printf -fprint -fprint0 -ls -fls -delete
 * -exec/-execdir (; and +) -ok/-okdir -prune -quit. Options: -maxdepth
 * -mindepth -depth -xdev -mount -follow -regextype -daystart -noleaf ...
 * Without an action the expression is followed by -print.
 */

interface Entry {
  /** path as printed */
  path: string;
  /** absolute path */
  abs: string;
  /** name for -name (basename; for a starting point, its last component) */
  name: string;
  depth: number;
  /** stat (lstat unless following links) */
  st: any;
  /** the starting point this entry is under */
  start: string;
}

type Node =
  | { k: 'and' | 'or' | 'comma'; l: Node; r: Node }
  | { k: 'not'; e: Node }
  | { k: 'pred'; name: string; fn: (e: Entry) => Promise<boolean> | boolean };

class FindError extends Error {}

const PERM_BITS: Record<string, number> = { r: 4, w: 2, x: 1 };

/** fnmatch(3) without FNM_PATHNAME/FNM_PERIOD as a RegExp */
function globRegExp(pat: string, icase: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\' && i + 1 < pat.length) { re += escRe(pat[++i]); continue; }
    if (c === '*') { re += '[\\s\\S]*'; continue; }
    if (c === '?') { re += '[\\s\\S]'; continue; }
    if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (pat[j] === '!' || pat[j] === '^') { neg = true; j++; }
      let body = '';
      let first = true;
      let closed = false;
      while (j < pat.length) {
        const d = pat[j];
        if (d === ']' && !first) { closed = true; break; }
        first = false;
        if (d === '[' && pat[j + 1] === ':') {
          const end = pat.indexOf(':]', j + 2);
          if (end > 0) {
            const cls = pat.slice(j + 2, end);
            const map: Record<string, string> = {
              alpha: 'a-zA-Z', digit: '0-9', alnum: '0-9a-zA-Z', upper: 'A-Z', lower: 'a-z',
              space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', print: ' -~',
              graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f',
            };
            body += map[cls] ?? '';
            j = end + 2;
            continue;
          }
        }
        if (d === '\\' && j + 1 < pat.length) { body += '\\' + pat[j + 1]; j += 2; continue; }
        body += /[\]\\^-]/.test(d) && !(d === '-' && body && pat[j + 1] !== ']') ? '\\' + d : d;
        j++;
      }
      if (!closed) { re += '\\['; continue; }
      re += `[${neg ? '^' : ''}${body}]`;
      i = j;
      continue;
    }
    re += escRe(c);
  }
  return new RegExp(`^${re}$`, icase ? 'i' : '');
}

function escRe(c: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(c) ? '\\' + c : c;
}

/** emacs regex syntax (find's default) → ERE */
function emacsToEre(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      const n = src[++i];
      if (n === '(' || n === ')' || n === '|') out += n;
      else out += '\\' + n;
      continue;
    }
    if (c === '[') {
      // copy the bracket expression unchanged
      let j = i + 1;
      if (src[j] === '^') j++;
      if (src[j] === ']') j++;
      while (j < src.length && src[j] !== ']') {
        if (src[j] === '[' && /[:.=]/.test(src[j + 1] ?? '')) {
          const end = src.indexOf(src[j + 1] + ']', j + 2);
          j = end > 0 ? end + 2 : j + 1;
        } else j++;
      }
      out += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '(' || c === ')' || c === '|' || c === '{' || c === '}') { out += '\\' + c; continue; }
    out += c;
  }
  return out;
}

function compileRegex(src: string, type: string, icase: boolean): RegExp {
  let ere: string;
  let extended = true;
  switch (type) {
    case 'emacs': case 'gnu-awk': case 'awk': ere = type === 'emacs' ? emacsToEre(src) : src; break;
    case 'posix-basic': case 'grep': case 'sed': case 'ed': ere = src; extended = false; break;
    default: ere = src; break; // posix-extended, egrep, posix-egrep, findutils-default
  }
  const re = posixRegExp(ere, { extended });
  return new RegExp(`^(?:${re.source})$`, icase ? 'i' : '');
}

/** Parse -perm MODE (octal or symbolic) → bits */
function parseMode(spec: string): number | null {
  if (/^[0-7]+$/.test(spec)) return parseInt(spec, 8);
  let mode = 0;
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause);
    if (!m) return null;
    const who = m[1] || 'a';
    let bits = 0;
    for (const p of m[3]) {
      if (p in PERM_BITS) {
        const b = PERM_BITS[p];
        if (who.includes('u') || who.includes('a')) bits |= b << 6;
        if (who.includes('g') || who.includes('a')) bits |= b << 3;
        if (who.includes('o') || who.includes('a')) bits |= b;
      } else if (p === 's') {
        if (who.includes('u') || who.includes('a')) bits |= 0o4000;
        if (who.includes('g') || who.includes('a')) bits |= 0o2000;
      } else if (p === 't') bits |= 0o1000;
    }
    if (m[2] === '-') mode &= ~bits; else mode |= bits;
  }
  return mode;
}

function typeChar(st: any): string {
  if (!st) return 'N';
  if (st.isSymbolicLink?.()) return 'l';
  if (st.isDirectory?.()) return 'd';
  if (st.isFIFO?.()) return 'p';
  if (st.isSocket?.()) return 's';
  if (st.isCharacterDevice?.()) return 'c';
  if (st.isBlockDevice?.()) return 'b';
  return 'f';
}

function modeString(st: any): string {
  const t = typeChar(st);
  const m = st.mode ?? 0;
  const rwx = (b: number, s: boolean, sc: string) => `${b & 4 ? 'r' : '-'}${b & 2 ? 'w' : '-'}${s ? (b & 1 ? sc : sc.toUpperCase()) : b & 1 ? 'x' : '-'}`;
  return (t === 'f' ? '-' : t) + rwx((m >> 6) & 7, !!(m & 0o4000), 's') + rwx((m >> 3) & 7, !!(m & 0o2000), 's') + rwx(m & 7, !!(m & 0o1000), 't');
}

const p2 = (n: number) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** ctime(3)-style "Sat Jan  2 03:04:05.0000000000 1999" as -printf %t prints it */
function ctimeStr(d: Date): string {
  return `${DAY[d.getDay()]} ${MON[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}0000000 ${d.getFullYear()}`;
}

function timeDirective(d: Date, k: string): string {
  const ms = d.getTime();
  switch (k) {
    case '@': return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}0000000`;
    case 'H': return p2(d.getHours());
    case 'I': return p2(((d.getHours() + 11) % 12) + 1);
    case 'k': return String(d.getHours()).padStart(2);
    case 'l': return String(((d.getHours() + 11) % 12) + 1).padStart(2);
    case 'M': return p2(d.getMinutes());
    case 'p': return d.getHours() < 12 ? 'AM' : 'PM';
    case 'r': return `${p2(((d.getHours() + 11) % 12) + 1)}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
    case 'S': return `${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}0000000`;
    case 'T': return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}0000000`;
    case '+': return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}+${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}0000000`;
    case 'X': return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    case 'Z': return 'UTC';
    case 'a': return DAY[d.getDay()];
    case 'A': return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
    case 'b': case 'h': return MON[d.getMonth()];
    case 'B': return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()];
    case 'c': return `${DAY[d.getDay()]} ${MON[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
    case 'd': return p2(d.getDate());
    case 'D': return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${p2(d.getFullYear() % 100)}`;
    case 'F': return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    case 'j': return String(Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86400000) + 1).padStart(3, '0');
    case 'm': return p2(d.getMonth() + 1);
    case 'U': case 'W': {
      const jan1 = new Date(d.getFullYear(), 0, 1);
      const yday = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
      const wd = k === 'U' ? d.getDay() : (d.getDay() + 6) % 7;
      return p2(Math.floor((yday + 7 - wd) / 7));
    }
    case 'w': return String(d.getDay());
    case 'x': return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${p2(d.getFullYear() % 100)}`;
    case 'y': return p2(d.getFullYear() % 100);
    case 'Y': return String(d.getFullYear());
    default: return '';
  }
}

/** Backslash escapes in -printf formats */
function printfEscape(fmt: string, i: number): [string, number, boolean] {
  const n = fmt[i + 1];
  const map: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
  if (n === undefined) return ['\\', i + 1, false];
  if (n === 'c') return ['', i + 2, true];
  if (map[n] !== undefined) return [map[n], i + 2, false];
  const m = /^[0-7]{1,3}/.exec(fmt.slice(i + 1));
  if (m) return [String.fromCharCode(parseInt(m[0], 8)), i + 1 + m[0].length, false];
  return ['\\' + n, i + 2, false];
}

export const findCmd: Command = {
  name: 'find',
  description: 'Search for files in a directory hierarchy',
  async exec(ctx: CommandContext) {
    try {
      return await runFind(ctx);
    } catch (e: any) {
      if (e instanceof FindError) { ctx.stderr += `find: ${e.message}\n`; return 1; }
      throw e;
    }
  },
};

async function runArgv(ctx: CommandContext, argv: string[], cwd: string, stdin: string, out: { stdout: string; stderr: string }): Promise<number> {
  const name = argv[0];
  if (!name.includes('/') && !ctx.shell.commands.get(name) && !ctx.shell.functions[name] &&
      !(await ctx.shell.findExecutableInPath(name))) {
    out.stderr += `find: '${name}': No such file or directory\n`;
    return 127;
  }
  const child = ctx.shell.fork();
  if (ctx.terminal) (child as any).setTerminal?.(ctx.terminal);
  child.cwd = cwd;
  child.env = { ...ctx.env, PWD: cwd };
  child.options.delete('errexit');
  let o = '';
  let e = '';
  let code: number;
  try {
    code = await child.executeWithStdin(quoteArgsForShell(argv), stdin, (s) => { o += s; }, (s) => { e += s; });
  } catch (err: any) {
    e += `find: ${name}: ${err?.message ?? err}\n`;
    code = 126;
  }
  out.stdout += o.replace(/\r\n/g, '\n');
  out.stderr += e.replace(/\r\n/g, '\n');
  return code;
}

async function runFind(ctx: CommandContext): Promise<number> {
  const args = ctx.args;
  const fs = ctx.fs;
  let follow: 'P' | 'L' | 'H' = 'P';
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-H' || a === '-L' || a === '-P') follow = a[1] as any;
    else if (a === '-D' || a === '-O') i++;
    else if (/^-O\d$/.test(a)) continue;
    else if (a === '--') { i++; break; }
    else break;
  }
  const starts: string[] = [];
  for (; i < args.length; i++) {
    const a = args[i];
    if ((a.startsWith('-') && a.length > 1) || a === '(' || a === '!' || a === ')' || a === ',') break;
    starts.push(a);
  }
  if (!starts.length) starts.push('.');

  // ── options gathered while parsing ──
  let maxDepth = Infinity;
  let minDepth = 0;
  let depthFirst = false;
  let xdev = false;
  let regexType = 'emacs';
  let dayStart = false;
  let hasAction = false;
  let status = 0;
  let quit = false;
  const now = Date.now();
  const out = { stdout: '', stderr: '' };
  const fileOutputs = new Map<string, string>();
  const plusBatches: { argv: string[]; dir: boolean; items: Map<string, string[]> }[] = [];
  let stdinPos = 0;
  const pruned = new Set<Entry>();

  const userName = ctx.env.USER || 'user';
  const toks = args.slice(i);
  let p = 0;
  const peek = () => toks[p];
  const need = (opt: string): string => {
    if (p >= toks.length) throw new FindError(`missing argument to \`${opt}'`);
    return toks[p++];
  };
  const numArg = (opt: string, v: string): { cmp: '+' | '-' | '='; n: number } => {
    const m = /^([+-]?)(\d+(?:\.\d+)?)$/.exec(v);
    if (!m) throw new FindError(`invalid argument \`${v}' to \`${opt}'`);
    return { cmp: (m[1] || '=') as any, n: parseFloat(m[2]) };
  };
  const cmpNum = (c: { cmp: string; n: number }, v: number) => (c.cmp === '+' ? v > c.n : c.cmp === '-' ? v < c.n : v === c.n);
  const statOf = async (abs: string, deref: boolean) => {
    try { return deref ? await fs.stat(abs) : await fs.lstat(abs); } catch { return null; }
  };
  const timeOf = (st: any, which: string): number => {
    const v = which === 'a' ? (st.atimeMs ?? st.mtime?.getTime?.()) : which === 'c' ? (st.ctimeMs ?? st.ctime?.getTime?.()) : (st.mtimeMs ?? st.mtime?.getTime?.());
    return typeof v === 'number' ? v : Date.now();
  };
  const dayBase = () => {
    if (!dayStart) return now;
    const d = new Date(now);
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  };

  const write = (target: string | null, text: string) => {
    if (target === null) out.stdout += text;
    else fileOutputs.set(target, (fileOutputs.get(target) ?? '') + text);
  };

  const lsLine = (e: Entry): string => {
    const st = e.st;
    const kb = Math.ceil((st.size ?? 0) / 1024);
    const d = st.mtime instanceof Date ? st.mtime : new Date(timeOf(st, 'm'));
    const recent = Math.abs(now - d.getTime()) < 182.5 * 86400000;
    const when = `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${recent ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : String(d.getFullYear()).padStart(5)}`;
    let line = `${String(st.ino ?? 0).padStart(6)} ${String(kb).padStart(4)} ${modeString(st)} ${String(st.nlink ?? 1).padStart(3)} ${userName.padEnd(8)} ${userName.padEnd(8)} ${String(st.size ?? 0).padStart(8)} ${when} ${e.path}`;
    if (typeChar(st) === 'l') line += ` -> ${e.st.__target ?? ''}`;
    return line + '\n';
  };

  const formatPrintf = async (fmt: string, e: Entry): Promise<string> => {
    let s = '';
    for (let k = 0; k < fmt.length;) {
      const c = fmt[k];
      if (c === '\\') {
        const [t, nk, stop] = printfEscape(fmt, k);
        s += t; k = nk;
        if (stop) return s;
        continue;
      }
      if (c !== '%') { s += c; k++; continue; }
      const m = /^%([-+ #0]*)(\d*)(?:\.(\d+))?([a-zA-Z%@{}]|[ACT].)?/.exec(fmt.slice(k));
      if (!m || !m[4]) { s += '%'; k++; continue; }
      k += m[0].length;
      const [, flags, width, prec, d] = m;
      let v: string;
      const st = e.st;
      switch (d[0]) {
        case '%': v = '%'; break;
        case 'p': v = e.path; break;
        case 'f': v = e.depth === 0 ? e.name : e.path.slice(e.path.lastIndexOf('/') + 1); break;
        case 'h': {
          const idx = e.path.replace(/\/+$/, '').lastIndexOf('/');
          v = idx < 0 ? '.' : idx === 0 ? '/' : e.path.slice(0, idx);
          break;
        }
        case 'P': v = e.depth === 0 ? '' : e.path.slice(e.start.length).replace(/^\/+/, ''); break;
        case 'H': v = e.start; break;
        case 'd': v = String(e.depth); break;
        case 's': v = String(st.size ?? 0); break;
        case 'k': v = String(Math.ceil((st.size ?? 0) / 1024)); break;
        case 'b': v = String(Math.ceil((st.size ?? 0) / 512)); break;
        case 'm': v = ((st.mode ?? 0) & 0o7777).toString(8); break;
        case 'M': v = modeString(st); break;
        case 'n': v = String(st.nlink ?? 1); break;
        case 'i': v = String(st.ino ?? 0); break;
        case 'u': case 'g': v = userName; break;
        case 'U': v = String(st.uid ?? 1000); break;
        case 'G': v = String(st.gid ?? 1000); break;
        case 'y': v = typeChar(st); break;
        case 'Y': {
          if (typeChar(st) !== 'l') { v = typeChar(st); break; }
          const t = await statOf(e.abs, true);
          v = t ? typeChar(t) : 'N';
          break;
        }
        case 'l': v = typeChar(st) === 'l' ? await fs.readlink(e.abs).catch(() => '') : ''; break;
        case 'D': v = String(st.dev ?? 0); break;
        case 'S': v = '1'; break;
        case 'F': v = 'idbfs'; break;
        case 'a': case 'c': case 't': v = ctimeStr(new Date(timeOf(st, d[0] === 't' ? 'm' : d[0]))); break;
        case 'A': case 'C': case 'T': v = timeDirective(new Date(timeOf(st, d[0] === 'T' ? 'm' : d[0].toLowerCase())), d[1]); break;
        default: v = ''; break;
      }
      if (prec !== undefined && /[^dimnsUGkb]/.test(d[0])) v = v.slice(0, parseInt(prec, 10));
      if (width) {
        const w = parseInt(width, 10);
        v = flags.includes('-') ? v.padEnd(w) : flags.includes('0') && /^\d/.test(v) ? v.padStart(w, '0') : v.padStart(w);
      }
      s += v;
    }
    return s;
  };

  // ── expression parser ──
  const primary = (): Node => {
    const t = toks[p++];
    const pred = (name: string, fn: (e: Entry) => Promise<boolean> | boolean): Node => ({ k: 'pred', name, fn });
    switch (t) {
      case '(': {
        const e = parseComma();
        if (toks[p] !== ')') throw new FindError(`invalid expression; I was expecting to find a ')' somewhere but did not see one.`);
        p++;
        return e;
      }
      case '!': case '-not': {
        if (p >= toks.length) throw new FindError(`invalid expression; you have used a binary operator '${t}' with nothing before it.`);
        return { k: 'not', e: unary() };
      }
      // options (always true)
      case '-maxdepth': { const v = need(t); if (!/^\d+$/.test(v)) throw new FindError(`Expected a positive decimal integer argument to ${t}, but got \`${v}'`); maxDepth = parseInt(v, 10); return pred(t, () => true); }
      case '-mindepth': { const v = need(t); if (!/^\d+$/.test(v)) throw new FindError(`Expected a positive decimal integer argument to ${t}, but got \`${v}'`); minDepth = parseInt(v, 10); return pred(t, () => true); }
      case '-depth': case '-d': depthFirst = true; return pred(t, () => true);
      case '-xdev': case '-mount': xdev = true; return pred(t, () => true);
      case '-follow': follow = 'L'; return pred(t, () => true);
      case '-regextype': regexType = need(t); return pred(t, () => true);
      case '-daystart': dayStart = true; return pred(t, () => true);
      case '-noleaf': case '-ignore_readdir_race': case '-noignore_readdir_race': case '-warn': case '-nowarn':
        return pred(t, () => true);
      // tests
      case '-true': return pred(t, () => true);
      case '-false': return pred(t, () => false);
      case '-name': case '-iname': {
        const pat = need(t);
        const re = globRegExp(pat, t === '-iname');
        return pred(t, (e) => re.test(e.name));
      }
      case '-path': case '-wholename': case '-ipath': case '-iwholename': {
        const re = globRegExp(need(t), t.startsWith('-i'));
        return pred(t, (e) => re.test(e.path));
      }
      case '-lname': case '-ilname': {
        const re = globRegExp(need(t), t === '-ilname');
        return pred(t, async (e) => typeChar(e.st) === 'l' && re.test(await fs.readlink(e.abs).catch(() => '')));
      }
      case '-regex': case '-iregex': {
        const src = need(t);
        let re: RegExp;
        try { re = compileRegex(src, regexType, t === '-iregex'); } catch (err: any) { throw new FindError(`invalid regular expression \`${src}': ${err.message}`); }
        return pred(t, (e) => re.test(e.path));
      }
      case '-type': case '-xtype': {
        const v = need(t);
        const types = v.split(',');
        for (const ty of types) if (!/^[fdlpsbcD]$/.test(ty)) throw new FindError(`Unknown argument to ${t}: ${ty}`);
        const xt = t === '-xtype';
        return pred(t, async (e) => {
          let st = e.st;
          // -xtype checks the other side of a symlink: the target without -L, the link with -L
          if (xt) st = follow === 'L' ? await statOf(e.abs, false) : typeChar(st) === 'l' ? (await statOf(e.abs, true)) ?? st : st;
          return types.includes(typeChar(st));
        });
      }
      case '-size': {
        const v = need(t);
        const m = /^([+-]?)(\d+)([bcwkMG]?)$/.exec(v);
        if (!m) throw new FindError(`invalid -size type \`${v}'`);
        const unit = { b: 512, c: 1, w: 2, k: 1024, M: 1048576, G: 1073741824, '': 512 }[m[3]]!;
        const n = parseInt(m[2], 10);
        return pred(t, (e) => {
          const sz = Math.ceil((e.st.size ?? 0) / unit);
          return m[1] === '+' ? sz > n : m[1] === '-' ? sz < n : sz === n;
        });
      }
      case '-empty': return pred(t, async (e) => {
        const ty = typeChar(e.st);
        if (ty === 'd') { try { return (await fs.readdir(await fs.realpath(e.abs).catch(() => e.abs))).length === 0; } catch { return false; } }
        return ty === 'f' && (e.st.size ?? 0) === 0;
      });
      case '-mtime': case '-atime': case '-ctime': case '-mmin': case '-amin': case '-cmin': {
        const c = numArg(t, need(t));
        const which = t[1];
        const unit = t.endsWith('min') ? 60000 : 86400000;
        return pred(t, (e) => {
          const age = (unit === 60000 ? now : dayBase()) - timeOf(e.st, which);
          // GNU: days are truncated; minutes compare exactly, rounded up for N
          const v = unit === 60000 ? age / unit : Math.floor(age / unit);
          if (c.cmp === '=') return (unit === 60000 ? Math.ceil(v) : v) === c.n;
          return c.cmp === '+' ? v > c.n : v < c.n;
        });
      }
      case '-newer': case '-anewer': case '-cnewer': {
        const ref = need(t);
        const which = t === '-newer' ? 'm' : t[1];
        let refTime: number | null = null;
        return pred(t, async (e) => {
          if (refTime === null) {
            const st = await statOf(fs.resolvePath(ref, ctx.cwd), true);
            if (!st) throw new FindError(`'${ref}': No such file or directory`);
            refTime = timeOf(st, 'm');
          }
          return timeOf(e.st, which) > refTime;
        });
      }
      case '-perm': {
        const v = need(t);
        const kind = v[0] === '-' ? '-' : v[0] === '/' || v[0] === '+' ? '/' : '=';
        const mode = parseMode(kind === '=' ? v : v.slice(1));
        if (mode === null) throw new FindError(`invalid mode \`${v}'`);
        return pred(t, (e) => {
          const fm = (e.st.mode ?? 0) & 0o7777;
          if (kind === '-') return (fm & mode) === mode;
          if (kind === '/') return mode === 0 || (fm & mode) !== 0;
          return fm === mode;
        });
      }
      case '-user': case '-group': { const v = need(t); return pred(t, () => v === userName || v === '1000'); }
      case '-uid': case '-gid': { const c = numArg(t, need(t)); return pred(t, (e) => cmpNum(c, t === '-uid' ? (e.st.uid ?? 1000) : (e.st.gid ?? 1000))); }
      case '-nouser': case '-nogroup': return pred(t, () => false);
      case '-links': { const c = numArg(t, need(t)); return pred(t, (e) => cmpNum(c, e.st.nlink ?? 1)); }
      case '-inum': { const c = numArg(t, need(t)); return pred(t, (e) => cmpNum(c, e.st.ino ?? 0)); }
      case '-samefile': {
        const ref = need(t);
        let refPath: string | null = null;
        return pred(t, async (e) => {
          if (refPath === null) refPath = await fs.realpath(fs.resolvePath(ref, ctx.cwd)).catch(() => '');
          return (await fs.realpath(e.abs).catch(() => e.abs)) === refPath;
        });
      }
      case '-readable': return pred(t, (e) => !!((e.st.mode ?? 0o444) & 0o444));
      case '-writable': return pred(t, (e) => !!((e.st.mode ?? 0o222) & 0o222));
      case '-executable': return pred(t, (e) => typeChar(e.st) === 'd' || !!((e.st.mode ?? 0) & 0o111));
      case '-fstype': { const v = need(t); return pred(t, () => v === 'idbfs'); }
      // actions
      case '-print': case '-print0': case '-fprint': case '-fprint0': {
        hasAction = true;
        const target = t.startsWith('-f') ? fs.resolvePath(need(t), ctx.cwd) : null;
        if (target !== null) fileOutputs.set(target, '');
        const sep = t.endsWith('0') ? '\0' : '\n';
        return pred(t, (e) => { write(target, e.path + sep); return true; });
      }
      case '-printf': case '-fprintf': {
        hasAction = true;
        const target = t === '-fprintf' ? fs.resolvePath(need(t), ctx.cwd) : null;
        if (target !== null) fileOutputs.set(target, '');
        const fmt = need(t);
        return pred(t, async (e) => { write(target, await formatPrintf(fmt, e)); return true; });
      }
      case '-ls': case '-fls': {
        hasAction = true;
        const target = t === '-fls' ? fs.resolvePath(need(t), ctx.cwd) : null;
        if (target !== null) fileOutputs.set(target, '');
        return pred(t, async (e) => {
          if (typeChar(e.st) === 'l') e.st.__target = await fs.readlink(e.abs).catch(() => '');
          write(target, lsLine(e));
          return true;
        });
      }
      case '-delete': {
        hasAction = true;
        depthFirst = true;
        return pred(t, async (e) => {
          if (e.depth === 0 && (e.name === '.' || e.path === '.')) return true;
          try {
            if (typeChar(e.st) === 'd') await fs.rmdir(e.abs);
            else await fs.unlink(e.abs);
            return true;
          } catch (err: any) {
            const msg = /ENOTEMPTY|not empty/i.test(err?.message ?? '') ? 'Directory not empty' : 'Permission denied';
            out.stderr += `find: cannot delete '${e.path}': ${msg}\n`;
            status = 1;
            return false;
          }
        });
      }
      case '-prune': return pred(t, (e) => { if (!depthFirst) pruned.add(e); return true; });
      case '-quit': hasAction = true; return pred(t, () => { quit = true; return true; });
      case '-exec': case '-execdir': case '-ok': case '-okdir': {
        hasAction = true;
        const cmd: string[] = [];
        let plus = false;
        for (;;) {
          if (p >= toks.length) throw new FindError(`missing argument to \`${t}'`);
          const a = toks[p++];
          if (a === ';') break;
          if (a === '+' && cmd.length && cmd[cmd.length - 1] === '{}' && !t.startsWith('-ok')) { cmd.pop(); plus = true; break; }
          cmd.push(a);
        }
        if (!cmd.length) throw new FindError(`missing argument to \`${t}'`);
        const inDir = t.endsWith('dir');
        if (plus) {
          const batch = { argv: cmd, dir: inDir, items: new Map<string, string[]>() };
          plusBatches.push(batch);
          return pred(t, (e) => {
            const dir = inDir ? dirOf(e.abs) : ctx.cwd;
            const arg = inDir ? './' + baseOf(e.abs) : e.path;
            if (!batch.items.has(dir)) batch.items.set(dir, []);
            batch.items.get(dir)!.push(arg);
            return true;
          });
        }
        return pred(t, async (e) => {
          const arg = inDir ? (e.depth === 0 && e.name === '.' ? '.' : './' + baseOf(e.abs)) : e.path;
          const argv = cmd.map((a) => a.split('{}').join(arg));
          const cwd = inDir ? dirOf(e.abs) : ctx.cwd;
          if (t.startsWith('-ok')) {
            out.stderr += `< ${argv[0]} ... ${arg} > ? `;
            const rest = (ctx.stdin || '').slice(stdinPos);
            const nl = rest.indexOf('\n');
            const answer = nl < 0 ? rest : rest.slice(0, nl);
            stdinPos += nl < 0 ? rest.length : nl + 1;
            if (!/^\s*[yY]/.test(answer)) return false;
          }
          return (await runArgv(ctx, argv, cwd, '', out)) === 0;
        });
      }
      default:
        if (t === undefined) throw new FindError('invalid expression');
        if (t === ')') throw new FindError(`invalid expression; you have too many ')'`);
        if (t === '-o' || t === '-or' || t === '-a' || t === '-and' || t === ',') {
          throw new FindError(`invalid expression; you have used a binary operator '${t}' with nothing before it.`);
        }
        if (t.startsWith('-')) throw new FindError(`unknown predicate \`${t}'`);
        throw new FindError(`paths must precede expression: \`${t}'`);
    }
  };
  const unary = (): Node => primary();
  const parseAnd = (): Node => {
    let l = unary();
    for (;;) {
      const t = peek();
      if (t === '-a' || t === '-and') { p++; if (p >= toks.length) throw new FindError(`invalid expression; you have used a binary operator '${t}' with nothing after it.`); l = { k: 'and', l, r: unary() }; continue; }
      if (t === undefined || t === '-o' || t === '-or' || t === ')' || t === ',') return l;
      l = { k: 'and', l, r: unary() };
    }
  };
  const parseOr = (): Node => {
    let l = parseAnd();
    while (peek() === '-o' || peek() === '-or') {
      const t = toks[p++];
      if (p >= toks.length) throw new FindError(`invalid expression; you have used a binary operator '${t}' with nothing after it.`);
      l = { k: 'or', l, r: parseAnd() };
    }
    return l;
  };
  const parseComma = (): Node => {
    let l = parseOr();
    while (peek() === ',') { p++; l = { k: 'comma', l, r: parseOr() }; }
    return l;
  };

  let expr: Node | null = toks.length ? parseComma() : null;
  if (p < toks.length) {
    if (toks[p] === ')') throw new FindError(`invalid expression; you have too many ')'`);
    throw new FindError(`paths must precede expression: \`${toks[p]}'`);
  }
  if (!hasAction) {
    const print: Node = { k: 'pred', name: '-print', fn: (e) => { out.stdout += e.path + '\n'; return true; } };
    expr = expr ? { k: 'and', l: expr, r: print } : print;
  }

  const evalNode = async (n: Node, e: Entry): Promise<boolean> => {
    switch (n.k) {
      case 'and': return (await evalNode(n.l, e)) && !quit && evalNode(n.r, e);
      case 'or': return (await evalNode(n.l, e)) || (!quit && evalNode(n.r, e));
      case 'comma': await evalNode(n.l, e); return quit ? false : evalNode(n.r, e);
      case 'not': return !(await evalNode(n.e, e));
      case 'pred': return n.fn(e);
    }
  };

  const visit = async (e: Entry) => {
    if (e.depth >= minDepth && e.depth <= maxDepth) await evalNode(expr!, e);
  };

  const walk = async (e: Entry): Promise<void> => {
    if (quit) return;
    const isDir = typeChar(e.st) === 'd';
    if (!depthFirst) await visit(e);
    if (quit) return;
    if (isDir && e.depth < maxDepth && !pruned.has(e)) {
      let names: string[] = [];
      try {
        names = await fs.readdir(await fs.realpath(e.abs).catch(() => e.abs));
      } catch {
        out.stderr += `find: '${e.path}': Permission denied\n`;
        status = 1;
      }
      for (const name of names) {
        if (quit) return;
        const abs = e.abs === '/' ? '/' + name : e.abs + '/' + name;
        const path = e.path.endsWith('/') ? e.path + name : e.path + '/' + name;
        let st = await statOf(abs, follow === 'L');
        if (!st && follow === 'L') st = await statOf(abs, false);
        if (!st) {
          out.stderr += `find: '${path}': No such file or directory\n`;
          status = 1;
          continue;
        }
        if (follow === 'L' && typeChar(st) === 'd') {
          // loop detection: an ancestor resolving to the same directory
          const real = await fs.realpath(abs).catch(() => abs);
          if (await isAncestorLoop(fs, e, real)) {
            out.stderr += `find: File system loop detected; '${path}' is part of the same file system loop as '${e.path}'.\n`;
            status = 1;
            continue;
          }
        }
        await walk({ path, abs, name, depth: e.depth + 1, st, start: e.start });
      }
    }
    if (depthFirst && !quit) await visit(e);
    pruned.delete(e);
  };
  void xdev;

  for (const s of starts) {
    if (quit) break;
    if (s === '') {
      out.stderr += `find: '': No such file or directory\n`;
      status = 1;
      continue;
    }
    const abs = fs.resolvePath(s, ctx.cwd);
    let st = await statOf(abs, follow !== 'P');
    if (!st && follow !== 'P') st = await statOf(abs, false);
    if (!st) {
      out.stderr += `find: '${s}': No such file or directory\n`;
      status = 1;
      continue;
    }
    if (/\/$/.test(s) && typeChar(st) !== 'd' && !(typeChar(st) === 'l')) {
      out.stderr += `find: '${s}': Not a directory\n`;
      status = 1;
      continue;
    }
    const trimmed = s.replace(/\/+$/, '');
    const name = trimmed === '' ? '/' : trimmed.slice(trimmed.lastIndexOf('/') + 1);
    await walk({ path: s, abs, name, depth: 0, st, start: s });
  }

  // -exec ... {} + batches
  for (const b of plusBatches) {
    for (const [dir, items] of b.items) {
      const CHUNK = 4096;
      for (let k = 0; k < items.length; k += CHUNK) {
        const code = await runArgv(ctx, [...b.argv, ...items.slice(k, k + CHUNK)], dir, '', out);
        if (code !== 0) status = 1;
      }
    }
  }
  for (const [path, text] of fileOutputs) {
    try { await fs.writeFile(path, text); } catch (err: any) { out.stderr += `find: '${path}': ${err.message}\n`; status = 1; }
  }
  ctx.stdout += out.stdout;
  ctx.stderr += out.stderr;
  return status;
}

function dirOf(abs: string): string {
  const i = abs.lastIndexOf('/');
  return i <= 0 ? '/' : abs.slice(0, i);
}

function baseOf(abs: string): string {
  return abs.slice(abs.lastIndexOf('/') + 1) || '/';
}

async function isAncestorLoop(fs: any, e: Entry, real: string): Promise<boolean> {
  // Only the direct chain is known through Entry.abs prefixes
  let a = e.abs;
  for (;;) {
    const r = await fs.realpath(a).catch(() => a);
    if (r === real) return true;
    if (a === '/' || !a) return false;
    a = dirOf(a);
  }
}
