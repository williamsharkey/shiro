/**
 * Group multi-line shell source into complete statements.
 *
 * Shiro's executor runs one statement at a time from a single line
 * (`for …; do …; done`, `f() { …; }`, `case … in a) …;; esac`). Source text
 * spreads those over lines, so this scanner tracks what is still open at the
 * end of each line (quotes, `(`/`$(`, `for/while/until/select…done`,
 * `if…fi`, `case…esac`, `{…}`, a trailing `|`/`&&`/`||` or `\`) and joins
 * lines until the statement is complete. A newline becomes `; ` where it
 * separates commands, a space where the grammar allows a newline but not a
 * `;` (after `do`, `then`, `else`, `{`, `|`, `;;`, a case pattern's `)`, …),
 * and stays a newline inside quotes and here-document bodies.
 *
 * Expects comment-free input (see shell-comments.ts).
 */

export interface Statement {
  text: string;
  /** 1-based line where the statement starts */
  line: number;
}

const OPENERS: Record<string, string> = { for: 'done', while: 'done', until: 'done', select: 'done', if: 'fi', case: 'esac' };
const CLOSERS = new Set(['done', 'fi', 'esac']);
/** Words after which the next word is again in command position */
const CMD_PREFIX = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'time', '{']);
/** A newline after these is plain whitespace */
const JOIN_WITH_SPACE = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'time', '{']);

type Paren = 'sub' | 'arith' | 'list' | 'dbracket';

