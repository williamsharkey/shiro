import type { Command } from './index';
import type { FileSystem } from '../filesystem';

/**
 * test / [ (POSIX, with the bash/coreutils extensions -nt -ot -ef < >).
 * Exit 0 true, 1 false, 2 on a usage error. With 1–4 arguments the POSIX
 * rules by argument count apply (so `test ! = x` and `test -n` work); longer
 * expressions are parsed with ( ), ! (binding tighter than -a), -a, -o.
 */
export const test: Command = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(ctx) {
    try {
      // -v NAME / -v NAME[SUB]: is the shell variable set
      const isSet = (n: string) => {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/s.exec(n);
        if (!m || typeof ctx.shell?.getVar !== 'function') return false;
        try { return ctx.shell.getVar(m[1], m[2]) !== undefined; } catch { return false; }
      };
      return (await new TestEval(ctx.args, ctx.fs, ctx.cwd, isSet).run()) ? 0 : 1;
    } catch (e: unknown) {
      ctx.stderr += `test: ${e instanceof Error ? e.message : e}\n`;
      return 2;
    }
  },
};

const UNARY = new Set(['-v', '-b', '-c', '-d', '-e', '-f', '-g', '-G', '-h', '-k', '-L', '-n', '-N', '-O', '-p', '-r', '-s', '-S', '-t', '-u', '-w', '-x', '-z']);
const BINARY = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

export class TestEval {
  private pos = 0;
  constructor(private args: string[], private fs: FileSystem, private cwd: string,
    private isSet: (name: string) => boolean = () => false) {}

  async run(): Promise<boolean> {
    const a = this.args;
    switch (a.length) {
      case 0: return false;
      case 1: return a[0] !== '';
      case 2:
        if (a[0] === '!') return a[1] === '';
        if (UNARY.has(a[0])) return this.unary(a[0], a[1]);
        throw new Error(`${a[0]}: unary operator expected`);
      case 3:
        if (BINARY.has(a[1])) return this.binary(a[0], a[1], a[2]);
        if (a[0] === '!') return !(await new TestEval(a.slice(1), this.fs, this.cwd, this.isSet).run());
        if (a[0] === '(' && a[2] === ')') return a[1] !== '';
        if (a[1] === '-a') return a[0] !== '' && a[2] !== '';
        if (a[1] === '-o') return a[0] !== '' || a[2] !== '';
        throw new Error(`${a[1]}: binary operator expected`);
      case 4:
        if (a[0] === '!') return !(await new TestEval(a.slice(1), this.fs, this.cwd, this.isSet).run());
        if (a[0] === '(' && a[3] === ')') return new TestEval(a.slice(1, 3), this.fs, this.cwd, this.isSet).run();
    }
    const v = await this.or();
    if (this.pos < a.length) throw new Error(`${a[this.pos]}: unexpected argument`);
    return v;
  }

  private peek(): string | undefined { return this.args[this.pos]; }

  private async or(): Promise<boolean> {
    let v = await this.and();
    while (this.peek() === '-o') { this.pos++; const r = await this.and(); v = v || r; }
    return v;
  }

  private async and(): Promise<boolean> {
    let v = await this.not();
    while (this.peek() === '-a') { this.pos++; const r = await this.not(); v = v && r; }
    return v;
  }

  private async not(): Promise<boolean> {
    if (this.peek() === '!' && this.pos + 1 < this.args.length) { this.pos++; return !(await this.not()); }
    return this.primary();
  }

  private async primary(): Promise<boolean> {
    const a = this.args;
    const t = a[this.pos];
    if (t === undefined) throw new Error('argument expected');
    // A binary expression wins over a leading ( or unary operator: `test ( = (`
    if (this.pos + 2 < a.length && BINARY.has(a[this.pos + 1])) {
      const r = await this.binary(t, a[this.pos + 1], a[this.pos + 2]);
      this.pos += 3;
      return r;
    }
    if (t === '(') {
      this.pos++;
      const v = await this.or();
      if (a[this.pos] !== ')') throw new Error("missing ')'");
      this.pos++;
      return v;
    }
    if (UNARY.has(t) && this.pos + 1 < a.length) {
      this.pos += 2;
      return this.unary(t, a[this.pos - 1]);
    }
    this.pos++;
    return t !== '';
  }

  private async stat(path: string, follow = true) {
    const p = this.fs.resolvePath(path, this.cwd);
    try {
      return follow ? await this.fs.stat(p) : await this.fs.lstat(p);
    } catch {
      return null;
    }
  }

  async unary(op: string, val: string): Promise<boolean> {
    switch (op) {
      case '-z': return val === '';
      case '-n': return val !== '';
      case '-t': return false; // no fd is a terminal from a builtin's point of view
      case '-v': return this.isSet(val);
    }
    if (val === '') return false;
    const s = await this.stat(val, op !== '-L' && op !== '-h');
    if (!s) return false;
    const mode = (s as any).mode ?? 0;
    switch (op) {
      case '-e': return true;
      case '-f': return s.isFile();
      case '-d': return s.isDirectory();
      case '-L': case '-h': return s.isSymbolicLink();
      case '-s': return (s.size ?? 0) > 0;
      case '-r': return true;
      case '-w': return true;
      case '-x': return s.isDirectory() || (mode & 0o111) !== 0;
      case '-u': return (mode & 0o4000) !== 0;
      case '-g': return (mode & 0o2000) !== 0;
      case '-k': return (mode & 0o1000) !== 0;
      case '-O': case '-G': return true;
      case '-N': return false;
      case '-p': return (s as any).isFIFO?.() ?? false;
      case '-S': return (s as any).isSocket?.() ?? false;
      case '-b': return (s as any).isBlockDevice?.() ?? false;
      case '-c': return (s as any).isCharacterDevice?.() ?? false;
    }
    return false;
  }

  private int(s: string): bigint {
    if (!/^\s*[+-]?\d+\s*$/.test(s)) throw new Error(`${s}: integer expression expected`);
    return BigInt(s.trim());
  }

  async binary(l: string, op: string, r: string): Promise<boolean> {
    switch (op) {
      case '=': case '==': return l === r;
      case '!=': return l !== r;
      case '<': return l < r;
      case '>': return l > r;
      case '-eq': return this.int(l) === this.int(r);
      case '-ne': return this.int(l) !== this.int(r);
      case '-lt': return this.int(l) < this.int(r);
      case '-le': return this.int(l) <= this.int(r);
      case '-gt': return this.int(l) > this.int(r);
      case '-ge': return this.int(l) >= this.int(r);
      case '-nt': case '-ot': {
        const a = await this.stat(l), b = await this.stat(r);
        if (op === '-nt') return !!a && (!b || a.mtime.getTime() > b.mtime.getTime());
        return !!b && (!a || a.mtime.getTime() < b.mtime.getTime());
      }
      case '-ef': {
        const rl = await this.fs.realpath(this.fs.resolvePath(l, this.cwd)).catch(() => null);
        const rr = await this.fs.realpath(this.fs.resolvePath(r, this.cwd)).catch(() => null);
        return !!rl && rl === rr;
      }
    }
    return false;
  }
}
