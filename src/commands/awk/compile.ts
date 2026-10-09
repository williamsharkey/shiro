/**
 * Compiles a parsed awk program to JavaScript source. Each awk expression
 * becomes a JS expression over the runtime helpers (N S O B C K); only the
 * functions that can reach getline/system/close/fflush are async. Globals and
 * locals are JS variables; arrays are Maps.
 */
import type { Expr, Stmt, Program, Func } from './parser';
import { AwkSyntaxError } from './lexer';

const SPECIAL_SCALARS = new Set(['NF', 'NR', 'FNR', 'FS', 'OFS', 'ORS', 'RS', 'SUBSEP', 'CONVFMT', 'OFMT',
  'RSTART', 'RLENGTH', 'FILENAME', 'ARGC', 'RT', 'ERRNO', 'IGNORECASE']);
const SPECIAL_ARRAYS = new Set(['ENVIRON', 'ARGV', 'PROCINFO']);
const ASYNC_BUILTINS = new Set(['system', 'close', 'fflush']);

type Ty = 'n' | 's' | 'a';
interface R { c: string; t: Ty }

interface Lval { setup: string[]; get: string; set: (v: string) => string }

class FnCtx {
  temps = 0;
  constructor(public scope: Func | null, public isAsync: boolean) {}
  temp(): string { return `t${this.temps++}`; }
  decl(): string {
    if (!this.temps) return '';
    return 'let ' + Array.from({ length: this.temps }, (_, i) => `t${i}`).join(', ') + ';\n';
  }
}

type Resolved =
  | { kind: 'local'; name: string; index: number }
  | { kind: 'global'; name: string }
  | { kind: 'special'; name: string }
  | { kind: 'specialArray'; name: string };

export interface CompiledInfo {
  source: string;
  globals: string[];
}

export function compileProgram(prog: Program): CompiledInfo {
  return new Compiler(prog).run();
}

class Compiler {
  private globalArrays = new Set<string>();
  private globalScalars = new Set<string>();
  private paramArray = new Map<string, boolean[]>();
  private asyncFuncs = new Set<string>();
  private regexConsts = new Map<string, string>();
  private ranges = 0;
  private fn!: FnCtx;

  constructor(private prog: Program) {
    for (const f of prog.funcs.values()) this.paramArray.set(f.name, f.params.map(() => false));
  }

  // ---------- analysis ----------

  private resolve(name: string, scope: Func | null): Resolved {
    if (scope) {
      const i = scope.params.indexOf(name);
      if (i >= 0) return { kind: 'local', name, index: i };
    }
    if (SPECIAL_SCALARS.has(name)) return { kind: 'special', name };
    if (SPECIAL_ARRAYS.has(name)) return { kind: 'specialArray', name };
    return { kind: 'global', name };
  }

  private markArray(name: string, scope: Func | null): boolean {
    const r = this.resolve(name, scope);
    if (r.kind === 'local') {
      const pa = this.paramArray.get(scope!.name)!;
      if (pa[r.index]) return false;
      pa[r.index] = true;
      return true;
    }
    if (r.kind === 'global') {
      if (this.globalArrays.has(name)) return false;
      this.globalArrays.add(name);
      return true;
    }
    return false;
  }

  private isArray(name: string, scope: Func | null): boolean {
    const r = this.resolve(name, scope);
    if (r.kind === 'local') return this.paramArray.get(scope!.name)![r.index];
    if (r.kind === 'global') return this.globalArrays.has(name);
    return r.kind === 'specialArray';
  }

