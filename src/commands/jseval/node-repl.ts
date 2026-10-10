/**
 * `node` with no script on a terminal: the REPL, a program run by
 * node-compat like any script. readline edits the line on the terminal
 * (node-compat/modules/readline.ts); each entry is evaluated in the scope the
 * entries before it left, so `let`, `const`, `var`, functions and classes
 * persist: the evaluator is a function declared inside the previous eval
 * (a function declared by a sloppy direct eval closes over that eval's
 * lexical scope), and the next entry runs in it.
 *
 * As node: "> " and "... " for an unfinished entry, the value inspected
 * with colors, "Uncaught ..." for an exception, `await` in an expression,
 * .help/.exit/.break, ^C clears the entry (twice on an empty one exits), ^D
 * exits.
 */
export const NODE_REPL = String.raw`
const readline = require('readline');
// (\r\n on a terminal: node-compat passes text with colors through as it is)
const out = (s) => process.stdout.write(process.stdout.isTTY ? s.replace(/\r?\n/g, '\r\n') : s);
out('Welcome to Node.js ' + process.version + '.\nType ".help" for more information.\n');

// The first evaluator sees node's module scope (require, console, module, ...), not this program's
// (node-compat's Function gives it process, Buffer and global)
const SUFFIX = '\n;function __replNext(__replCode) { return [eval(__replCode + __replSuffix), __replNext]; }';
let evaluate = new Function('require', 'console', 'module', 'exports', '__filename', '__dirname', '__replSuffix',
  'return function __replNext(__replCode) { return [eval(__replCode + __replSuffix), __replNext]; };',
)(require, console, module, exports, process.cwd() + '/[eval]', process.cwd(), SUFFIX);

// (the realm's own constructors: node-compat's Function wraps the body in braces of its own)
const PlainFunction = (function () {}).constructor;
const AsyncFunction = (async function () {}).constructor;
const parses = (code, Fn = PlainFunction) => { try { new Fn(code); return true; } catch (e) { return e; } };
/** Brackets, a string, template or comment still open at the end: the entry goes on */
function unfinished(code) {
  const BQ = '\x60';
  const open = []; // ( [ { , BQ inside a template's text, 'T' inside a template's placeholder
  let prev = ''; // the last significant character, to tell a regex from a division
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (open[open.length - 1] === BQ) {
      if (c === '\\') i++;
      else if (c === BQ) { open.pop(); prev = c; }
      else if (c === '$' && code[i + 1] === '{') { open.push('T'); i++; }
      continue;
    }
    if (c === '/' && code[i + 1] === '/') { const j = code.indexOf('\n', i); if (j < 0) break; i = j; continue; }
    if (c === '/' && code[i + 1] === '*') { const j = code.indexOf('*/', i + 2); if (j < 0) return true; i = j + 1; continue; }
    if (c === "'" || c === '"' || (c === '/' && (!prev || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)))) {
      for (i++; i < code.length && code[i] !== c; i++) {
        if (code[i] === '\\') i++;
        else if (code[i] === '\n') return false; // a syntax error
      }
      if (i >= code.length) return c !== '/';
      prev = c;
      continue;
    }
    if (c === BQ || c === '(' || c === '[' || c === '{') open.push(c);
    else if (c === ')' || c === ']' || c === '}') {
      if (!open.length) return false; // a syntax error, not an unfinished entry
      open.pop(); // (a placeholder's } goes back to its template's text)
    }
    if (!/\s/.test(c)) prev = c;
  }
  return open.length > 0;
}

/** What to run for an entry: an object literal is one; await makes it an async expression or block */
function compile(code) {
  if (/^\s*\{/.test(code) && !/;\s*$/.test(code) && parses('(' + code + '\n)') === true) return { code: '(' + code + '\n)' };
  const plain = parses(code);
  if (plain === true) return { code };
  if (/\bawait\b/.test(code) && parses(code, AsyncFunction) === true) {
    const expr = parses('return (' + code + '\n)', AsyncFunction) === true;
    return { code: expr ? '(async () => (' + code + '\n))()' : '(async () => {' + code + '\n})()', awaited: true };
  }
  if (unfinished(code)) return { unfinished: true };
  return { code }; // eval throws the SyntaxError
}

/** A value as node's util.inspect shows it, with colors (node-compat's inspect is JSON) */
function show(v, depth = 2, seen = []) {
  const paint = (code, t) => '\x1b[' + code + 'm' + t + '\x1b[' + (code === 1 ? 22 : 39) + 'm';
  const quote = (t) => "'" + t.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
  switch (typeof v) {
    case 'undefined': return paint(90, 'undefined');
    case 'number': return paint(33, Object.is(v, -0) ? '-0' : String(v));
    case 'bigint': return paint(33, v + 'n');
    case 'boolean': return paint(33, String(v));
    case 'string': return paint(32, quote(v));
    case 'symbol': return paint(32, v.toString());
    case 'function': {
      const cls = /^class\b/.test(Function.prototype.toString.call(v));
      return paint(36, '[' + (cls ? 'class ' + (v.name || '(anonymous)') : (v.constructor?.name === 'AsyncFunction' ? 'AsyncFunction' : 'Function') + (v.name ? ': ' + v.name : ' (anonymous)')) + ']');
    }
  }
  if (v === null) return paint(1, 'null');
  if (seen.includes(v)) return paint(36, '[Circular]');
  if (v instanceof Date) return paint(35, isNaN(v) ? 'Invalid Date' : v.toISOString());
  if (v instanceof RegExp) return paint(31, String(v));
  if (v instanceof Error) return v.stack || v.name + ': ' + v.message;
  if (typeof Promise !== 'undefined' && v instanceof Promise) return 'Promise { ' + paint(36, '<pending>') + ' }';
  const proto = Object.getPrototypeOf(v);
  const ctor = proto === null ? '[Object: null prototype]' : proto.constructor?.name || '';
  if (depth < 0) return paint(36, Array.isArray(v) ? '[Array]' : '[' + (ctor || 'Object') + ']');
  const next = (x) => show(x, depth - 1, [...seen, v]);
  const key = (k) => typeof k === 'symbol' ? '[' + paint(32, k.toString()) + ']' : /^[A-Za-z_$][\w$]*$/.test(k) ? k : paint(32, quote(k));
  let items, open = '{', close = '}', prefix = ctor && ctor !== 'Object' ? ctor + ' ' : '';
  if (Array.isArray(v)) {
    items = [];
    for (let i = 0; i < v.length && i < 100; i++) items.push(i in v ? next(v[i]) : paint(90, '<empty>'));
    if (v.length > 100) items.push('... ' + (v.length - 100) + ' more items');
    open = '['; close = ']'; prefix = ctor === 'Array' ? '' : ctor + '(' + v.length + ') ';
  } else if (v instanceof Map) {
    items = [...v].map(([k, x]) => next(k) + ' => ' + next(x)); prefix = 'Map(' + v.size + ') ';
  } else if (v instanceof Set) {
    items = [...v].map(next); prefix = 'Set(' + v.size + ') ';
  } else if (ArrayBuffer.isView(v) && typeof v.length === 'number') {
    items = Array.from(v.slice(0, 100), (x) => paint(33, String(x))); open = '['; close = ']'; prefix = ctor + '(' + v.length + ') ';
  } else items = [];
  if (!Array.isArray(v)) {
    for (const k of Reflect.ownKeys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !d.enumerable) continue;
      items.push(key(k) + ': ' + ('value' in d ? next(d.value) : paint(36, d.set ? '[Getter/Setter]' : '[Getter]')));
    }
  }
  if (!items.length) return prefix + open + close;
  const flat = prefix + open + ' ' + items.join(', ') + ' ' + close;
  if (flat.replace(/\x1b\[\d+m/g, '').length <= 72 && !flat.includes('\n')) return flat;
  return prefix + open + '\n' + items.map((x) => '  ' + x.replace(/\n/g, '\n  ')).join(',\n') + '\n' + close;
}
const uncaught = (e) => out('Uncaught ' + (e instanceof Error ? (e.stack && /^\w*Error/.test(e.stack) ? e.stack.split('\n')[0] : e.name + ': ' + e.message) : show(e)) + '\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
let entry = '';
let interrupted = false;
let quiet = false; // .exit: the line already ended

function prompt() { rl.setPrompt(entry ? '... ' : '> '); rl.prompt(); }

function command(line) {
  const [cmd] = line.trim().split(/\s+/);
  if (cmd === '.exit') { quiet = true; rl.close(); return; }
  if (cmd === '.break' || cmd === '.clear') entry = '';
  else if (cmd === '.help') {
    out('.break    Sometimes you get stuck, this gets you out\n.clear    Alias for .break\n' +
      '.exit     Exit the REPL\n.help     Print this help message\n\n' +
      'Press Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n');
  } else out('Invalid REPL keyword\n');
  prompt();
}

rl.on('line', async (line) => {
  interrupted = false;
  if (!entry && /^\s*\.[a-z]/.test(line)) return command(line);
  entry = entry ? entry + '\n' + line : line;
  if (!entry.trim()) { entry = ''; return prompt(); }
  const c = compile(entry);
  if (c.unfinished) return prompt();
  entry = '';
  try {
    const [value, next] = evaluate(c.code);
    evaluate = next;
    let v = value;
    if (c.awaited) { rl.pause(); try { v = await value; } finally { rl.resume(); } }
    out(show(v) + '\n');
  } catch (e) {
    uncaught(e);
  }
  prompt();
});

rl.on('SIGINT', () => {
  if (entry || rl.line) {
    entry = ''; rl.line = ''; rl.cursor = 0;
    interrupted = false;
    out('\n');
    return prompt();
  }
  if (interrupted) return rl.close();
  interrupted = true;
  out('\n(To exit, press Ctrl+C again or Ctrl+D or type .exit)\n');
  prompt();
});

// (exit throws to end the program: not out through readline into the terminal's key handler)
rl.on('close', () => { if (!quiet) out('\n'); try { process.exit(0); } catch { /* exiting */ } });
prompt();
`;
