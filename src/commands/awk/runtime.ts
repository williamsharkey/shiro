/**
 * awk runtime: value semantics (number / string / strnum / uninitialized),
 * records and fields, input sources, output redirections, and the builtin
 * functions that need more than a line of generated code.
 */
import type { CommandContext } from '../index';
import { awkSprintf, numToString, intString } from './format';
import { compileEre, compileEreGlobal } from './regex';
import { unescapeString } from './lexer';

/** A string from input (field, getline var, split element, ARGV, ENVIRON, -v): numeric if it looks numeric */
export class SN {
  n: number | undefined = undefined;
  numLike = false;
  constructor(public s: string) {}
}

/** undefined is the uninitialized value */
export type AwkVal = number | string | SN | undefined;

export class AwkFatal extends Error {
  /** exit status; gawk exits 1 for non-fatal `error:` conditions like division by zero */
  constructor(msg: string, public status = 2, public kind = 'fatal') { super(msg); }
}
export class ExitSig { constructor(public code: number | undefined) {} }
export const NEXT = { next: true };
export const NEXTFILE = { nextfile: true };

const EMPTY = new SN('');
EMPTY.n = 0;

const INFNAN = /^[ \t\n\r\f\v]*([-+])(inf|nan)/i;

function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}

/** Scan a decimal number at s[i]: the index after it, or -1 if there is none */
function scanNumber(s: string, i: number): number {
  const n = s.length;
  let c = s.charCodeAt(i);
  if (c === 43 || c === 45) c = s.charCodeAt(++i);
  let digits = 0;
  while (c >= 48 && c <= 57) { digits++; c = s.charCodeAt(++i); }
  if (c === 46) {
    c = s.charCodeAt(++i);
    while (c >= 48 && c <= 57) { digits++; c = s.charCodeAt(++i); }
  }
  if (!digits) return -1;
  if (c === 101 || c === 69) {
    let j = i + 1;
    let d = s.charCodeAt(j);
    if (d === 43 || d === 45) d = s.charCodeAt(++j);
    if (d >= 48 && d <= 57) {
      while (j < n && (d = s.charCodeAt(j)) >= 48 && d <= 57) j++;
      i = j;
    }
  }
  return i;
}

/** strtod-like: the longest numeric prefix, 0 if none (and [-+]inf/nan, as gawk) */
export function strToNum(s: string): number {
  let i = 0;
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  const end = scanNumber(s, i);
  if (end >= 0) return Number(s.slice(i, end));
  const f = INFNAN.exec(s);
  if (f) {
    if (f[2].toLowerCase() === 'nan') return NaN;
    return f[1] === '-' ? -Infinity : Infinity;
  }
  return 0;
}

function snInit(v: SN): void {
  const s = v.s;
  let i = 0;
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  let end = scanNumber(s, i);
  if (end >= 0) {
    v.n = Number(s.slice(i, end));
    while (end < s.length && isSpace(s.charCodeAt(end))) end++;
    v.numLike = end === s.length;
    return;
  }
  v.n = strToNum(s);
  v.numLike = /^[ \t\n\r\f\v]*[-+](inf|nan)[ \t\n\r\f\v]*$/i.test(s);
}

export function num(v: AwkVal): number {
  if (typeof v === 'number') return v;
  if (v === undefined) return 0;
  if (typeof v === 'string') return strToNum(v);
  if (v.n === undefined) snInit(v);
  return v.n!;
}

/** Number or uninitialized or numeric-looking strnum: compares numerically */
function isNumLike(v: AwkVal): boolean {
  if (typeof v === 'number' || v === undefined) return true;
  if (typeof v === 'string') return false;
  if (v.n === undefined) snInit(v);
  return v.numLike;
}

export function bool(v: AwkVal): boolean {
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '';
  if (v === undefined) return false;
  if (v.n === undefined) snInit(v);
  return v.numLike ? v.n !== 0 : v.s !== '';
}

interface Out { kind: '>' | '>>' | '|'; buf: string; opened: boolean }

/** A text being read record by record */
class Source {
  pos = 0;
  constructor(public text: string) {}