  /** Visit every expression and statement of the program */
  private walk(visitE: (e: Expr, scope: Func | null) => void, visitS?: (s: Stmt, scope: Func | null) => void): void {
    const ex = (e: Expr | undefined, sc: Func | null): void => {
      if (!e) return;
      visitE(e, sc);
      switch (e.k) {
        case 'idx': e.subs.forEach((x) => ex(x, sc)); break;
        case 'field': case 'group': case 'unary': ex(e.e, sc); break;
        case 'assign': ex(e.lv, sc); ex(e.e, sc); break;
        case 'cond': ex(e.c, sc); ex(e.a, sc); ex(e.b, sc); break;
        case 'and': case 'or': case 'cat': case 'bin': case 'cmp': ex(e.a, sc); ex(e.b, sc); break;
        case 'in': e.subs.forEach((x) => ex(x, sc)); break;
        case 'match': ex(e.a, sc); ex(e.re, sc); break;
        case 'incdec': ex(e.lv, sc); break;
        case 'call': case 'builtin': e.args.forEach((x) => ex(x, sc)); break;
        case 'getline': ex(e.lv, sc); ex(e.src, sc); break;
      }
    };
    const st = (s: Stmt | undefined, sc: Func | null): void => {
      if (!s) return;
      visitS?.(s, sc);
      switch (s.k) {
        case 'block': s.body.forEach((x) => st(x, sc)); break;
        case 'expr': ex(s.e, sc); break;
        case 'print': case 'printf': s.args.forEach((x) => ex(x, sc)); ex(s.redir?.e, sc); break;
        case 'if': ex(s.c, sc); st(s.then, sc); st(s.else, sc); break;
        case 'while': case 'do': ex(s.c, sc); st(s.body, sc); break;
        case 'for': st(s.init, sc); ex(s.c, sc); st(s.step, sc); st(s.body, sc); break;
        case 'forin': ex(s.v, sc); st(s.body, sc); break;
        case 'exit': case 'return': ex(s.e, sc); break;
        case 'delete': s.subs?.forEach((x) => ex(x, sc)); break;
      }
    };
    for (const b of this.prog.begin) b.forEach((s) => st(s, null));
    for (const b of this.prog.end) b.forEach((s) => st(s, null));
    for (const r of this.prog.rules) {
      ex(r.pattern, null);
      ex(r.pattern2, null);
      r.action?.forEach((s) => st(s, null));
    }
    for (const f of this.prog.funcs.values()) f.body.forEach((s) => st(s, f));
  }

  private analyze(): void {
    // arrays from direct use
    const edges: { callee: string; i: number; name: string; scope: Func | null }[] = [];
    this.walk((e, sc) => {
      switch (e.k) {
        case 'idx': case 'in': this.markArray(e.name, sc); break;
        case 'call': {
          const f = this.prog.funcs.get(e.name);
          if (!f) throw new AwkSyntaxError(`function \`${e.name}' not defined`, e.line);
          e.args.forEach((a, i) => { if (a.k === 'var' && i < f.params.length) edges.push({ callee: e.name, i, name: a.name, scope: sc }); });
          break;
        }
        case 'builtin': {
          const arrArg = (k: number) => { const a = e.args[k]; if (a && a.k === 'var') this.markArray(a.name, sc); };
          if (e.name === 'split') { arrArg(1); arrArg(3); }
          if (e.name === 'match') arrArg(2);
          if (e.name === 'asort' || e.name === 'asorti') { arrArg(0); arrArg(1); }
          break;
        }
      }
    }, (s, sc) => {
      if (s.k === 'forin') this.markArray(s.arr, sc);
      if (s.k === 'delete') this.markArray(s.name, sc);
    });
    let changed = true;
    while (changed) {
      changed = false;
      for (const ed of edges) {
        const pa = this.paramArray.get(ed.callee)!;
        if (pa[ed.i] && this.markArray(ed.name, ed.scope)) changed = true;
        if (!pa[ed.i] && this.isArray(ed.name, ed.scope)) { pa[ed.i] = true; changed = true; }
      }
    }
    // global scalars
    this.walk((e, sc) => {
      if (e.k === 'var') {
        const r = this.resolve(e.name, sc);
        if (r.kind === 'global' && !this.globalArrays.has(e.name)) this.globalScalars.add(e.name);
      }
    }, (s, sc) => {
      if (s.k === 'forin' && s.v.k === 'var') {
        const r = this.resolve(s.v.name, sc);
        if (r.kind === 'global') this.globalScalars.add(s.v.name);
      }
    });
    // async functions (fixpoint)
    changed = true;
    while (changed) {
      changed = false;
      for (const f of this.prog.funcs.values()) {
        if (this.asyncFuncs.has(f.name)) continue;
        if (f.body.some((s) => this.stmtAsync(s))) { this.asyncFuncs.add(f.name); changed = true; }
      }
    }
  }

