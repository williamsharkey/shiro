/**
 * A syntax check of one complete shell command (a script's statement, a
 * `sh -c` string) before any of it runs, as bash parses a command before
 * executing it: `echo hi; while` prints nothing and is status 2, not "hi"
 * and then an error. It reports only what is surely an error (unterminated
 * compounds, quotes and substitutions, a stray `}` / `;;` / `)` / `fi`, a `(`
 * inside a word, an array literal where none can be); anything it isn't sure
 * of passes, so a script it doesn't understand still runs as before.
 */

type Tok = { t: 'word'; v: string } | { t: 'op'; v: string } | { t: 'nl' } | { t: 'eof' };

class Unsure extends Error {}
class Syntax extends Error {}

const OPS = [';;&', ';;', ';&', '&&', '||', '|&', '&>>', '<<<', '<<-', '<<', '>>', '<>', '<&', '>&', '>|', '&>', '|', ';', '&', '(', ')', '<', '>'];
const REDIRS = new Set(['&>>', '<<<', '<<-', '<<', '>>', '<>', '<&', '>&', '>|', '&>', '<', '>']);
const DECLARE = new Set(['declare', 'typeset', 'local', 'export', 'readonly', 'let']);

class Lexer {
  i = 0;
  /** Here-doc delimiters to skip at the next newline */
  pending: { delim: string; strip: boolean }[] = [];
  /** Set by the parser: a NAME=( here is an array literal, not an error */
  allowArray = false;
  constructor(private s: string) {}

  private eofErr(what: string): never { throw new Syntax(`unexpected EOF while looking for matching \`${what}'`); }

