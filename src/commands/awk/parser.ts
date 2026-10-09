/**
 * Recursive-descent parser for the awk grammar (POSIX plus the common gawk
 * extensions): implicit concatenation, unparenthesized `print > file`,
 * `cmd | getline [var]`, `getline [var] [< file]`, `(a,b) in arr`, regex
 * literals, range patterns and user functions.
 */
import { Token, TokType, tokenize, AwkSyntaxError } from './lexer';

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 're'; v: string }
  | { k: 'var'; name: string }
  | { k: 'idx'; name: string; subs: Expr[] }
  | { k: 'field'; e: Expr }
  | { k: 'group'; e: Expr }
  | { k: 'assign'; op: string; lv: Expr; e: Expr }
  | { k: 'cond'; c: Expr; a: Expr; b: Expr }
  | { k: 'and'; a: Expr; b: Expr }
  | { k: 'or'; a: Expr; b: Expr }
  | { k: 'in'; subs: Expr[]; name: string }
  | { k: 'match'; neg: boolean; a: Expr; re: Expr }
  | { k: 'cmp'; op: string; a: Expr; b: Expr }
  | { k: 'cat'; a: Expr; b: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'unary'; op: string; e: Expr }
  | { k: 'incdec'; op: string; pre: boolean; lv: Expr }
  | { k: 'call'; name: string; args: Expr[]; line: number }
  | { k: 'builtin'; name: string; args: Expr[] }
  | { k: 'getline'; kind: 'simple' | 'file' | 'cmd'; lv?: Expr; src?: Expr };

export type Redirect = { op: '>' | '>>' | '|'; e: Expr };

export type Stmt =
  | { k: 'block'; body: Stmt[] }
  | { k: 'expr'; e: Expr }
  | { k: 'print'; args: Expr[]; redir?: Redirect }
  | { k: 'printf'; args: Expr[]; redir?: Redirect }
  | { k: 'if'; c: Expr; then: Stmt; else?: Stmt }
  | { k: 'while'; c: Expr; body: Stmt }
  | { k: 'do'; body: Stmt; c: Expr }
  | { k: 'for'; init?: Stmt; c?: Expr; step?: Stmt; body: Stmt }
  | { k: 'forin'; v: Expr; arr: string; body: Stmt }
  | { k: 'break' } | { k: 'continue' } | { k: 'next' } | { k: 'nextfile' }
  | { k: 'exit'; e?: Expr }
  | { k: 'return'; e?: Expr }
  | { k: 'delete'; name: string; subs?: Expr[] }
  | { k: 'empty' };

export interface Rule { pattern?: Expr; pattern2?: Expr; action?: Stmt[] }
export interface Func { name: string; params: string[]; body: Stmt[]; line: number }
export interface Program {
  begin: Stmt[][];
  end: Stmt[][];
  rules: Rule[];
  funcs: Map<string, Func>;
}

const ASSIGN_OPS = new Set<string>(['=', '+=', '-=', '*=', '/=', '%=', '^=']);
const CONCAT_START = new Set<TokType>(['NUMBER', 'STRING', 'ERE', 'NAME', 'FUNC_NAME', 'BUILTIN', '$', '(', '++', '--', '!', '-', '+']);

function isLvalue(e: Expr): boolean {
  return e.k === 'var' || e.k === 'idx' || e.k === 'field';
}

export class Parser {
  private toks: Token[];
  private p = 0;
  private noGt = 0; // >0 while parsing unparenthesized print arguments
  private noIn = 0;
  private loopDepth = 0;
  private inFunc = false;
  private funcNames = new Set<string>();

  constructor(src: string) {
    this.toks = tokenize(src);
    for (let i = 0; i + 1 < this.toks.length; i++) {
      if (this.toks[i].t === 'function' && (this.toks[i + 1].t === 'NAME' || this.toks[i + 1].t === 'FUNC_NAME')) {
        this.funcNames.add(this.toks[i + 1].s);
      }
    }
  }

  private get tok(): Token { return this.toks[this.p]; }
  private peek(o = 1): Token { return this.toks[Math.min(this.p + o, this.toks.length - 1)]; }
  private is(t: TokType): boolean { return this.toks[this.p].t === t; }
  private next(): Token { return this.toks[this.p++]; }
  private err(msg = 'syntax error'): never {
    throw new AwkSyntaxError(msg, this.tok.line);
  }
  private expect(t: TokType): Token {
    if (!this.is(t)) this.err();
    return this.next();
  }
  private optNewlines(): void {
    while (this.is('NEWLINE')) this.p++;
  }
  private skipTerms(): void {
    while (this.is('NEWLINE') || this.is(';')) this.p++;
  }