  private exprAsync(e: Expr | undefined): boolean {
    if (!e) return false;
    switch (e.k) {
      case 'getline': return true;
      case 'builtin': if (ASYNC_BUILTINS.has(e.name)) return true; return e.args.some((a) => this.exprAsync(a));
      case 'call': if (this.asyncFuncs.has(e.name)) return true; return e.args.some((a) => this.exprAsync(a));
      case 'idx': case 'in': return e.subs.some((a) => this.exprAsync(a));
      case 'field': case 'group': case 'unary': return this.exprAsync(e.e);
      case 'assign': return this.exprAsync(e.lv) || this.exprAsync(e.e);
      case 'cond': return this.exprAsync(e.c) || this.exprAsync(e.a) || this.exprAsync(e.b);
      case 'and': case 'or': case 'cat': case 'bin': case 'cmp': return this.exprAsync(e.a) || this.exprAsync(e.b);
      case 'match': return this.exprAsync(e.a) || this.exprAsync(e.re);
      case 'incdec': return this.exprAsync(e.lv);
    }
    return false;
  }

  private stmtAsync(s: Stmt | undefined): boolean {
    if (!s) return false;
    switch (s.k) {
      case 'block': return s.body.some((x) => this.stmtAsync(x));
      case 'expr': return this.exprAsync(s.e);
      case 'print': case 'printf': return s.args.some((x) => this.exprAsync(x)) || this.exprAsync(s.redir?.e);
      case 'if': return this.exprAsync(s.c) || this.stmtAsync(s.then) || this.stmtAsync(s.else);
      case 'while': case 'do': return this.exprAsync(s.c) || this.stmtAsync(s.body);
      case 'for': return this.stmtAsync(s.init) || this.exprAsync(s.c) || this.stmtAsync(s.step) || this.stmtAsync(s.body);
      case 'forin': return this.exprAsync(s.v) || this.stmtAsync(s.body);
      case 'exit': case 'return': return this.exprAsync(s.e);
      case 'delete': return !!s.subs?.some((x) => this.exprAsync(x));
    }
    return false;
  }

  // ---------- code generation ----------

  private regex(src: string): string {
    let name = this.regexConsts.get(src);
    if (!name) {
      name = `R${this.regexConsts.size}`;
      this.regexConsts.set(src, name);
    }
    return this.usesIgnoreCase ? `RX(${name})` : name;
  }
  private usesIgnoreCase = false;

  private N(r: R): string { return r.t === 'n' ? r.c : `N(${r.c})`; }
  private S(r: R): string { return r.t === 's' ? r.c : `S(${r.c})`; }
  private B(r: R): string {
    if (r.t === 'n') return `(${r.c} !== 0)`;
    if (r.t === 's') return `(${r.c} !== "")`;
    return `B(${r.c})`;
  }
  private K(e: Expr): string {
    const r = this.expr(e);
    if (r.t === 's') return r.c;
    if (e.k === 'num' && Number.isInteger(e.v)) return JSON.stringify(String(e.v));
    return `K(${r.c})`;
  }
  private key(subs: Expr[]): string {
    if (subs.length === 1) return this.K(subs[0]);
    return '(' + subs.map((s) => this.K(s)).join(' + S(rt.SUBSEP) + ') + ')';
  }

  private arrRef(name: string): string {
    const r = this.resolve(name, this.fn.scope);
    if (r.kind === 'local') return `L_${name}`;
    if (r.kind === 'specialArray') return `rt.${name}`;
    if (r.kind === 'special') throw new AwkSyntaxError(`attempt to use scalar \`${name}' as array`, 0);
    return `A_${name}`;
  }

  private aw(): string { return this.fn.isAsync ? 'await ' : ''; }

  private lval(e: Expr): Lval {
    if (e.k === 'group') return this.lval(e.e);
    if (e.k === 'var') {
      const r = this.resolve(e.name, this.fn.scope);
      if (this.isArray(e.name, this.fn.scope)) throw new AwkSyntaxError(`attempt to use array \`${e.name}' in a scalar context`, 0);
      if (r.kind === 'local') return { setup: [], get: `L_${e.name}`, set: (v) => `(L_${e.name} = ${v})` };
      if (r.kind === 'special') {
        if (e.name === 'NF') return { setup: [], get: 'rt.getNF()', set: (v) => `rt.setNF(${v})` };
        return { setup: [], get: `rt.${e.name}`, set: (v) => `(rt.${e.name} = ${v})` };
      }
      return { setup: [], get: `G_${e.name}`, set: (v) => `(G_${e.name} = ${v})` };
    }
    if (e.k === 'idx') {
      const arr = this.arrRef(e.name);
      const t = this.fn.temp();
      return { setup: [`${t} = ${this.key(e.subs)}`], get: `rt.aget(${arr}, ${t})`, set: (v) => `rt.aset(${arr}, ${t}, ${v})` };
    }
    if (e.k === 'field') {
      if (e.e.k === 'num') {
        const i = String(e.e.v);
        return { setup: [], get: `rt.getField(${i})`, set: (v) => `rt.setField(${i}, ${v})` };
      }
      const t = this.fn.temp();
      return { setup: [`${t} = ${this.N(this.expr(e.e))}`], get: `rt.getField(${t})`, set: (v) => `rt.setField(${t}, ${v})` };
    }
    throw new AwkSyntaxError('assignment to non-lvalue', 0);
  }

