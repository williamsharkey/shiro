import type { Command, CommandContext } from './index';
import { posixToJsSource } from '../utils/posix-regex';

/**
 * sed, following GNU sed: scripts from -e/-f/the first operand, -n, -E/-r,
 * -i[SUFFIX], -s, -z; addresses N, $, /re/I, \cREc, first~step, A,B, A,+N,
 * A,~N, 0,/re/, with ! and { } blocks; commands s y p P d D n N g G h H x
 * b t T : = l q Q a i c r R w W e z F and #comments. Regular expressions
 * are POSIX BRE (ERE with -E), translated by utils/posix-regex.ts.
 */

type Addr =
  | { kind: 'line'; n: number }
  | { kind: 'last' }
  | { kind: 're'; re: RegExp | null }
  | { kind: 'step'; first: number; step: number }
  | { kind: 'zero' };

type Addr2 = Addr | { kind: 'plus'; n: number } | { kind: 'mult'; n: number };

interface Cmd {
  a1?: Addr;
  a2?: Addr2;
  negate: boolean;
  name: string;
  /** s: regex, replacement and flags; y: maps; a/i/c: text; b/t/T: label; r/w: file */
  re?: RegExp | null;
  replacement?: string;
  global?: boolean;
  occurrence?: number;
  print?: number; // s///p count
  wfile?: string;
  text?: string;
  label?: string;
  file?: string;
  from?: string;
  to?: string;
  qcode?: number;
  /** index of the matching } for {, of the command after the block */
  blockEnd?: number;
  /** range state */
  active?: boolean;
  started?: boolean;
  endLine?: number;
}

class SedError extends Error {}