  /** Skip a quoted or nested part starting at i (the opener), returning the index after it */
  private skipPart(i: number): number {
    const s = this.s;
    const c = s[i];
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) this.eofErr("'"); return e + 1; }
    if (c === '"') {
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '"') return j + 1;
        if (s[j] === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) { j = this.skipPart(j) - 1; continue; }
        if (s[j] === '`') { j = this.skipPart(j) - 1; continue; }
      }
      this.eofErr('"');
    }
    if (c === '`') {
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '`') return j + 1;
      }
      this.eofErr('`');
    }
    if (c === '$' && s[i + 1] === "'") {
      for (let j = i + 2; j < s.length; j++) {
        // (\cX takes the next character whatever it is, a quote too)
        if (s[j] === '\\') { j += s[j + 1] === 'c' ? 2 : 1; continue; }
        if (s[j] === "'") return j + 1;
      }
      this.eofErr("'");
    }
    if (c === '$' && s[i + 1] === '{') return this.skipBalanced(i + 2, '{', '}');
    if (c === '$' && s[i + 1] === '[') return this.skipBalanced(i + 2, '[', ']');
    if (c === '$' && s[i + 1] === '(') {
      // $( … ): a case statement inside can have unbalanced ) in its patterns
      const end = this.skipBalanced(i + 2, '(', ')');
      if (/\bcase\b/.test(s.slice(i, end))) throw new Unsure();
      return end;
    }
    return i + 1;
  }

  /** From i, past the closer matching an already opened opener (quotes skipped) */
  private skipBalanced(i: number, open: string, close: string): number {
    const s = this.s;
    let depth = 1;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      // a here-doc inside $( … ): its body can hold anything (it's for the shell to judge)
      if (c === '<' && s[j + 1] === '<' && s[j + 2] !== '<') throw new Unsure();
      if (c === "'" || c === '"' || c === '`' || (c === '$' && (s[j + 1] === "'" || s[j + 1] === '(' || s[j + 1] === '{' || s[j + 1] === '['))) {
        j = this.skipPart(j) - 1;
        continue;
      }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j + 1;
    }
    this.eofErr(close);
  }

  next(): Tok {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && (s[this.i] === ' ' || s[this.i] === '\t')) this.i++;
      if (s[this.i] === '\\' && s[this.i + 1] === '\n') { this.i += 2; continue; }
      if (s[this.i] === '#') { while (this.i < s.length && s[this.i] !== '\n') this.i++; continue; }
      break;
    }
    if (this.i >= s.length) return { t: 'eof' };
    const c = s[this.i];
    if (c === '\n') {
      this.i++;
      // here-doc bodies follow the line that started them
      for (const h of this.pending) {
        for (;;) {
          const nl = s.indexOf('\n', this.i);
          const line = s.slice(this.i, nl < 0 ? s.length : nl);
          this.i = nl < 0 ? s.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          if (nl < 0) throw new Unsure(); // (bash warns and goes on)
        }
      }
      this.pending = [];
      return { t: 'nl' };
    }
    // operators (a digit or {name} before a redirection is part of it)
    const fdPrefix = /^(\d+|\{[A-Za-z_]\w*\})(?=[<>])/.exec(s.slice(this.i));
    const at = this.i + (fdPrefix ? fdPrefix[0].length : 0);
    for (const op of OPS) {
      if (s.startsWith(op, at) && (fdPrefix ? REDIRS.has(op) : true)) {
        // <( >( are process substitutions: words
        if ((op === '<' || op === '>') && s[at + 1] === '(') break;
        this.i = at + op.length;
        return { t: 'op', v: op };
      }
    }
    // a word
    const start = this.i;
    let j = this.i;
    while (j < s.length) {
      const ch = s[j];
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      if (ch === '\\') { j += 2; continue; }
      if (ch === "'" || ch === '"' || ch === '`' || (ch === '$' && (s[j + 1] === "'" || s[j + 1] === '(' || s[j + 1] === '{' || s[j + 1] === '['))) {
        j = this.skipPart(j);
        continue;
      }
      if ((ch === '<' || ch === '>') && s[j + 1] === '(') { j = this.skipBalanced(j + 2, '(', ')'); continue; }
      // NAME[ … ]: a subscript (arithmetic, parentheses allowed)
      if (ch === '[' && /^[A-Za-z_]\w*$/.test(s.slice(start, j))) {
        try { j = this.skipBalanced(j + 1, '[', ']'); } catch (e) { if (!(e instanceof Syntax)) throw e; j++; }
        continue;
      }
      if (ch === '(') {
        const before = s.slice(start, j);
        // extglob ?( *( +( @( !(
        if (/[?*+@!]$/.test(before)) { j = this.skipBalanced(j + 1, '(', ')'); continue; }
        // NAME=( … ) / NAME+=( … ): an array literal where an assignment can be
        if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=$/.test(before)) {
          if (!this.allowArray) throw new Syntax("syntax error near unexpected token `('");
          j = this.arrayLiteral(j + 1);
          continue;
        }
        if (j === start) break; // an operator
        // NAME() : a function definition's header (the parser checks the rest)
        if (/^\s*\)/.test(s.slice(j + 1))) break;
        throw new Syntax("syntax error near unexpected token `('");
      }
      if (';&|<>)'.includes(ch)) break;
      j++;
    }
    this.i = j;
    return { t: 'word', v: s.slice(start, j) };
  }

  /** The inside of an array literal from i (after its `(`): words, no nested ( */
  private arrayLiteral(i: number): number {
    const s = this.s;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === "'" || c === '"' || c === '`' || (c === '$' && (s[j + 1] === "'" || s[j + 1] === '(' || s[j + 1] === '{' || s[j + 1] === '['))) {
        j = this.skipPart(j) - 1;
        continue;
      }
      if (c === '#' && (j === i || /\s/.test(s[j - 1]))) { while (j < s.length && s[j] !== '\n') j++; continue; }
      if (c === '(') {
        if (/[?*+@!]$/.test(s.slice(i, j))) { j = this.skipBalanced(j + 1, '(', ')') - 1; continue; }
        throw new Syntax("syntax error near unexpected token `('");
      }
      if (c === ')') return j + 1;
    }
    this.eofErr(')');
  }

  /** `(( … ))` after its opening `((`: through the closing `))` */
  arith(): void {
    const end = this.skipBalanced(this.i, '(', ')');
    if (this.s[end] !== ')') throw new Unsure(); // `( (…) …)`: a subshell after all
    this.i = end + 1;
  }
}

const near = (tok: Tok) => tok.t === 'eof' ? 'syntax error: unexpected end of file'
  : `syntax error near unexpected token \`${tok.t === 'nl' ? 'newline' : tok.v}'`;

class Parser {
  private tok!: Tok;
  constructor(private lx: Lexer) {}