  read(rt: Runtime): string | null {
    const text = this.text;
    const len = text.length;
    if (this.pos >= len) return null;
    const rs = rt.S(rt.RS);
    if (rs.length === 1) {
      const idx = text.indexOf(rs, this.pos);
      let rec: string;
      if (idx < 0) { rec = text.slice(this.pos); this.pos = len; rt.RT = ''; }
      else { rec = text.slice(this.pos, idx); this.pos = idx + 1; rt.RT = rs; }
      return rec;
    }
    if (rs === '') {
      // paragraph mode
      let p = this.pos;
      while (p < len && text[p] === '\n') p++;
      if (p >= len) { this.pos = len; return null; }
      const re = /\n\n+/g;
      re.lastIndex = p;
      const m = re.exec(text);
      if (!m) {
        let rec = text.slice(p);
        let t = '';
        const tm = /\n+$/.exec(rec);
        if (tm) { t = tm[0]; rec = rec.slice(0, tm.index); }
        this.pos = len;
        rt.RT = t;
        return rec;
      }
      this.pos = m.index + m[0].length;
      rt.RT = m[0];
      return text.slice(p, m.index);
    }
    const re = compileEreGlobal(rs);
    let from = this.pos;
    for (;;) {
      re.lastIndex = from;
      const m = re.exec(text);
      if (!m) {
        const rec = text.slice(this.pos);
        this.pos = len;
        rt.RT = '';
        return rec;
      }
      if (m[0] === '') { from = m.index + 1; if (from > len) { const rec = text.slice(this.pos); this.pos = len; rt.RT = ''; return rec; } continue; }
      const rec = text.slice(this.pos, m.index);
      this.pos = m.index + m[0].length;
      rt.RT = m[0];
      return rec;
    }
  }
}

const SPECIAL_NUM = new Set(['NR', 'FNR', 'RSTART', 'RLENGTH', 'ARGC']);

export class Runtime {
  // special variables
  FS: AwkVal = ' ';
  OFS: AwkVal = ' ';
  ORS: AwkVal = '\n';
  RS: AwkVal = '\n';
  SUBSEP: AwkVal = '\x1c';
  CONVFMT: AwkVal = '%.6g';
  OFMT: AwkVal = '%.6g';
  RSTART: AwkVal = 0;
  RLENGTH: AwkVal = -1;
  NR: AwkVal = 0;
  FNR: AwkVal = 0;
  FILENAME: AwkVal = '';
  ARGC: AwkVal = 0;
  RT: AwkVal = '';
  ERRNO: AwkVal = '';
  IGNORECASE: AwkVal = 0;
  ENVIRON = new Map<string, AwkVal>();
  ARGV = new Map<string, AwkVal>();
  PROCINFO = new Map<string, AwkVal>();

  // record
  private rec = '';
  private rec0: SN = EMPTY;
  private fields: AwkVal[] = [];
  private nf = 0;
  private splitDone = true;
  private recDirty = false;
  private recFS = ' ';
  private recPara = false;

  // input
  private argi = 1;
  private usedFile = false;
  private cur: Source | null = null;
  private stdinSrc: Source | null = null;
  private files = new Map<string, Source>();
  private cmds = new Map<string, Source>();
  private outs = new Map<string, Out>();

  private seed = 0;
  private prevSeed = 0;
  private randState = 0;
  /** command-line `var=value` assignments, set by the compiled program */
  assignVar: (name: string, v: AwkVal) => void = () => {};

  readonly h: {
    N: (v: AwkVal) => number; S: (v: AwkVal) => string; O: (v: AwkVal) => string; B: (v: AwkVal) => boolean;
    C: (a: AwkVal, b: AwkVal) => number; K: (v: AwkVal) => string;
  };

  constructor(public ctx: CommandContext, private stdinText: string = ctx.stdin) {
    this.srandInit(0);
    const S = (v: AwkVal) => this.S(v);
    this.h = {
      N: num,
      S,
      O: (v: AwkVal) => this.O(v),
      B: bool,
      C: (a, b) => this.cmp(a, b),
      K: (v: AwkVal) => (typeof v === 'number' && Number.isInteger(v) ? intString(v) : S(v)),
    };
  }