  parseProgram(): Program {
    const prog: Program = { begin: [], end: [], rules: [], funcs: new Map() };
    this.skipTerms();
    while (!this.is('EOF')) {
      this.item(prog);
      this.skipTerms();
    }
    return prog;
  }

  private item(prog: Program): void {
    const t = this.tok;
    if (t.t === 'function') {
      this.next();
      const nameTok = this.next();
      if (nameTok.t !== 'NAME' && nameTok.t !== 'FUNC_NAME') this.err();
      if (prog.funcs.has(nameTok.s)) this.err(`function \`${nameTok.s}' previously defined`);
      this.expect('(');
      const params: string[] = [];
      this.optNewlines();
      if (!this.is(')')) {
        for (;;) {
          const pt = this.next();
          if (pt.t !== 'NAME') { this.p--; this.err(); }
          params.push(pt.s);
          this.optNewlines();
          if (this.is(')')) break;
          this.expect(',');
          this.optNewlines();
        }
      }
      this.expect(')');
      this.optNewlines();
      this.inFunc = true;
      const body = this.blockBody();
      this.inFunc = false;
      prog.funcs.set(nameTok.s, { name: nameTok.s, params, body, line: t.line });
      return;
    }
    if (t.t === 'BEGIN' || t.t === 'END') {
      this.next();
      this.optNewlines();
      if (!this.is('{')) this.err();
      (t.t === 'BEGIN' ? prog.begin : prog.end).push(this.blockBody());
      return;
    }
    if (t.t === 'BEGINFILE' || t.t === 'ENDFILE') {
      // accepted, but run never (no per-file hooks)
      this.next();
      this.optNewlines();
      this.blockBody();
      return;
    }
    if (t.t === '{') {
      prog.rules.push({ action: this.blockBody() });
      return;
    }
    const rule: Rule = { pattern: this.expr() };
    if (this.is(',')) {
      this.next();
      this.optNewlines();
      rule.pattern2 = this.expr();
    }
    if (this.is('{')) rule.action = this.blockBody();
    else if (!this.is('NEWLINE') && !this.is(';') && !this.is('EOF')) this.err();
    prog.rules.push(rule);
  }

  /** `{ stmts }` */
  private blockBody(): Stmt[] {
    this.expect('{');
    const body: Stmt[] = [];
    this.skipTerms();
    while (!this.is('}')) {
      if (this.is('EOF')) this.err();
      body.push(this.stmt());
      this.skipTerms();
    }
    this.next();
    return body;
  }

  /** End of a simple statement */
  private term(): void {
    if (this.is(';') || this.is('NEWLINE')) { this.next(); return; }
    if (this.is('}') || this.is('EOF')) return;
    this.err();
  }