  private advance(allowArray = false): Tok {
    this.lx.allowArray = allowArray;
    this.tok = this.lx.next();
    return this.tok;
  }
  private kind(): Tok['t'] { return this.tok.t; }
  private val(): string { return (this.tok as { v?: string }).v ?? ''; }
  private isWord(v?: string): boolean { return this.kind() === 'word' && (v === undefined || this.val() === v); }
  private isOp(v: string): boolean { return this.kind() === 'op' && this.val() === v; }
  private fail(): never { throw new Syntax(near(this.tok)); }
  private skipNl(allowArray = false) { while (this.kind() === 'nl') this.advance(allowArray); }

  /** Nothing parsed yet: a `;` here is the one bash always rejects */
  private atStart = true;

  parse(): void {
    this.advance(true);
    this.list(new Set());
    if (this.kind() !== 'eof') this.fail();
  }

  /** Commands separated by ; & && || | and newlines, until a word in `ends` at command position (or ) / ;; / EOF) */
  private list(ends: Set<string>, caseItem = false): void {
    this.skipNl(true);
    let any = false;
    for (;;) {
      if (this.kind() === 'eof') return;
      if (this.kind() === 'word' && ends.has(this.val())) return;
      if (this.isOp(')') || (caseItem && (this.isOp(';;') || this.isOp(';&') || this.isOp(';;&')))) return;
      // (an empty command before ; after an opener or a newline: bash takes `then;`, `{;`)
      if (this.isOp(';') && !this.atStart) { this.advance(true); this.skipNl(true); continue; }
      this.atStart = false;
      this.pipeline();
      any = true;
      if (this.kind() === 'op' && (this.val() === ';' || this.val() === '&' || this.val() === '&&' || this.val() === '||')) {
        const sep = this.val();
        this.advance(true);
        if (sep === '&&' || sep === '||') { this.skipNl(true); if (this.kind() === 'eof') this.fail(); continue; }
        this.skipNl(true);
        continue;
      }
      if (this.kind() === 'nl') { this.skipNl(true); continue; }
      if (this.kind() === 'eof' || this.isOp(')')) return;
      if (this.kind() === 'word' && ends.has(this.val())) return;
      if (caseItem && (this.isOp(';;') || this.isOp(';&') || this.isOp(';;&'))) return;
      this.fail();
    }
    void any;
  }

  private pipeline(): void {
    if (this.isWord('!') || this.isWord('time')) this.advance(true);
    this.command();
    while (this.isOp('|') || this.isOp('|&')) {
      this.advance(true);
      this.skipNl(true);
      if (this.kind() === 'eof') this.fail();
      this.command();
    }
  }