  private seq(parts: string[]): string {
    return parts.length === 1 ? parts[0] : `(${parts.join(', ')})`;
  }

  private arith(op: string, a: string, b: string): string {
    switch (op) {
      case '+': return `(${a} + ${b})`;
      case '-': return `(${a} - ${b})`;
      case '*': return `(${a} * ${b})`;
      case '/': return `D(${a}, ${b})`;
      case '%': return `M(${a}, ${b})`;
      case '^': return `P(${a}, ${b})`;
    }
    throw new Error('bad op ' + op);
  }

  private reArg(e: Expr): string {
    if (e.k === 're') return this.regex(e.v);
    return `rt.re(${this.expr(e).c})`;
  }

  private setter(lv: Expr | undefined): string {
    if (!lv) return 'undefined';
    const l = this.lval(lv);
    return `((v) => ${this.seq([...l.setup, l.set('v')])})`;
  }

  expr(e: Expr): R {
    switch (e.k) {
      case 'num': return { c: Object.is(e.v, -0) ? '0' : String(e.v), t: 'n' };
      case 'str': return { c: JSON.stringify(e.v), t: 's' };
      case 're': return { c: `(${this.regex(e.v)}.test(rt.get0().s) ? 1 : 0)`, t: 'n' };
      case 'group': return this.expr(e.e);
      case 'var': {
        const r = this.resolve(e.name, this.fn.scope);
        if (this.isArray(e.name, this.fn.scope)) throw new AwkSyntaxError(`attempt to use array \`${e.name}' in a scalar context`, 0);
        if (r.kind === 'local') return { c: `L_${e.name}`, t: 'a' };
        if (r.kind === 'special') return e.name === 'NF' ? { c: 'rt.getNF()', t: 'n' } : { c: `rt.${e.name}`, t: 'a' };
        return { c: `G_${e.name}`, t: 'a' };
      }
      case 'idx': return { c: `rt.aget(${this.arrRef(e.name)}, ${this.key(e.subs)})`, t: 'a' };
      case 'field': {
        if (e.e.k === 'num') return { c: e.e.v === 0 ? 'rt.get0()' : `rt.getField(${e.e.v})`, t: 'a' };
        return { c: `rt.getField(${this.N(this.expr(e.e))})`, t: 'a' };
      }
      case 'assign': {
        // gawk evaluates the right side before the target's subscript and old value
        const rhs = this.expr(e.e);
        const l = this.lval(e.lv);
        if (e.op === '=') {
          if (!l.setup.length) return { c: l.set(rhs.c), t: rhs.t };
          const tv = this.fn.temp();
          return { c: this.seq([`${tv} = ${rhs.c}`, ...l.setup, l.set(tv)]), t: rhs.t };
        }
        const tv = this.fn.temp();
        const v = this.arith(e.op[0], `N(${l.get})`, tv);
        return { c: this.seq([`${tv} = ${this.N(rhs)}`, ...l.setup, l.set(v)]), t: 'n' };
      }
      case 'cond': {
        const a = this.expr(e.a);
        const b = this.expr(e.b);
        return { c: `(${this.B(this.expr(e.c))} ? ${a.c} : ${b.c})`, t: a.t === b.t ? a.t : 'a' };
      }
      case 'and': return { c: `(${this.B(this.expr(e.a))} && ${this.B(this.expr(e.b))} ? 1 : 0)`, t: 'n' };
      case 'or': return { c: `(${this.B(this.expr(e.a))} || ${this.B(this.expr(e.b))} ? 1 : 0)`, t: 'n' };
      case 'in': return { c: `(${this.arrRef(e.name)}.has(${this.key(e.subs)}) ? 1 : 0)`, t: 'n' };
      case 'match': {
        const s = this.S(this.expr(e.a));
        return { c: `(${this.reArg(e.re)}.test(${s}) ? ${e.neg ? '0 : 1' : '1 : 0'})`, t: 'n' };
      }
      case 'cmp': {
        const a = this.expr(e.a);
        const b = this.expr(e.b);
        const op = e.op === '==' ? '===' : e.op === '!=' ? '!==' : e.op;
        if ((a.t === 'n' && b.t === 'n') || (a.t === 's' && b.t === 's')) return { c: `(${a.c} ${op} ${b.c} ? 1 : 0)`, t: 'n' };
        return { c: `(C(${a.c}, ${b.c}) ${op} 0 ? 1 : 0)`, t: 'n' };
      }
      case 'cat': return { c: `(${this.S(this.expr(e.a))} + ${this.S(this.expr(e.b))})`, t: 's' };
      case 'bin': return { c: this.arith(e.op, this.N(this.expr(e.a)), this.N(this.expr(e.b))), t: 'n' };
      case 'unary': {
        const r = this.expr(e.e);
        if (e.op === '!') return { c: `(${this.B(r)} ? 0 : 1)`, t: 'n' };
        if (e.op === '-') return { c: `(-${this.N(r)})`, t: 'n' };
        return { c: `(+${this.N(r)})`, t: 'n' };
      }
      case 'incdec': {
        const l = this.lval(e.lv);
        const d = e.op === '++' ? '+' : '-';
        if (e.pre) return { c: this.seq([...l.setup, l.set(`(N(${l.get}) ${d} 1)`)]), t: 'n' };
        const t = this.fn.temp();
        return { c: `(${[...l.setup, `${t} = N(${l.get})`, l.set(`${t} ${d} 1`), t].join(', ')})`, t: 'n' };
      }
      case 'call': return this.call(e);
      case 'builtin': return this.builtin(e);
      case 'getline': {
        const set = this.setter(e.lv);
        if (e.kind === 'simple') return { c: `(await rt.getlineMain(${set}))`, t: 'n' };
        const src = this.S(this.expr(e.src!));
        if (e.kind === 'file') return { c: `(await rt.getlineFile(${src}, ${set}))`, t: 'n' };
        return { c: `(await rt.getlineCmd(${src}, ${set}))`, t: 'n' };
      }
    }
  }