  private stmt(): Stmt {
    const t = this.tok;
    switch (t.t) {
      case '{': return { k: 'block', body: this.blockBody() };
      case ';': this.next(); return { k: 'empty' };
      case 'if': {
        this.next();
        this.expect('(');
        const c = this.expr();
        this.expect(')');
        this.optNewlines();
        const then = this.stmtOrEmpty();
        const save = this.p;
        this.skipTerms();
        if (this.is('else')) {
          this.next();
          this.optNewlines();
          return { k: 'if', c, then, else: this.stmtOrEmpty() };
        }
        this.p = save;
        return { k: 'if', c, then };
      }
      case 'while': {
        this.next();
        this.expect('(');
        const c = this.expr();
        this.expect(')');
        if (this.is(';')) { this.next(); return { k: 'while', c, body: { k: 'empty' } }; }
        this.optNewlines();
        return { k: 'while', c, body: this.loopBody() };
      }
      case 'do': {
        this.next();
        this.optNewlines();
        const body = this.loopBody();
        this.skipTerms();
        this.expect('while');
        this.expect('(');
        const c = this.expr();
        this.expect(')');
        this.term();
        return { k: 'do', body, c };
      }
      case 'for': {
        this.next();
        this.expect('(');
        // for (name in arr) / for ((name) in arr)
        if (this.is('NAME') && this.peek().t === 'in' && this.peek(2).t === 'NAME' && this.peek(3).t === ')') {
          const v = this.next().s;
          this.next();
          const arr = this.next().s;
          this.next();
          this.optNewlines();
          return { k: 'forin', v: { k: 'var', name: v }, arr, body: this.loopBody() };
        }
        if (this.is('(') && this.peek().t === 'NAME' && this.peek(2).t === ')' && this.peek(3).t === 'in' && this.peek(4).t === 'NAME' && this.peek(5).t === ')') {
          this.next();
          const v = this.next().s;
          this.p += 2;
          const arr = this.next().s;
          this.next();
          this.optNewlines();
          return { k: 'forin', v: { k: 'var', name: v }, arr, body: this.loopBody() };
        }
        const init = this.is(';') ? undefined : this.simpleStmt();
        this.expect(';');
        this.optNewlines();
        const c = this.is(';') ? undefined : this.expr();
        this.expect(';');
        this.optNewlines();
        const step = this.is(')') ? undefined : this.simpleStmt();
        this.expect(')');
        if (this.is(';')) { this.next(); return { k: 'for', init, c, step, body: { k: 'empty' } }; }
        this.optNewlines();
        return { k: 'for', init, c, step, body: this.loopBody() };
      }
      case 'break': case 'continue':
        if (this.loopDepth === 0) this.err(`\`${t.t}' is not allowed outside a loop`);
        this.next();
        this.term();
        return { k: t.t };
      case 'next': case 'nextfile':
        this.next();
        this.term();
        return { k: t.t };
      case 'exit': {
        this.next();
        const e = this.atTerm() ? undefined : this.expr();
        this.term();
        return { k: 'exit', e };
      }
      case 'return': {
        if (!this.inFunc) this.err('`return\' used outside function context');
        this.next();
        const e = this.atTerm() ? undefined : this.expr();
        this.term();
        return { k: 'return', e };
      }
    }
    const s = this.simpleStmt();
    this.term();
    return s;
  }

  private stmtOrEmpty(): Stmt {
    if (this.is(';')) { this.next(); return { k: 'empty' }; }
    return this.stmt();
  }

  private loopBody(): Stmt {
    this.loopDepth++;
    try { return this.stmtOrEmpty(); } finally { this.loopDepth--; }
  }

  private atTerm(): boolean {
    const t = this.tok.t;
    return t === ';' || t === 'NEWLINE' || t === '}' || t === 'EOF';
  }

  private simpleStmt(): Stmt {
    const t = this.tok;
    if (t.t === 'print' || t.t === 'printf') {
      this.next();
      let args: Expr[] = [];
      if (this.is('(')) {
        // print (a, b) [> file]: a parenthesized list, unless more expression follows
        const save = this.p;
        this.next();
        const saveGt = this.noGt;
        this.noGt = 0;
        let list: Expr[] | null = null;
        try {
          if (!this.is(')')) list = this.exprList();
          else list = [];
          this.expect(')');
        } catch (e) {
          list = null;
        }
        this.noGt = saveGt;
        const n = this.tok.t;
        if (list && (n === ';' || n === 'NEWLINE' || n === '}' || n === 'EOF' || n === '>' || n === '>>' || n === '|')) {
          if (list.length === 0 && t.t === 'print') this.err('syntax error');
          args = list;
        } else {
          this.p = save;
          args = this.printArgs();
        }
      } else if (!this.atTerm() && !this.is('>') && !this.is('>>') && !this.is('|')) {
        args = this.printArgs();
      }
      if (t.t === 'printf' && args.length === 0) this.err();
      let redir: Redirect | undefined;
      if (this.is('>') || this.is('>>') || this.is('|')) {
        const op = this.next().t as '>' | '>>' | '|';
        this.noGt++;
        try { redir = { op, e: this.concat() }; } finally { this.noGt--; }
      }
      return { k: t.t, args, redir };
    }
    if (t.t === 'delete') {
      this.next();
      let paren = false;
      if (this.is('(')) { paren = true; this.next(); }
      if (!this.is('NAME')) this.err();
      const name = this.next().s;
      let subs: Expr[] | undefined;
      if (this.is('[')) {
        this.next();
        subs = this.exprList();
        this.expect(']');
      }
      if (paren) this.expect(')');
      return { k: 'delete', name, subs };
    }
    return { k: 'expr', e: this.expr() };
  }

  private printArgs(): Expr[] {
    this.noGt++;
    try { return this.exprList(); } finally { this.noGt--; }
  }

  private exprList(): Expr[] {
    const list = [this.expr()];
    while (this.is(',')) {
      this.next();
      this.optNewlines();
      list.push(this.expr());
    }
    return list;
  }