  S(v: AwkVal): string {
    if (typeof v === 'string') return v;
    if (v === undefined) return '';
    if (typeof v === 'number') {
      if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v === 0 ? 0 : v);
      const f = this.CONVFMT;
      return numToString(v, typeof f === 'string' ? f : this.S(f));
    }
    return v.s;
  }

  O(v: AwkVal): string {
    if (typeof v === 'number') {
      if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v === 0 ? 0 : v);
      const f = this.OFMT;
      return numToString(v, typeof f === 'string' ? f : this.S(f));
    }
    return this.S(v);
  }

  cmp(a: AwkVal, b: AwkVal): number {
    if (isNumLike(a) && isNumLike(b)) {
      const x = num(a);
      const y = num(b);
      if (x < y) return -1;
      if (x > y) return 1;
      if (x === y) return 0;
      // NaN: unordered; gawk treats it as not equal
      return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
    }
    const s = this.S(a);
    const t = this.S(b);
    return s < t ? -1 : s > t ? 1 : 0;
  }

  fatal(msg: string): never {
    throw new AwkFatal(msg);
  }

  error(msg: string): never {
    throw new AwkFatal(msg, 1, 'error');
  }

  // ---- records and fields ----

  setRecord(text: string): void {
    this.rec = text;
    this.rec0 = new SN(text);
    this.splitDone = false;
    this.recDirty = false;
    this.recFS = this.S(this.FS);
    this.recPara = this.S(this.RS) === '';
  }

  private ensureSplit(): void {
    if (this.splitDone) return;
    this.splitDone = true;
    const parts = this.splitText(this.rec, this.recFS, this.recPara);
    this.nf = parts.length;
    const f: AwkVal[] = new Array(parts.length + 1);
    f[0] = undefined;
    for (let i = 0; i < parts.length; i++) f[i + 1] = new SN(parts[i]);
    this.fields = f;
  }

  /** Split by an FS value (string) */
  splitText(s: string, fs: string, para = false): string[] {
    if (s === '') return [];
    if (fs === ' ') {
      const out: string[] = [];
      const n = s.length;
      let i = 0;
      for (;;) {
        let c = s.charCodeAt(i);
        while (i < n && (c === 32 || c === 9 || c === 10)) c = s.charCodeAt(++i);
        if (i >= n) break;
        const start = i;
        while (i < n && c !== 32 && c !== 9 && c !== 10) c = s.charCodeAt(++i);
        out.push(s.slice(start, i));
      }
      return out;
    }
    if (fs.length === 1 && fs !== '\\') {
      if (para && fs !== '\n') {
        return s.split(fs === '\n' ? '\n' : new RegExp('[' + (fs === ']' || fs === '^' ? '\\' + fs : fs) + '\\n]'));
      }
      if (fs === '\t' || !/[A-Za-z]/.test(fs) || !this.ignoreCase()) return s.split(fs);
    }
    if (fs === '') return [...s];
    return this.splitRegex(s, para ? '(?:' + fs + ')|\n' : fs, null);
  }

  private ignoreCase(): boolean {
    return bool(this.IGNORECASE);
  }

  /** Split on non-empty matches of an ERE; seps collects the separators */
  splitRegex(s: string, re: string | RegExp, seps: string[] | null): string[] {
    const g = typeof re === 'string' ? compileEreGlobal(re) : new RegExp(re.source, 'gs');
    const out: string[] = [];
    let start = 0;
    let from = 0;
    while (from <= s.length) {
      g.lastIndex = from;
      const m = g.exec(s);
      if (!m) break;
      if (m[0] === '') { from = m.index + 1; continue; }
      out.push(s.slice(start, m.index));
      if (seps) seps.push(m[0]);
      start = from = m.index + m[0].length;
    }
    out.push(s.slice(start));
    return out;
  }

  get0(): SN {
    if (this.recDirty) this.rebuild();
    return this.rec0;
  }

  private rebuild(): void {
    const ofs = this.S(this.OFS);
    let s = '';
    for (let i = 1; i <= this.nf; i++) {
      if (i > 1) s += ofs;
      s += this.S(this.fields[i]);
    }
    this.rec = s;
    this.rec0 = new SN(s);
    this.recDirty = false;
  }

  getField(i: number): AwkVal {
    if (i === 0) return this.get0();
    if (!(i >= 0)) this.fatal(`attempt to access field ${intString(i)}`);
    i = Math.trunc(i);
    if (i === 0) return this.get0();
    this.ensureSplit();
    return i <= this.nf ? this.fields[i] : EMPTY;
  }

  setField(i: number, v: AwkVal): AwkVal {
    if (!(i >= 0)) this.fatal(`attempt to access field ${intString(i)}`);
    i = Math.trunc(i);
    if (i === 0) {
      const s = this.S(v);
      this.setRecord(s);
      return v;
    }
    this.ensureSplit();
    if (i > this.nf) {
      for (let k = this.nf + 1; k < i; k++) this.fields[k] = EMPTY;
      this.nf = i;
    }
    this.fields[i] = v;
    this.recDirty = true;
    return v;
  }

  getNF(): number {
    this.ensureSplit();
    return this.nf;
  }

  setNF(v: AwkVal): AwkVal {
    this.ensureSplit();
    const n = Math.trunc(num(v));
    if (n < 0) this.fatal(`NF set to negative value`);
    for (let k = this.nf + 1; k <= n; k++) this.fields[k] = EMPTY;
    this.fields.length = n + 1;
    this.nf = n;
    this.recDirty = true;
    return v;
  }

  // ---- arrays ----

  aget(m: Map<string, AwkVal>, k: string): AwkVal {
    const v = m.get(k);
    if (v === undefined && !m.has(k)) m.set(k, undefined);
    return v;
  }

  aset(m: Map<string, AwkVal>, k: string, v: AwkVal): AwkVal {
    m.set(k, v);
    return v;
  }

  // ---- input ----

  private stdin(): Source {
    if (!this.stdinSrc) this.stdinSrc = new Source(this.stdinText);
    return this.stdinSrc;
  }

  private async readFile(name: string): Promise<string | null> {
    if (name === '-' || name === '/dev/stdin') return null;
    await this.flushAll();
    const path = this.ctx.fs.resolvePath(name, this.ctx.cwd);
    const data = await this.ctx.fs.readFile(path, 'utf8');
    return typeof data === 'string' ? data : new TextDecoder().decode(data);
  }

  private async openNextMain(): Promise<boolean> {
    while (this.argi < num(this.ARGC)) {
      const a = this.ARGV.get(String(this.argi++));
      const s = this.S(a);
      if (a === undefined || s === '') continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(s);
      if (m) {
        this.assignVar(m[1], this.cmdlineValue(m[2]));
        continue;
      }
      this.usedFile = true;
      if (s === '-' || s === '/dev/stdin') {
        this.cur = this.stdin();
      } else {
        let text: string | null;
        try {
          text = await this.readFile(s);
        } catch (e) {
          const msg = /EISDIR|is a directory/i.test(String(e)) ? 'Is a directory' : 'No such file or directory';
          if (msg === 'Is a directory') {
            this.ctx.stderr += `awk: warning: command line argument \`${s}' is a directory: skipped\n`;
            continue;
          }
          this.fatal(`cannot open file \`${s}' for reading: ${msg}`);
        }
        this.cur = new Source(text ?? '');
      }
      this.FILENAME = s;
      this.FNR = 0;
      return true;
    }
    if (!this.usedFile) {
      this.usedFile = true;
      this.cur = this.stdin();
      this.FILENAME = '-';
      this.FNR = 0;
      return true;
    }
    return false;
  }

  /** Value of a command-line or -v assignment: escapes processed, strnum */
  cmdlineValue(raw: string): SN {
    return new SN(unescapeString(raw));
  }

  async nextMainRecord(): Promise<string | null> {
    for (;;) {
      if (this.cur) {
        const r = this.cur.read(this);
        if (r !== null) {
          this.NR = num(this.NR) + 1;
          this.FNR = num(this.FNR) + 1;
          return r;
        }
        this.cur = null;
      }
      if (!(await this.openNextMain())) return null;
    }
  }

  /** nextfile: drop the rest of the current file */
  skipFile(): void {
    if (this.cur) this.cur.pos = this.cur.text.length;
  }

  async getlineMain(set?: (v: AwkVal) => void): Promise<number> {
    const r = await this.nextMainRecord();
    if (r === null) return 0;
    if (set) set(new SN(r));
    else this.setRecord(r);
    return 1;
  }

  async getlineFile(name: string, set?: (v: AwkVal) => void): Promise<number> {
    let src = this.files.get(name);
    if (!src) {
      if (name === '-' || name === '/dev/stdin') src = this.stdin();
      else {
        try {
          src = new Source((await this.readFile(name)) ?? '');
        } catch {
          this.ERRNO = 'No such file or directory';
          return -1;
        }
      }
      this.files.set(name, src);
    }
    const r = src.read(this);
    if (r === null) return 0;
    if (set) set(new SN(r));
    else { this.setRecord(r); }
    return 1;
  }

  async getlineCmd(cmd: string, set?: (v: AwkVal) => void): Promise<number> {
    let src = this.cmds.get(cmd);
    if (!src) {
      this.flushStdout();
      await this.flushAll();
      const { out } = await this.runCmd(cmd, '');
      src = new Source(out);
      this.cmds.set(cmd, src);
    }
    const r = src.read(this);
    if (r === null) return 0;
    // gawk: cmd | getline sets $0/NF or var (and RT), not NR
    if (set) set(new SN(r));
    else { this.setRecord(r); }
    return 1;
  }

  // ---- output ----

  /** stdout not yet written: like gawk writing to a pipe, output is block-buffered
   * and flushed before running commands, at close/fflush and after pipes close at exit */
  private obuf = '';

  out(text: string): void {
    if (this.ctx.stdoutIsTTY) this.ctx.stdout += text;
    else this.obuf += text;
  }

  flushStdout(): void {
    if (this.obuf) { this.ctx.stdout += this.obuf; this.obuf = ''; }
  }

  outTo(kind: '>' | '>>' | '|', name: string, text: string): void {
    if (kind !== '|') {
      if (name === '/dev/stdout' || name === '-') { this.out(text); return; }
      if (name === '/dev/stderr') { this.ctx.stderr += text; return; }
    }
    let o = this.outs.get(name);
    if (!o) {
      if (kind === '|') this.flushStdout();
      o = { kind, buf: '', opened: false };
      this.outs.set(name, o);
    }
    o.buf += text;
  }

  private async flushOut(name: string, o: Out): Promise<number> {
    if (o.kind === '|') {
      const text = o.buf;
      o.buf = '';
      const { out, code } = await this.runCmd(name, text);
      this.ctx.stdout += out;
      return code;
    }
    const path = this.ctx.fs.resolvePath(name, this.ctx.cwd);
    if (!o.opened && o.kind === '>') {
      await this.ctx.fs.writeFile(path, o.buf);
    } else if (o.buf !== '' || !o.opened) {
      await (this.ctx.fs as any).appendFile(path, o.buf);
    }
    o.opened = true;
    o.buf = '';
    return 0;
  }

  /** Write buffered file output (pipes run at close) */
  async flushAll(): Promise<void> {
    for (const [name, o] of this.outs) {
      if (o.kind !== '|' && (o.buf !== '' || !o.opened)) await this.flushOut(name, o);
    }
  }

  async close(name: string): Promise<number> {
    let found = false;
    let code = 0;
    const o = this.outs.get(name);
    if (o) {
      found = true;
      this.flushStdout();
      this.outs.delete(name);
      code = await this.flushOut(name, o);
    }
    if (this.files.delete(name)) found = true;
    if (this.cmds.delete(name)) found = true;
    return found ? code : -1;
  }

  async closeAll(): Promise<void> {
    const pending = this.obuf;
    this.obuf = '';
    for (const name of [...this.outs.keys()]) {
      const o = this.outs.get(name)!;
      this.outs.delete(name);
      try { await this.flushOut(name, o); } catch (e) {
        this.ctx.stderr += `awk: close of \`${name}' failed: ${e instanceof Error ? e.message : e}\n`;
      }
    }
    this.ctx.stdout += pending + this.obuf;
    this.obuf = '';
  }

  async fflush(name?: string): Promise<number> {
    this.flushStdout();
    if (name === undefined || name === '') {
      await this.flushAll();
      return 0;
    }
    const o = this.outs.get(name);
    if (!o) return name === '/dev/stdout' || name === '/dev/stderr' ? 0 : -1;
    if (o.kind !== '|') await this.flushOut(name, o);
    return 0;
  }

  async runCmd(cmd: string, stdin: string): Promise<{ out: string; code: number }> {
    const sh: any = (this.ctx.shell as any).fork();
    sh.cwd = this.ctx.cwd;
    let out = '';
    let code: number;
    try {
      code = await sh.executeWithStdin(cmd, stdin, (s: string) => { out += s; }, (s: string) => { this.ctx.stderr += s.replace(/\r\n/g, '\n'); });
    } catch (e) {
      this.ctx.stderr += `awk: ${e instanceof Error ? e.message : e}\n`;
      code = 127;
    }
    return { out: out.replace(/\r\n/g, '\n'), code };
  }

  async system(cmd: string): Promise<number> {
    this.flushStdout();
    await this.flushAll();
    const { out, code } = await this.runCmd(cmd, '');
    this.ctx.stdout += out;
    return code;
  }

  // ---- builtins ----

  sprintf(args: AwkVal[]): string {
    if (args.length === 0) return '';
    const fmt = this.S(args[0]);
    let i = 1;
    return awkSprintf(fmt, {
      num: () => { if (i >= args.length) this.fatal('not enough arguments to satisfy format string'); return num(args[i++]); },
      str: () => { if (i >= args.length) this.fatal('not enough arguments to satisfy format string'); return this.S(args[i++]); },
      peekIsNum: () => {
        const v = args[i];
        return typeof v === 'number' || (v instanceof SN && isNumLike(v));
      },
      more: () => i < args.length,
    }, (c) => {
      const n = Math.trunc(c);
      if (n < 0 || n > 0x10ffff || Number.isNaN(n)) return String.fromCharCode(n & 0xff);
      return String.fromCodePoint(n);
    });
  }

  substr(s: string, m: number, n?: number): string {
    let start = Math.trunc(m);
    if (!(start >= 1)) start = 1;
    if (n === undefined) return s.slice(start - 1);
    if (Number.isNaN(n)) return '';
    const len = n === Infinity ? s.length : Math.trunc(n);
    if (!(len >= 1)) return '';
    return s.slice(start - 1, start - 1 + len);
  }

  split(s: string, arr: Map<string, AwkVal>, sep?: AwkVal | RegExp, seps?: Map<string, AwkVal>): number {
    arr.clear();
    if (seps) seps.clear();
    if (s === '') return 0;
    let parts: string[];
    const sepList: string[] | null = seps ? [] : null;
    if (sep instanceof RegExp) {
      parts = this.splitRegex(s, sep, sepList);
    } else {
      const fs = sep === undefined ? this.S(this.FS) : this.S(sep);
      if (fs === ' ' && sepList) {
        const lead = /^[ \t\n]+/.exec(s);
        if (lead) { seps!.set('0', lead[0]); s = s.slice(lead[0].length); }
        const trail = /[ \t\n]+$/.exec(s);
        parts = s === '' ? [] : this.splitRegex(s.slice(0, trail ? trail.index : s.length), '[ \t\n]+', sepList);
        if (trail && parts.length) sepList.push(trail[0]);
      } else if (fs.length === 1 && fs !== ' ' && fs !== '\\') {
        parts = s.split(fs);
        if (sepList) for (let k = 1; k < parts.length; k++) sepList.push(fs);
      } else if (fs === ' ' || fs === '') {
        parts = this.splitText(s, fs);
      } else {
        parts = this.splitRegex(s, fs, sepList);
      }
    }
    for (let k = 0; k < parts.length; k++) arr.set(String(k + 1), new SN(parts[k]));
    if (seps && sepList) for (let k = 0; k < sepList.length; k++) seps.set(String(k + 1), new SN(sepList[k]));
    return parts.length;
  }

  private icaseCache = new Map<RegExp, RegExp>();
  icase(r: RegExp): RegExp {
    let c = this.icaseCache.get(r);
    if (!c) { c = new RegExp(r.source, r.flags + 'i'); this.icaseCache.set(r, c); }
    return c;
  }

  re(v: AwkVal | RegExp): RegExp {
    if (v instanceof RegExp) return v;
    const src = this.S(v);
    if (bool(this.IGNORECASE)) {
      const r = compileEre(src);
      return new RegExp(r.source, 'si');
    }
    return compileEre(src);
  }

  match(s: string, re: RegExp, arr?: Map<string, AwkVal>): number {
    const m = re.exec(s);
    if (arr) arr.clear();
    if (!m) {
      this.RSTART = 0;
      this.RLENGTH = -1;
      return 0;
    }
    this.RSTART = m.index + 1;
    this.RLENGTH = m[0].length;
    if (arr) {
      let pos = m.index;
      for (let k = 0; k < m.length; k++) {
        if (m[k] === undefined) continue;
        arr.set(String(k), new SN(m[k]));
        // group offsets (approximate for groups: first occurrence at or after the match start)
        const start = k === 0 ? m.index : s.indexOf(m[k], pos);
        arr.set(k + this.S(this.SUBSEP) + 'start', start + 1);
        arr.set(k + this.S(this.SUBSEP) + 'length', m[k].length);
        if (k === 0) pos = m.index;
      }
    }
    return m.index + 1;
  }

  /** sub/gsub: the new text, or null when nothing matched; subCount has the count */
  subCount = 0;
  subst(re: RegExp, repl: string, target: string, global: boolean): string | null {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let out = '';
    let pos = 0;
    let count = 0;
    let lastEnd = -1;
    const len = target.length;
    while (pos <= len) {
      g.lastIndex = pos;
      const m = g.exec(target);
      if (!m) break;
      const start = m.index;
      const end = start + m[0].length;
      if (start === end && start === lastEnd) {
        // no empty match right after a previous match
        if (start >= len) break;
        out += target.slice(pos, start + 1);
        pos = start + 1;
        continue;
      }
      out += target.slice(pos, start) + subRepl(repl, m[0]);
      count++;
      lastEnd = end;
      if (start === end) {
        if (start < len) out += target[start];
        pos = start + 1;
      } else pos = end;
      if (!global) break;
    }
    this.subCount = count;
    if (count === 0) return null;
    if (pos < len) out += target.slice(pos);
    return out;
  }

  gensub(re: RegExp, repl: string, how: AwkVal, target: string): string {
    const hs = this.S(how);
    const global = /^[gG]/.test(hs);
    let which = global ? 0 : Math.trunc(num(how));
    if (!global && which < 1) which = 1;
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let out = '';
    let pos = 0;
    let n = 0;
    let lastEnd = -1;
    const len = target.length;
    while (pos <= len) {
      g.lastIndex = pos;
      const m = g.exec(target);
      if (!m) break;
      const start = m.index;
      const end = start + m[0].length;
      if (start === end && start === lastEnd) {
        if (start >= len) break;
        out += target.slice(pos, start + 1);
        pos = start + 1;
        continue;
      }
      n++;
      out += target.slice(pos, start);
      if (global || n === which) out += gensubRepl(repl, m);
      else out += m[0];
      lastEnd = end;
      if (start === end) {
        if (start < len) out += target[start];
        pos = start + 1;
      } else pos = end;
      if (!global && n >= which) break;
    }
    if (pos < len) out += target.slice(pos);
    return out;
  }

  // rand: a 48-bit LCG (drand48)
  private srandInit(seed: number): void {
    this.seed = seed;
    const s = BigInt.asUintN(32, BigInt(Math.trunc(seed)));
    this.randState = Number(((s << 16n) | 0x330en) & 0xffffffffffffn);
  }

  rand(): number {
    const a = 0x5deece66dn;
    const next = (BigInt(this.randState) * a + 0xbn) & 0xffffffffffffn;
    this.randState = Number(next);
    return this.randState / 2 ** 48;
  }

  srand(v?: AwkVal): number {
    const prev = this.seed;
    this.prevSeed = prev;
    this.srandInit(v === undefined ? Math.floor(Date.now() / 1000) : num(v));
    return prev;
  }

  strftime(fmt?: string, t?: number, utc?: boolean): string {
    const d = new Date((t === undefined ? Date.now() / 1000 : t) * 1000);
    const f = fmt ?? '%a %b %e %H:%M:%S %Z %Y';
    const g = (k: 'FullYear' | 'Month' | 'Date' | 'Hours' | 'Minutes' | 'Seconds' | 'Day') => (d as any)[(utc ? 'getUTC' : 'get') + k]() as number;
    const p2 = (n: number) => String(n).padStart(2, '0');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return f.replace(/%([a-zA-Z%])/g, (_m, c: string) => {
      switch (c) {
        case 'Y': return String(g('FullYear'));
        case 'y': return p2(g('FullYear') % 100);
        case 'm': return p2(g('Month') + 1);
        case 'd': return p2(g('Date'));
        case 'e': return String(g('Date')).padStart(2, ' ');
        case 'H': return p2(g('Hours'));
        case 'I': return p2(((g('Hours') + 11) % 12) + 1);
        case 'M': return p2(g('Minutes'));
        case 'S': return p2(g('Seconds'));
        case 'p': return g('Hours') < 12 ? 'AM' : 'PM';
        case 'a': return days[g('Day')].slice(0, 3);
        case 'A': return days[g('Day')];
        case 'b': case 'h': return months[g('Month')].slice(0, 3);
        case 'B': return months[g('Month')];
        case 'j': {
          const start = utc ? Date.UTC(g('FullYear'), 0, 1) : new Date(g('FullYear'), 0, 1).getTime();
          return String(Math.floor((d.getTime() - start) / 86400000) + 1).padStart(3, '0');
        }
        case 'Z': return utc ? 'UTC' : (this.ctx.env.TZ || 'UTC');
        case 'z': {
          const off = utc ? 0 : -d.getTimezoneOffset();
          return (off < 0 ? '-' : '+') + p2(Math.floor(Math.abs(off) / 60)) + p2(Math.abs(off) % 60);
        }
        case 's': return String(Math.floor(d.getTime() / 1000));
        case 'u': return String(g('Day') || 7);
        case 'w': return String(g('Day'));
        case 'D': return `${p2(g('Month') + 1)}/${p2(g('Date'))}/${p2(g('FullYear') % 100)}`;
        case 'F': return `${g('FullYear')}-${p2(g('Month') + 1)}-${p2(g('Date'))}`;
        case 'T': return `${p2(g('Hours'))}:${p2(g('Minutes'))}:${p2(g('Seconds'))}`;
        case 'R': return `${p2(g('Hours'))}:${p2(g('Minutes'))}`;
        case 'c': return `${days[g('Day')].slice(0, 3)} ${months[g('Month')].slice(0, 3)} ${String(g('Date')).padStart(2, ' ')} ${p2(g('Hours'))}:${p2(g('Minutes'))}:${p2(g('Seconds'))} ${g('FullYear')}`;
        case 'n': return '\n';
        case 't': return '\t';
        case '%': return '%';
      }
      return '%' + c;
    });
  }

  mktime(spec: string, utc?: boolean): number {
    const p = spec.trim().split(/\s+/).map(Number);
    if (p.length < 6 || p.some((x) => Number.isNaN(x))) return -1;
    const t = utc ? Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]) : new Date(p[0], p[1] - 1, p[2], p[3], p[4], p[5]).getTime();
    return Math.floor(t / 1000);
  }

  asort(src: Map<string, AwkVal>, dest: Map<string, AwkVal> | undefined, byIndex: boolean): number {
    const vals: AwkVal[] = byIndex ? [...src.keys()] : [...src.values()];
    const rank = (v: AwkVal) => (typeof v === 'number' || (v instanceof SN && isNumLike(v)) ? 0 : 1);
    vals.sort((a, b) => {
      if (byIndex) return this.S(a) < this.S(b) ? -1 : this.S(a) > this.S(b) ? 1 : 0;
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return num(a) - num(b);
      const s = this.S(a);
      const t = this.S(b);
      return s < t ? -1 : s > t ? 1 : 0;
    });
    const d = dest ?? src;
    d.clear();
    vals.forEach((v, k) => d.set(String(k + 1), v));
    return vals.length;
  }

  bitop(op: string, xs: number[]): number {
    const M64 = (1n << 64n) - 1n;
    const b = xs.map((x) => {
      if (x < 0) this.fatal(`${op}: negative values are not allowed`);
      return BigInt(Math.trunc(x)) & M64;
    });
    let r: bigint;
    switch (op) {
      case 'and': r = b.reduce((x, y) => x & y); break;
      case 'or': r = b.reduce((x, y) => x | y); break;
      case 'xor': r = b.reduce((x, y) => x ^ y); break;
      case 'lshift': r = (b[0] << b[1]) & M64; break;
      case 'rshift': r = b[0] >> b[1]; break;
      default: r = ~b[0] & ((1n << 53n) - 1n);
    }
    return Number(r);
  }

  typeOf(v: AwkVal): string {
    if (v === undefined) return 'unassigned';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') return 'string';
    return isNumLike(v) ? 'strnum' : 'string';
  }

  isSpecialNumeric(name: string): boolean {
    return SPECIAL_NUM.has(name);
  }
}

/** sub/gsub replacement text (gawk rules) */
function subRepl(repl: string, matched: string): string {
  if (!repl.includes('\\') && !repl.includes('&')) return repl;
  let out = '';
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i];
    if (c === '&') { out += matched; continue; }
    if (c !== '\\') { out += c; continue; }
    if (repl.startsWith('\\\\\\&', i)) { out += '\\&'; i += 3; continue; }
    if (repl.startsWith('\\\\\\\\', i)) { out += '\\\\'; i += 3; continue; }
    if (repl.startsWith('\\\\&', i)) { out += '\\' + matched; i += 2; continue; }
    if (repl[i + 1] === '&') { out += '&'; i++; continue; }
    out += '\\';
  }
  return out;
}

function gensubRepl(repl: string, m: RegExpExecArray): string {
  let out = '';
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i];
    if (c === '&') { out += m[0]; continue; }
    if (c !== '\\') { out += c; continue; }
    const d = repl[i + 1];
    if (d === undefined) { out += '\\'; continue; }
    i++;
    if (d >= '0' && d <= '9') { out += m[Number(d)] ?? ''; continue; }
    out += d;
  }
  return out;
}