  private call(e: Extract<Expr, { k: 'call' }>): R {
    const f = this.prog.funcs.get(e.name)!;
    const pa = this.paramArray.get(e.name)!;
    const args = e.args.map((a, i) => {
      if (i < pa.length && pa[i]) {
        if (a.k !== 'var') throw new AwkSyntaxError(`function \`${e.name}': argument #${i + 1} must be an array`, e.line);
        return this.arrRef(a.name);
      }
      if (a.k === 'var' && this.isArray(a.name, this.fn.scope)) return this.arrRef(a.name);
      return this.expr(a).c;
    });
    void f;
    const c = `F_${e.name}(${args.join(', ')})`;
    return { c: this.asyncFuncs.has(e.name) ? `(await ${c})` : c, t: 'a' };
  }

  private builtin(e: Extract<Expr, { k: 'builtin' }>): R {
    const a = e.args;
    const n = (i: number) => this.N(this.expr(a[i]));
    const s = (i: number) => this.S(this.expr(a[i]));
    const arr = (i: number) => {
      const x = a[i];
      if (!x || x.k !== 'var') throw new AwkSyntaxError(`${e.name}: argument ${i + 1} is not an array`, 0);
      return this.arrRef(x.name);
    };
    const need = (min: number, max: number) => {
      if (a.length < min || a.length > max) throw new AwkSyntaxError(`${e.name}: called with ${a.length} arguments`, 0);
    };
    switch (e.name) {
      case 'length':
        need(0, 1);
        if (a.length === 0) return { c: 'rt.get0().s.length', t: 'n' };
        if (a[0].k === 'var' && this.isArray(a[0].name, this.fn.scope)) return { c: `${this.arrRef(a[0].name)}.size`, t: 'n' };
        return { c: `${s(0)}.length`, t: 'n' };
      case 'substr':
        need(2, 3);
        return { c: `rt.substr(${s(0)}, ${n(1)}${a.length > 2 ? ', ' + n(2) : ''})`, t: 's' };
      case 'index':
        need(2, 2);
        return { c: `(${s(0)}.indexOf(${s(1)}) + 1)`, t: 'n' };
      case 'split': {
        need(2, 4);
        const fs = a.length > 2 ? (a[2].k === 're' ? this.regex(a[2].v) : this.expr(a[2]).c) : 'undefined';
        return { c: `rt.split(${s(0)}, ${arr(1)}, ${fs}${a.length > 3 ? ', ' + arr(3) : ''})`, t: 'n' };
      }
      case 'sub': case 'gsub': {
        need(2, 3);
        const re = this.reArg(a[0]);
        const repl = s(1);
        const target: Expr = a.length > 2 ? a[2] : { k: 'field', e: { k: 'num', v: 0 } };
        const tt = target.k === 'group' ? target.e : target;
        const g = e.name === 'gsub' ? 'true' : 'false';
        if (tt.k !== 'var' && tt.k !== 'idx' && tt.k !== 'field') {
          return { c: `(rt.subst(${re}, ${repl}, ${this.S(this.expr(tt))}, ${g}), rt.subCount)`, t: 'n' };
        }
        const l = this.lval(tt);
        const t = this.fn.temp();
        const body = `((${t} = rt.subst(${re}, ${repl}, S(${l.get}), ${g})) === null ? 0 : (${l.set(t)}, rt.subCount))`;
        return { c: this.seq([...l.setup, body]), t: 'n' };
      }
      case 'gensub':
        need(3, 4);
        return { c: `rt.gensub(${this.reArg(a[0])}, ${s(1)}, ${this.expr(a[2]).c}, ${a.length > 3 ? s(3) : 'rt.get0().s'})`, t: 's' };
      case 'match':
        need(2, 3);
        return { c: `rt.match(${s(0)}, ${this.reArg(a[1])}${a.length > 2 ? ', ' + arr(2) : ''})`, t: 'n' };
      case 'sprintf':
        if (a.length === 0) throw new AwkSyntaxError('sprintf: no arguments', 0);
        return { c: `rt.sprintf([${a.map((x) => this.expr(x).c).join(', ')}])`, t: 's' };
      case 'sin': case 'cos': case 'exp': case 'sqrt': case 'log':
        need(1, 1);
        return { c: `Math.${e.name}(${n(0)})`, t: 'n' };
      case 'atan2':
        need(2, 2);
        return { c: `Math.atan2(${n(0)}, ${n(1)})`, t: 'n' };
      case 'int':
        need(1, 1);
        return { c: `Math.trunc(${n(0)})`, t: 'n' };
      case 'rand':
        need(0, 0);
        return { c: 'rt.rand()', t: 'n' };
      case 'srand':
        need(0, 1);
        return { c: `rt.srand(${a.length ? this.expr(a[0]).c : ''})`, t: 'n' };
      case 'tolower': need(1, 1); return { c: `${s(0)}.toLowerCase()`, t: 's' };
      case 'toupper': need(1, 1); return { c: `${s(0)}.toUpperCase()`, t: 's' };
      case 'system': need(1, 1); return { c: `(await rt.system(${s(0)}))`, t: 'n' };
      case 'close': need(1, 2); return { c: `(await rt.close(${s(0)}))`, t: 'n' };
      case 'fflush': need(0, 1); return { c: `(await rt.fflush(${a.length ? s(0) : ''}))`, t: 'n' };
      case 'and': case 'or': case 'xor':
        if (a.length < 2) throw new AwkSyntaxError(`${e.name}: called with less than two arguments`, 0);
        return { c: `BIT(${JSON.stringify(e.name)}, [${a.map((_, i) => n(i)).join(', ')}])`, t: 'n' };
      case 'lshift': need(2, 2); return { c: `BIT("lshift", [${n(0)}, ${n(1)}])`, t: 'n' };
      case 'rshift': need(2, 2); return { c: `BIT("rshift", [${n(0)}, ${n(1)}])`, t: 'n' };
      case 'compl': need(1, 1); return { c: `BIT("compl", [${n(0)}])`, t: 'n' };
      case 'systime': need(0, 0); return { c: 'Math.floor(Date.now() / 1000)', t: 'n' };
      case 'strftime':
        need(0, 3);
        return { c: `rt.strftime(${a.length > 0 ? s(0) : 'undefined'}, ${a.length > 1 ? n(1) : 'undefined'}, ${a.length > 2 ? this.B(this.expr(a[2])) : 'false'})`, t: 's' };
      case 'mktime':
        need(1, 2);
        return { c: `rt.mktime(${s(0)}, ${a.length > 1 ? this.B(this.expr(a[1])) : 'false'})`, t: 'n' };
      case 'asort': case 'asorti':
        need(1, 2);
        return { c: `rt.asort(${arr(0)}, ${a.length > 1 ? arr(1) : 'undefined'}, ${e.name === 'asorti'})`, t: 'n' };
      case 'typeof':
        need(1, 1);
        if (a[0].k === 'var' && this.isArray(a[0].name, this.fn.scope)) return { c: '"array"', t: 's' };
        return { c: `rt.typeOf(${this.expr(a[0]).c})`, t: 's' };
      case 'isarray':
        need(1, 1);
        return { c: a[0].k === 'var' && this.isArray(a[0].name, this.fn.scope) ? '1' : '0', t: 'n' };
    }
    throw new AwkSyntaxError(`function \`${e.name}' not defined`, 0);
  }