  /** Full expression (assignment is lowest, right-associative) */
  expr(): Expr {
    const left = this.ternary();
    if (ASSIGN_OPS.has(this.tok.t)) {
      if (!isLvalue(left)) {
        if (this.tok.t === '=') this.err();
        return left;
      }
      const op = this.next().t;
      this.optNewlines();
      const e = this.expr();
      return { k: 'assign', op, lv: left, e };
    }
    return left;
  }

  private ternary(): Expr {
    const c = this.or();
    if (!this.is('?')) return c;
    this.next();
    this.optNewlines();
    const a = this.expr();
    this.optNewlines();
    this.expect(':');
    this.optNewlines();
    const b = this.expr();
    return { k: 'cond', c, a, b };
  }

  private or(): Expr {
    let a = this.and();
    while (this.is('||')) {
      this.next();
      this.optNewlines();
      const b = this.and();
      a = { k: 'or', a, b };
    }
    return a;
  }

  private and(): Expr {
    let a = this.inExpr();
    while (this.is('&&')) {
      this.next();
      this.optNewlines();
      const b = this.inExpr();
      a = { k: 'and', a, b };
    }
    return a;
  }

  private inExpr(): Expr {
    let a = this.matchExpr();
    while (this.is('in') && !this.noIn) {
      this.next();
      const name = this.expect('NAME').s;
      a = { k: 'in', subs: [a], name };
    }
    return a;
  }

  private matchExpr(): Expr {
    let a = this.comparison();
    while (this.is('~') || this.is('!~')) {
      const neg = this.next().t === '!~';
      const re = this.comparison();
      a = { k: 'match', neg, a, re };
    }
    return a;
  }

  private comparison(): Expr {
    let a = this.pipeGetline();
    for (;;) {
      const t = this.tok.t;
      if (t === '<' || t === '<=' || t === '!=' || t === '==' || t === '>=' || (t === '>' && !this.noGt)) {
        this.next();
        const b = this.pipeGetline();
        a = { k: 'cmp', op: t, a, b };
        continue;
      }
      return a;
    }
  }

  /** cmd | getline [var] */
  private pipeGetline(): Expr {
    let a = this.concat();
    while ((this.is('|') || this.is('|&')) && this.peek().t === 'getline') {
      this.p += 2;
      const lv = this.optGetlineLvalue();
      a = { k: 'getline', kind: 'cmd', lv, src: a };
    }
    return a;
  }

  private concat(): Expr {
    let a = this.additive();
    for (;;) {
      const t = this.tok.t;
      if (!CONCAT_START.has(t) || t === '-' || t === '+' || t === '!') return a;
      if (t === 'in') return a;
      const b = this.additive();
      a = { k: 'cat', a, b };
    }
  }

  private additive(): Expr {
    let a = this.multiplicative();
    while (this.is('+') || this.is('-')) {
      const op = this.next().t;
      const b = this.multiplicative();
      a = { k: 'bin', op, a, b };
    }
    return a;
  }

  private multiplicative(): Expr {
    let a = this.unary();
    while (this.is('*') || this.is('/') || this.is('%')) {
      const op = this.next().t;
      const b = this.unary();
      a = { k: 'bin', op, a, b };
    }
    return a;
  }

  private unary(): Expr {
    const t = this.tok.t;
    if (t === '!' || t === '-' || t === '+') {
      this.next();
      const e = this.unary();
      // `!x = y` is !(x = y)
      if (isLvalue(e) && ASSIGN_OPS.has(this.tok.t)) {
        const op = this.next().t;
        const rhs = this.expr();
        return { k: 'unary', op: t, e: { k: 'assign', op, lv: e, e: rhs } };
      }
      return { k: 'unary', op: t, e };
    }
    return this.power();
  }

  private power(): Expr {
    const a = this.postfix();
    if (this.is('^')) {
      this.next();
      // right associative; the exponent may carry a unary sign
      let b: Expr;
      if (this.is('-') || this.is('+') || this.is('!')) {
        const op = this.next().t;
        b = { k: 'unary', op, e: this.powerOperand() };
      } else b = this.powerOperand();
      return { k: 'bin', op: '^', a, b };
    }
    return a;
  }

  private powerOperand(): Expr {
    return this.power();
  }

  private postfix(): Expr {
    if (this.is('++') || this.is('--')) {
      const op = this.next().t;
      const lv = this.postfix();
      if (!isLvalue(lv)) this.err();
      return { k: 'incdec', op, pre: true, lv };
    }
    const e = this.primary();
    if (isLvalue(e) && (this.is('++') || this.is('--'))) {
      const op = this.next().t;
      return { k: 'incdec', op, pre: false, lv: e };
    }
    return e;
  }