/** Parse a sed script into a flat command list ({ jumps to its blockEnd when not selected) */
function parseScript(script: string, extended: boolean): { cmds: Cmd[]; labels: Map<string, number> } {
  const cmds: Cmd[] = [];
  const labels = new Map<string, number>();
  const blockStack: number[] = [];
  let i = 0;
  const n = script.length;
  let lastRe: RegExp | null = null;
  const compile = (src: string, flags: string): RegExp | null => {
    // An empty regex means the last one used
    if (src === '') return null;
    try {
      const re = new RegExp(posixToJsSource(src, { extended }), flags);
      lastRe = re;
      return re;
    } catch (e: any) {
      throw new SedError(`-e expression #1, char ${i}: ${e.message}`);
    }
  };
  void lastRe;
  const skipWs = () => { while (i < n && (script[i] === ' ' || script[i] === '\t')) i++; };
  /** Read a delimited part (regex or replacement), handling \delim and \n */
  const readDelimited = (delim: string, isRegex: boolean): string => {
    let out = '';
    let inBracket = false;
    while (i < n) {
      const c = script[i];
      if (isRegex && inBracket) {
        out += c;
        i++;
        if (c === ']' ) inBracket = false;
        continue;
      }
      if (c === '\\' && i + 1 < n) {
        const nx = script[i + 1];
        // \DELIM is the delimiter character itself, literally
        if (nx === delim) { out += !isRegex ? (delim === '&' ? '\\&' : delim) : /[.*[\]^$\\+?(){}|]/.test(delim) ? `[${delim}]` : delim; i += 2; continue; }
        if (nx === '\n') { out += isRegex ? '\\n' : '\n'; i += 2; continue; }
        out += c + nx;
        i += 2;
        continue;
      }
      if (c === delim) { i++; return out; }
      if (isRegex && c === '[') {
        inBracket = true;
        out += c;
        i++;
        // ] or ^] right after [ is literal
        if (script[i] === '^') { out += '^'; i++; }
        if (script[i] === ']') { out += ']'; i++; }
        continue;
      }
      if (c === '\n' && !isRegex) { out += c; i++; continue; }
      out += c;
      i++;
    }
    throw new SedError(`unterminated \`s' command`);
  };
  const readNumber = (): number => {
    const m = /^\d+/.exec(script.slice(i));
    if (!m) throw new SedError('expected a number');
    i += m[0].length;
    return parseInt(m[0], 10);
  };
  const readAddr = (): Addr | null => {
    const c = script[i];
    if (c === '$') { i++; return { kind: 'last' }; }
    if (/\d/.test(c)) {
      const first = readNumber();
      if (script[i] === '~') { i++; const step = /\d/.test(script[i] ?? '') ? readNumber() : 0; return { kind: 'step', first, step }; }
      return first === 0 ? { kind: 'zero' } : { kind: 'line', n: first };
    }
    if (c === '/' || c === '\\') {
      let delim = '/';
      if (c === '\\') { delim = script[i + 1]; i += 2; } else i++;
      const src = readDelimited(delim, true);
      let flags = 's';
      while (script[i] === 'I' || script[i] === 'M') { if (script[i] === 'I') flags += 'i'; else flags += 'm'; i++; }
      return { kind: 're', re: compile(src, flags) };
    }
    return null;
  };
  /** Text argument of a/i/c: GNU one-liner (`a text`) or POSIX `a\` + lines */
  const readText = (): string => {
    skipWs();
    if (script[i] === '\\') {
      i++;
      if (script[i] === '\n') i++;
    }
    let out = '';
    while (i < n && script[i] !== '\n') {
      if (script[i] === '\\' && i + 1 < n) {
        const e = gnuEscape(script, i + 1);
        out += e.text;
        i = e.next;
        continue;
      }
      out += script[i];
      i++;
    }
    return out;
  };
  /** A label: for b/t/T it ends at a blank, ; or } (GNU); for `:` at ; or newline */
  const readLabel = (forJump: boolean): string => {
    skipWs();
    let out = '';
    while (i < n && script[i] !== '\n' && script[i] !== ';' && !(forJump && /[\s}]/.test(script[i]))) out += script[i++];
    return out.trim();
  };
  const readFilename = (): string => {
    skipWs();
    let out = '';
    while (i < n && script[i] !== '\n') out += script[i++];
    return out;
  };
  const endCommand = () => {
    skipWs();
    if (i < n && script[i] === '}') return;
    if (i < n && script[i] === '#') { while (i < n && script[i] !== '\n') i++; return; }
    if (i < n && script[i] !== ';' && script[i] !== '\n') throw new SedError(`extra characters after command`);
    if (i < n) i++;
  };

  while (i < n) {
    while (i < n && /[\s;]/.test(script[i])) i++;
    if (i >= n) break;
    if (script[i] === '#') { while (i < n && script[i] !== '\n') i++; continue; }
    const cmd: Cmd = { negate: false, name: '' };
    const a1 = readAddr();
    if (a1) {
      cmd.a1 = a1;
      skipWs();
      if (script[i] === ',') {
        i++;
        skipWs();
        if (script[i] === '+') { i++; cmd.a2 = { kind: 'plus', n: readNumber() }; }
        else if (script[i] === '~') { i++; cmd.a2 = { kind: 'mult', n: readNumber() }; }
        else {
          const a2 = readAddr();
          if (!a2) throw new SedError('unexpected `,\'');
          cmd.a2 = a2.kind === 'zero' ? { kind: 'line', n: 0 } : a2;
        }
      }
    }
    skipWs();
    while (script[i] === '!') { cmd.negate = true; i++; skipWs(); }
    const name = script[i++];
    if (name === undefined) throw new SedError('missing command');
    cmd.name = name;
    switch (name) {
      case '{':
        blockStack.push(cmds.length);
        cmds.push(cmd);
        continue;
      case '}':
        if (!blockStack.length) throw new SedError('unexpected `}\'');
        cmds[blockStack.pop()!].blockEnd = cmds.length;
        endCommand();
        continue;
      case 's': {
        const delim = script[i++];
        if (!delim || delim === '\n' || delim === '\\') throw new SedError("unterminated `s' command");
        const src = readDelimited(delim, true);
        const rep = readDelimited(delim, false);
        let flags = 's';
        cmd.global = false;
        cmd.print = 0;
        for (;;) {
          const f = script[i];
          if (f === 'g') { cmd.global = true; i++; }
          else if (f === 'p') { cmd.print!++; i++; }
          else if (f === 'i' || f === 'I') { flags += 'i'; i++; }
          else if (f === 'm' || f === 'M') { flags += 'm'; i++; }
          else if (f === 'e') { i++; }
          else if (f !== undefined && /\d/.test(f)) { cmd.occurrence = readNumber(); }
          else if (f === 'w') { i++; cmd.wfile = readFilename(); break; }
          else break;
        }
        cmd.re = compile(src, flags + 'g');
        cmd.replacement = rep;
        break;
      }
      case 'y': {
        const delim = script[i++];
        const from = readDelimited(delim, false).replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
        const to = readDelimited(delim, false).replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
        if ([...from].length !== [...to].length) throw new SedError("strings for `y' command are different lengths");
        cmd.from = from;
        cmd.to = to;
        break;
      }
      case 'a': case 'i': case 'c':
        cmd.text = readText();
        cmds.push(cmd);
        if (i < n) i++;
        continue;
      case ':': {
        if (cmd.a1) throw new SedError(': doesn\'t want any addresses');
        const label = readLabel(false);
        if (!label) throw new SedError('":" lacks a label');
        labels.set(label, cmds.length);
        if (script[i] === ';') i++;
        continue;
      }
      case 'b': case 't': case 'T':
        cmd.label = readLabel(true);
        break;
      case 'r': case 'R': case 'w': case 'W':
        cmd.file = readFilename();
        break;
      case 'q': case 'Q': case 'l': case 'L': {
        skipWs();
        if (/\d/.test(script[i] ?? '')) cmd.qcode = readNumber();
        break;
      }
      case '=': case 'd': case 'D': case 'g': case 'G': case 'h': case 'H': case 'n': case 'N':
      case 'p': case 'P': case 'x': case 'z': case 'F': case 'e':
        break;
      default:
        throw new SedError(`unknown command: \`${name}'`);
    }
    cmds.push(cmd);
    endCommand();
  }
  if (blockStack.length) throw new SedError('unmatched `{\'');
  return { cmds, labels };
}