  private stmts(list: Stmt[]): string {
    return list.map((s) => this.stmt(s)).join('\n');
  }

  private simpleAsExpr(s: Stmt | undefined): string {
    if (!s) return '';
    if (s.k === 'expr') return this.expr(s.e).c;
    if (s.k === 'empty') return '';
    // print/delete etc. in a for header: run it as a statement via an arrow function
    return `(${this.fn.isAsync ? 'await (async ' : '('}() => { ${this.stmt(s)} })())`;
  }

  private stmt(s: Stmt): string {
    switch (s.k) {
      case 'block': return `{\n${this.stmts(s.body)}\n}`;
      case 'empty': return ';';
      case 'expr': return `${this.expr(s.e).c};`;
      case 'print': {
        const parts = s.args.length === 0 ? ['rt.get0().s'] : s.args.map((a) => {
          const r = this.expr(a);
          return r.t === 's' ? r.c : `O(${r.c})`;
        });
        const text = parts.length === 1 ? `${parts[0]} + S(rt.ORS)` : `${parts.join(' + S(rt.OFS) + ')} + S(rt.ORS)`;
        if (!s.redir) return `rt.out(${text});`;
        return `rt.outTo(${JSON.stringify(s.redir.op)}, ${this.S(this.expr(s.redir.e))}, ${text});`;
      }
      case 'printf': {
        const text = `rt.sprintf([${s.args.map((a) => this.expr(a).c).join(', ')}])`;
        if (!s.redir) return `rt.out(${text});`;
        return `rt.outTo(${JSON.stringify(s.redir.op)}, ${this.S(this.expr(s.redir.e))}, ${text});`;
      }
      case 'if': {
        let code = `if (${this.B(this.expr(s.c))}) {\n${this.stmt(s.then)}\n}`;
        if (s.else) code += ` else {\n${this.stmt(s.else)}\n}`;
        return code;
      }
      case 'while': return `while (${this.B(this.expr(s.c))}) {\n${this.stmt(s.body)}\n}`;
      case 'do': return `do {\n${this.stmt(s.body)}\n} while (${this.B(this.expr(s.c))});`;
      case 'for': {
        const init = this.simpleAsExpr(s.init);
        const cond = s.c ? this.B(this.expr(s.c)) : '';
        const step = this.simpleAsExpr(s.step);
        return `for (${init}; ${cond}; ${step}) {\n${this.stmt(s.body)}\n}`;
      }
      case 'forin': {
        const arr = this.arrRef(s.arr);
        const k = this.fn.temp();
        const l = this.lval(s.v);
        return `for (const ${k}_ of [...${arr}.keys()]) {\nif (!${arr}.has(${k}_)) continue;\n${this.seq([...l.setup, l.set(`new SNc(${k}_)`)])};\n${this.stmt(s.body)}\n}`;
      }
      case 'break': return 'break;';
      case 'continue': return 'continue;';
      case 'next': return 'throw NEXT;';
      case 'nextfile': return 'throw NEXTFILE;';
      case 'exit': return `throw new ExitSig(${s.e ? this.N(this.expr(s.e)) : 'undefined'});`;
      case 'return': return `return ${s.e ? this.expr(s.e).c : 'undefined'};`;
      case 'delete': {
        const arr = this.arrRef(s.name);
        if (!s.subs) return `${arr}.clear();`;
        return `${arr}.delete(${this.key(s.subs)});`;
      }
    }
  }