  /** Operand of `$`: a primary, possibly with prefix ++/-- or unary sign */
  private fieldOperand(): Expr {
    if (this.is('++') || this.is('--')) {
      const op = this.next().t;
      const lv = this.fieldOperand();
      if (!isLvalue(lv)) this.err();
      return { k: 'incdec', op, pre: true, lv };
    }
    if (this.is('-') || this.is('+') || this.is('!')) {
      const op = this.next().t;
      return { k: 'unary', op, e: this.fieldOperand() };
    }
    return this.primary();
  }

  private optGetlineLvalue(): Expr | undefined {
    if (this.is('$')) {
      this.next();
      return { k: 'field', e: this.fieldOperand() };
    }
    if (this.is('NAME')) {
      const name = this.next().s;
      if (this.is('[')) {
        this.next();
        const subs = this.exprList();
        this.expect(']');
        return { k: 'idx', name, subs };
      }
      return { k: 'var', name };
    }
    return undefined;
  }

  private parenthesized<T>(fn: () => T): T {
    const g = this.noGt;
    const i = this.noIn;
    this.noGt = 0;
    this.noIn = 0;
    try { return fn(); } finally { this.noGt = g; this.noIn = i; }
  }

  private primary(): Expr {
    const t = this.tok;
    switch (t.t) {
      case 'NUMBER': this.next(); return { k: 'num', v: t.n };
      case 'STRING': this.next(); return { k: 'str', v: t.s };
      case 'ERE': this.next(); return { k: 're', v: t.s };
      case '$': {
        this.next();
        return { k: 'field', e: this.fieldOperand() };
      }
      case '(': {
        this.next();
        const list = this.parenthesized(() => {
          this.optNewlines();
          const l = this.exprList();
          this.optNewlines();
          return l;
        });
        this.expect(')');
        if (list.length > 1) {
          if (!this.is('in')) this.err();
          this.next();
          const name = this.expect('NAME').s;
          return { k: 'in', subs: list, name };
        }
        return { k: 'group', e: list[0] };
      }
      case '-': case '+': case '!': {
        this.next();
        return { k: 'unary', op: t.t, e: this.unary() };
      }
      case '++': case '--':
        return this.postfix();
      case 'getline': {
        this.next();
        const lv = this.optGetlineLvalue();
        if (this.is('<')) {
          this.next();
          const src = this.getlineSource();
          return { k: 'getline', kind: 'file', lv, src };
        }
        return { k: 'getline', kind: 'simple', lv };
      }
      case 'FUNC_NAME': {
        this.next();
        return this.callArgs(t);
      }
      case 'NAME': {
        this.next();
        if (this.is('[')) {
          this.next();
          const subs = this.parenthesized(() => this.exprList());
          this.expect(']');
          return { k: 'idx', name: t.s, subs };
        }
        // `f (x)` for a user function (gawk accepts the space)
        if (this.is('(') && this.funcNames.has(t.s)) return this.callArgs(t);
        return { k: 'var', name: t.s };
      }
      case 'BUILTIN': {
        this.next();
        if (!this.is('(')) {
          if (t.s === 'length') return { k: 'builtin', name: 'length', args: [] };
          this.err();
        }
        this.next();
        const args = this.parenthesized(() => {
          this.optNewlines();
          const a = this.is(')') ? [] : this.exprList();
          this.optNewlines();
          return a;
        });
        this.expect(')');
        return { k: 'builtin', name: t.s, args };
      }
    }
    this.err();
  }

  /** getline < file: the file is a primary (no concatenation) */
  private getlineSource(): Expr {
    if (this.is('$')) {
      this.next();
      return { k: 'field', e: this.fieldOperand() };
    }
    if (this.is('-') || this.is('+') || this.is('!')) this.err();
    const e = this.primary();
    if (isLvalue(e) && (this.is('++') || this.is('--'))) {
      const op = this.next().t;
      return { k: 'incdec', op, pre: false, lv: e };
    }
    return e;
  }

  private callArgs(t: Token): Expr {
    this.expect('(');
    const args = this.parenthesized(() => {
      this.optNewlines();
      const a = this.is(')') ? [] : this.exprList();
      this.optNewlines();
      return a;
    });
    this.expect(')');
    return { k: 'call', name: t.s, args, line: t.line };
  }
}

export function parseProgram(src: string): Program {
  return new Parser(src).parseProgram();
}