/** GNU sed's escapes after a backslash at s[i]: \n \t \r \a \f \v \dNNN \oNNN \xHH \cX; others are the character */
function gnuEscape(s: string, i: number): { text: string; next: number } {
  const c = s[i];
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', f: '\f', v: '\v' };
  if (simple[c] !== undefined) return { text: simple[c], next: i + 1 };
  const num = (re: RegExp, base: number) => {
    const m = re.exec(s.slice(i + 1));
    return m ? { text: String.fromCharCode(parseInt(m[0], base)), next: i + 1 + m[0].length } : null;
  };
  if (c === 'd') return num(/^\d{1,3}/, 10) ?? { text: c, next: i + 1 };
  if (c === 'o') return num(/^[0-7]{1,3}/, 8) ?? { text: c, next: i + 1 };
  if (c === 'x') return num(/^[0-9a-fA-F]{1,2}/, 16) ?? { text: c, next: i + 1 };
  if (c === 'c' && i + 1 < s.length) return { text: String.fromCharCode(s[i + 1].toUpperCase().charCodeAt(0) ^ 0x40), next: i + 2 };
  return { text: c ?? '', next: i + 1 };
}

/** Expand a replacement: & \1-\9 \n \L \U \l \u \E */
function substitute(rep: string, m: RegExpExecArray): string {
  let out = '';
  let caseMode: '' | 'L' | 'U' = '';
  let oneShot: '' | 'l' | 'u' = '';
  const emit = (s: string) => {
    for (const ch of s) {
      let c = caseMode === 'L' ? ch.toLowerCase() : caseMode === 'U' ? ch.toUpperCase() : ch;
      if (oneShot) { c = oneShot === 'l' ? c.toLowerCase() : c.toUpperCase(); oneShot = ''; }
      out += c;
    }
  };
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '&') { emit(m[0]); continue; }
    if (c === '\\' && i + 1 < rep.length) {
      const nx = rep[++i];
      if (/\d/.test(nx)) { emit(m[Number(nx)] ?? ''); continue; }
      if (nx === 'L' || nx === 'U') { caseMode = nx; continue; }
      if (nx === 'E') { caseMode = ''; continue; }
      if (nx === 'l' || nx === 'u') { oneShot = nx; continue; }
      const e = gnuEscape(rep, i);
      emit(e.text);
      i = e.next - 1;
      continue;
    }
    emit(c);
  }
  return out;
}