  /** Generate a JS function; returns [code, isAsync] */
  private genFunction(name: string, params: string[], scope: Func | null, isAsync: boolean, body: () => string, prologue = ''): string {
    const saved = this.fn;
    this.fn = new FnCtx(scope, isAsync);
    const code = body();
    const decl = this.fn.decl();
    this.fn = saved;
    return `${isAsync ? 'async ' : ''}function ${name}(${params.join(', ')}) {\n${prologue}${decl}${code}\n}\n`;
  }

  run(): CompiledInfo {
    this.analyze();
    this.walk((e) => { if (e.k === 'var' && e.name === 'IGNORECASE') this.usesIgnoreCase = true; });
    const out: string[] = [];

    // user functions
    for (const f of this.prog.funcs.values()) {
      const pa = this.paramArray.get(f.name)!;
      const prologue = f.params.map((p, i) => (pa[i] ? `if (L_${p} === undefined) L_${p} = new Map();\n` : '')).join('');
      out.push(this.genFunction(`F_${f.name}`, f.params.map((p) => `L_${p}`), f, this.asyncFuncs.has(f.name), () => this.stmts(f.body), prologue));
    }

    // BEGIN / main / END (always async: they may await functions)
    const beginBody = this.prog.begin.flat();
    out.push(this.genFunction('BEGIN_', [], null, true, () => this.stmts(beginBody)));
    const endBody = this.prog.end.flat();
    out.push(this.genFunction('END_', [], null, true, () => this.stmts(endBody)));
    const rangeDecls: string[] = [];
    out.push(this.genFunction('MAIN_', [], null, true, () => this.prog.rules.map((r) => {
      const action = r.action ? this.stmts(r.action) : 'rt.out(rt.get0().s + S(rt.ORS));';
      if (!r.pattern) return `{\n${action}\n}`;
      const p1 = r.pattern.k === 're' ? `${this.regex(r.pattern.v)}.test(rt.get0().s)` : this.B(this.expr(r.pattern));
      if (!r.pattern2) return `if (${p1}) {\n${action}\n}`;
      const rg = `RG${this.ranges++}`;
      rangeDecls.push(`let ${rg} = false;`);
      const p2 = r.pattern2.k === 're' ? `${this.regex(r.pattern2.v)}.test(rt.get0().s)` : this.B(this.expr(r.pattern2));
      return `{\nlet fire = false;\nif (!${rg}) { if (${p1}) { fire = true; ${rg} = !(${p2}); } }\nelse { fire = true; if (${p2}) ${rg} = false; }\nif (fire) {\n${action}\n}\n}`;
    }).join('\n')));

    const head: string[] = [
      'const { N, S, O, B, C, K } = h;',
      'const D = (a, b) => (b === 0 ? rt.error("division by zero attempted") : a / b);',
      'const M = (a, b) => (b === 0 ? rt.error("division by zero attempted in `%\'") : a % b);',
      'const P = (a, b) => (a === 1 ? 1 : Math.pow(a, b));',
      'const BIT = (op, xs) => rt.bitop(op, xs);',
      'const RX = (r) => (B(rt.IGNORECASE) ? rt.icase(r) : r);',
    ];
    for (const [src, name] of this.regexConsts) head.push(`const ${name} = rt.re(${JSON.stringify(src)});`);
    const scalars = [...this.globalScalars];
    if (scalars.length) head.push(`let ${scalars.map((g) => `G_${g}`).join(', ')};`);
    for (const a of this.globalArrays) head.push(`const A_${a} = new Map();`);
    head.push(...rangeDecls);
    const cases = scalars.map((g) => `case ${JSON.stringify(g)}: G_${g} = v; return;`);
    for (const sp of SPECIAL_SCALARS) {
      cases.push(sp === 'NF' ? `case "NF": rt.setNF(v); return;` : `case ${JSON.stringify(sp)}: rt.${sp} = v; return;`);
    }
    head.push(`rt.assignVar = (name, v) => { switch (name) { ${cases.join(' ')} } };`);
    const hasMain = this.prog.rules.length > 0;
    const hasEnd = this.prog.end.length > 0;
    const source = `${head.join('\n')}\n${out.join('\n')}\nreturn { begin: BEGIN_, main: MAIN_, end: END_, hasMain: ${hasMain}, hasEnd: ${hasEnd} };`;
    return { source, globals: scalars };
  }
}