  private redirect(): void {
    const op = (this.tok as { v: string }).v;
    this.advance();
    if (this.kind() !== 'word') this.fail();
    if (op === '<<' || op === '<<-') {
      const delim = this.val().replace(/['"\\]/g, '');
      this.lx.pending.push({ delim, strip: op === '<<-' });
    }
    this.advance();
  }

  private command(): void {
    const t = this.tok;
    if (t.t === 'op') {
      if (REDIRS.has(t.v)) return this.simple();
      if (t.v === '(') {
        // (( arithmetic )) or a ( subshell )
        if (this.lx['s'][this.lx.i] === '(') {
          this.lx.i++;
          this.lx.arith();
          this.advance();
          return this.tail();
        }
        this.advance(true);
        this.list(new Set());
        if (!this.isOp(')')) this.fail();
        this.advance();
        return this.tail();
      }
      this.fail();
    }
    if (t.t !== 'word') this.fail();
    switch (t.v) {
      case '{': this.advance(true); this.list(new Set(['}'])); this.expect('}'); return this.tail();
      case 'if': return this.ifCmd();
      case 'while': case 'until':
        this.advance(true); this.list(new Set(['do'])); this.expect('do');
        this.list(new Set(['done'])); this.expect('done'); return this.tail();
      case 'for': case 'select': return this.forCmd();
      case 'case': return this.caseCmd();
      case '[[': {
        // up to ]] (its own little language, regexes with ( in them: the shell checks it when it runs)
        try {
          while (!this.isWord(']]')) { if (this.kind() === 'eof' || this.kind() === 'nl') throw new Unsure(); this.advance(); }
          this.advance();
        } catch (e) {
          if (e instanceof Syntax) throw new Unsure();
          throw e;
        }
        return this.tail();
      }
      case 'coproc': throw new Unsure();
      case 'function': {
        this.advance();
        if (this.kind() !== 'word') this.fail();
        this.advance();
        if (this.isOp('(')) { this.advance(); if (!this.isOp(')')) this.fail(); this.advance(); }
        this.skipNl();
        return this.command();
      }
      case '}': case 'fi': case 'done': case 'esac': case 'then': case 'else': case 'elif': case 'do': case 'in':
        if (t.v === 'in') return this.simple();
        this.fail();
    }
    return this.simple();
  }

  /** Redirections after a compound command */
  private tail(): void {
    while (this.kind() === 'op' && REDIRS.has(this.val())) this.redirect();
  }

  private expect(w: string): void {
    if (!this.isWord(w)) this.fail();
    // (after then/do/else a command starts: NAME=( … ) is an assignment there)
    this.advance(w === 'then' || w === 'do' || w === 'else');
  }

  private simple(): void {
    let first = true;
    let declare = false;
    for (;;) {
      if (this.kind() === 'op' && REDIRS.has(this.val())) { this.redirect(); continue; }
      if (this.kind() !== 'word') break;
      const w = this.val();
      const isAssign = /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(w);
      const prefix = first && (w === 'builtin' || w === 'command');
      if (first && DECLARE.has(w)) declare = true;
      this.advance(declare || (first && isAssign) || prefix);
      // NAME() { …: a function definition
      if (first && !isAssign && this.isOp('(')) {
        this.advance();
        if (!this.isOp(')')) this.fail();
        this.advance();
        this.skipNl();
        return this.command();
      }
      // (builtin/command typeset a=(…) too)
      if (prefix) continue;
      // assignments keep the command position (and array literals there)
      if (!isAssign) first = false;
    }
    if (this.isOp('(')) this.fail();
  }

  private ifCmd(): void {
    this.advance(true);
    this.list(new Set(['then']));
    this.expect('then');
    this.list(new Set(['elif', 'else', 'fi']));
    while (this.isWord('elif')) {
      this.advance(true);
      this.list(new Set(['then']));
      this.expect('then');
      this.list(new Set(['elif', 'else', 'fi']));
    }
    if (this.isWord('else')) { this.advance(true); this.list(new Set(['fi'])); }
    this.expect('fi');
    this.tail();
  }

  private forCmd(): void {
    this.advance();
    if (this.isOp('(')) {
      // for (( … ))
      if (this.lx['s'][this.lx.i] !== '(') this.fail();
      this.lx.i++;
      this.lx.arith();
      this.advance();
    } else {
      if (this.kind() !== 'word') this.fail();
      this.advance();
      this.skipNl();
      if (this.isWord('in')) {
        this.advance();
        while (this.kind() === 'word') this.advance();
        if (this.kind() !== 'nl' && !this.isOp(';')) this.fail();
      }
    }
    if (this.isOp(';')) this.advance();
    this.skipNl();
    if (this.isWord('{')) { this.advance(true); this.list(new Set(['}'])); this.expect('}'); return this.tail(); }
    this.expect('do');
    this.list(new Set(['done']));
    this.expect('done');
    this.tail();
  }

  private caseCmd(): void {
    this.advance();
    if (this.kind() !== 'word') this.fail();
    this.advance();
    this.skipNl();
    this.expect('in');
    this.skipNl();
    for (;;) {
      this.skipNl();
      if (this.isWord('esac')) { this.advance(); return this.tail(); }
      if (this.kind() === 'eof') this.fail();
      if (this.isOp('(')) this.advance();
      // patterns: words separated by |
      for (;;) {
        if (this.kind() !== 'word') this.fail();
        this.advance();
        if (this.isOp('|')) { this.advance(); continue; }
        break;
      }
      if (!this.isOp(')')) this.fail();
      this.advance(true);
      this.list(new Set(['esac']), true);
      if (this.isOp(';;') || this.isOp(';&') || this.isOp(';;&')) { this.advance(); continue; }
      if (this.isWord('esac')) { this.advance(); return this.tail(); }
      this.fail();
    }
  }
}

/** The syntax error in a complete command, as bash words it; null if none (or unsure) */
export function syntaxError(text: string): string | null {
  try {
    new Parser(new Lexer(text)).parse();
    return null;
  } catch (e) {
    if (e instanceof Syntax) return e.message;
    return null; // Unsure, or a bug here: let the command run as before
  }
}