/** `l` output: escapes and line wrapping at 70 columns */
function listLine(s: string, width: number): string {
  const esc: Record<string, string> = { '\\': '\\\\', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' };
  let out = '';
  let col = 0;
  for (const byte of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(byte);
    const piece = esc[ch] ?? (byte < 32 || byte >= 127 ? '\\' + byte.toString(8).padStart(3, '0') : ch);
    if (width > 1 && col + piece.length > width - 1) { out += '\\\n'; col = 0; }
    out += piece;
    col += piece.length;
  }
  return out + '$\n';
}

interface Input { name: string; text: string }

export const sedCmd: Command = {
  name: 'sed',
  description: 'Stream editor for filtering and transforming text',
  async exec(ctx: CommandContext) {
    let quiet = false, extended = false, inPlace: string | null = null, separate = false, nulData = false;
    let lineWrap = 70;
    const scripts: string[] = [];
    const files: string[] = [];
    const args = ctx.args;
    let scriptGiven = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (!a.startsWith('-') || a === '-') {
        if (!scriptGiven) { scripts.push(a); scriptGiven = true; } else files.push(a);
        continue;
      }
      if (a.startsWith('--')) {
        const [name, val] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
        if (name === '--quiet' || name === '--silent') quiet = true;
        else if (name === '--regexp-extended') extended = true;
        else if (name === '--in-place') { inPlace = val ?? ''; separate = true; }
        else if (name === '--separate') separate = true;
        else if (name === '--null-data') nulData = true;
        else if (name === '--expression') { scripts.push(val ?? args[++i] ?? ''); scriptGiven = true; }
        else if (name === '--file') {
          const f = val ?? args[++i] ?? '';
          try { scripts.push((await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string).replace(/\n$/, '')); scriptGiven = true; }
          catch { ctx.stderr += `sed: couldn't open file ${f}: No such file or directory\n`; return 1; }
        }
        else if (name === '--line-length') lineWrap = parseInt(val ?? args[++i] ?? '70', 10);
        else if (name === '--posix' || name === '--debug' || name === '--sandbox' || name === '--unbuffered' || name === '--follow-symlinks') { /* accepted */ }
        else { ctx.stderr += `sed: unknown option -- '${a}'\n`; return 1; }
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        const rest = a.slice(j + 1);
        if (ch === 'n') quiet = true;
        else if (ch === 'E' || ch === 'r') extended = true;
        else if (ch === 's') separate = true;
        else if (ch === 'z') nulData = true;
        else if (ch === 'u') { /* unbuffered */ }
        else if (ch === 'i') { inPlace = rest; separate = true; break; }
        else if (ch === 'e') { scripts.push(rest || args[++i] || ''); scriptGiven = true; break; }
        else if (ch === 'l') { lineWrap = parseInt(rest || args[++i] || '70', 10); break; }
        else if (ch === 'f') {
          const f = rest || args[++i] || '';
          try {
            const t = f === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string;
            scripts.push(t.replace(/\n$/, ''));
            scriptGiven = true;
          } catch { ctx.stderr += `sed: couldn't open file ${f}: No such file or directory\n`; return 1; }
          break;
        } else { ctx.stderr += `sed: invalid option -- '${ch}'\n`; return 1; }
      }
    }
    if (!scripts.length) { ctx.stderr += 'Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n'; return 1; }

    let parsed: ReturnType<typeof parseScript>;
    try {
      parsed = parseScript(scripts.join('\n'), extended);
    } catch (e: any) {
      ctx.stderr += `sed: -e expression #1, char 0: ${e.message}\n`;
      return 1;
    }
    const { cmds, labels } = parsed;
    for (const c of cmds) {
      if ((c.name === 'b' || c.name === 't' || c.name === 'T') && c.label && !labels.has(c.label)) {
        ctx.stderr += `sed: -e expression #1, char 0: can't find label for jump to \`${c.label}'\n`;
        return 1;
      }
    }

    // Inputs
    const inputs: Input[] = [];
    let exitCode = 0;
    let stdinUsed = false;
    for (const f of files.length ? files : ['-']) {
      if (f === '-') { inputs.push({ name: '-', text: stdinUsed ? '' : ctx.stdin }); stdinUsed = true; continue; }
      try {
        const st = await ctx.fs.stat(ctx.fs.resolvePath(f, ctx.cwd));
        if (st.isDirectory()) { ctx.stderr += `sed: couldn't edit ${f}: not a regular file\n`; exitCode = 2; continue; }
        inputs.push({ name: f, text: await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string });
      } catch {
        ctx.stderr += `sed: can't read ${f}: No such file or directory\n`;
        exitCode = 2;
      }
    }
    if (inPlace !== null && files.length === 0) { ctx.stderr += 'sed: no input files\n'; return 1; }

    const sep = nulData ? '\0' : '\n';
    // Each unit runs the script over a stream of lines: one per file with -s/-i, else all files together
    const units: Input[][] = separate ? inputs.map((x) => [x]) : [inputs];
    const wfiles = new Map<string, string>();
    let quitAll = false;
    let lastRe: RegExp | null = null;
    const rfileCache = new Map<string, string | null>();
    const readFileText = async (f: string): Promise<string | null> => {
      if (!rfileCache.has(f)) {
        try { rfileCache.set(f, f === '/dev/stdin' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string); }
        catch { rfileCache.set(f, null); }
      }
      return rfileCache.get(f)!;
    };
    const rLinePos = new Map<string, number>();

    let lineNo = 0;
    for (const unit of units) {
      if (quitAll) break;
      // Lines of the unit, remembering which ended without a newline
      const lines: { text: string; file: string; nl: boolean }[] = [];
      for (const inp of unit) {
        if (!inp.text) continue;
        const parts = inp.text.split(sep);
        const nlEnd = inp.text.endsWith(sep);
        if (nlEnd) parts.pop();
        parts.forEach((p, k) => lines.push({ text: p, file: inp.name, nl: k < parts.length - 1 || nlEnd }));
      }
      if (separate) lineNo = 0;
      for (const c of cmds) { c.active = false; c.started = false; c.endLine = undefined; }
      let out = '';
      let hold = '';
      let idx = 0;
      let ps = '';
      let curNl = true;
      let appendQueue: string[] = [];
      let tFlag = false;
      const isLast = () => idx >= lines.length;
      const readNext = (): boolean => {
        if (idx >= lines.length) return false;
        const l = lines[idx++];
        lineNo++;
        ps = l.text;
        curNl = l.nl;
        return true;
      };
      // A line printed without its newline (the input's last line had none) gets
      // one as soon as anything else is printed after it, as in GNU sed
      let missingNl = false;
      const emit = (s: string, nl = true) => {
        out += (missingNl ? sep : '') + s + (nl ? sep : '');
        missingNl = !nl;
      };
      const emitPS = (s: string) => emit(s, curNl);
      const flushAppends = async () => {
        for (const a of appendQueue) { out += (missingNl ? sep : '') + a; missingNl = false; }
        appendQueue = [];
      };
      const matchAddr = (a: Addr): boolean => {
        switch (a.kind) {
          case 'line': return lineNo === a.n;
          case 'last': return isLast();
          case 'zero': return false;
          case 'step': return a.step <= 0 ? lineNo === a.first : lineNo >= a.first && (lineNo - a.first) % a.step === 0;
          case 're': {
            const re: RegExp | null = a.re ?? lastRe;
            if (!re) throw new SedError('no previous regular expression');
            lastRe = re;
            re.lastIndex = 0;
            return re.test(ps);
          }
        }
      };
      const selected = (c: Cmd): boolean => {
        let r: boolean;
        if (!c.a1) r = true;
        else if (!c.a2) r = matchAddr(c.a1);
        else if (c.active) {
          // Inside a range: this line is selected; does it end the range?
          const a2 = c.a2;
          if (a2.kind === 'line') c.active = lineNo < a2.n;
          else if (a2.kind === 'plus' || a2.kind === 'mult') c.active = lineNo < (c.endLine ?? 0);
          else c.active = !matchAddr(a2 as Addr);
          r = true;
        } else if (matchAddr(c.a1) || (c.a1.kind === 'line' && !c.started && lineNo > c.a1.n && (c.a2.kind !== 'line' || lineNo <= c.a2.n))) {
          c.started = true;
          const a2 = c.a2;
          r = true;
          if (a2.kind === 'line') c.active = a2.n > lineNo;
          else if (a2.kind === 'plus') { c.endLine = lineNo + a2.n; c.active = a2.n > 0; }
          else if (a2.kind === 'mult') { c.endLine = a2.n <= 0 ? lineNo : Math.ceil(lineNo / a2.n) * a2.n; c.active = c.endLine > lineNo; }
          else c.active = true; // a regex end is only tried from the next line
        } else r = false;
        return c.negate ? !r : r;
      };
      // 0,/re/: the range is open before line 1, so the regex may end it on line 1
      for (const c of cmds) if (c.a1?.kind === 'zero') c.active = true;

      let carry: string | null = null; // D: pattern space for the next cycle, no line read
      let stop = false;
      while (!stop) {
        if (carry !== null) { ps = carry; carry = null; }
        else if (!readNext()) break;
        tFlag = false;
        let autoprint = true;
        let pc = 0;
        cycle: while (pc < cmds.length) {
          const c = cmds[pc];
          if (!selected(c)) {
            pc = c.name === '{' ? c.blockEnd! : pc + 1;
            continue;
          }
          pc++;
          switch (c.name) {
            case '{': break;
            case '=': emit(String(lineNo)); break;
            case 'a': appendQueue.push(c.text! + '\n'); break;
            case 'i': emit(c.text!); break;
            case 'c':
              // With a range, the text replaces the whole range (printed at its end)
              if (!c.a2 || !c.active || c.negate) emit(c.text!);
              autoprint = false;
              break cycle;
            case 'd': autoprint = false; break cycle;
            case 'D': {
              const nl = ps.indexOf('\n');
              autoprint = false;
              if (nl >= 0) carry = ps.slice(nl + 1);
              break cycle;
            }
            case 'p': emitPS(ps); break;
            case 'P': emit(ps.split('\n')[0]); break;
            case 'l': out += listLine(ps, c.qcode ?? lineWrap); break;
            case 'n':
              if (isLast()) {
                // No next line: GNU prints the pattern space and quits
                stop = true;
                break cycle;
              }
              if (!quiet) emitPS(ps);
              await flushAppends();
              readNext();
              break;
            case 'N':
              if (isLast()) { stop = true; break cycle; }
              {
                const prev = ps;
                readNext();
                ps = prev + '\n' + ps;
              }
              break;
            case 'g': ps = hold; break;
            case 'G': ps += '\n' + hold; break;
            case 'h': hold = ps; break;
            case 'H': hold += '\n' + ps; break;
            case 'x': [ps, hold] = [hold, ps]; break;
            case 'z': ps = ''; break;
            case 'F': emit(lines[idx - 1]?.file ?? '-'); break;
            case 'y': {
              const from = [...c.from!], to = [...c.to!];
              ps = [...ps].map((ch) => { const k = from.indexOf(ch); return k >= 0 ? to[k] : ch; }).join('');
              break;
            }
            case 's': {
              const re: RegExp | null = c.re ?? lastRe;
              if (!re) { ctx.stderr += 'sed: no previous regular expression\n'; return 1; }
              lastRe = re;
              const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
              const nth = c.occurrence ?? 1;
              let count = 0;
              let did = false;
              let res = '';
              let pos = 0;
              let prevEnd = -1; // end of the last non-empty match: no empty match right there
              while (pos <= ps.length) {
                g.lastIndex = pos;
                const m = g.exec(ps);
                if (!m) break;
                if (m[0] === '' && m.index === prevEnd) {
                  if (m.index >= ps.length) break;
                  res += ps.slice(pos, m.index + 1);
                  pos = m.index + 1;
                  continue;
                }
                count++;
                const want = c.global ? count >= nth : count === nth;
                res += ps.slice(pos, m.index) + (want ? substitute(c.replacement!, m) : m[0]);
                if (want) did = true;
                if (m[0] === '') {
                  if (m.index < ps.length) res += ps[m.index];
                  pos = m.index + 1;
                } else {
                  pos = m.index + m[0].length;
                  prevEnd = pos;
                }
                if (!c.global && count >= nth) break;
              }
              if (did) {
                ps = res + ps.slice(pos);
                tFlag = true;
                for (let k = 0; k < (c.print ?? 0); k++) emitPS(ps);
                if (c.wfile) {
                  if (c.wfile === '/dev/stdout') emit(ps);
                  else wfiles.set(c.wfile, (wfiles.get(c.wfile) ?? '') + ps + '\n');
                }
              }
              break;
            }
            case 'b': pc = c.label ? labels.get(c.label)! : cmds.length; break;
            case 't': if (tFlag) { tFlag = false; pc = c.label ? labels.get(c.label)! : cmds.length; } break;
            case 'T': if (!tFlag) pc = c.label ? labels.get(c.label)! : cmds.length; else tFlag = false; break;
            case 'r': {
              const t = await readFileText(c.file!);
              if (t) appendQueue.push(t.endsWith('\n') ? t : t + '\n');
              break;
            }
            case 'R': {
              const t = await readFileText(c.file!);
              if (t) {
                const ls = t.split('\n');
                if (t.endsWith('\n')) ls.pop();
                const k = rLinePos.get(c.file!) ?? 0;
                if (k < ls.length) { appendQueue.push(ls[k] + '\n'); rLinePos.set(c.file!, k + 1); }
              }
              break;
            }
            case 'w': case 'W': {
              const text = c.name === 'W' ? ps.split('\n')[0] : ps;
              if (c.file === '/dev/stdout') emit(text);
              else wfiles.set(c.file!, (wfiles.get(c.file!) ?? '') + text + '\n');
              break;
            }
            case 'q':
              quitAll = true;
              stop = true;
              exitCode = c.qcode ?? 0;
              break cycle;
            case 'Q':
              quitAll = true;
              stop = true;
              exitCode = c.qcode ?? 0;
              autoprint = false;
              break cycle;
            case 'e': break;
          }
        }
        if (autoprint && !quiet) emitPS(ps);
        await flushAppends();
      }
      if (inPlace !== null && unit.length === 1 && unit[0].name !== '-') {
        const path = ctx.fs.resolvePath(unit[0].name, ctx.cwd);
        if (inPlace) {
          const bak = inPlace.includes('*') ? inPlace.replace(/\*/g, unit[0].name.split('/').pop()!) : unit[0].name + inPlace;
          await ctx.fs.writeFile(ctx.fs.resolvePath(bak, ctx.cwd), unit[0].text);
        }
        await ctx.fs.writeFile(path, out);
      } else {
        ctx.stdout += out;
      }
    }
    for (const [f, text] of wfiles) {
      await ctx.fs.writeFile(ctx.fs.resolvePath(f, ctx.cwd), text);
    }
    return exitCode;
  },
};