export function groupStatements(src: string): Statement[] {
  const lines = src.split(/\r?\n/);
  const out: Statement[] = [];

  // Lexer state carried across lines
  let quote: '' | "'" | '"' | "$'" = '';
  const parens: Paren[] = [];
  const blocks: string[] = []; // expected closers: done / fi / esac / }
  let cmdPos = true;
  let patternPos = false; // in a case, before a pattern's `)`
  let caseWantIn = false; // saw `case WORD`, waiting for `in`
  let forWantIn = 0; // words since `for`/`select` (the `in` there is not a case `in`)
  let lastWord = ''; // last word or operator on the current statement, for join rules
  let lastWasPatternClose = false;
  let lastWasHeredoc = false;
  let functionWord = false; // saw `function`, its NAME comes next

  let text = '';
  let startLine = 1;
  let pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];

  const flush = () => {
    if (text.trim()) out.push({ text: text.trim(), line: startLine });
    text = '';
    lastWord = '';
    lastWasPatternClose = false;
    lastWasHeredoc = false;
    cmdPos = true;
  };

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];

    if (!text) startLine = li + 1;
    else if (quote) text += '\n';
    else if (lastWasHeredoc) text += '\n';
    else if (line.trim()) {
      // Inside $((…)) or an array literal a=(…) a newline is just a blank
      const inWords = parens.length > 0 && parens[parens.length - 1] !== 'sub';
      const sep = inWords || joinWithSpace(lastWord, lastWasPatternClose) || /^\s*;;/.test(line) ? ' ' : '; ';
      text += sep;
    }

    // A newline separates commands: the next word is in command position
    if (!quote && !patternPos && !caseWantIn && !forWantIn) cmdPos = true;

    // Scan the line
    let i = 0;
    let lineOut = '';
    let n = line.length;
    for (;;) {
    while (i < n) {
      const ch = line[i];
      if (quote === "'") {
        const e = line.indexOf("'", i);
        if (e === -1) { lineOut += line.slice(i); i = n; break; }
        lineOut += line.slice(i, e + 1); i = e + 1; quote = '';
        continue;
      }
      if (quote === '"' || quote === "$'") {
        if (ch === '\\') { lineOut += line.slice(i, i + 2); i += 2; continue; }
        const close = quote === '"' ? '"' : "'";
        if (ch === close) { lineOut += ch; i++; quote = ''; continue; }
        if (quote === '"' && ch === '$' && line[i + 1] === '(') {
          // Command substitution inside double quotes: balance it on this line
          const j = skipParen(line, i + 2);
          lineOut += line.slice(i, j); i = j;
          continue;
        }
        lineOut += ch; i++;
        continue;
      }
      if (ch === '\\') { lineOut += line.slice(i, i + 2); i += 2; cmdPos = false; lastWord = 'x'; lastWasPatternClose = false; continue; }
      if (ch === ' ' || ch === '\t') { lineOut += ch; i++; continue; }
      if (ch === "'") { quote = "'"; lineOut += ch; i++; cmdPos = false; lastWord = 'x'; lastWasPatternClose = false; continue; }
      if (ch === '"') { quote = '"'; lineOut += ch; i++; cmdPos = false; lastWord = 'x'; lastWasPatternClose = false; continue; }
      if (ch === '$' && line[i + 1] === "'") { quote = "$'"; lineOut += "$'"; i += 2; cmdPos = false; lastWord = 'x'; lastWasPatternClose = false; continue; }
      if (ch === '`') {
        let j = i + 1;
        while (j < n && line[j] !== '`') j += line[j] === '\\' ? 2 : 1;
        lineOut += line.slice(i, j + 1); i = j + 1; cmdPos = false; lastWord = 'x'; lastWasPatternClose = false;
        continue;
      }
      // Operators
      if (ch === ';') {
        if (line[i + 1] === ';') {
          // `;;` (or `;;&`) ends a case item: next comes a pattern or esac
          const op = line[i + 2] === '&' ? ';;&' : ';;';
          lineOut += op; i += op.length;
          patternPos = true; cmdPos = false; lastWord = ';;'; lastWasPatternClose = false;
          continue;
        }
        if (line[i + 1] === '&') {
          lineOut += ';&'; i += 2;
          patternPos = true; cmdPos = false; lastWord = ';;'; lastWasPatternClose = false;
          continue;
        }
        lineOut += ch; i++; cmdPos = true; lastWord = ';'; lastWasPatternClose = false;
        continue;
      }
      if (ch === '&' || ch === '|') {
        const two = line.slice(i, i + 2);
        const op = two === '&&' || two === '||' || two === '|&' ? two : ch;
        lineOut += op; i += op.length; cmdPos = true; lastWord = op; lastWasPatternClose = false;
        continue;
      }
      if (ch === '(') {
        const arith = line[i + 1] === '(' && (cmdPos || line[i - 1] === '$');
        if (patternPos && blocks[blocks.length - 1] === 'esac') {
          // optional `(` before a case pattern
          lineOut += ch; i++; continue;
        }
        if (arith) { parens.push('arith'); parens.push('arith'); lineOut += '(('; i += 2; }
        else { parens.push(line[i - 1] === '=' ? 'list' : 'sub'); lineOut += ch; i++; }
        cmdPos = true; lastWord = '('; lastWasPatternClose = false;
        continue;
      }
      if (ch === ')') {
        lineOut += ch; i++;
        if (parens.length) {
          const wasEmpty = line[i - 2] === '(';
          parens.pop();
          // `name()` is followed by the function body, a compound command
          cmdPos = wasEmpty;
          lastWord = wasEmpty ? '()' : ')';
          lastWasPatternClose = false;
        } else if (blocks[blocks.length - 1] === 'esac') {
          // A case pattern's `)`
          patternPos = false; cmdPos = true; lastWord = ')'; lastWasPatternClose = true;
        } else {
          cmdPos = false; lastWord = ')'; lastWasPatternClose = false;
        }
        continue;
      }
      if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<' && parens[parens.length - 1] !== 'arith') {
        const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|()<>]+))/.exec(line.slice(i));
        if (m) {
          pendingHeredocs.push({ delim: m[2] ?? m[3] ?? m[4].replace(/\\/g, ''), stripTabs: m[1] === '-' });
          lineOut += m[0]; i += m[0].length; cmdPos = false; lastWord = 'x'; lastWasPatternClose = false;
          continue;
        }
      }
      if (ch === '<' || ch === '>') {
        let j = i + 1;
        while (j < n && /[<>&|-]/.test(line[j]) && j - i < 3) j++;
        lineOut += line.slice(i, j); i = j; cmdPos = false; lastWord = 'x'; lastWasPatternClose = false;
        continue;
      }
      // A word (stops at blanks and operators; quotes inside a word are handled above on the next turn)
      let j = i;
      while (j < n && !/[\s;&|()<>'"`\\]/.test(line[j])) {
        if (line[j] === '$' && line[j + 1] === '(') break;
        if (line[j] === '$' && line[j + 1] === "'") break;
        j++;
      }
      if (j === i) {
        // `$(` / `$((` starting here
        if (line[i] === '$' && line[i + 1] === '(') {
          if (line[i + 2] === '(') { parens.push('arith'); parens.push('arith'); lineOut += '$(('; i += 3; }
          else { parens.push('sub'); lineOut += '$('; i += 2; }
          cmdPos = parens[parens.length - 1] === 'sub'; lastWord = 'x'; lastWasPatternClose = false;
          continue;
        }
        lineOut += ch; i++; cmdPos = false; lastWord = 'x'; lastWasPatternClose = false;
        continue;
      }
      const word = line.slice(i, j);
      // A word glued to a following quote or $( is not a keyword
      const glued = j < n && /['"`$\\]/.test(line[j]);
      lineOut += word; i = j;
      lastWasPatternClose = false;
      // [[ … ]] may span lines; a newline inside it is a blank
      if (word === ']]' && parens[parens.length - 1] === 'dbracket') { parens.pop(); cmdPos = false; lastWord = 'x'; continue; }
      if (cmdPos && !glued && word === '[[' && !patternPos) { parens.push('dbracket'); cmdPos = false; lastWord = 'x'; continue; }
      if (patternPos) {
        if (word === 'esac' && !glued && blocks[blocks.length - 1] === 'esac') {
          blocks.pop(); patternPos = false; cmdPos = false; lastWord = 'esac';
        } else {
          lastWord = 'x';
        }
        continue;
      }
      if (caseWantIn) {
        if (word === 'in') { caseWantIn = false; patternPos = true; lastWord = 'in'; continue; }
        lastWord = 'x';
        continue;
      }
      if (forWantIn) {
        forWantIn++;
        if (word === 'in' || word === 'do') { forWantIn = 0; }
        if (word === 'do') { cmdPos = true; lastWord = 'do'; continue; }
        lastWord = word === 'in' ? 'forin' : 'x';
        cmdPos = false;
        continue;
      }
      if (functionWord) {
        // `function NAME` / `function NAME()`: the body follows
        functionWord = false; cmdPos = true; lastWord = '()';
        continue;
      }
      if (cmdPos && !glued) {
        if (word === 'function') { functionWord = true; lastWord = 'x'; continue; }
        if (OPENERS[word]) {
          blocks.push(OPENERS[word]);
          if (word === 'case') caseWantIn = true;
          if (word === 'for' || word === 'select') forWantIn = 1;
          cmdPos = word !== 'case' && word !== 'for' && word !== 'select';
          lastWord = word;
          continue;
        }
        if (CLOSERS.has(word) && blocks[blocks.length - 1] === word) {
          blocks.pop(); cmdPos = false; lastWord = word;
          continue;
        }
        if (word === '{') { blocks.push('}'); cmdPos = true; lastWord = '{'; continue; }
        if (word === '}' && blocks[blocks.length - 1] === '}') { blocks.pop(); cmdPos = false; lastWord = '}'; continue; }
      }
      cmdPos = cmdPos && CMD_PREFIX.has(word) && !glued;
      lastWord = cmdPos ? word : 'x';
    }
    // Backslash-newline (outside single quotes, at the line's end state) joins the next line
    if (quote !== "'" && endsWithContinuation(line) && li + 1 < lines.length) {
      lineOut = lineOut.slice(0, -1);
      line = lines[++li];
      i = 0;
      n = line.length;
      continue;
    }
    break;
    }
    text += lineOut;

    // Here-document bodies follow the line that opened them, verbatim
    lastWasHeredoc = false;
    for (const h of pendingHeredocs) {
      while (li + 1 < lines.length) {
        const body = lines[++li];
        text += '\n' + body;
        const cmp = h.stripTabs ? body.replace(/^\t+/, '') : body;
        if (cmp === h.delim || cmp.trim() === h.delim) break;
      }
      lastWasHeredoc = true;
    }
    pendingHeredocs = [];

    const open = quote !== '' || parens.length > 0 || blocks.length > 0 || caseWantIn || forWantIn > 0
      || ['|', '&&', '||', '|&'].includes(lastWord);
    if (!open) flush();
  }
  // Unterminated input: hand over what we have (the executor reports the error)
  if (text.trim()) out.push({ text: text.trim(), line: startLine });
  return out;
}

function joinWithSpace(lastWord: string, patternClose: boolean): boolean {
  if (patternClose) return true;
  if (JOIN_WITH_SPACE.has(lastWord)) return true;
  return lastWord === ';' || lastWord === ';;' || lastWord === '&' || lastWord === '|' || lastWord === '&&'
    || lastWord === '||' || lastWord === '|&' || lastWord === '(' || lastWord === 'in' || lastWord === '' || lastWord === '()';
}

function endsWithContinuation(line: string): boolean {
  let k = line.length - 1;
  let count = 0;
  while (k >= 0 && line[k] === '\\') { count++; k--; }
  return count % 2 === 1;
}

/** Index just past the `)` closing a `$(` whose body starts at j (single line). */
function skipParen(src: string, j: number): number {
  let depth = 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", j + 1); j = e === -1 ? src.length : e + 1; continue; }
    if (c === '"') {
      j++;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      j++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j + 1;
    j++;
  }
  return j;
}
