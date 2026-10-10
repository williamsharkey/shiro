import { stripComments } from './shell-comments';
import * as fifo from './shell-fifo';
import { groupStatements, trimCommand } from './shell-statements';
import { printfFormat } from './utils/printf';
import { evalArith, ArithError, type ArithEnv } from './utils/arith';
import { readRecord, recordText, splitRecord } from './shell-read';
import { parseDoubleBracket, doubleBracketEnd, DbSyntaxError, decodeAnsiC, ansiCEnd, type DbNode } from './shell-dbracket';
import { parseUmask, formatUmask, symbolicUmask } from './shell-umask';
import { TestEval } from './commands/posix-test';
import { posixRegExp, RegexSyntaxError } from './utils/posix-regex';
import { arrayValues, arrayTop, copyArray, splitRawWords as splitAssignWords, parseAssignWord, splitListWords, type AssignWord } from './shell-arrays';
import { HeredocStore, extractHeredocs, hasHeredoc } from './shell-heredoc';
import { FileSystem, addProcInfoSource, setProcSelf } from './filesystem';
import { CommandRegistry, CommandContext, type Command } from './commands/index';
import type { ShiroTerminal } from './terminal';
import type { KernelStdio } from './shell-stdio';
import type { OpenFile } from './kernel/fd';
import { getCompiledModule } from './wasi-packages';
import { builtinIndex, findEntry, packageStatus, packageShadows, pkgOwnShadows, loadPackageShadows, packageOfPath, runPackageBinary, PKG_BIN_DIR } from './pkg-manager';
import { activeProfile } from './profile';
import { BUILTIN_SHIM_INTERP } from './path-shims';
import { parseShellArgs } from './shell-args';

// Lazy-load the WASI runtime (~960 lines) only when WASM execution is needed
let _wasiRuntime: typeof import('./wasi-runtime') | null = null;
async function loadWasiRuntime() {
  if (!_wasiRuntime) _wasiRuntime = await import('./wasi-runtime');
  return _wasiRuntime;
}

// shell-kernel is loaded on first use and then reached synchronously: a
// dynamic import() per command (through Vite's preload helper) was a large
// part of every builtin's cost
/** A writer that forwards to another (or to a file when it returns null): `writesTo` sees through it */
const WRITER_TARGET = Symbol('writerTarget');
/** Does `w` write straight to `to` (through `exec >&` routing)? */
function writesTo(w: (s: string) => void, to: (s: string) => void): boolean {
  for (let k = 0; k < 8 && w; k++) {
    if (w === to) return true;
    const t = (w as { [WRITER_TARGET]?: () => ((s: string) => void) | null })[WRITER_TARGET];
    if (!t) return false;
    w = t()!;
  }
  return false;
}

let _shellKernel: typeof import('./shell-kernel') | null = null;
let _shellKernelLoading: Promise<typeof import('./shell-kernel')> | null = null;
function loadShellKernel(): Promise<typeof import('./shell-kernel')> {
  return _shellKernelLoading ??= import('./shell-kernel').then(m => (_shellKernel = m));
}

interface Redirect {
  /** 'dup': fd `fd` becomes a copy of fd `target` (exec N>&M, N<&M) */
  type: '>' | '>>' | '<' | '2>' | '2>>' | '2>&1' | '>&-' | 'dup' | 'open';
  target: string;
  fd?: number;
  /** 'open' (N> file, N>> file, N< file for N >= 3): how the file is opened */
  mode?: '>' | '>>' | '<';
  /** >| : write even with noclobber */
  force?: boolean;
}

/** Does a word have a glob character the tokenizer didn't mark as quoted (\x01)? */
function hasUnquotedGlob(word: string, extglob: boolean): boolean {
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === '\x01') { i++; continue; }
    if (c === '*' || c === '?') return true;
    if (c === '[' && bracketToRegex(word, i)) return true;
    if (extglob && '+@!'.includes(c) && word[i + 1] === '(') return true;
  }
  return false;
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: '0-9a-zA-Z', upper: 'A-Z', lower: 'a-z', space: '\\s',
  blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f',
};

/** A tilde expansion's text: one field, never globbed, literal in [[ =~ ]] (as if quoted) */
const tildeText = (dir: string) => `"${protectExpansion(dir)}"`;

/** Does `cmd` end with the `&` operator (not &&, >&, an escaped \& or one in quotes)? */
function endsWithBackgroundAmp(cmd: string): boolean {
  if (!/[^&]&$/.test(cmd)) return false;
  let q = '';
  for (let i = 0; i < cmd.length - 1; i++) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = '';
      continue;
    }
    if (c === '\\') { if (i === cmd.length - 2) return false; i++; continue; }
    if (c === "'" || c === '"') q = c;
  }
  return !q && !/[<>]$/.test(cmd.slice(0, -1));
}

/** A character for inside a RegExp class */
const classChar = (c: string) => c.replace(/[\\\]\[^-]/g, '\\$&');

/**
 * The POSIX bracket expression at s[i] ('[') as a RegExp class, or null when
 * it has no closing ']' (then '[' is literal). `!` or `^` first negates; a
 * `]` first (or after `!`) is literal; [:class:], [.c.] and [=c=]; a quoted (\x01-marked)
 * or backslashed character is literal, including '-' and ']'.
 */
function bracketToRegex(s: string, i: number, caretCloses = false): { re: string; end: number } | null {
  let j = i + 1;
  let neg = false;
  if (s[j] === '!' || s[j] === '^') { neg = true; j++; }
  let body = '';
  // (bash's own matcher, caretCloses: after `^` a `]` closes the class even first)
  for (let first = !(caretCloses && s[j - 1] === '^'); j < s.length; j++, first = false) {
    const c = s[j];
    if (c === ']' && !first) return { re: (neg ? '[^' : '[') + body + ']', end: j };
    if ((c === '\x01' || c === '\\') && j + 1 < s.length) { body += classChar(s[++j]); continue; }
    if (c === '[' && (s[j + 1] === ':' || s[j + 1] === '.' || s[j + 1] === '=')) {
      const kind = s[j + 1];
      const close = s.indexOf(kind + ']', j + 2);
      if (close > j + 1) {
        const name = s.slice(j + 2, close);
        body += kind === ':' ? (POSIX_CLASSES[name] ?? '') : classChar(name);
        j = close + 1;
        continue;
      }
    }
    body += c === '-' ? '-' : classChar(c);
  }
  return null;
}

/** Redirect target naming an open shell fd (`>&3`, `<&6`) rather than a file */
const FD_REF = '\uE020';
const fdRef = (n: number) => FD_REF + n;
const fdOfRef = (target: string): number | null => (target.startsWith(FD_REF) ? Number(target.slice(1)) : null);

/** An output fd of the shell: a file, or a copy of the shell's own stdout/stderr */
/**
 * An output fd of the shell: a file, a copy of the shell's own stdout/stderr
 * (`dup`, relative to this shell), or a stream it inherited (`writer`: what a
 * `dup` of the parent's pointed at when this shell was forked, so
 * `exec 3>&1 >/dev/null; sh -c 'echo x >&3'` reaches the parent's stdout).
 * `fifo`: a named pipe's write end this shell opened (exec N>fifo); `owner`
 * closes it when the entry goes.
 */
type OutFd = { path: string; fifo?: import('./kernel/fd').OpenFile; owner?: Shell } | { dup: 1 | 2 } | { writer: (s: string) => void };

export interface BackgroundJob {
  id: number;
  command: string;
  promise: Promise<number>;
  status: 'running' | 'stopped' | 'done' | 'failed';
  exitCode: number;
  abortController?: AbortController;
  /** In-page jobs: the made-up pid that $! holds */
  pid?: number;
  /** In-page jobs: the signal `kill` ended it with (its status is then 128+signal) */
  signal?: number;
  /** Started by a non-interactive shell without job control: SIGINT and SIGQUIT are ignored (POSIX 2.11) */
  ignoresIntQuit?: boolean;
  /** Kernel jobs: the process group (signals, fg/bg, Ctrl-Z) and its members */
  pgid?: number;
  pids?: number[];
  /** Kernel jobs: tty modes saved when the job stopped */
  termios?: import('./kernel/pty').Termios;
}

/** bash's shopt options, and those on by default in a non-interactive bash */
const SHOPT_OPTIONS = ['autocd', 'assoc_expand_once', 'cdable_vars', 'cdspell', 'checkhash', 'checkjobs', 'checkwinsize',
  'cmdhist', 'compat31', 'compat32', 'compat40', 'compat41', 'compat42', 'compat43', 'compat44', 'complete_fullquote',
  'direxpand', 'dirspell', 'dotglob', 'execfail', 'expand_aliases', 'extdebug', 'extglob', 'extquote', 'failglob',
  'force_fignore', 'globasciiranges', 'globskipdots', 'globstar', 'gnu_errfmt', 'histappend', 'histreedit', 'histverify',
  'hostcomplete', 'huponexit', 'inherit_errexit', 'interactive_comments', 'lastpipe', 'lithist', 'localvar_inherit',
  'localvar_unset', 'login_shell', 'mailwarn', 'no_empty_cmd_completion', 'nocaseglob', 'nocasematch',
  'noexpand_translation', 'nullglob', 'patsub_replacement', 'progcomp', 'progcomp_alias', 'promptvars',
  'restricted_shell', 'shift_verbose', 'sourcepath', 'varredir_close', 'xpg_echo'];
/** POSIX special builtins (2.14): their errors end a non-interactive POSIX shell */
const POSIX_SPECIAL_BUILTINS = new Set(['break', ':', 'continue', '.', 'eval', 'exec', 'exit', 'export', 'readonly', 'return', 'set', 'shift', 'times', 'trap', 'unset']);

/** set -o options a shell starts with */
const DEFAULT_OPTIONS = ['hashall', 'braceexpand', 'interactive-comments'];
const SHOPT_DEFAULTS = ['checkwinsize', 'cmdhist', 'complete_fullquote', 'extquote', 'force_fignore', 'globasciiranges',
  'globskipdots', 'hostcomplete', 'interactive_comments', 'patsub_replacement', 'progcomp', 'promptvars', 'sourcepath'];
/** set -o option names */
const SET_O_OPTIONS = ['allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand',
  'history', 'ignoreeof', 'interactive-comments', 'keyword', 'monitor', 'noclobber', 'noexec', 'noglob', 'nolog', 'notify',
  'nounset', 'onecmd', 'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'xtrace'];

/** bash's reserved words and builtins (what type/command -v call them) */
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until',
  'do', 'done', 'in', 'function', 'time', '{', '}', '!', '[[', ']]', 'coproc']);
const SHELL_BUILTIN_NAMES = new Set([':', '.', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command',
  'compgen', 'complete', 'compopt', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit',
  'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile',
  'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source',
  'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait']);

/** Builtins that run in a subshell as a pipeline element (they change the shell's state) */
const PIPELINE_SUBSHELL_BUILTINS = new Set(['cd', 'pushd', 'popd', 'eval', 'source', '.', 'exit', 'export', 'unset',
  'set', 'shift', 'declare', 'typeset', 'local', 'readonly', 'alias', 'unalias', 'trap', 'umask', 'shopt', 'hash']);

/** Signal names by number, as trap and kill use them (0 is EXIT) */
const SIGNALS = ['EXIT', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2',
  'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ',
  'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS'];

/** The traps-map key for a signal spec (INT, SIGINT, 2, EXIT, 0, ERR, DEBUG, RETURN), or null */
function trapKey(spec: string): string | null {
  if (/^\d+$/.test(spec)) return SIGNALS[Number(spec)] ?? null;
  const name = spec.toUpperCase().replace(/^SIG/, '');
  if (name === 'EXIT' || name === 'ERR' || name === 'DEBUG' || name === 'RETURN') return name;
  return SIGNALS.includes(name) ? name : null;
}

/** Replace each unquoted <(…) / >(…) with a placeholder (\uE030 N \uE031) kept in `out` */
function hideProcSubs(text: string, out: string[]): string {
  let res = '';
  let q = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { res += c; if (c === '\\' && q === '"') res += text[++i] ?? ''; else if (c === q) q = ''; continue; }
    if (c === '\\') { res += c + (text[i + 1] ?? ''); i++; continue; }
    if (c === "'" || c === '"') { q = c; res += c; continue; }
    if ((c === '<' || c === '>') && text[i + 1] === '(' && !/[<>$\d]/.test(text[i - 1] ?? ' ') ) {
      let depth = 0, j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')' && --depth === 0) break;
      }
      if (j < text.length) {
        out.push(text.slice(i, j + 1));
        res += `\uE030${out.length - 1}\uE031`;
        i = j;
        continue;
      }
    }
    res += c;
  }
  return res;
}

/** Rewrite each unquoted `|&` as ` 2>&1 |` */
function pipeAmpToRedirect(text: string): string {
  let out = '';
  let q = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { out += c; if (c === '\\' && q === '"') out += text[++i] ?? ''; else if (c === q) q = ''; continue; }
    if (c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue; }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    if (c === '|' && text[i + 1] === '&' && text[i - 1] !== '|') { out += ' 2>&1 |'; i++; continue; }
    out += c;
  }
  return out;
}

/** Distinct names for process-substitution files */
let procSubCounter = 0;

/** Pids for in-page background jobs ($!), above any kernel pid in practice */
let nextInPagePid = 40000;

/** Shells started as their own process (`sh script`, `sh -c`), by $$: `kill PID` reaches them */
const shellsByPid = new Map<number, WeakRef<Shell>>();
/** Running in-page background jobs by their made-up pid ($!), for `kill PID` from any shell */
const inPageJobs = new Map<number, BackgroundJob>();
export function inPageJobForPid(pid: number): BackgroundJob | undefined {
  return inPageJobs.get(pid);
}

/** bash's ${x@Q}: '…' ('\\'' for a quote), or $'…' when the value has control characters */
export function quoteReusable(v: string): string {
  if (!/[\x00-\x1f\x7f]/.test(v)) return `'${v.replace(/'/g, "'\\''")}'`;
  const named: Record<string, string> = { '\n': 'n', '\t': 't', '\r': 'r', '\x07': 'a', '\b': 'b', '\x1b': 'E', '\f': 'f', '\v': 'v', '\\': '\\', "'": "'" };
  let out = "$'";
  for (const ch of v) {
    if (named[ch]) out += '\\' + named[ch];
    else if (/[\x00-\x1f\x7f]/.test(ch)) out += '\\' + ch.charCodeAt(0).toString(8).padStart(3, '0');
    else out += ch;
  }
  return out + "'";
}

/** A value in double quotes, as declare -p and ${a[@]@K} write it */
function dquote(v: string): string {
  return `"${v.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** An associative array key as declare -p writes it */
function quoteKey(k: string): string {
  return /^[\w.-]+$/.test(k) ? k : dquote(k);
}

/** A caller's variable, saved by `local` (or declare in a function) and put back on return */
interface LocalSave {
  env?: string;
  arr?: string[];
  assoc?: Map<string, string>;
  attrs?: Set<string>;
  readonly?: boolean;
  nameref?: string;
  unexported?: boolean;
  declared?: boolean;
}

/** The shell whose $$ is `pid`, while it runs */
export function shellForPid(pid: number): Shell | undefined {
  const s = shellsByPid.get(pid)?.deref();
  if (!s) shellsByPid.delete(pid);
  return s;
}

/** The shell that last ran an in-page command: /proc/self for in-page commands */
let activeShell: WeakRef<Shell> | undefined;

/** In-page shells in /proc: their own pids, the shell running in-page commands as /proc/self */
addProcInfoSource({
  get(pid) {
    const active = activeShell?.deref();
    const sh = shellForPid(pid) ?? (active?.shellPid === pid ? active : undefined);
    if (!sh) return undefined;
    const comm = sh.invokedAsSh ? 'sh' : 'bash';
    return {
      pid, ppid: sh.parentPid, pgid: pid, sid: pid, comm, state: sh === active ? 'R' : 'S', cmdline: [comm],
      cwd: sh.cwd, environ: sh.exportedEnv(), exe: `/usr/bin/${comm}`,
      startMs: Date.now() - ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - sh.startTime),
    };
  },
  list() {
    const active = activeShell?.deref();
    return [...shellsByPid.keys(), ...(active ? [active.shellPid] : [])];
  },
});
setProcSelf(() => activeShell?.deref()?.shellPid);

// Env var names whose values should be masked in terminal output
const SECRET_ENV_KEYS = [
  'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY',
  'API_KEY', 'SECRET_KEY', 'ACCESS_TOKEN', 'AUTH_TOKEN',
];

interface CompletionSpec {
  words?: string[];
  funcName?: string;
  action?: string;
  prefix?: string;
  suffix?: string;
}

/** Sentinel thrown by `break [N]` inside loops */
/** Quiet period before command history is written to ~/.bash_history. */
const HISTORY_SAVE_DELAY_MS = 500;
/** Shells with a history save scheduled, flushed together when the page hides. */
const historySavePending = new Set<Shell>();
let historyFlushInstalled = false;
function installHistoryFlush(): void {
  if (historyFlushInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  historyFlushInstalled = true;
  const flush = () => { for (const sh of [...historySavePending]) void sh.flushHistory(); };
  window.addEventListener('pagehide', flush);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  }
}

/** Cheap pre-check for expandPrefixAssignments: starts with NAME= and has another NAME= later (a superset: false hits just take the full pass) */
const ORDERED_PREFIX_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*\+?=[\s\S]*\s[A-Za-z_][A-Za-z0-9_]*\+?=/;

class BreakSignal { constructor(public levels: number = 1) {} }
/** Sentinel thrown by `continue [N]` inside loops */
class ContinueSignal { constructor(public levels: number = 1) {} }
/** Sentinel thrown by `return [N]` inside functions */
class ReturnSignal { constructor(public code: number = 0) {} }
/** Sentinel thrown by `exit [N]`; caught by the outermost execute() of the shell */
export class ExitSignal { constructor(public code: number = 0) {} }
/** set -u: an unset parameter was expanded. Ends a script (status 127, as bash) or the subshell it is in */
export class UnboundVariable extends Error {
  code = 127;
  constructor(name: string) { super(`${name}: unbound variable`); }
}
/** An expansion error that abandons the current command line (bad substitution, arithmetic): a script goes on with the next line, status 1 */
export class LineAbort extends Error {}

/**
 * Whether the inside of ${…} is a parameter expansion bash can parse:
 * [#|!]PARAM[[SUB]] and then nothing or an operator (:- = + ?, # ## % %%,
 * / // /# /%, ^ ^^ , ,,, @X, :offset). Anything else is a "bad substitution".
 */
export function validParamExpansion(inner: string): boolean {
  const base = (s: string): string | null => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/.exec(s);
    if (!m) return null;
    let i = m[0].length;
    if (s[i] === '[' && /^[A-Za-z_]/.test(m[0])) {
      let depth = 0;
      for (; i < s.length; i++) {
        if (s[i] === '[') depth++;
        else if (s[i] === ']' && --depth === 0) break;
      }
      if (i >= s.length) return null;
      i++;
    }
    return s.slice(i);
  };
  const op = (rest: string) => rest === '' || /^(:?[-=+?]|[#%/^,]|:)/.test(rest) && !/^@/.test(rest) || /^@[A-Za-z]$/.test(rest);
  const plain = base(inner);
  if (plain !== null && op(plain)) return true;
  if (inner[0] === '#') {
    const rest = base(inner.slice(1));
    if (rest === '') return true;
  }
  if (inner[0] === '!') {
    if (/^![A-Za-z_][A-Za-z0-9_]*[@*]$/.test(inner)) return true;
    const rest = base(inner.slice(1));
    if (rest !== null && op(rest)) return true;
  }
  return false;
}
function isControlSignal(e: unknown): boolean {
  return e instanceof ExitSignal || e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal;
}

const ENV_PREFIX_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\+?)=((?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s'"|;&<>()\\])*)(?=\s)/;

/**
 * Split leading `NAME=value` assignments off a command segment.
 * Returns null unless at least one assignment is followed by a command.
 */
export function splitEnvPrefix(segment: string): { assignments: ([string, string] | [string, string, true])[]; rest: string } | null {
  const assignments: ([string, string] | [string, string, true])[] = [];
  let rest = segment;
  for (let m = ENV_PREFIX_RE.exec(rest); m; m = ENV_PREFIX_RE.exec(rest)) {
    const value = m[3].replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'|\\(.)/g, (_all, dq, sq, esc) =>
      dq !== undefined ? dq.replace(/\\(["\\$`])/g, '$1') : sq ?? esc);
    assignments.push(m[2] === '+' ? [m[1], value, true] : [m[1], value]); // (NAME+=value appends)
    rest = rest.slice(m[0].length);
  }
  if (assignments.length === 0 || !rest.trim() || /^\s*[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(rest)) return null;
  // Array assignments (arr=(...)) and bare compound words stay on the existing path
  if (/^\s*\(/.test(rest)) return null;
  return { assignments, rest: rest.trimStart() };
}

/**
 * The terminal for a command whose stdout the caller collects ($(...), exec()):
 * kernel jobs keep the tty for stdin and stderr, as in bash, but their stdout
 * is captured instead of going to the screen.
 */
export function capturingStdout<T extends object>(term: T): T {
  return new Proxy(term, {
    get(t, k) {
      if (k === 'captureStdout') return true;
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/** The terminal minus its pty session (for background work that must not become the foreground job) */
function withoutTty<T extends object>(term: T): T {
  return new Proxy(term, {
    get(t, k) {
      if (k === 'tty') return undefined;
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/** Runaway-loop guard for while/until/for((;;)); high enough for `while read` over big files */
const LOOP_ITERATION_LIMIT = 10_000_000;
/** Let the page paint and handle input during long shell loops */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Expansion results ($VAR, ${NAME}, $(cmd)) are data: bash never re-reads their
 * quotes, backslashes, $, or operators (| < > & ;) as syntax. This shell expands into the command text
 * and tokenizes afterwards, so those characters are swapped for private-use
 * stand-ins on the way in and swapped back once words are final.
 */
const EXPANSION_PROTECT: Record<string, string> = {
  '"': '\uE000', "'": '\uE001', '\\': '\uE002', '$': '\uE003', '`': '\uE004',
  '|': '\uE005', '<': '\uE006', '>': '\uE007', '&': '\uE008', ';': '\uE009',
  // \x01 marks quoted glob characters inside the shell; a \x01 in data is kept apart
  '\x01': '\uE00D',
};
/** Blanks inside one field of an unquoted expansion (IFS doesn't split them) */
const BLANK_PROTECT: Record<string, string> = { ' ': '\uE00A', '\t': '\uE00B', '\n': '\uE00C' };
const EXPANSION_RESTORE: Record<string, string> = Object.fromEntries(
  [...Object.entries(EXPANSION_PROTECT), ...Object.entries(BLANK_PROTECT)].map(([k, v]) => [v, k]));
/**
 * Put after an expansion that is directly followed by < or >: `$?>f` is the
 * word `5` and a redirect, not the fd redirect `5>f` (the shell tokenizes
 * after expanding). Restored to nothing.
 */
const REDIR_GUARD = '\uE00E';
EXPANSION_RESTORE[REDIR_GUARD] = '';
const redirGuard = (next: string | undefined) => (next === '<' || next === '>' ? REDIR_GUARD : '');

/**
 * Field splitting of an unquoted expansion's value (POSIX 2.6.5): returns
 * command text whose words are the fields. IFS whitespace runs separate
 * fields and are trimmed at the ends; each other IFS character ends a field
 * (so `a::b` has an empty field, written as ''). Blanks that IFS doesn't
 * split on are protected.
 */
export function splitFields(value: string, ifs: string | undefined): string {
  const sep = ifs ?? ' \t\n';
  const protect = (f: string) => protectExpansion(f).replace(/[ \t\n]/g, (c) => BLANK_PROTECT[c]);
  if (sep === '') return protect(value);
  const ws = [...sep].filter((c) => c === ' ' || c === '\t' || c === '\n').join('');
  const isWs = (c: string) => ws.includes(c);
  const isSep = (c: string) => sep.includes(c) && !isWs(c);
  const fields: string[] = [];
  let cur = '';
  let i = 0;
  const n = value.length;
  while (i < n && isWs(value[i])) i++;
  while (i < n) {
    const c = value[i];
    if (isSep(c)) {
      fields.push(cur); cur = ''; i++;
      while (i < n && isWs(value[i])) i++;
      continue;
    }
    if (isWs(c)) {
      while (i < n && isWs(value[i])) i++;
      if (i < n && isSep(value[i])) continue;
      if (i < n) { fields.push(cur); cur = ''; }
      continue;
    }
    cur += c; i++;
  }
  if (cur !== '') fields.push(cur);
  return fields.map((f) => (f === '' ? "''" : protect(f))).join(' ');
}
export function protectExpansion(value: string): string {
  return /["'\\$`|<>&;\x01]/.test(value) ? value.replace(/["'\\$`|<>&;\x01]/g, (c) => EXPANSION_PROTECT[c]) : value;
}
export function restoreExpansion(text: string): string {
  return /[\uE000-\uE00E]/.test(text) ? text.replace(/[\uE000-\uE00E]/g, (c) => EXPANSION_RESTORE[c]) : text;
}

/** restoreExpansion for tokenized words, where \x01 marks the next character as quoted: a data \x01 is itself marked */
function restoreWord(text: string): string {
  return restoreExpansion(text.replace(/\uE00D/g, '\x01\uE00D'));
}

/**
 * Expanded shell text with its quoting removed, as one word: '…' literal,
 * "…" with \ before $ ` " \ and newline, a backslash outside quotes takes
 * the next character.
 */
function removeQuoting(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) { out += text.slice(i + 1); break; } out += text.slice(i + 1, e); i = e; continue; }
    if (c === '\\') { out += text[++i] ?? ''; continue; }
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\' && '$`"\\\n'.includes(text[i + 1] ?? '')) i++;
        out += text[i] ?? '';
      }
      continue;
    }
    out += c;
  }
  return out;
}

/** A tokenized word without its quote markers (\x01 + char is that char) */
function unmark(word: string): string {
  return word.includes('\x01') ? word.replace(/\x01([\s\S])?/g, '$1') : word;
}

/** Re-quote already-parsed args so a command can be run again verbatim (time, env, exec, aliases). */
export function quoteArgsForShell(args: string[]): string {
  return args.map((a) => (/^[A-Za-z0-9_\-.,/:=@%+]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

export class Shell {
  fs: FileSystem;
  /** User id kernel processes started by this shell run as (`sudo` sets 0); undefined = the parent's (1000). */
  uid?: number;
  /**
   * Boot work that decides what names mean (Debian mode's overlay, which
   * makes `python3` Debian's once installed): commands wait for it, so one
   * typed right after load doesn't run the builtin.
   */
  bootGate?: Promise<unknown>;
  cwd: string = '/home/user';
  env: Record<string, string> = {};
  history: string[] = [];
  commands: CommandRegistry;
  lastExitCode: number = 0;
  /** The `exit` builtin ended this shell (an interactive loop stops reading). */
  exited = false;
  /** Function definitions; `source`: the file defining it (its BASH_SOURCE entry) */
  functions: Record<string, { body: string; source?: string; line?: number }> = {};
  /** The file whose commands run now (`bash FILE`, `source FILE`); '' for -c or a terminal */
  sourceFile = '';
  /** Functions marked with `export -f`: the only ones a new shell process (sh -c, a script) gets */
  exportedFunctions = new Set<string>();
  backgroundJobs: Map<number, BackgroundJob> = new Map();
  /** Shell options: errexit (-e), xtrace (-x), nounset (-u), verbose (-v) */
  options: Set<string> = new Set(DEFAULT_OPTIONS);
  /** $BASHPID: 1 (= $$) in the top shell, a new number in each subshell */
  bashPid = 1;
  /** $$ (a subshell keeps its parent's) and $PPID */
  shellPid = 1;
  parentPid = 0;
  /** BASHPID of the shell this one was forked from: a new shell's $PPID */
  private forkParentPid = 0;
  /**
   * The pid and parent pid for a shell started as this one's only command,
   * as if this process exec'd it: `sh script &` ($! is its $$), `$(sh -c …)`
   * (its $PPID is the shell around the substitution). Taken once.
   */
  execPid?: number;
  execPpid?: number;
  /**
   * Variables created by assignment and never exported: a new shell process
   * (startProcess) and kernel programs don't get them. Everything else in
   * env (what the shell started with, `export`ed names) is exported.
   */
  localVars = new Set<string>();
  /** Started as `sh`: POSIX-style output where bash's sh mode differs (export -p) */
  invokedAsSh = false;
  /** `export NAME` before NAME has a value */
  exportedUnset = new Set<string>();
  /** When this shell process started (performance.now()), for `times` */
  startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  /**
   * An interactive shell running as a kernel process on a pty: job control on
   * that pty (its jobs get their own process groups and the terminal; Ctrl-Z
   * stops them), and where job messages go.
   */
  kernelTty?: { tty: import('./kernel/pty').ProcessTty; writeOutput: (s: string) => void };
  /** A fork of another shell (a subshell, or a new shell process) */
  isSubshell = false;
  /** In a subshell: the traps of the shell it was forked from, for a plain `trap` */
  private parentTraps?: Map<string, string>;
  private trapsModified = false;
  /** Signals sent to this shell (kill $$), handled before its next command */
  private pendingSignals: number[] = [];
  /** The logical working directory cd set (symlinks kept), which pwd prints; null: use cwd */
  logicalPwd: string | null = null;
  /** Bash-style indexed arrays */
  arrays: Map<string, string[]> = new Map();
  /** Bash-style associative arrays (declare -A) */
  assocArrays: Map<string, Map<string, string>> = new Map();
  /** Trap handlers: signal → command string */
  traps: Map<string, string> = new Map();
  /** Shell aliases: name → replacement string */
  aliases: Map<string, string> = new Map();
  /** Namerefs: name → target variable name */
  namerefs: Map<string, string> = new Map();
  private ownUmask = 0o022;
  /** The file creation mask: the kernel process's when the shell runs as one */
  get umask(): number { return this.kernelStdio?.proc.umask ?? this.ownUmask; }
  set umask(v: number) {
    this.ownUmask = v;
    if (this.kernelStdio) this.kernelStdio.proc.umask = v;
  }

  /** The directory stack after the current directory (pushd/popd/dirs, shell-builtins.ts) */
  dirStack: string[] = [];
  /** Local variable frames for function scoping — stack of {varName → savedValue|undefined} */
  private localVarStack: Map<string, LocalSave>[] = [];
  /** declare -i / -l / -u: applied on every assignment (setVar) */
  varAttrs: Map<string, Set<string>> = new Map();
  /** Declared without a value (`declare x`, `local x`): set for declare -p, unset otherwise */
  declaredNames: Set<string> = new Set();
  /** Loops being run (break/continue only act inside one; a subshell starts at 0) */
  private loopDepth = 0;
  /** Readonly variable names */
  readonlyVars: Set<string> = new Set();
  /** Bash shopt options: extglob, nocaseglob, nullglob, dotglob, globstar, etc. */
  /** shopt options that are on (bash's non-interactive defaults to start) */
  shoptopts: Set<string> = new Set(SHOPT_DEFAULTS);
  /** Programmable completion specs: command name → spec */
  completionSpecs: Map<string, CompletionSpec> = new Map();
  /** Builtins disabled via `enable -n` */
  disabledBuiltins: Set<string> = new Set();
  /** `builtin NAME` runs Shiro's NAME even when a package provides NAME */
  pkgShadowBypass: string | null = null;
  /**
   * Set when this shell runs as a kernel process (`sh -c CMD` exec'd by a
   * program, kernel.ts runShellProcess): kernel programs it starts get that
   * process's real fds 0-2 (binary-safe, the tty) and stay in its process
   * group, as a real non-interactive sh would do it.
   */
  kernelHost: { kernel: import('./kernel/kernel').Kernel; proc: import('./kernel/process').Process } | null = null;
  /** File descriptors for `read -u FD` and `exec N< file` */
  fileDescriptors: Map<number, { content: string; offset: number }> = new Map();
  /** Coproc state: { name, pid, output } */
  coproc: { name: string; pid: number; output: string } | null = null;
  /** Abort controller for the currently running command (SIGINT) */
  abortController: AbortController | null = null;
  /** Current line number for LINENO tracking */
  currentLine: number = 1;
  /** Depth of execute() recursion — only top-level resets LINENO */
  private executeDepth: number = 0;
  private nextJobId = 1;
  /** Next job number for the job table (kernel jobs use it too) */
  allocJobId(): number {
    return this.nextJobId++;
  }
  private terminal?: ShiroTerminal;

  constructor(fs: FileSystem, commands: CommandRegistry) {
    this.fs = fs;
    this.commands = commands;
    // Commands that read or write a named pipe by name (cat fifo, tee fifo) go through the kernel's pipe
    fs.fifoIO ??= {
      read: async (path) => new TextEncoder().encode(await fifo.readFifo(this, path)),
      write: (path, data) => fifo.writeFifo(this, path, typeof data === 'string' ? data : new TextDecoder().decode(data)),
    };
    // Which builtins installed packages replace (read once, kept current by pkg)
    loadPackageShadows(fs).catch(() => {});
    this.env = {
      HOME: '/home/user',
      USER: 'user',
      LOGNAME: 'user',
      LANG: 'C.UTF-8',
      SHELL: '/bin/sh',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      PWD: '/home/user',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
    };
    // Load history async (don't block construction)
    this.loadHistory();
  }

  private historyFile = '/home/user/.bash_history';
  private maxHistorySize = 1000;

  /** Load command history from ~/.bash_history */
  async loadHistory(): Promise<void> {
    try {
      const raw = await this.fs.readFile(this.historyFile);
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      this.history = content.split('\n')
        .map((line: string) => line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''))
        .filter((line: string) => line.trim());
      // Keep only the most recent entries
      if (this.history.length > this.maxHistorySize) {
        this.history = this.history.slice(-this.maxHistorySize);
      }
    } catch {
      // File doesn't exist yet, that's fine
      this.history = [];
    }
  }

  private historySaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Save history once the shell has been quiet for a moment: one write per
   *  burst of commands instead of one full-file write per command. */
  scheduleHistorySave(): void {
    if (this.historySaveTimer) clearTimeout(this.historySaveTimer);
    this.historySaveTimer = setTimeout(() => {
      this.historySaveTimer = null;
      historySavePending.delete(this);
      void this.saveHistory();
    }, HISTORY_SAVE_DELAY_MS);
    historySavePending.add(this);
    installHistoryFlush();
  }

  /** Write a scheduled history save now and commit it (page going away). */
  async flushHistory(): Promise<void> {
    if (!this.historySaveTimer) return;
    clearTimeout(this.historySaveTimer);
    this.historySaveTimer = null;
    historySavePending.delete(this);
    await this.saveHistory();
    await this.fs.sync().catch(() => {});
  }

  /** Save command history to ~/.bash_history */
  async saveHistory(): Promise<void> {
    try {
      // Keep only the most recent entries
      const toSave = this.history.slice(-this.maxHistorySize);
      await this.fs.writeFile(this.historyFile, toSave.join('\n') + '\n');
    } catch (err) {
      // Silently fail - history is nice to have but not critical
    }
  }

  /**
   * Set the terminal reference for interactive commands like vi.
   */
  setTerminal(terminal: ShiroTerminal): void {
    this.terminal = terminal;
  }

  /**
   * Create a child shell that shares fs/commands but has its own cwd/env.
   * Used by spawn to isolate process state from the parent terminal.
   */
  /** Get positional parameters $1..$# as an array */
  private getPositionalArgs(): string[] {
    // Callers that only set $@ (no $#/$1…) get its words
    if (this.env['#'] === undefined && this.env['@']) return this.env['@'].split(' ');
    const count = parseInt(this.env['#'] || '0', 10);
    const args: string[] = [];
    for (let i = 1; i <= count; i++) args.push(this.env[String(i)] || '');
    return args;
  }

  /** Pop and restore local variable frame */
  private restoreLocalVars(): void {
    const frame = this.localVarStack.pop();
    if (!frame) return;
    for (const [varName, saved] of frame) this.restoreLocal(varName, saved);
  }

  /** The caller's NAME, as a local saved it */
  private saveLocal(name: string): LocalSave {
    return {
      env: this.env[name], arr: this.arrays.get(name), assoc: this.assocArrays.get(name),
      attrs: this.varAttrs.get(name), readonly: this.readonlyVars.has(name), nameref: this.namerefs.get(name),
      unexported: this.localVars.has(name), declared: this.declaredNames.has(name),
    };
  }

  private restoreLocal(name: string, saved: LocalSave): void {
    if (saved.env === undefined) delete this.env[name]; else this.env[name] = saved.env;
    if (saved.arr) this.arrays.set(name, saved.arr); else this.arrays.delete(name);
    if (saved.assoc) this.assocArrays.set(name, saved.assoc); else this.assocArrays.delete(name);
    if (saved.attrs === undefined && saved.readonly === undefined) return; // (a frame from before attributes were saved)
    if (saved.attrs) this.varAttrs.set(name, saved.attrs); else this.varAttrs.delete(name);
    if (saved.readonly) this.readonlyVars.add(name); else this.readonlyVars.delete(name);
    if (saved.nameref !== undefined) this.namerefs.set(name, saved.nameref); else this.namerefs.delete(name);
    if (saved.unexported) this.localVars.add(name); else if (saved.env !== undefined) this.localVars.delete(name);
    if (saved.declared) this.declaredNames.add(name); else this.declaredNames.delete(name);
  }

  /**
   * declare / typeset / local [-aAfFgilnprtux] [+…] [NAME[=VALUE]…] (bash 5.2):
   * attributes stick to the variable (-i evaluates every assignment, -l/-u
   * fold case, -x exports, -r after the value is set, -n is a nameref); in
   * a function declare and typeset make locals, as local does, unless -g.
   * -p prints NAMEs, or without names every variable with the given
   * attributes. (Arrays NAME=(…) are assigned by tryArrayAssignment, which
   * calls this for the attributes first.)
   */
  private declareBuiltin(cmd: string, args: string[], out: (s: string) => void, err: (s: string) => void): number {
    const inFunc = this.localVarStack.length > 0;
    if (cmd === 'local' && !inFunc) { err(`tabcomputer: local: can only be used in a function\r\n`); return 1; }
    const on = new Set<string>();
    const off = new Set<string>();
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { i++; break; }
      if (!/^[-+][A-Za-z]+$/.test(a)) break;
      for (const ch of a.slice(1)) {
        if (!'aAfFgiIlnprtux'.includes(ch)) {
          err(`tabcomputer: ${cmd}: ${a[0]}${ch}: invalid option\r\n${cmd}: usage: ${cmd} [-aAfFgiIlnrtux] [name[=value] ...] or ${cmd} -p [-aAfFilnrtux] [name ...]\r\n`);
          return 2;
        }
        (a[0] === '-' ? on : off).add(ch);
      }
    }
    const names = args.slice(i);

    // declare -f [NAME…]: definitions; -F: names
    if ((on.has('f') || on.has('F')) && cmd !== 'local') {
      let status = 0;
      for (const name of names.length ? names : Object.keys(this.functions).sort()) {
        const fn = this.functions[name];
        if (!fn) { status = 1; continue; }
        if (on.has('F')) { out(names.length ? `${name}\r\n` : `declare -f ${name}\r\n`); continue; }
        const body = fn.body.split('\n').filter((l) => l.trim()).map((l) => '    ' + l.trim().replace(/;$/, '')).join('\r\n');
        out(`${name} () \r\n{ \r\n${body}\r\n}\r\n`);
      }
      return status;
    }

    // -p, or no names: print
    if (on.has('p') || names.length === 0) {
      if (names.length) {
        let status = 0;
        for (const name of names) {
          const line = this.declareLine(name);
          if (line === null) { err(`tabcomputer: ${cmd}: ${name}: not found\r\n`); status = 1; }
          else out(line + '\r\n');
        }
        return status;
      }
      const want = [...on].filter((c) => 'aAilnrux'.includes(c));
      const all = new Set([...Object.keys(this.env), ...this.arrays.keys(), ...this.assocArrays.keys(), ...this.namerefs.keys(), ...this.declaredNames, ...this.exportedUnset]);
      for (const name of [...all].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !n.startsWith('__')).sort()) {
        const flags = this.attrFlags(name, false);
        if (want.some((c) => !flags.includes(c))) continue;
        const line = this.declareLine(name);
        if (line !== null) out(line + '\r\n');
      }
      return 0;
    }

    const makeLocal = inFunc && !on.has('g');
    let status = 0;
    for (const word of names) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)?([\s\S]*)$/.exec(word);
      if (!m) { err(`tabcomputer: ${cmd}: \`${word}': not a valid identifier\r\n`); status = 1; continue; }
      const name = m[1];
      const append = m[2] === '+=';
      let value: string | undefined = m[2] ? m[3] : undefined;
      if (makeLocal) {
        const frame = this.localVarStack[this.localVarStack.length - 1];
        if (!frame.has(name)) {
          frame.set(name, this.saveLocal(name));
          // a fresh local: unset (local x), not the caller's value or attributes
          delete this.env[name];
          this.arrays.delete(name);
          this.assocArrays.delete(name);
          this.varAttrs.delete(name);
          this.readonlyVars.delete(name);
          this.namerefs.delete(name);
          this.declaredNames.delete(name);
          this.localVars.add(name);
        }
      }
      // -n: NAME refers to the variable named by VALUE
      if (on.has('n')) {
        if (value !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?$/.test(value)) {
          err(`tabcomputer: ${cmd}: \`${value}': invalid variable name for name reference\r\n`); status = 1; continue;
        }
        if (value !== undefined) { this.namerefs.set(name, value); this.declaredNames.delete(name); }
        else if (!this.namerefs.has(name)) {
          // (a value that isn't a variable name leaves a plain variable: ref='#', ref=1)
          const v = this.env[name];
          if (v !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?$/.test(v)) continue;
          this.namerefs.set(name, v ?? '');
          delete this.env[name];
        }
        continue; // (bash ignores -r and -x on a nameref)
      }
      // +n: a plain variable again, holding the name it referred to
      if (off.has('n') && this.namerefs.has(name)) {
        const t = this.namerefs.get(name)!;
        this.namerefs.delete(name);
        if (t) this.setVar(name, t);
      }
      const target = this.refTarget(name);
      if ((value !== undefined || off.has('r')) && this.readonlyVars.has(target)) {
        err(`tabcomputer: ${cmd}: ${target}: readonly variable\r\n`);
        status = 1;
        continue;
      }
      const attrs = new Set(this.varAttrs.get(target) ?? []);
      for (const c of 'ilu') { if (on.has(c)) attrs.add(c); if (off.has(c)) attrs.delete(c); }
      if (on.has('l')) attrs.delete('u');
      if (on.has('u')) attrs.delete('l');
      if (attrs.size) this.varAttrs.set(target, attrs); else this.varAttrs.delete(target);
      if (on.has('A') && !this.assocArrays.has(target)) {
        if (this.arrays.has(target)) { err(`tabcomputer: ${cmd}: ${target}: cannot convert indexed to associative array\r\n`); status = 1; continue; }
        const map = new Map<string, string>();
        if (this.env[target] !== undefined) { map.set('0', this.env[target]); delete this.env[target]; }
        this.assocArrays.set(target, map);
        this.declaredNames.delete(target);
      }
      if (on.has('a') && !this.arrays.has(target)) {
        if (this.assocArrays.has(target)) { err(`tabcomputer: ${cmd}: ${target}: cannot convert associative to indexed array\r\n`); status = 1; continue; }
        this.toArray(target);
        this.declaredNames.delete(target);
      }
      if (value !== undefined) {
        const e = append ? this.appendVar(target, value) : this.setVar(target, value);
        if (e) { err(`tabcomputer: ${cmd}: ${e}\r\n`); status = 1; continue; }
        this.declaredNames.delete(target);
      } else if (this.env[target] === undefined && !this.arrays.has(target) && !this.assocArrays.has(target)) {
        this.declaredNames.add(target);
      }
      if (on.has('x')) { if (this.env[target] !== undefined) this.localVars.delete(target); else this.exportedUnset.add(target); }
      if (off.has('x')) { if (this.env[target] !== undefined) this.localVars.add(target); this.exportedUnset.delete(target); }
      if (on.has('r')) this.readonlyVars.add(target);
    }
    return status;
  }

  /**
   * The variable NAME refers to: its nameref chain followed (NAME itself if it
   * isn't one); a target like a[2] gives the subscript too. Null for a circular chain.
   */
  derefName(name: string): { name: string; sub?: string } | null {
    if (!this.namerefs.has(name)) return { name };
    const seen = new Set<string>();
    let n = name;
    for (;;) {
      const t = this.namerefs.get(n);
      if (t === undefined || t === '') return { name: n };
      if (seen.has(n)) return null;
      seen.add(n);
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([\s\S]*)\])?$/.exec(t);
      if (!m) return { name: n };
      if (m[2] !== undefined) return { name: m[1], sub: m[2] };
      n = m[1];
    }
  }

  /** The variable NAME names, namerefs followed (NAME on a circular chain) */
  refTarget(name: string): string {
    return this.namerefs.has(name) ? this.derefName(name)?.name ?? name : name;
  }

  /** NAME+=VALUE: appended, or added for an integer (declare -i) */
  appendVar(name: string, value: string, sub?: string): string | null {
    const target = this.refTarget(name);
    if (this.varAttrs.get(target)?.has('i')) {
      try {
        const old = this.evalArithBig(this.getVar(name, sub) || '0');
        const add = this.evalArithBig(value || '0');
        return this.setVar(name, String(old + add), sub);
      } catch (e) {
        if (e instanceof ArithError) return e.message;
        throw e;
      }
    }
    return this.setVar(name, (this.getVar(name, sub) ?? '') + value, sub);
  }

  /** The abort of the shell this one was forked from (Ctrl-C reaches it); timeout gives its child its own */
  inheritedAbort: AbortController | null = null;

  /** Set when this shell runs as a kernel process: its fds 0-2 are its stdio (shell-stdio.ts) */
  kernelStdio?: KernelStdio;
  /** fd 0 is still this shell's stdin (nothing handed it a string in its place) */
  kernelStdinLive = false;

  /**
   * This fork is a new shell process (`sh script`, `sh -c`), not a subshell:
   * its own $$, the caller's $$ as $PPID, and `kill $$` reaches it. Undo
   * with endProcess() when it finishes.
   */
  startProcess(pid = this.bashPid, ppid = this.forkParentPid): void {
    // Only exported variables reach a new process, and only `export -f` functions
    for (const n of this.localVars) delete this.env[n];
    this.localVars.clear();
    this.dropUnexportedFunctions();
    this.parentTraps = undefined;
    this.startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // ...and its own options; readonly is not passed on either
    this.options = new Set(DEFAULT_OPTIONS);
    this.shoptopts = new Set(SHOPT_DEFAULTS);
    this.readonlyVars = new Set();
    // A shell starts with the default IFS, whatever its environment says (POSIX 2.5.3)
    this.env.IFS = ' \t\n';
    this.localVars.add('IFS');
    this.parentPid = ppid;
    this.shellPid = pid;
    shellsByPid.set(pid, new WeakRef(this));
    // A new process starts with no call stack, and getopts at the start (OPTIND=1, not exported)
    this.sourceFile = '';
    this.env['OPTIND'] = '1';
    this.localVars.add('OPTIND');
    this.env['BASH_SUBSHELL'] = '0';
    this.localVars.add('BASH_SUBSHELL');
    for (const n of ['FUNCNAME', 'BASH_SOURCE', 'BASH_LINENO']) this.arrays.delete(n);
  }

  /** The process runs FILE (`bash FILE`): BASH_SOURCE=(FILE), BASH_LINENO=(0), no FUNCNAME */
  setScriptSource(file: string): void {
    this.sourceFile = file;
    this.arrays.set('BASH_SOURCE', [file]);
    this.arrays.set('BASH_LINENO', ['0']);
    this.arrays.delete('FUNCNAME');
  }

  /** A function defined now: its body, the file (BASH_SOURCE) and its line (LINENO inside it) */
  private functionRecord(body: string): { body: string; source: string; line: number } {
    // (statements arrive flattened onto one line: the definition's line is as close as it gets)
    return { body, source: this.definingSource(), line: this.currentLine };
  }

  /** BASH_SOURCE for a function defined now (bash: "environment" for -c, "main" at a prompt) */
  private definingSource(): string {
    return this.sourceFile || (this.interactiveFlag ? 'main' : 'environment');
  }

  /**
   * Push a frame on the FUNCNAME / BASH_SOURCE / BASH_LINENO stacks (a
   * function call, or `source`); returns the undo. bash adds the "main" frame
   * under a script's first function, and lists `source` only inside one.
   */
  private pushCallFrame(func: string, source: string): () => void {
    const prev = ['FUNCNAME', 'BASH_SOURCE', 'BASH_LINENO'].map((n) => this.arrays.get(n));
    const [f, src, line] = prev;
    if (func !== 'source') this.arrays.set('FUNCNAME', [func, ...(f?.length ? f : src?.length ? ['main'] : [])]);
    else if (f?.length) this.arrays.set('FUNCNAME', ['source', ...f]);
    this.arrays.set('BASH_SOURCE', [source, ...(src ?? [])]);
    this.arrays.set('BASH_LINENO', [this.env['LINENO'] ?? '0', ...(line ?? [])]);
    return () => {
      ['FUNCNAME', 'BASH_SOURCE', 'BASH_LINENO'].forEach((n, k) => {
        if (prev[k]) this.arrays.set(n, prev[k]!); else this.arrays.delete(n);
      });
    };
  }

  /** A new process keeps only the functions exported with `export -f` (bash's BASH_FUNC_name%%) */
  dropUnexportedFunctions(): void {
    for (const name of Object.keys(this.functions)) {
      if (!this.exportedFunctions.has(name)) delete this.functions[name];
    }
  }

  /** `hash`: command name → where it was found, and how often it ran */
  hashTable = new Map<string, { path: string; hits: number }>();

  /** Where a command name resolves for `hash`: a file on PATH, or a registered command's /usr/bin name */
  private async commandPath(name: string): Promise<string | null> {
    if (SHELL_BUILTIN_NAMES.has(name)) return null;
    const file = await this.findExecutableInPath(name).catch(() => null);
    return file ?? (this.commands.get(name) ? `/usr/bin/${name}` : null);
  }

  /** Errors that end a non-interactive POSIX shell (sh, or set -o posix) do so here */
  posixFatal(): boolean {
    return this.scriptShell && !this.interactiveFlag && (this.invokedAsSh || this.options.has('posix'));
  }

  /**
   * Assigning to a readonly variable ends a non-interactive POSIX shell
   * (2.8.1; dash, bash --posix); bash itself goes on. As `sh` we exit.
   */
  readonlyAssignFailed(): void {
    if (this.posixFatal()) {
      this.lastExitCode = 1;
      this.env['?'] = '1';
      throw new ExitSignal(1);
    }
  }

  /** The environment a program started from this shell gets: env minus unexported variables */
  exportedEnv(): Record<string, string> {
    if (!this.localVars.size) return this.env;
    const e = { ...this.env };
    for (const n of this.localVars) delete e[n];
    return e;
  }

  endProcess(): void {
    if (shellsByPid.get(this.shellPid)?.deref() === this) shellsByPid.delete(this.shellPid);
  }

  /** `kill -SIG $$`: handled before the shell's next command (processSignals) */
  queueSignal(sig: number): void {
    this.pendingSignals.push(sig);
  }

  /**
   * Act on signals sent to this shell: run its trap (keeping $?), ignore it
   * (trap '' SIG, or a signal whose default is to be ignored), or end the
   * shell with status 128+SIG, as an uncaught signal would.
   */
  private async processSignals(writeStdout: (s: string) => void, writeStderr: (s: string) => void): Promise<void> {
    while (this.pendingSignals.length) {
      const sig = this.pendingSignals.shift()!;
      const action = this.traps.get(SIGNALS[sig]);
      if (action === '') continue;
      if (action !== undefined) {
        const saved = this.lastExitCode;
        await this.execute(action, writeStdout, writeStderr, false, undefined, true);
        this.lastExitCode = saved;
        this.env['?'] = String(saved);
        continue;
      }
      const { defaultAction } = await import('./kernel/signals');
      const d = defaultAction(sig);
      // An interactive shell survives the usual terminating signals
      if (!this.scriptShell || d === 'ign' || d === 'stop' || d === 'cont') continue;
      throw new ExitSignal(128 + sig);
    }
  }

  fork(): Shell {
    const child = new Shell(this.fs, this.commands);
    child.inheritedAbort = this.abortController ?? this.inheritedAbort;
    child.kernelStdio = this.kernelStdio;
    child.kernelStdinLive = this.kernelStdinLive;
    child.heredocs = this.heredocs;
    // A dup of this shell's stdout/stderr is that stream itself in the child
    // (whose own stdout may be redirected): keep the writer, not the reference
    const base = this.fdBase;
    child.userFds = new Map([...this.userFds].map(([n, e]) => [n, base && 'dup' in e ? { writer: base[e.dup] } : e]));
    child.fileDescriptors = new Map(this.fileDescriptors);
    child.cwd = this.cwd;
    child.env = { ...this.env };
    child.functions = { ...this.functions };
    child.exportedFunctions = new Set(this.exportedFunctions);
    child.options = new Set(this.options);
    child.shoptopts = new Set(this.shoptopts);
    child.readonlyVars = new Set(this.readonlyVars);
    child.logicalPwd = this.logicalPwd;
    child.bashPid = nextInPagePid++;
    child.isSubshell = true;
    child.scriptShell = this.scriptShell; // a subshell of a script is non-interactive too
    child.interactiveFlag = this.interactiveFlag;
    child.hashTable = new Map([...this.hashTable].map(([k, v]) => [k, { ...v }]));
    child.lastExitCode = this.lastExitCode; // $? in a subshell or $(…) is the caller's
    child.forkParentPid = this.bashPid;
    child.shellPid = this.shellPid;
    child.parentPid = this.parentPid;
    child.localVars = new Set(this.localVars);
    child.invokedAsSh = this.invokedAsSh;
    child.exportedUnset = new Set(this.exportedUnset);
    child.arrays = new Map(Array.from(this.arrays.entries()).map(([k, v]) => [k, copyArray(v)]));
    child.assocArrays = new Map(Array.from(this.assocArrays.entries()).map(([k, v]) => [k, new Map(v)]));
    // A subshell starts with the traps reset, except ignored ones (trap '' SIG)
    // A subshell keeps ignored signals; ERR (set -E) and DEBUG (set -T) only with those options
    child.traps = new Map([...this.traps].filter(([k, v]) => v === '' ||
      (k === 'ERR' && this.options.has('errtrace')) || (k === 'DEBUG' && this.options.has('functrace'))));
    child.parentTraps = this.trapsModified || !this.parentTraps ? new Map(this.traps) : this.parentTraps;
    child.aliases = new Map(this.aliases);
    child.namerefs = new Map(this.namerefs);
    if (this.varAttrs.size) child.varAttrs = new Map([...this.varAttrs].map(([k, v]) => [k, new Set(v)]));
    if (this.declaredNames.size) child.declaredNames = new Set(this.declaredNames);
    child.ownUmask = this.umask;
    // (a new process sets it back to 0: startProcess)
    child.env['BASH_SUBSHELL'] = String((parseInt(this.env['BASH_SUBSHELL'] ?? '0', 10) || 0) + 1);
    child.localVars.add('BASH_SUBSHELL');
    child.sourceFile = this.sourceFile;
    child.dirStack = [...this.dirStack];
    child.history = this.history; // share history array reference
    child.completionSpecs = new Map(this.completionSpecs);
    // A subshell in an if/while condition ignores set -e too
    child.errexitSuppressed = this.errexitSuppressed;
    child.inheritedReturn = this.canReturn();
    child.kernelHost = this.kernelHost;
    child.uid = this.uid;
    child.bootGate = this.bootGate;
    return child;
  }

  /**
   * Replace secret env values in text with '***'.
   * Used by terminals to mask tokens in output.
   */
  maskSecrets(text: string): string {
    for (const key of SECRET_ENV_KEYS) {
      const val = this.env[key];
      if (val && val.length >= 8 && text.includes(val)) {
        text = text.replaceAll(val, '***');
      }
    }
    return text;
  }

  /**
   * Run a command substitution: a child shell (assignments, cd and exit stay
   * inside it) that keeps the terminal, so kernel programs in it can use the tty
   * while their stdout is captured. $? afterwards is its status.
   */
  /**
   * Command text for a substitution's output: one quoted word as an assignment's
   * value (VAR=$(…)) or inside double quotes, else field-split on IFS.
   */
  private substitutionText(out: string, preceding: string, inQuotes: boolean): string {
    if (inQuotes) return protectExpansion(out);
    if (/[A-Za-z_][A-Za-z0-9_]*=$/.test(preceding)) return '"' + protectExpansion(out) + '"';
    return splitFields(out, this.fieldIFS());
  }

  /** Status of the last command substitution while expanding the current command */
  private substStatus: number | null = null;

  private async subshellExec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const child = this.fork();
    child.terminal = this.terminal;
    child.userFds.delete(1); // inside $(...) stdout is the capture
    if (!/[;&|\n]/.test(cmd)) { child.execPid = child.bashPid; child.execPpid = this.bashPid; }
    let stdout = '';
    let stderr = '';
    const out = (s: string) => { stdout += s; };
    const err = (s: string) => { stderr += s; };
    const exitCode = await child.runSubshell(cmd, out, err, this.terminal ? capturingStdout(this.terminal) : undefined);
    this.substStatus = exitCode;
    return { stdout, stderr, exitCode };
  }

  // Execute a command string and return { stdout, stderr, exitCode }
  async exec(input: string, remote: boolean = false): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let stdout = '';
    let stderr = '';
    const exitCode = await this.execute(
      input,
      (s) => { stdout += s; },
      (s) => { stderr += s; },
      remote,
      this.terminal ? capturingStdout(this.terminal) : undefined,
    );
    return { stdout, stderr, exitCode };
  }

  private executeBackground(
    command: string,
    writeStdout: (s: string) => void,
    writeStderr?: (s: string) => void,
  ): number {
    const jobId = this.nextJobId++;
    const stderrWriter = writeStderr || writeStdout;
    // An in-page job has no kernel process; $! and `wait PID` use a made-up pid
    const pid = nextInPagePid++;
    // `( list ) &`: the job's shell is already the subshell
    const t = command.trim();
    if (t.startsWith('(') && !t.startsWith('((') && t.endsWith(')') && this.parseCompound(t).length === 1 && splitTopLevelPipes(t).length === 1) {
      command = t.slice(1, -1).trim() || ':';
    }
    // Runs in a child shell (its variables and cd stay there), output to ours,
    // with its own abort: `kill $!` ends just this job
    const child = this.fork();
    child.bashPid = pid;
    // A shell run as the job's only command gets the job's pid as its $$, as if exec'd
    // (in a pipeline $! is its last element: the earlier ones must not start a shell themselves)
    const parts = splitTopLevelPipes(command);
    if (!/[;&]/.test(command) && parts.slice(0, -1).every((p) => !/^(\S*\/)?(sh|bash)\b|^\$/.test(p.trim()))) {
      child.execPid = pid;
      child.execPpid = this.bashPid;
    }
    const abort = new AbortController();
    const outer = this.abortController ?? this.inheritedAbort;
    outer?.signal.addEventListener('abort', () => abort.abort(), { once: true });
    child.inheritedAbort = abort;
    const job: BackgroundJob = {
      id: jobId,
      command,
      status: 'running',
      exitCode: 0,
      pid,
      abortController: abort,
      ignoresIntQuit: this.scriptShell && !this.options.has('monitor'),
      // No tty for in-page background work: kernel programs inside it must not take the terminal
      promise: child.execute(command, writeStdout, stderrWriter, false, this.terminal ? withoutTty(this.terminal) : undefined)
        .then((code) => child.finishSubshell(code, writeStdout, stderrWriter)).then(
        (code) => {
          inPageJobs.delete(pid);
          if (job.signal) code = 128 + job.signal;
          job.status = code === 0 ? 'done' : 'failed';
          job.exitCode = code;
          return code;
        },
        (err) => {
          inPageJobs.delete(pid);
          job.status = 'failed';
          job.exitCode = 1;
          return 1;
        },
      ),
    };
    this.backgroundJobs.set(jobId, job);
    if (job.status === 'running') inPageJobs.set(pid, job);
    this.env['!'] = String(pid);
    // An interactive shell reports the job; a script doesn't
    if (!this.scriptShell) writeStdout(`[${jobId}] ${pid}\n`);
    return 0;
  }

  async execute(
    line: string,
    writeStdout: (s: string) => void,
    writeStderr?: (s: string) => void,
    remote: boolean = false,
    terminalOverride?: any,
    skipHistory: boolean = false,
  ): Promise<number> {
    // No terminal given: a nested call made by the shell itself (a function,
    // loop or if body) runs on the terminal of the call around it; a builtin
    // calling back with its own sink collects the output like $(...), kernel
    // programs included (their stdout doesn't go to the screen)
    if (this.bootGate) { await this.bootGate; this.bootGate = undefined; }
    if (terminalOverride === undefined) {
      terminalOverride = this.inCommand > 0
        ? (this.terminal ? capturingStdout(this.terminal) : undefined)
        : this.activeTerminal;
    }
    const outerTerminal = this.activeTerminal;
    const outerInCommand = this.inCommand;
    this.activeTerminal = terminalOverride;
    this.inCommand = 0;
    try {
      return await this.executeOn(line, writeStdout, writeStderr, remote, terminalOverride, skipHistory);
    } finally {
      this.activeTerminal = outerTerminal;
      this.inCommand = outerInCommand;
    }
  }

  /** `exec -a NAME prog`: argv[0] for the next kernel program named `name` */
  execArgv0?: { name: string; argv0: string };

  /** The terminal of the execute() in progress (undefined: the shell's own) */
  private activeTerminal: any = undefined;
  /** A builtin (Command.exec) is running: an execute() it makes is its own */
  private inCommand = 0;

  /** Run a builtin; execute() calls it makes without a terminal collect their output */
  private async runCommand(cmd: { exec(ctx: CommandContext): Promise<number> }, ctx: CommandContext): Promise<number> {
    this.inCommand++;
    // /proc/self for an in-page command is this shell (setProcSelf below)
    activeShell = new WeakRef(this);
    // Ctrl-C (or a timeout's abort) ends a builtin even if it never looks at the
    // signal (one stuck awaiting something): the shell stops waiting, status 130
    const abort = (this.abortController ?? this.inheritedAbort)?.signal;
    let off = () => {};
    try {
      if (!abort) return await cmd.exec(ctx);
      if (abort.aborted) return 130;
      const interrupted = new Promise<number>((resolve) => {
        const on = () => resolve(130);
        abort.addEventListener('abort', on, { once: true });
        off = () => abort.removeEventListener('abort', on);
      });
      return await Promise.race([cmd.exec(ctx), interrupted]);
    } finally {
      off();
      this.inCommand--;
    }
  }

  private async executeOn(
    line: string,
    writeStdout: (s: string) => void,
    writeStderr: ((s: string) => void) | undefined,
    remote: boolean,
    terminalOverride: any,
    skipHistory: boolean,
  ): Promise<number> {
    const depth = this.executeDepth;
    const suppressed = this.errexitSuppressed;
    // After `exec >file` / `exec 2>file`, default output goes there. The outermost
    // call routes it, looking the fds up at write time (exec can change them mid-line)
    if (!this.fdRouting) {
      const base1 = writeStdout;
      const base2 = writeStderr || writeStdout;
      const pending = new Map<string, string>();
      const route = (n: 1 | 2) => {
        const target = () => {
          const e = this.userFds.get(n);
          return !e ? (n === 1 ? base1 : base2) : 'dup' in e ? (e.dup === 1 ? base1 : base2) : 'writer' in e ? e.writer : null;
        };
        const w = (s: string) => {
          const t = target();
          if (t) t(s);
          else {
            const e = this.userFds.get(n) as { path: string };
            pending.set(e.path, (pending.get(e.path) ?? '') + s);
          }
        };
        return Object.assign(w, { [WRITER_TARGET]: target });
      };
      const flush = async () => {
        for (const [path, text] of [...pending]) {
          pending.delete(path);
          await this.fs.appendFile(path, text.replace(/\r\n/g, '\n'));
        }
      };
      this.fdRouting = true;
      this.flushFdWrites = flush;
      const outerBase = this.fdBase;
      this.fdBase = { 1: base1, 2: base2 };
      try {
        return await this.execute(line, route(1), route(2), remote, terminalOverride, skipHistory);
      } finally {
        this.fdRouting = false;
        this.flushFdWrites = null;
        this.fdBase = outerBase;
        await flush();
      }
    }
    // A file write per statement keeps output in order for the commands that read it
    if (this.flushFdWrites) await this.flushFdWrites();
    try {
      const code = await this.executeImpl(line, writeStdout, writeStderr, remote, terminalOverride, skipHistory);
      if (this.pendingSignals.length) await this.processSignals(writeStdout, writeStderr || writeStdout);
      return code;
    } catch (e) {
      // `exit` unwinds to the outermost execute() of this shell (a script, `sh -c`,
      // a subshell or $(...) each run in their own Shell), which runs the EXIT trap
      if (e instanceof ExitSignal && depth === 0 && this.sourcing === 0) {
        this.executeDepth = 0;
        this.exited = true;
        const code = (await this.runExitTrap(writeStdout, writeStderr || writeStdout, terminalOverride)) ?? e.code;
        this.lastExitCode = code;
        this.env['?'] = String(code);
        return code;
      }
      throw e;
    } finally {
      // break/continue/return/exit unwind through nested execute() calls
      this.executeDepth = depth;
      this.errexitSuppressed = suppressed;
      if (depth === 0) this.abortController = null;
    }
  }

  /** shopt [-pqsu] [-o] [NAME...] */
  private shoptBuiltin(args: string[], writeStdout: (s: string) => void, writeStderr: (s: string) => void): number {
    let set: boolean | null = null, print = false, quiet = false, setO = false;
    const names: string[] = [];
    for (const a of args) {
      if (names.length === 0 && /^-[psuqo]+$/.test(a)) {
        for (const c of a.slice(1)) {
          if (c === 's') set = true; else if (c === 'u') set = false; else if (c === 'p') print = true;
          else if (c === 'q') quiet = true; else setO = true;
        }
      } else if (a !== '--' || names.length) names.push(a);
    }
    const all = setO ? SET_O_OPTIONS : SHOPT_OPTIONS;
    const isOn = (n: string) => (setO ? this.options : this.shoptopts).has(n);
    let status = 0;
    for (const n of names) if (!all.includes(n)) { writeStderr(`shopt: ${n}: invalid ${setO ? '' : 'shell '}option name\r\n`); status = 1; }
    const valid = names.filter((n) => all.includes(n));
    if (set !== null && names.length) {
      for (const n of valid) {
        if (setO) { if (set) this.options.add(n); else this.options.delete(n); }
        else if (set) this.shoptopts.add(n); else this.shoptopts.delete(n);
      }
      return status;
    }
    if (quiet) return status || (valid.every(isOn) ? 0 : 1);
    const shown = names.length ? valid : all.filter((n) => set === null || isOn(n) === set);
    for (const n of shown) {
      const on = isOn(n);
      if (print) writeStdout(setO ? `set ${on ? '-' : '+'}o ${n}\r\n` : `shopt ${on ? '-s' : '-u'} ${n}\r\n`);
      else writeStdout(`${n.padEnd(15)}\t${on ? 'on' : 'off'}\r\n`);
    }
    // Asking about named options: the status says whether they are all on
    return status || (names.length && !valid.every(isOn) ? 1 : 0);
  }

  /** What NAME runs as, in lookup order (all: every match, else the first) */
  private async commandKinds(name: string, all: boolean): Promise<{ kind: 'alias' | 'keyword' | 'function' | 'builtin' | 'registered' | 'file'; path?: string }[]> {
    const out: { kind: 'alias' | 'keyword' | 'function' | 'builtin' | 'registered' | 'file'; path?: string }[] = [];
    const done = () => !all && out.length > 0;
    if (this.aliases.has(name)) out.push({ kind: 'alias', path: this.aliases.get(name) });
    if (!done() && SHELL_KEYWORDS.has(name)) out.push({ kind: 'keyword' });
    if (!done() && name in this.functions) out.push({ kind: 'function' });
    if (!done() && SHELL_BUILTIN_NAMES.has(name)) out.push({ kind: 'builtin' });
    // Shiro's own commands come before files on PATH, unless a program shadows
    // them as it does when run (pkg install, or Debian mode's /usr/bin/NAME)
    if (!done() && !name.includes('/') && this.commands.get(name) && !SHELL_BUILTIN_NAMES.has(name) &&
      !(this.pkgShadowBypass !== name && packageShadows(this.fs).has(name))) out.push({ kind: 'registered' });
    if (!done()) {
      const path = await this.findExecutableInPath(name).catch(() => null);
      if (path) out.push({ kind: 'file', path });
    }
    return out;
  }

  /** $-: the set options as letters, in bash's order */
  private optionFlags(): string {
    const order: [string, string][] = [['allexport', 'a'], ['notify', 'b'], ['errexit', 'e'], ['noglob', 'f'], ['hashall', 'h'],
      ['monitor', 'm'], ['noexec', 'n'], ['nounset', 'u'], ['verbose', 'v'], ['xtrace', 'x'], ['braceexpand', 'B'],
      ['noclobber', 'C'], ['errtrace', 'E'], ['histexpand', 'H'], ['physical', 'P'], ['functrace', 'T']];
    return order.filter(([o]) => this.options.has(o)).map(([, c]) => c).join('') + (this.scriptShell && !this.interactiveFlag ? '' : 'i')
      + (this.commandStringFlag ? 'c' : '');
  }

  /** sh -i: $- has i; sh -c: $- has c */
  interactiveFlag = false;
  commandStringFlag = false;

  /** trap [-lp] [[ACTION] SIGNAL...] */
  private trapBuiltin(args: string[], writeStdout: (s: string) => void, writeStderr: (s: string) => void, subshell = false): number {
    if (args[0] === '--') args = args.slice(1);
    if (args[0] === '-l') {
      writeStdout(SIGNALS.map((n, k) => (n ? `${k}) SIG${n}` : '')).filter(Boolean).join(' ') + '\r\n');
      return 0;
    }
    // A subshell lists the traps of the shell it came from until it sets its own
    // (bash; `saved=$(trap)` relies on it)
    const table = !subshell && this.parentTraps && !this.trapsModified ? this.parentTraps : this.traps;
    const show = (keys: string[]) => {
      for (const k of keys) {
        const cmd = table.get(k);
        // In a pipeline trap runs in a subshell, where only ignored signals stay set
        if (cmd === undefined || (subshell && cmd !== '')) continue;
        writeStdout(`trap -- '${cmd.replace(/'/g, "'\\''")}' ${SIGNALS.includes(k) && k !== 'EXIT' ? 'SIG' + k : k}\r\n`);
      }
    };
    if (args[0] && /^-./.test(args[0]) && args[0] !== '-p') {
      writeStderr(`tabcomputer: trap: ${args[0]}: invalid option\r\ntrap: usage: trap [-lp] [[arg] signal_spec ...]\r\n`);
      return 2;
    }
    if (args.length === 0 || args[0] === '-p') {
      const keys = args.length > 1 ? args.slice(1).map(trapKey).filter((k): k is string => !!k)
        : [...SIGNALS.filter(Boolean), 'DEBUG', 'ERR', 'RETURN'];
      show(keys);
      return 0;
    }
    this.trapsModified = true;
    // trap SIGNAL / trap N M (an unsigned integer first): reset those signals
    let action: string | null = args[0];
    let sigs = args.slice(1);
    if (sigs.length === 0 || /^\d+$/.test(args[0])) {
      if (sigs.length === 0 && !trapKey(args[0])) {
        writeStderr('trap: usage: trap [-lp] [[arg] signal_spec ...]\r\n');
        return 2;
      }
      action = null;
      sigs = args;
    } else if (action === '-') action = null;
    let status = 0;
    for (const sig of sigs) {
      const k = trapKey(sig);
      if (!k) { writeStderr(`trap: ${sig}: invalid signal specification\r\n`); status = 1; continue; }
      if (action === null) this.traps.delete(k);
      else this.traps.set(k, action);
    }
    return status;
  }

  /** Run and clear the EXIT trap */
  /** Run the EXIT trap; returns the status of an `exit N` in it (which becomes the shell's) */
  async runExitTrap(writeStdout: (s: string) => void, writeStderr: (s: string) => void, terminal?: any): Promise<number | undefined> {
    if (!this.traps.has('EXIT')) return undefined;
    const exitCmd = this.traps.get('EXIT')!;
    this.traps.delete('EXIT'); // prevent re-entry
    const saved = this.lastExitCode;
    // (run nested, so an `exit` in it unwinds to here)
    const depth = this.executeDepth;
    this.executeDepth++;
    try {
      await this.execute(exitCmd, writeStdout, writeStderr, false, terminal, true);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
      this.lastExitCode = e.code;
      return e.code;
    } finally {
      this.executeDepth = depth;
    }
    this.lastExitCode = saved;
    return undefined;
  }

  /** >0 while running a context where `set -e` doesn't apply (if/while/until conditions) */
  errexitSuppressed = 0;

  /**
   * `set -e`: a command that failed exits the shell, unless it is followed by
   * && or ||, negated with !, or runs inside a condition.
   */
  private checkErrexit(compounds: { operator: string; command: string }[], idx: number, exitCode: number): void {
    const ignoredBefore = this.failureIgnored;
    this.failureIgnored = false;
    if (exitCode === 0 || !this.options.has('errexit')) return;
    const nextOp = compounds[idx + 1]?.operator;
    const cmd = compounds[idx].command.trim();
    if (this.errexitSuppressed > 0 || nextOp === '&&' || nextOp === '||' || /^!\s/.test(cmd)) {
      this.failureIgnored = true;
      return;
    }
    // A { group } whose status is a failure set -e ignored inside it doesn't exit either
    if (ignoredBefore && isBraceGroup(cmd)) { this.failureIgnored = true; return; }
    throw new ExitSignal(exitCode);
  }

  /** The last status checked by set -e was a failure it ignored (&&, ||, !, a condition) */
  private failureIgnored = false;

  /** The ERR trap is running */
  private inErrTrap = false;
  /** The DEBUG trap is running */
  private inTrapDebug = false;

  /**
   * The ERR trap after a failed simple command, (( )), [[ ]] or subshell:
   * where set -e would act, not inside itself, and in functions only with set -E
   */
  private async errTrap(code: number, writeStdout: (s: string) => void, writeStderr: (s: string) => void): Promise<void> {
    if (code === 0 || !this.traps.has('ERR') || this.inErrTrap || this.errexitSuppressed !== 0) return;
    if (this.localVarStack.length > 0 && !this.options.has('errtrace')) return;
    this.inErrTrap = true;
    try {
      await this.execute(this.traps.get('ERR')!, writeStdout, writeStderr, false, undefined, true);
    } finally {
      this.inErrTrap = false;
    }
    this.lastExitCode = code;
    this.env['?'] = String(code);
  }

  /** Run the DEBUG trap: $? stays what it was; under set -e its failure ends the shell */
  private async runDebugTrap(writeStdout: (s: string) => void, writeStderr: (s: string) => void): Promise<void> {
    const status = this.lastExitCode;
    this.inTrapDebug = true;
    let code: number;
    try {
      code = await this.execute(this.traps.get('DEBUG')!, writeStdout, writeStderr, false, undefined, true);
    } finally {
      this.inTrapDebug = false;
    }
    this.lastExitCode = status;
    this.env['?'] = String(status);
    if (code !== 0 && this.options.has('errexit')) throw new ExitSignal(code);
  }

  /** Here-document bodies, referenced by `< MARKER` redirections */
  heredocs = new HeredocStore();

  /** Contents of an input redirection's target: a file, or a here-document (expanded now if unquoted) */
  async readInputRedirect(target: string): Promise<string> {
    const ref = fdOfRef(target);
    if (ref !== null) {
      // <&N: the rest of the shell's input fd N
      const f = this.fileDescriptors.get(ref);
      if (!f) throw new Error(`${ref}: Bad file descriptor`);
      const rest = f.content.slice(f.offset);
      f.offset = f.content.length;
      return rest;
    }
    const h = this.heredocs.lookup(target);
    if (h) return h.expand ? this.expandHeredocBody(h.body) : h.body;
    // `< <(cmd)`: the output of cmd
    const ps = /^<\(([\s\S]+)\)$/.exec(target);
    if (ps) return this.procSubOutput(ps[1], () => {});
    const path = this.fs.resolvePath(target, this.cwd);
    if (await fifo.isFifo(this, path)) return fifo.readFifo(this, path);
    const data = await this.fs.readFile(path, 'utf8');
    return typeof data === 'string' ? data : new TextDecoder().decode(data as any);
  }

  /**
   * Expand an unquoted here-document body: $var, ${…}, $(…), `…`, $((…)), with
   * \$ \` \\ and \<newline> as escapes. Quotes are ordinary characters and
   * nothing is field-split.
   */
  private async expandHeredocBody(body: string): Promise<string> {
    let pre = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      // A command substitution's text is a command: its quotes stay quotes
      if (c === '$' && body[i + 1] === '(' && body[i + 2] !== '(') {
        const end = this.skipBalancedParen(body, i + 1);
        pre += body.slice(i, end);
        i = end - 1;
        continue;
      }
      if (c === '`') {
        let e = i + 1;
        while (e < body.length && body[e] !== '`') e += body[e] === '\\' ? 2 : 1;
        pre += body.slice(i, e + 1);
        i = e;
        continue;
      }
      if (c === '\\') {
        const nx = body[i + 1];
        if (nx === '$' || nx === '`' || nx === '\\') { pre += EXPANSION_PROTECT[nx]; i++; continue; }
        if (nx === '\n') { i++; continue; }
        pre += EXPANSION_PROTECT['\\'];
        continue;
      }
      if (c === '"' || c === "'") { pre += EXPANSION_PROTECT[c]; continue; }
      pre += c;
    }
    let expanded = this.expandArithmetic(pre);
    expanded = await this.expandCommandSubstitution(expanded, () => {}, true);
    expanded = this.expandVars(expanded, true);
    return restoreExpansion(expanded);
  }

  /** Set while execute() routes default output through exec'd fds (nested calls don't re-route) */
  private fdRouting = false;
  /** A non-interactive shell (script, sh -c): a syntax error exits it with status 2 */
  private scriptShell = false;
  private flushFdWrites: (() => Promise<void>) | null = null;

  /** Output fds opened by exec (1 and 2 too, after `exec >file`) */
  userFds = new Map<number, OutFd>();
  /** While execute() routes output: the writers a `dup` entry means (this shell's own stdout/stderr) */
  private fdBase: { 1: (s: string) => void; 2: (s: string) => void } | null = null;

  /** Where output to fd n goes: a file, or the shell's stdout/stderr; null if not open */
  resolveOutFd(n: number): OutFd | null {
    const e = this.userFds.get(n);
    if (e) return e;
    if (n === 1) return { dup: 1 };
    if (n === 2) return { dup: 2 };
    return null;
  }

  /** Fd n is being replaced or closed: close a named pipe end this shell opened for it */
  private dropFd(n: number, keep?: OutFd): void {
    const e = this.userFds.get(n);
    if (e && 'fifo' in e && e.fifo && e.owner === this && e !== keep) fifo.dropHeld(e.fifo);
  }

  /** exec with only redirections: update the shell's fd tables */
  private async applyExecRedirects(redirects: Redirect[]): Promise<string | null> {
    if (this.flushFdWrites) await this.flushFdWrites();
    const pending: Promise<unknown>[] = [];
    const openOut = (fd: number, target: string, truncate: boolean): string | null => {
      const ref = fdOfRef(target);
      if (ref !== null) {
        const e = this.resolveOutFd(ref);
        if (!e) return `${ref}: Bad file descriptor`;
        this.dropFd(fd, e);
        this.userFds.set(fd, 'fifo' in e ? { ...e, owner: undefined } : e);
        return null;
      }
      if (target === '/dev/stdout') { this.userFds.set(fd, this.resolveOutFd(1)!); return null; }
      if (target === '/dev/stderr') { this.userFds.set(fd, this.resolveOutFd(2)!); return null; }
      // exec > >(cmd) (exec > >(tee log)): what the script writes, cmd reads when the script ends
      const ps = /^>\(([\s\S]+)\)$/.exec(target);
      if (ps) {
        target = `/tmp/.procsub_${Date.now()}_${procSubCounter++}`;
        this.execOutSubs.push({ path: target, cmd: ps[1] });
        truncate = true;
      }
      const path = this.fs.resolvePath(target, this.cwd);
      this.dropFd(fd);
      this.userFds.set(fd, { path });
      pending.push((async () => {
        if (await fifo.isFifo(this, path)) {
          // A named pipe: open its write end now (it waits for a reader), as exec does
          this.userFds.set(fd, { path, fifo: await fifo.openHeldFifoEnd(this, path, 'w'), owner: this });
        } else if (truncate) await this.fs.writeFile(path, '');
        else await this.fs.appendFile(path, '');
      })());
      return null;
    };
    for (const r of redirects) {
      let err: string | null = null;
      switch (r.type) {
        case '>': case '>>': err = openOut(r.fd ?? 1, r.target, r.type === '>'); break;
        case '2>': case '2>>': err = openOut(2, r.target, r.type === '2>'); break;
        case '2>&1': this.userFds.set(2, this.resolveOutFd(1)!); break;
        case 'open':
          if (r.mode === '<') {
            const fd = r.fd!;
            pending.push(this.readInputRedirect(r.target).then((content) => { this.fileDescriptors.set(fd, { content, offset: 0 }); }));
          } else err = openOut(r.fd!, r.target, r.mode === '>');
          break;
        case 'dup': {
          const to = Number(r.target);
          if (this.fileDescriptors.has(to)) this.fileDescriptors.set(r.fd!, this.fileDescriptors.get(to)!);
          else {
            const e = this.resolveOutFd(to);
            if (!e) err = `${to}: Bad file descriptor`;
            else { this.dropFd(r.fd!, e); this.userFds.set(r.fd!, 'fifo' in e ? { ...e, owner: undefined } : e); }
          }
          break;
        }
        case '>&-': this.dropFd(r.fd!); this.userFds.delete(r.fd!); this.fileDescriptors.delete(r.fd!); break;
        case '<':
          if (fdOfRef(r.target) === null) {
            pending.push(this.readInputRedirect(r.target).then((content) => { this.fileDescriptors.set(0, { content, offset: 0 }); }));
          }
          break;
      }
      if (err) return err;
    }
    try {
      await Promise.all(pending);
    } catch (e: any) {
      return e?.message ?? String(e);
    }
    return null;
  }

  /** File writes started by exec redirections (truncation), awaited before the next write */
  private pendingFdOps: Promise<void> = Promise.resolve();

  /** The shell's fds 3-9 as programs it starts inherit them (runKernelPipeline inheritFds) */
  private inheritableFds(writeStdout: (s: string) => void, writeStderr: (s: string) => void) {
    const out: { fd: number; path?: string; file?: OpenFile; write?: (s: string) => void; content?: string }[] = [];
    for (let n = 3; n <= 9; n++) {
      const e = this.userFds.get(n);
      const inp = this.fileDescriptors.get(n);
      // (a named pipe's open end itself: opening the path again would be another writer)
      if (e && 'path' in e && e.fifo) out.push({ fd: n, file: e.fifo });
      else if (e && 'path' in e) out.push({ fd: n, path: e.path });
      else if (e && 'writer' in e) out.push({ fd: n, write: e.writer });
      else if (e && 'dup' in e) out.push({ fd: n, write: this.fdBase ? this.fdBase[e.dup] : e.dup === 1 ? writeStdout : writeStderr });
      else if (inp) out.push({ fd: n, content: inp.content.slice(inp.offset) });
    }
    return out;
  }

  /** Write command output to fd n's target */
  private async writeToFd(n: number, text: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void): Promise<boolean> {
    const e = this.resolveOutFd(n);
    if (!e) return false;
    if ('dup' in e) {
      // A copy of the shell's own stdout/stderr, even if fd 1/2 now go elsewhere (exec 3>&1 >/dev/null)
      // (fd 1/2 with no exec entry are just the current stdout/stderr: a pipe, a capture)
      const w = this.userFds.has(n) && this.fdBase ? this.fdBase[e.dup] : e.dup === 1 ? writeStdout : writeStderr;
      w(text.replace(/\r?\n/g, '\r\n'));
      return true;
    }
    if ('writer' in e) {
      e.writer(text.replace(/\r?\n/g, '\r\n'));
      return true;
    }
    await this.pendingFdOps;
    if (e.fifo) {
      if (text) await fifo.writeOpenFifo(e.fifo, text.replace(/\r\n/g, '\n'));
      return true;
    }
    if (text) await this.fs.appendFile(e.path, text.replace(/\r\n/g, '\n'));
    return true;
  }

  /** Aliases being expanded right now */
  private expandingAliases = new Set<string>();

  /** getopts' position inside a bundled option word (-abc), valid while OPTIND is unchanged */
  private getoptsState = { optind: 1, char: 1 };

  /** `source` nesting: exit inside a sourced file leaves the sourcing shell too */
  private sourcing = 0;
  /** A subshell of a function or sourced script: `return` leaves the subshell */
  private inheritedReturn = false;
  private canReturn(): boolean {
    return this.inheritedReturn || this.localVarStack.length > 0 || this.sourcing > 0;
  }

  private async executeImpl(
    line: string,
    writeStdout: (s: string) => void,
    writeStderr: ((s: string) => void) | undefined,
    remote: boolean,
    terminalOverride: any,
    skipHistory: boolean,
  ): Promise<number> {
    // Stdin handed over by a pipeline whose head was a loop or subshell (see runHeadedPipeline)
    const injectedStdin = this.injectedStdin;
    this.injectedStdin = null;
    // Source text from the user, a script or `source` loses its comments first
    if (this.executeDepth === 0) line = stripComments(line, this.sourcing > 0 ? 'posix' : 'interactive');
    // Here-documents become `< MARKER` redirections (shell-heredoc.ts)
    if (hasHeredoc(line)) line = extractHeredocs(line, this.heredocs);
    const source = trimCommand(line);
    // A comment line (a multi-line script that starts with one still runs)
    if (!source || (source.startsWith('#') && !source.includes('\n'))) return 0;

    // LINENO tracking: reset at top-level execute, track depth
    this.executeDepth++;
    const isTopLevel = this.executeDepth === 1;
    if (isTopLevel) {
      this.currentLine = 1;
      // Set up abort controller for SIGINT (Ctrl+C)
      this.abortController = this.inheritedAbort ?? new AbortController();
    }

    // Split multi-line input into complete statements (shell-statements.ts); a
    // single statement comes back on one line, with \<newline> continuations joined
    const statements = groupStatements(source);
    const trimmed = statements.length === 1 ? statements[0].text : source;

    // Check for background execution (&)
    if (statements.length <= 1 && endsWithBackgroundAmp(trimmed) && this.parseCompound(trimmed).length === 1) {
      const bgCmd = trimmed.slice(0, -1).trim();
      if (bgCmd) {
        this.executeDepth--;
        if (isTopLevel) this.abortController = null;
        if (await this.launchKernelBackground(bgCmd, writeStdout, terminalOverride || this.terminal)) return 0;
        return this.executeBackground(bgCmd, writeStdout, writeStderr);
      }
    }

    if (statements.length > 1) {
      let lastExit = 0;
      let lineOffset = isTopLevel ? 0 : this.currentLine - 1;
      for (let si = 0; si < statements.length; si++) {
        const stmt = statements[si].text;
        this.currentLine = lineOffset + statements[si].line;
        this.env['LINENO'] = String(this.currentLine);
        if (si === 0 && injectedStdin !== null) this.injectedStdin = injectedStdin;
        lastExit = await this.execute(stmt, writeStdout, writeStderr, remote, terminalOverride, true);
      }
      // Fire EXIT trap at end of top-level multi-line script
      if (isTopLevel && this.traps.has('EXIT')) {
        const exitCmd = this.traps.get('EXIT')!;
        this.traps.delete('EXIT'); // prevent re-entry
        await this.execute(exitCmd, writeStdout, writeStderr, false, terminalOverride, true);
      }
      this.lastExitCode = lastExit;
      this.env['?'] = String(lastExit);
      this.executeDepth--;
      if (isTopLevel) this.abortController = null;
      return lastExit;
    }

    // Handle heredocs before anything else
    const heredoc = this.parseHeredoc(trimmed);
    const effectiveLine = heredoc ? heredoc.command : trimmed;
    const heredocStdin = heredoc ? heredoc.body : (injectedStdin ?? '');

    // Strip control characters from history entries (ink UI can leak ANSI/DEL chars)
    // Only record user-typed commands (not programmatic calls from child_process, spawn, etc.)
    if (!skipHistory) {
      const sanitized = trimmed.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      if (sanitized.trim()) {
        this.history.push(sanitized);
        this.scheduleHistorySave(); // Persist to disk (debounced)
      }
    }

    let stderrWriter = writeStderr || writeStdout;
    // The caller's writers; builtins in a pipeline or with redirects write to capture buffers instead
    const outerStdout = writeStdout;
    const outerStderr = stderrWriter;

    // Check for function definition: name() { ... } or function name { ... }
    const funcDef = this.parseFunctionDef(effectiveLine);
    if (funcDef) {
      this.functions[funcDef.name] = this.functionRecord(funcDef.body);
      // A function definition is a command whose status is 0
      this.lastExitCode = 0;
      this.env['?'] = '0';
      this.executeDepth--;
      if (isTopLevel) this.abortController = null;
      return 0;
    }

    // Update LINENO before executing commands
    this.env['LINENO'] = String(this.currentLine);

    // NOTE: Control structures, (( )), and subshells are handled inside the
    // parseCompound loop below. This ensures that semicolons AFTER a control
    // structure closing keyword (fi, done, esac) are properly split.
    // e.g., "if [ $x -eq 1 ]; then break; fi; echo $x" → two compounds.

    // Split into compound commands: &&, ||, ;
    // `a |& b` is `a 2>&1 | b`
    const compounds = this.parseCompound(effectiveLine.includes('|&') ? pipeAmpToRedirect(effectiveLine) : effectiveLine);
    let exitCode = 0;
    let lastRan = -1; // index of the last compound that ran, for errexit
    let suppressing = false;

    for (let ci = 0; ci < compounds.length; ci++) {
      const compound = compounds[ci];
      if (this.pendingSignals.length) await this.processSignals(writeStdout, stderrWriter);
      if (lastRan >= 0) this.checkErrexit(compounds, lastRan, exitCode);
      if (suppressing) { this.errexitSuppressed--; suppressing = false; }
      // Check conditional
      if (compound.operator === '&&' && exitCode !== 0) continue;
      if (compound.operator === '||' && exitCode === 0) continue;
      lastRan = ci;
      // set -e is off inside a command followed by && / || or negated with !
      const nextOp = compounds[ci + 1]?.operator;
      if (nextOp === '&&' || nextOp === '||' || /^!\s/.test(compound.command.trim())) {
        this.errexitSuppressed++;
        suppressing = true;
      }

      // set -n: a script reads the rest without running it
      if (this.scriptShell && !this.interactiveFlag && this.options.has('noexec')) break;

      // `cmd &` before more commands on the line
      if (endsWithBackgroundAmp(compound.command) && compounds.length > 1) {
        const bgCmd = compound.command.slice(0, -1).trim();
        if (!(await this.launchKernelBackground(bgCmd, writeStdout, terminalOverride || this.terminal))) {
          this.executeBackground(bgCmd, writeStdout, stderrWriter);
        }
        exitCode = 0;
        this.lastExitCode = 0;
        this.env['?'] = '0';
        continue;
      }

      // Check for function definition in this compound
      const compFuncDef = this.parseFunctionDef(compound.command.trim());
      if (compFuncDef) {
        this.functions[compFuncDef.name] = this.functionRecord(compFuncDef.body);
        exitCode = 0;
        this.lastExitCode = 0;
        this.env['?'] = '0';
        continue;
      }

      // trap … DEBUG: before each command (in functions only with set -T)
      if (this.traps.has('DEBUG') && !this.inTrapDebug && (this.localVarStack.length === 0 || this.options.has('functrace'))) {
        await this.runDebugTrap(writeStdout, stderrWriter);
      }

      const trimmedCmd = trimCommand(compound.command);

      // Check for (( expr )) arithmetic command in compound
      if (trimmedCmd.startsWith('((') && trimmedCmd.endsWith('))')) {
        const expr = trimmedCmd.slice(2, -2).trim();
        exitCode = this.arithStatus([expr], stderrWriter);
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
        await this.errTrap(exitCode, writeStdout, stderrWriter);
        continue;
      }

      // A loop, if, or subshell piped onward (`for …; done | tail -1`): run the head,
      // then the rest of the pipeline on its output
      if (this.isControlStructure(trimmedCmd) || trimmedCmd.startsWith('(')) {
        const parts = splitTopLevelPipes(trimmedCmd);
        if (parts.length > 1) {
          exitCode = await this.runHeadedPipeline(parts, heredocStdin, writeStdout, stderrWriter, terminalOverride);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          continue;
        }
      }

      // A subshell or (( … )) followed by redirections: (cmds) > file
      if (/^\(/.test(trimmedCmd) && !trimmedCmd.endsWith(')') && splitCompoundRedirects(trimmedCmd).redirects.length) {
        exitCode = await this.execControlStructure(trimmedCmd, writeStdout, stderrWriter);
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
        continue;
      }

      // Check if compound is a subshell: (commands)
      if (trimmedCmd.startsWith('(') && trimmedCmd.endsWith(')')) {
        const inner = trimmedCmd.slice(1, -1).trim();
        if (inner) {
          // Output streams through; the child's variables, cd and exit stay inside it
          const child = this.fork();
          child.injectedStdin = heredocStdin || null;
          if (heredocStdin) child.kernelStdinLive = false;
          exitCode = await child.runSubshell(inner, writeStdout, stderrWriter, terminalOverride || this.terminal);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          this.arrays.set('PIPESTATUS', [String(exitCode)]);
          await this.errTrap(exitCode, writeStdout, stderrWriter);
          continue;
        }
      }

      // Check if compound is a control structure BEFORE variable expansion
      // (control structures handle their own expansion internally to support loop variables)
      if (this.isControlStructure(trimmedCmd)) {
        exitCode = await this.execControlStructure(trimmedCmd, writeStdout, stderrWriter);
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
        continue;
      }

      // time [-p] PIPELINE: times the whole pipeline (( … ), { …; }, a | b) and
      // reports on stderr after it (a bare `time` is the builtin below)
      const timed = /^time(\s+-p)?\s+(?=\S)/.exec(trimmedCmd);
      if (timed && !this.disabledBuiltins.has('time')) {
        const start = performance.now();
        exitCode = await this.execute(trimmedCmd.slice(timed[0].length), writeStdout, stderrWriter, false, terminalOverride, true);
        const elapsed = (performance.now() - start) / 1000;
        stderrWriter(timed[1]
          ? `real ${elapsed.toFixed(2)}\r\nuser 0.00\r\nsys 0.00\r\n`
          : `\r\nreal\t${Math.floor(elapsed / 60)}m${(elapsed % 60).toFixed(3)}s\r\nuser\t0m0.000s\r\nsys\t0m0.000s\r\n`);
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
        continue;
      }

      // ! PIPELINE: run it and negate its status (! ( … ), ! { …; }, ! a | b)
      if (/^!\s+\S/.test(trimmedCmd) && !/^!\s+\[\[/.test(trimmedCmd)) {
        exitCode = await this.execute(trimmedCmd.replace(/^!\s+/, ''), writeStdout, stderrWriter, false, terminalOverride, true);
        exitCode = exitCode === 0 ? 1 : 0;
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
        continue;
      }

      // [[ … ]] (and ! [[ … ]]): parsed from the raw text
      {
        const neg = /^!\s+\[\[/.test(trimmedCmd);
        const dbText = neg ? trimmedCmd.replace(/^!\s+/, '') : trimmedCmd;
        if (dbText.startsWith('[[') && doubleBracketEnd(dbText, 0) === dbText.length) {
          exitCode = await this.evalDoubleBracket(dbText.slice(2, -2), stderrWriter);
          if (neg) exitCode = exitCode === 0 ? 1 : 0;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          continue;
        }
      }

      // a=(…), a+=(…), a[i]=v, local/declare with array literals: expanded per word here
      const arrayStatus = await this.tryArrayAssignment(trimmedCmd, writeStdout, stderrWriter);
      if (arrayStatus !== null) {
        exitCode = arrayStatus;
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
        continue;
      }

      // Control structures after a pipe (`echo y | while read l; do …; done`) expand
      // their own words as they run (loop variables), so only the other segments
      // are expanded up front
      let pipeline: string[];
      this.substStatus = null;
      const rawSegments = splitTopLevelPipes(compound.command);
      // (A `( … )` subshell segment too: its words expand inside the subshell)
      const keepRaw = (seg: string) => this.isControlStructure(seg) || /^\s*\((?!\()[\s\S]*\)\s*$/.test(seg);
      if (rawSegments.length > 1 && rawSegments.some(keepRaw)) {
        pipeline = [];
        for (const seg of rawSegments) {
          pipeline.push(keepRaw(seg) ? seg.trim() : await this.expandWords(seg, stderrWriter));
        }
      } else {
        // Only `a=1 b=$a cmd` (two or more leading assignments, one expanding) needs the ordered pass;
        // checking that first keeps a tokenizer pass and an await off every other command
        const ordered = rawSegments.length === 1 && ORDERED_PREFIX_RE.test(compound.command) && /[$`]/.test(compound.command)
          ? await this.expandPrefixAssignments(compound.command, stderrWriter) : null;
        pipeline = this.parsePipeline(ordered ?? await this.expandWords(quoteAssignmentValues(compound.command), stderrWriter));
      }

      // Check for ! negation prefix
      let negateExit = false;
      if (pipeline.length > 0 && pipeline[0].trim().startsWith('! ')) {
        negateExit = true;
        pipeline[0] = pipeline[0].trim().slice(2);
      } else if (pipeline.length > 0 && pipeline[0].trim() === '!') {
        // Bare ! with pipeline after
        negateExit = true;
        pipeline.shift();
      }

      let lastOutput = '';
      exitCode = 0;
      const pipeExitCodes: number[] = [];
      // Env from `NAME=value cmd` prefixes, restored once the pipeline finishes
      const prefixEnvSaved = new Map<string, string | undefined>();
      // ...and which of them were unexported (the prefix exports them to the command)
      const prefixWasLocal = new Set<string>();
      // As sh, assignments before a special builtin stay (POSIX 2.14)
      let prefixPersists = false;
      // Output of a builtin/function/loop that must be piped on or redirected
      let capture: { out: string; err: string; redirects: Redirect[]; isLast: boolean } | null = null;
      const flushCapture = async () => {
        if (!capture) return;
        const c = capture;
        capture = null;
        writeStdout = outerStdout;
        stderrWriter = outerStderr;
        lastOutput = await this.applyOutputRedirects(
          c.out.replace(/\r\n/g, '\n'), c.err.replace(/\r\n/g, '\n'), c.redirects, c.isLast, writeStdout, stderrWriter);
      };
      const startCapture = (redirects: Redirect[], isLast: boolean) => {
        const c = { out: '', err: '', redirects, isLast };
        capture = c;
        writeStdout = (t: string) => { c.out += t; };
        stderrWriter = (t: string) => { c.err += t; };
      };

      // Segments started so far: one that ended early (a builtin's `continue`) left its status in exitCode
      let segCount = 0;
      for (let i = 0; i < pipeline.length; i++) {
        while (pipeExitCodes.length < i) pipeExitCodes.push(exitCode);
        segCount = i + 1;
        // A builtin that captured its output `continue`d here: pipe/redirect it now
        await flushCapture();

        // Check for SIGINT (abort)
        if (this.abortController?.signal.aborted) {
          exitCode = 130; // 128 + SIGINT(2)
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          break;
        }

        let segment = pipeline[i];

        // `NAME=value cmd args`: export NAME to cmd only, like POSIX shells do
        const envPrefix = splitEnvPrefix(segment);
        if (envPrefix) {
          for (const [key, value, append] of envPrefix.assignments) {
            if (!prefixEnvSaved.has(key)) {
              prefixEnvSaved.set(key, Object.prototype.hasOwnProperty.call(this.env, key) ? this.env[key] : undefined);
              if (this.localVars.delete(key)) prefixWasLocal.add(key);
            }
            this.env[key] = append ? (this.getVar(key) ?? '') + value : value;
          }
          segment = envPrefix.rest;
          // (not unset or eval: `x=tmp unset x` removes the temporary x and the old one is back, as in bash)
          const sb = segment.trim().split(/\s+/)[0];
          if (POSIX_SPECIAL_BUILTINS.has(sb) && sb !== 'unset' && sb !== 'eval' && (this.invokedAsSh || this.options.has('posix'))) prefixPersists = true;
        }

        // A subshell after a pipe: `echo abc | (cat)`
        const trimmedSeg = segment.trim();
        if (i > 0 && trimmedSeg.startsWith('(') && trimmedSeg.endsWith(')') && !trimmedSeg.startsWith('((')) {
          const pipeStdin = lastOutput;
          lastOutput = '';
          startCapture([], i === pipeline.length - 1);
          const sub = this.fork();
          exitCode = await sub.executeWithStdin(trimmedSeg.slice(1, -1).trim(), pipeStdin, writeStdout, stderrWriter);
          exitCode = await sub.finishSubshell(exitCode, writeStdout, stderrWriter);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          continue;
        }

        // Check if this pipeline segment is a control structure (e.g. `echo foo | while ...`)
        if (this.isControlStructure(segment.trim())) {
          const pipeStdin = i > 0 ? lastOutput : '';
          lastOutput = '';
          if (i < pipeline.length - 1) startCapture([], false);
          // An element of a pipeline runs in a subshell: exit, cd and variables stay there
          // (shopt -s lastpipe: the last one runs in this shell)
          if (pipeline.length > 1 && !(i === pipeline.length - 1 && this.shoptopts.has('lastpipe'))) {
            exitCode = await this.inSubshell((sub) => sub.execControlStructurePiped(segment.trim(), pipeStdin, writeStdout, stderrWriter));
          } else {
            exitCode = await this.execControlStructurePiped(segment.trim(), pipeStdin, writeStdout, stderrWriter);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          continue;
        }

        const { args, redirects, hereString } = this.parseSegment(segment);

        if (args.length === 0) {
          // Only redirections (`> file`, `>> log`, `< in`): files are opened (created,
          // truncated) and closed; a missing input file fails
          if (redirects.length) {
            exitCode = 0;
            for (const r of redirects) {
              if (r.type === '<' && fdOfRef(r.target) === null && !this.heredocs.lookup(r.target)) {
                const st = await this.fs.stat(this.fs.resolvePath(r.target, this.cwd)).catch(() => null);
                if (!st) { stderrWriter(`tabcomputer: ${r.target}: No such file or directory\r\n`); exitCode = 1; }
              }
            }
            if (exitCode === 0) await this.applyOutputRedirects('', '', redirects, false, writeStdout, stderrWriter);
            if (this.redirectFailed) { exitCode = 1; this.redirectFailed = false; }
            // `x=$(cmd) >file`: assignments with no command stay set; the status is the last $(…)'s
            if (envPrefix) {
              prefixPersists = true;
              if (exitCode === 0) exitCode = this.substStatus ?? 0;
              // ...as plain assignments: a new or unexported variable stays unexported
              for (const [k, v] of prefixEnvSaved) if (v === undefined || prefixWasLocal.has(k)) this.localVars.add(k);
            }
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
          }
          continue;
        }

        // Builtins and functions write straight to the writers; when this segment
        // feeds a pipe or has output redirects, collect that output instead
        const isLastSegment = i === pipeline.length - 1;
        if (!isLastSegment || redirects.some(r => r.type !== '<')) startCapture(redirects, isLastSegment);
        // Stdin for builtins that run commands in a nested execute (eval, sh -c, aliases, functions)
        const nestedStdin = i > 0 ? lastOutput : (hereString ?? heredocStdin);

        // Expand glob patterns in args (but not quoted ones marked with \x01)
        const globResult = await this.expandGlobs(args, stderrWriter, true);
        if (globResult === null) {
          // failglob: unmatched glob pattern — abort this command
          exitCode = 1;
          this.lastExitCode = 1;
          this.env['?'] = '1';
          lastOutput = '';
          continue;
        }
        let expandedArgs = globResult;

        // Expand process substitution: <(cmd) and >(cmd)
        expandedArgs = await this.expandProcessSubstitution(expandedArgs, stderrWriter);

        const cmdName = expandedArgs[0];
        const cmdArgs = expandedArgs.slice(1);
        // A builtin that changes the shell's state (cd, eval, export, exit …) runs in a
        // subshell when it is part of a pipeline, as in bash (lastpipe: not the last one).
        // read and mapfile stay in this shell (`… | read v` sets v, as in zsh).
        if (pipeline.length > 1 && !(isLastSegment && this.shoptopts.has('lastpipe'))
          && (PIPELINE_SUBSHELL_BUILTINS.has(cmdName) || /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(cmdName ?? ''))) {
          exitCode = await this.inSubshell((sub) => sub.executeWithStdin(quoteArgsForShell(expandedArgs), nestedStdin, writeStdout, stderrWriter));
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        // $_: the last word of the previous simple command (not of an assignment)
        if (!/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(cmdName ?? '')) this.env['_'] = expandedArgs[expandedArgs.length - 1] ?? '';

        // Handle [[ ... ]] as inline test command
        if (cmdName === '[[') {
          const closingIdx = cmdArgs.indexOf(']]');
          const testArgs = closingIdx >= 0 ? cmdArgs.slice(0, closingIdx) : cmdArgs;
          exitCode = await this.evalTest(testArgs.join(' '));
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Handle /bin/sh, /bin/bash, /bin/zsh — dispatch to shell
        if (/^\/bin\/(sh|bash|zsh)$/.test(cmdName)) {
          // Options parse as the sh builtin's do: `/bin/sh -c -l CMD` (Claude
          // Code's Bash tool) took -l for the command
          const parsedSh = parseShellArgs(cmdArgs);
          if (parsedSh.command && parsedSh.rest.length) {
            // `sh -c CMD [NAME ARGS...]`: only CMD is the command string
            const shellCmd = parsedSh.rest[0];
            const child = this.fork();
            child.startProcess();
            const rest = parsedSh.rest.slice(1);
            child.setPositional(rest.slice(1), rest[0] ?? cmdName);
            for (const o of parsedSh.on) child.options.add(o);
            for (const o of parsedSh.off) child.options.delete(o);
            child.commandStringFlag = true;
            child.injectedStdin = nestedStdin;
            if (!this.liveStdin(i, heredocStdin, hereString, redirects)) child.kernelStdinLive = false;
            exitCode = await child.runScriptText(shellCmd, terminalOverride || this.terminal, writeStdout, stderrWriter);
          } else {
            // /bin/sh script.sh or /bin/sh (no args)
            const scripts = cmdArgs.filter(a => !a.startsWith('-'));
            if (scripts.length > 0) {
              const scriptPath = this.fs.resolvePath(scripts[0], this.cwd);
              try {
                const content = await this.fs.readFile(scriptPath, 'utf8') as string;
                const shCtx: CommandContext = { args: scripts.slice(1), fs: this.fs, cwd: this.cwd, env: this.env, stdin: nestedStdin, stdout: '', stderr: '', shell: this, terminal: terminalOverride || this.terminal,
                  liveStdin: this.liveStdin(i, heredocStdin, hereString, redirects) };
                exitCode = await this.executeShellScript(content, scripts.slice(1), shCtx, writeStdout, stderrWriter, scripts[0]);
              } catch (e: any) {
                stderrWriter(`tabcomputer: ${scripts[0]}: ${e.message}\r\n`);
                exitCode = 1;
              }
            } else {
              exitCode = 0; // bare /bin/sh with flags only → no-op
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Handle /usr/bin/env CMD ARGS → execute CMD ARGS
        if (cmdName === '/usr/bin/env' || cmdName === '/bin/env') {
          if (cmdArgs.length > 0) {
            const envCmd = quoteArgsForShell(cmdArgs);
            this.injectedStdin = nestedStdin;
            exitCode = await this.execute(envCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          } else {
            // bare env → print environment
            this.injectedStdin = nestedStdin;
            exitCode = await this.execute('env', writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Alias expansion: if cmdName matches an alias, replace it
        // (only an unquoted command word: 'hi' and \hi are not aliases)
        if (this.aliases.has(cmdName) && !this.expandingAliases.has(cmdName)
          && segment.replace(/^\s*(?:\d*(?:>>?|<|&>>?|>\|)\s*[^\s'"]+\s+)*/, '').startsWith(cmdName)) {
          let aliasValue = this.aliases.get(cmdName)!;
          // An alias ending in a blank makes the next word an alias position too (alias sudo='sudo ')
          let rest = cmdArgs;
          const seen = new Set([cmdName]);
          while (/\s$/.test(aliasValue) && rest.length && this.aliases.has(rest[0]) && !seen.has(rest[0])) {
            seen.add(rest[0]);
            aliasValue += this.aliases.get(rest[0])!;
            rest = rest.slice(1);
          }
          const fullCmd = aliasValue + (rest.length > 0 ? (/\s$/.test(aliasValue) ? '' : ' ') + quoteArgsForShell(rest) : '');
          this.injectedStdin = nestedStdin;
          // An alias is not expanded again inside its own expansion (alias ls='ls -F')
          this.expandingAliases.add(cmdName);
          try {
            exitCode = await this.execute(fullCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          } finally {
            this.expandingAliases.delete(cmdName);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Handle . as alias for source
        const effectiveCmdName = cmdName === '.' ? 'source' : cmdName;

        // xtrace: echo command to stderr before executing
        if (this.options.has('xtrace')) {
          stderrWriter(`+ ${[effectiveCmdName, ...cmdArgs].join(' ')}\r\n`);
        }

        // Handle array assignment: arr=(a b c) or arr[N]=val
        if (effectiveCmdName.includes('=') && !effectiveCmdName.startsWith('=')) {
          const eqIdx = cmdName.indexOf('=');
          const key = cmdName.substring(0, eqIdx);
          const val = cmdName.substring(eqIdx + 1);

          // Array append: name+=(elem1 elem2)
          if (key.endsWith('+') && val.startsWith('(') && (val.endsWith(')') || cmdArgs.length > 0)) {
            const arrName = key.slice(0, -1);
            let elements: string;
            if (val.endsWith(')')) {
              elements = val.slice(1, -1);
            } else {
              const fullVal = [val, ...cmdArgs].join(' ');
              const closeIdx = fullVal.indexOf(')');
              elements = closeIdx >= 0 ? fullVal.slice(1, closeIdx) : fullVal.slice(1);
            }
            const newElems = elements.trim() ? this.tokenize(elements) : [];
            const existing = this.arrays.get(arrName) || [];
            existing.push(...newElems.map(a => unmark(a)));
            this.arrays.set(arrName, existing);
            continue;
          }

          // Array assignment: name=(elem1 elem2 elem3)
          if (val.startsWith('(') && (val.endsWith(')') || cmdArgs.length > 0)) {
            let elements: string;
            if (val.endsWith(')')) {
              elements = val.slice(1, -1);
            } else {
              // Multi-token: name=(a b c) got split, reconstruct
              const fullVal = [val, ...cmdArgs].join(' ');
              const closeIdx = fullVal.indexOf(')');
              elements = closeIdx >= 0 ? fullVal.slice(1, closeIdx) : fullVal.slice(1);
            }
            const arr = elements.trim() ? this.tokenize(elements) : [];
            this.arrays.set(key, arr.map(a => unmark(a)));
            continue;
          }

          // Indexed or associative array element assignment: arr[key]=val
          const bracketMatch = key.match(/^(\w+)\[(.+)\]$/);
          if (bracketMatch) {
            const arrName = bracketMatch[1];
            const idxKey = bracketMatch[2];
            // Associative array?
            if (this.assocArrays.has(arrName)) {
              this.assocArrays.get(arrName)!.set(idxKey, val);
              continue;
            }
            // Indexed array (numeric index)
            const numIdx = parseInt(idxKey, 10);
            if (!isNaN(numIdx)) {
              const arr = this.arrays.get(arrName) || [];
              while (arr.length <= numIdx) arr.push('');
              arr[numIdx] = val;
              this.arrays.set(arrName, arr);
            }
            continue;
          }

          // Regular variable assignment: FOO=bar, FOO+=bar (element 0 of an array)
          if (key.endsWith('+') && /^[A-Za-z_][A-Za-z0-9_]*\+$/.test(key)) {
            const name = key.slice(0, -1);
            const err = this.appendVar(name, val);
            if (err) stderrWriter(`tabcomputer: ${err}\r\n`);
            exitCode = err ? 1 : this.substStatus ?? 0;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          if (this.readonlyVars.has(key)) {
            stderrWriter(`${key}: readonly variable\r\n`);
            exitCode = 1;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            this.readonlyAssignFailed();
            continue;
          }
          const setErr = this.setVar(key, val);
          if (setErr) stderrWriter(`tabcomputer: ${setErr}\r\n`);
          // An assignment-only command's status is that of its last $(...)
          exitCode = setErr ? 1 : this.substStatus ?? 0;
          // `a=1 b=2` assigns both
          for (const extra of cmdArgs) {
            const em = extra.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
            if (!em) break;
            if (this.readonlyVars.has(em[1])) { stderrWriter(`${em[1]}: readonly variable\r\n`); exitCode = 1; this.readonlyAssignFailed(); continue; }
            const e2 = this.setVar(em[1], em[2]);
            if (e2) { stderrWriter(`tabcomputer: ${e2}\r\n`); exitCode = 1; }
          }
          // Persist API keys to localStorage
          const persistKeys: Record<string, string> = {
            ANTHROPIC_API_KEY: 'tabcomputer_anthropic_key',
            OPENAI_API_KEY: 'tabcomputer_openai_key',
            GOOGLE_API_KEY: 'tabcomputer_google_key',
          };
          if (persistKeys[key] && typeof localStorage !== 'undefined') {
            localStorage.setItem(persistKeys[key], val);
          }
          continue;
        }

        // Check if this builtin has been disabled via `enable -n`
        // If disabled, skip the builtin dispatch and fall through to external command lookup
        // A function of the same name runs instead (bash; in POSIX mode not for the special builtins)
        const _builtinDisabled = this.disabledBuiltins.has(effectiveCmdName) ||
          (!!this.functions[effectiveCmdName] && !((this.invokedAsSh || this.options.has('posix')) && POSIX_SPECIAL_BUILTINS.has(effectiveCmdName)));

        // Shell builtin: time — measure command execution time
        if (!_builtinDisabled && effectiveCmdName === 'time') {
          // Args are already parsed and expanded; quote them so re-running doesn't re-split `;` or quotes
          const timeCmd = quoteArgsForShell(cmdArgs);
          const start = performance.now();
          if (timeCmd) {
            this.injectedStdin = nestedStdin;
            exitCode = await this.execute(timeCmd, writeStdout, stderrWriter, false, undefined, true);
          }
          const elapsed = (performance.now() - start) / 1000;
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          stderrWriter(`\nreal\t${mins}m${secs.toFixed(3)}s\r\n`);
          stderrWriter(`user\t0m0.000s\r\n`);
          stderrWriter(`sys\t0m0.000s\r\n`);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: caller — print call stack info
        if (!_builtinDisabled && effectiveCmdName === 'caller') {
          // caller: "LINE FILE" of the current call; caller N: "LINE FUNC FILE" of frame N
          const fn = this.arrays.get('FUNCNAME') ?? [];
          const src = this.arrays.get('BASH_SOURCE') ?? [];
          const lines = this.arrays.get('BASH_LINENO') ?? [];
          exitCode = 1;
          if (cmdArgs.length === 0) {
            if (fn.length || src.length) { writeStdout(`${lines[0] ?? 0} ${src[1] ?? 'NULL'}\r\n`); exitCode = 0; }
          } else {
            const n = Number(cmdArgs[0]);
            if (!/^\d+$/.test(cmdArgs[0])) stderrWriter(`tabcomputer: caller: ${cmdArgs[0]}: invalid number\r\n`);
            else if (n + 1 < fn.length) { writeStdout(`${lines[n] ?? 0} ${fn[n + 1]} ${src[n + 1] ?? 'NULL'}\r\n`); exitCode = 0; }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtins: eval, setopt, shopt
        if (!_builtinDisabled && effectiveCmdName === 'eval') {
          // Execute remaining args as a shell command
          exitCode = 0;
          const evalCmd = stripComments((cmdArgs[0] === '--' ? cmdArgs.slice(1) : cmdArgs).join(' '));
          if (evalCmd && !this.compoundsBalanced(evalCmd)) {
            // `eval "if"`: a syntax error; as sh it ends the script (eval is a special builtin)
            stderrWriter('tabcomputer: eval: syntax error: unexpected end of file\r\n');
            exitCode = 2;
            if (this.posixFatal()) throw new ExitSignal(2);
          } else if (evalCmd) {
            this.injectedStdin = nestedStdin;
            exitCode = await this.execute(evalCmd, writeStdout, stderrWriter, false, undefined, true);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'setopt') {
          // zsh shell options — no-op in Shiro
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'shopt') {
          exitCode = this.shoptBuiltin(cmdArgs, writeStdout, stderrWriter);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        // declare/typeset/local/readonly/export NAME+=value appends to the current value
        if (!_builtinDisabled && ['readonly', 'export'].includes(effectiveCmdName)) {
          for (const [k, a] of cmdArgs.entries()) {
            const m = /^([A-Za-z_][A-Za-z0-9_]*)\+=([\s\S]*)$/.exec(a);
            if (m) cmdArgs[k] = `${m[1]}=${this.getVar(m[1]) ?? ''}${m[2]}`;
          }
        }
        if (!_builtinDisabled && (effectiveCmdName === 'declare' || effectiveCmdName === 'typeset' || effectiveCmdName === 'local')) {
          exitCode = this.declareBuiltin(effectiveCmdName, cmdArgs, writeStdout, stderrWriter);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: read
        if (!_builtinDisabled && effectiveCmdName === 'read') {
          // Options (getopts style: -rd '' / -n4 / -u 3)
          let rawMode = false;
          let arrayName: string | null = null;
          let readDelim = '\n';
          let readNchars = -1;
          let readExact = false;
          let readTimeout = -1;
          let readFd = -1;
          const readVars: string[] = [];
          let badOpt: string | null = null;
          for (let ri = 0; ri < cmdArgs.length; ri++) {
            const a = cmdArgs[ri];
            if (readVars.length || !a.startsWith('-') || a === '-') { readVars.push(a); continue; }
            if (a === '--') { readVars.push(...cmdArgs.slice(ri + 1)); break; }
            for (let k = 1; k < a.length; k++) {
              const o = a[k];
              if (o === 'r') { rawMode = true; continue; }
              if (o === 's' || o === 'e') continue;
              if (!'adinNptu'.includes(o)) { badOpt = `-${o}: invalid option`; break; }
              let v = a.slice(k + 1);
              if (!v) { if (ri + 1 >= cmdArgs.length) { badOpt = `-${o}: option requires an argument`; break; } v = cmdArgs[++ri]; }
              if (o === 'a') arrayName = v;
              else if (o === 'd') readDelim = v;
              else if (o === 'n' || o === 'N') { readNchars = parseInt(v, 10); readExact = o === 'N'; if (isNaN(readNchars) || readNchars < 0) badOpt = `${v}: invalid number`; }
              else if (o === 't') readTimeout = parseFloat(v) || 0;
              else if (o === 'u') readFd = parseInt(v, 10);
              break;
            }
            if (badOpt) break;
          }
          if (badOpt) {
            stderrWriter(`tabcomputer: read: ${badOpt}\r\n`);
            exitCode = 2;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          // Read one line from stdin — prefer FD, then the command's own <<< / <,
          // then piped stdin (__PIPE_STDIN), then pipe, then heredoc
          let readInput = '';
          let liveRead = false;
          let stdinRedirect = redirects.find(r => r.type === '<' && r.fd === undefined);
          if (stdinRedirect && fdOfRef(stdinRedirect.target) !== null) {
            // read <&N reads one line from fd N, like read -u N
            readFd = fdOfRef(stdinRedirect.target)!;
            stdinRedirect = undefined;
          }
          let redirectInput: string | undefined = hereString;
          if (redirectInput === undefined && stdinRedirect) {
            try {
              redirectInput = stdinRedirect.target === '/dev/null' ? ''
                : await this.readInputRedirect(stdinRedirect.target);
            } catch (e: any) {
              stderrWriter(`tabcomputer: ${stdinRedirect.target}: ${e.message}\r\n`);
              exitCode = 1;
              this.lastExitCode = 1;
              this.env['?'] = '1';
              lastOutput = '';
              continue;
            }
          }
          // An explicit redirect doesn't consume the enclosing loop's piped stdin
          // (nor does `cmd | read`: the pipe from the stage before is its stdin)
          const hasPipeStdin = redirectInput === undefined && i === 0 && '__PIPE_STDIN' in this.env;
          // read -u N with N opened on this command (read -u 3 3<file)
          const fdOpen = readFd >= 0 ? redirects.find(r => r.type === 'open' && r.mode === '<' && r.fd === readFd) : undefined;
          if (fdOpen) {
            try {
              readInput = await this.readInputRedirect(fdOpen.target);
            } catch (e: any) {
              stderrWriter(`tabcomputer: ${fdOpen.target}: ${e.message}\r\n`);
            }
          } else if (readFd >= 0 && this.fileDescriptors.has(readFd)) {
            // Read from file descriptor
            const fd = this.fileDescriptors.get(readFd)!;
            readInput = fd.content.slice(fd.offset);
          } else if (redirectInput !== undefined) {
            readInput = redirectInput;
          } else if (hasPipeStdin) {
            readInput = this.env['__PIPE_STDIN'];
          } else if (readFd < 0 && this.liveStdin(i, heredocStdin, hereString, redirects)) {
            // One record from fd 0, leaving the rest for whatever reads it next
            liveRead = true;
            if (readTimeout !== 0) readInput = await this.kernelStdio!.readRecord(readDelim, readNchars, rawMode, readExact);
          } else {
            readInput = i > 0 ? lastOutput : (heredocStdin || '');
          }
          // Input from a file, pipe or here-doc (not the terminal): -t never times out
          const hasSource = !!fdOpen || readFd >= 0 || redirectInput !== undefined || hasPipeStdin || i > 0 || !!heredocStdin || liveRead;
          // Handle -t 0: check if input is available (non-blocking)
          if (readTimeout === 0) {
            exitCode = hasSource ? 0 : 1;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          // Handle -t N: timeout (for non-piped/non-interactive, just check availability)
          if (readTimeout > 0 && !hasSource) {
            // No input available and timeout specified → exit 142 (128 + SIGALRM(14))
            exitCode = 142;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          const rec = readRecord(readInput, { raw: rawMode, delim: readDelim, nchars: readNchars, exact: readExact });
          const remaining = readInput.slice(rec.consumed);
          // Consume the record from the source so the next read gets what follows
          if (readFd >= 0 && this.fileDescriptors.has(readFd)) {
            const fd = this.fileDescriptors.get(readFd)!;
            fd.offset = fd.content.length - remaining.length;
          } else if (hasPipeStdin) {
            this.env['__PIPE_STDIN'] = remaining;
          }
          const ifs = this.env['IFS'] ?? ' \t\n';
          let readErr: string | null = null;
          if (arrayName !== null) {
            if (this.readonlyVars.has(arrayName)) readErr = `${arrayName}: readonly variable`;
            else {
              this.arrays.set(arrayName, readExact ? [recordText(rec)] : splitRecord(rec.chars, ifs, Infinity));
              this.assocArrays.delete(arrayName);
              delete this.env[arrayName];
            }
          } else if (readVars.length === 0) {
            readErr = this.setVar('REPLY', recordText(rec));
          } else {
            const fields = readExact ? [recordText(rec)] : splitRecord(rec.chars, ifs, readVars.length);
            for (let vi = 0; vi < readVars.length && !readErr; vi++) {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(readVars[vi])) { readErr = `\`${readVars[vi]}': not a valid identifier`; break; }
              readErr = this.setVar(readVars[vi], fields[vi] ?? '');
            }
          }
          if (readErr) stderrWriter(`tabcomputer: read: ${readErr}\r\n`);
          exitCode = readErr ? (readErr.includes('identifier') ? 2 : 1) : rec.complete ? 0 : 1;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: mapfile / readarray [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback [-c quantum]] [array]
        if (!_builtinDisabled && (effectiveCmdName === 'mapfile' || effectiveCmdName === 'readarray')) {
          let mapDelim = '\n';
          let mapSkip = 0;
          let mapCount = 0;
          let mapOrigin: number | null = null;
          let mapStrip = false;
          let mapFd = -1;
          let mapCallback = '';
          let mapQuantum = 5000;
          let arrName = 'MAPFILE';
          let bad: string | null = null;
          const optArgs = 'dnOsuCc';
          for (let mi = 0; mi < cmdArgs.length && !bad; mi++) {
            const a = cmdArgs[mi];
            if (a === '--') { if (mi + 1 < cmdArgs.length) arrName = cmdArgs[mi + 1]; break; }
            if (!a.startsWith('-') || a === '-') { arrName = a; continue; }
            for (let k = 1; k < a.length; k++) {
              const o = a[k];
              if (o === 't') { mapStrip = true; continue; }
              if (!optArgs.includes(o)) { bad = `-${o}: invalid option`; break; }
              let v = a.slice(k + 1);
              if (!v) { if (mi + 1 >= cmdArgs.length) { bad = `-${o}: option requires an argument`; break; } v = cmdArgs[++mi]; }
              const num = Number(v);
              const needNum = o !== 'd' && o !== 'C';
              if (needNum && (!/^\d+$/.test(v) || (o === 'c' && num === 0))) { bad = `${v}: invalid ${o === 'O' ? 'array origin' : o === 'u' ? 'file descriptor specification' : o === 'c' ? 'callback quantum' : 'line count'}`; break; }
              if (o === 'd') mapDelim = v === '' ? '\0' : v[0];
              else if (o === 'n') mapCount = num;
              else if (o === 'O') mapOrigin = num;
              else if (o === 's') mapSkip = num;
              else if (o === 'u') mapFd = num;
              else if (o === 'C') mapCallback = v;
              else if (o === 'c') mapQuantum = num;
              break;
            }
          }
          if (!bad && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(arrName)) bad = `\`${arrName}': not a valid identifier`;
          if (!bad && this.readonlyVars.has(this.refTarget(arrName))) bad = `${arrName}: readonly variable`;
          if (bad) {
            stderrWriter(`tabcomputer: ${effectiveCmdName}: ${bad}\r\n`);
            exitCode = /invalid option|requires an argument/.test(bad) ? 2 : 1;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          // Input as read gets it: -u FD, < FILE or here-doc, <<< word, the pipe, fd 0
          let mapInput = '';
          const inRedirect = redirects.find(r => r.type === '<' && r.fd === undefined);
          if (mapFd >= 0 || (inRedirect && fdOfRef(inRedirect.target) !== null)) {
            const fd = mapFd >= 0 ? mapFd : fdOfRef(inRedirect!.target)!;
            const fdOpen = redirects.find(r => r.type === 'open' && r.mode === '<' && r.fd === fd);
            if (fdOpen) mapInput = await this.readInputRedirect(fdOpen.target).catch(() => '');
            else if (this.fileDescriptors.has(fd)) {
              const f = this.fileDescriptors.get(fd)!;
              mapInput = f.content.slice(f.offset);
              f.offset = f.content.length;
            } else if (fd === 0 && this.liveStdin(i, heredocStdin, hereString, redirects)) mapInput = await this.kernelStdio!.readAll();
          } else if (hereString !== undefined) {
            mapInput = hereString;
          } else if (inRedirect) {
            try {
              mapInput = inRedirect.target === '/dev/null' ? '' : await this.readInputRedirect(inRedirect.target);
            } catch (e: any) {
              stderrWriter(`tabcomputer: ${inRedirect.target}: ${e.message}\r\n`);
              exitCode = 1;
              this.lastExitCode = 1;
              this.env['?'] = '1';
              lastOutput = '';
              continue;
            }
          } else if (i === 0 && '__PIPE_STDIN' in this.env) {
            mapInput = this.env['__PIPE_STDIN'];
            this.env['__PIPE_STDIN'] = '';
          } else if (this.liveStdin(i, heredocStdin, hereString, redirects)) {
            mapInput = await this.kernelStdio!.readAll();
          } else {
            mapInput = i > 0 ? lastOutput : (heredocStdin || '');
          }
          // Records end with the delimiter, which stays unless -t
          const records: string[] = [];
          for (let at = 0; at < mapInput.length;) {
            const end = mapInput.indexOf(mapDelim, at);
            const stop = end < 0 ? mapInput.length : end + 1;
            records.push(mapInput.slice(at, stop));
            at = stop;
          }
          let take = records.slice(mapSkip);
          if (mapCount > 0) take = take.slice(0, mapCount);
          // (a NUL can't be in a shell string: it goes even without -t)
          if (mapStrip || mapDelim === '\0') take = take.map((r) => (r.endsWith(mapDelim) ? r.slice(0, -1) : r));
          const target = this.refTarget(arrName);
          // Without -O the array starts empty; -O N stores from index N on
          const arr: string[] = mapOrigin === null ? [] : this.arrays.get(target) ?? (this.env[target] !== undefined ? [this.env[target]] : []);
          const origin = mapOrigin ?? 0;
          this.assocArrays.delete(target);
          delete this.env[target];
          this.arrays.set(target, arr);
          for (let li = 0; li < take.length; li++) {
            if (mapCallback && (li + 1) % mapQuantum === 0) {
              // (every QUANTUM lines, before storing: the index it goes to and the line)
              await this.execute(`${mapCallback} ${origin + li} ${quoteReusable(take[li])}`, writeStdout, stderrWriter, false, undefined, true);
            }
            arr[origin + li] = take[li];
          }
          exitCode = 0;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtins: break and continue (throw sentinels caught by loop handlers)
        // Outside a loop (also in a subshell inside one) break and continue do nothing
        if (effectiveCmdName === 'break' || effectiveCmdName === 'continue') {
          if (this.loopDepth > 0) {
            const levels = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) || 1 : 1;
            throw effectiveCmdName === 'break' ? new BreakSignal(levels) : new ContinueSignal(levels);
          }
          stderrWriter(`tabcomputer: ${effectiveCmdName}: only meaningful in a \`for', \`while', or \`until' loop\r\n`);
          exitCode = 0;
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }

        // Shell builtin: exit (unwinds to the shell's outermost execute())
        if (effectiveCmdName === 'exit' && !_builtinDisabled) {
          let code = this.lastExitCode;
          if (cmdArgs.length > 0) {
            const n = Number(cmdArgs[0]);
            if (!/^\s*[-+]?\d+\s*$/.test(cmdArgs[0]) || !Number.isFinite(n)) {
              stderrWriter(`exit: ${cmdArgs[0]}: numeric argument required\r\n`);
              code = 2;
            } else {
              code = ((n % 256) + 256) % 256;
            }
          }
          throw new ExitSignal(code);
        }

        // Shell builtin: return (throw sentinel caught by execFunction)
        if (effectiveCmdName === 'return' && !this.canReturn()) {
          stderrWriter('tabcomputer: return: can only `return\' from a function or sourced script\r\n');
          exitCode = 2;
          this.lastExitCode = 2;
          this.env['?'] = '2';
          lastOutput = '';
          continue;
        }
        if (effectiveCmdName === 'return') {
          // (a status is 0-255: return 257 is 1, return -1 is 255)
          const n = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) || 0 : this.lastExitCode;
          throw new ReturnSignal(((n % 256) + 256) % 256);
        }

        // Shell builtin: trap
        if (!_builtinDisabled && effectiveCmdName === 'trap') {
          exitCode = this.trapBuiltin(cmdArgs, writeStdout, stderrWriter, pipeline.length > 1);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: fc (fix command — list/re-execute history)
        if (!_builtinDisabled && effectiveCmdName === 'fc') {
          let listMode = false;
          let reverseMode = false;
          let reExecMode = false;
          let substitution: { pat: string; rep: string } | null = null;
          const fcPositional: string[] = [];

          for (let ai = 0; ai < cmdArgs.length; ai++) {
            const a = cmdArgs[ai];
            if (a === '-l') { listMode = true; }
            else if (a === '-r') { reverseMode = true; }
            else if (a === '-s') { reExecMode = true; }
            else if (a === '-e' && cmdArgs[ai + 1] === '-') { reExecMode = true; ai++; }
            else if (a === '-lr' || a === '-rl') { listMode = true; reverseMode = true; }
            else if (reExecMode && a.includes('=') && fcPositional.length === 0) {
              const eqIdx = a.indexOf('=');
              substitution = { pat: a.slice(0, eqIdx), rep: a.slice(eqIdx + 1) };
            }
            else if (!a.startsWith('-')) { fcPositional.push(a); }
          }

          const hist = this.history;

          if (listMode) {
            // fc -l [first [last]] — list history entries
            let first = -16, last = -1;
            if (fcPositional.length >= 1) {
              first = this.fcResolveRef(fcPositional[0], hist);
            }
            if (fcPositional.length >= 2) {
              last = this.fcResolveRef(fcPositional[1], hist);
            }
            // Normalize negative indices
            if (first < 0) first = hist.length + first;
            if (last < 0) last = hist.length + last;
            first = Math.max(0, first);
            last = Math.min(hist.length - 1, last);
            if (first > last) { const tmp = first; first = last; last = tmp; reverseMode = !reverseMode; }
            const entries: string[] = [];
            for (let hi = first; hi <= last; hi++) {
              entries.push(`${hi + 1}\t${hist[hi]}`);
            }
            if (reverseMode) entries.reverse();
            writeStdout(entries.join('\r\n') + '\r\n');
          } else if (reExecMode) {
            // fc -s [pat=rep] [cmd] — re-execute (skip the fc command itself in history)
            let targetIdx = hist.length - 2;
            if (fcPositional.length > 0) {
              const ref = fcPositional[fcPositional.length - 1];
              targetIdx = this.fcResolveRef(ref, hist);
              if (targetIdx < 0) targetIdx = hist.length + targetIdx;
            }
            targetIdx = Math.max(0, Math.min(hist.length - 1, targetIdx));
            let cmd = hist[targetIdx] || '';
            if (substitution) {
              cmd = cmd.replace(substitution.pat, substitution.rep);
            }
            writeStdout(cmd + '\r\n');
            exitCode = await this.execute(cmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          } else {
            // Default: fc with no flags — in bash opens editor, here just list last 16
            let first = hist.length - 16, last = hist.length - 1;
            first = Math.max(0, first);
            const entries: string[] = [];
            for (let hi = first; hi <= last; hi++) {
              entries.push(`${hi + 1}\t${hist[hi]}`);
            }
            writeStdout(entries.join('\r\n') + '\r\n');
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtins: type, command -v, hash
        if (!_builtinDisabled && effectiveCmdName === 'type') {
          // type [-afptP] NAME...: alias, keyword, function, builtin, file (in that order)
          let mode: 'long' | 't' | 'p' | 'P' = 'long', all = false, noFuncs = false;
          const names: string[] = [];
          for (const a of cmdArgs) {
            if (!names.length && /^-[afptP]+$/.test(a)) {
              for (const c of a.slice(1)) {
                if (c === 'a') all = true; else if (c === 'f') noFuncs = true;
                else if (c === 't') mode = 't'; else if (c === 'p') mode = 'p'; else if (c === 'P') mode = 'P';
              }
            } else if (a !== '--' || names.length) names.push(a);
          }
          exitCode = 0;
          for (const name of names) {
            let found = await this.commandKinds(name, all || mode === 'P');
            if (noFuncs) found = found.filter((k) => k.kind !== 'function');
            if (mode === 'P') found = found.filter((k) => k.kind === 'file');
            if (mode === 'p' && found.length && found[0].kind !== 'file') { continue; }
            if (!found.length) {
              if (mode === 'long') stderrWriter(`tabcomputer: type: ${name}: not found\r\n`);
              exitCode = 1;
              continue;
            }
            for (const k of all ? found : found.slice(0, 1)) {
              if (mode === 't') { writeStdout((k.kind === 'registered' ? 'file' : k.kind) + '\r\n'); continue; }
              if (mode === 'p' || mode === 'P') { if (k.kind === 'file') writeStdout(k.path + '\r\n'); continue; }
              switch (k.kind) {
                case 'alias': writeStdout(`${name} is aliased to \`${k.path}'\r\n`); break;
                case 'keyword': writeStdout(`${name} is a shell keyword\r\n`); break;
                case 'function': {
                  const body = this.functions[name].body.split('\n').map((l) => '    ' + l.trim().replace(/;$/, '')).join('\r\n');
                  writeStdout(`${name} is a function\r\n${name} () \r\n{ \r\n${body}\r\n}\r\n`);
                  break;
                }
                case 'builtin': writeStdout(`${name} is a shell builtin\r\n`); break;
                case 'registered': writeStdout(`${name} is a registered command\r\n`); break;
                case 'file': writeStdout(`${name} is ${k.path}\r\n`); break;
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'command' && /^-[vV]+$/.test(cmdArgs[0] ?? '')) {
          // command -v NAME: how it would run (a path for files); -V: in words
          const verbose = cmdArgs[0].includes('V');
          exitCode = 0;
          for (const name of cmdArgs.slice(1)) {
            const [k] = await this.commandKinds(name, false);
            if (!k) { if (verbose) stderrWriter(`tabcomputer: command: ${name}: not found\r\n`); exitCode = 1; continue; }
            if (!verbose) writeStdout((k.kind === 'file' ? k.path : k.kind === 'alias' ? `alias ${name}='${k.path}'` : name) + '\r\n');
            else if (k.kind === 'file') writeStdout(`${name} is ${k.path}\r\n`);
            else if (k.kind === 'alias') writeStdout(`${name} is aliased to \`${k.path}'\r\n`);
            else writeStdout(`${name} is a ${k.kind === 'keyword' ? 'shell keyword' : k.kind === 'builtin' ? 'shell builtin' : k.kind === 'registered' ? 'registered command' : 'function'}\r\n`);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'hash') {
          // The commands this shell has run (or looked up) and where they are; -r forgets them
          exitCode = 0;
          const names = cmdArgs.filter((a) => !a.startsWith('-'));
          if (cmdArgs.includes('-r')) this.hashTable.clear();
          for (const name of names) {
            const path = await this.commandPath(name);
            if (path) this.hashTable.set(name, { path, hits: 0 });
            else { stderrWriter(`tabcomputer: hash: ${name}: not found\r\n`); exitCode = 1; }
          }
          if (!names.length && !cmdArgs.includes('-r')) {
            if (!this.hashTable.size) writeStdout('hash: hash table empty\r\n');
            else {
              writeStdout('hits\tcommand\r\n');
              for (const { path, hits } of this.hashTable.values()) writeStdout(`${String(hits).padStart(4)}\t${path}\r\n`);
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: printf FORMAT [ARGS...]
        if (!_builtinDisabled && effectiveCmdName === 'printf' && cmdArgs[0] === '-v') {
          if (cmdArgs.length === 0) {
            stderrWriter('printf: usage: printf format [arguments]\r\n');
            exitCode = 1;
          } else {
            // Handle -v varname
            let printfVarName: string | null = null;
            let printfCmdArgs = cmdArgs;
            if (cmdArgs[0] === '-v' && cmdArgs.length >= 3) {
              printfVarName = cmdArgs[1];
              printfCmdArgs = cmdArgs.slice(2);
            }
            if (printfCmdArgs[0] === '--') printfCmdArgs = printfCmdArgs.slice(1);
            const r = printfFormat(printfCmdArgs[0] ?? '', printfCmdArgs.slice(1));
            if (printfVarName) {
              // -v NAME or NAME[SUB]
              const vm = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([\s\S]*)\])?$/.exec(printfVarName);
              if (!vm) { stderrWriter(`tabcomputer: printf: \`${printfVarName}': not a valid identifier\r\n`); exitCode = 2; this.lastExitCode = 2; this.env['?'] = '2'; lastOutput = ''; continue; }
              let err: string | null = null;
              try { err = this.setVar(vm[1], r.out, vm[2]); } catch (e) { if (e instanceof ArithError) err = e.message; else throw e; }
              if (err) r.errors.push(`tabcomputer: printf: ${err}`);
            } else {
              writeStdout(r.out.replace(/\n/g, '\r\n'));
            }
            for (const e of r.errors) stderrWriter(e + '\r\n');
            exitCode = r.errors.length ? 1 : 0;
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: getopts OPTSTRING VAR [args...]
        if (!_builtinDisabled && effectiveCmdName === 'getopts') {
          if (cmdArgs.length < 2) {
            stderrWriter('getopts: usage: getopts optstring name [arg ...]\r\n');
            exitCode = 1;
          } else {
            const silent = cmdArgs[0].startsWith(':');
            const optstring = silent ? cmdArgs[0].slice(1) : cmdArgs[0];
            const varName = cmdArgs[1];
            // Use positional params if no extra args
            const args = cmdArgs.length > 2 ? cmdArgs.slice(2) : this.getPositionalArgs();
            let optind = parseInt(this.env['OPTIND'] || '1', 10) || 1;
            // Position inside a bundled argument (-abc); reset when OPTIND is changed by the script
            if (this.getoptsState.optind !== optind) this.getoptsState = { optind, char: 1 };
            let charIdx = this.getoptsState.char;
            const arg = args[optind - 1];
            if (arg === undefined || !arg.startsWith('-') || arg === '-' || arg === '--') {
              // End of options; `--` is consumed
              if (arg === '--') optind++;
              this.setVar(varName, '?');
              delete this.env['OPTARG'];
              exitCode = 1;
            } else {
              const opt = arg[charIdx];
              const advance = () => {
                charIdx++;
                if (charIdx >= arg.length) { optind++; charIdx = 1; }
              };
              const pos = opt === ':' ? -1 : optstring.indexOf(opt);
              if (pos < 0) {
                // Unknown option
                this.setVar(varName, '?');
                if (silent) this.setVar('OPTARG', opt);
                else { delete this.env['OPTARG']; stderrWriter(`${this.env['0'] || 'sh'}: illegal option -- ${opt}\r\n`); }
                advance();
              } else if (optstring[pos + 1] === ':') {
                // Option takes an argument: the rest of this word, or the next word
                if (charIdx + 1 < arg.length) {
                  this.setVar(varName, opt);
                  this.setVar('OPTARG', arg.slice(charIdx + 1));
                  optind++;
                } else if (optind < args.length) {
                  this.setVar(varName, opt);
                  this.setVar('OPTARG', args[optind]);
                  optind += 2;
                } else if (silent) {
                  this.setVar(varName, ':');
                  this.setVar('OPTARG', opt);
                  optind++;
                } else {
                  this.setVar(varName, '?');
                  delete this.env['OPTARG'];
                  stderrWriter(`${this.env['0'] || 'sh'}: option requires an argument -- ${opt}\r\n`);
                  optind++;
                }
                charIdx = 1;
              } else {
                this.setVar(varName, opt);
                delete this.env['OPTARG'];
                advance();
              }
              exitCode = 0;
            }
            this.env['OPTIND'] = String(optind);
            this.getoptsState = { optind, char: charIdx };
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: alias / unalias
        if (!_builtinDisabled && effectiveCmdName === 'alias') {
          if (cmdArgs[0] === '--') cmdArgs.shift();
          if (cmdArgs[0] === '-p') cmdArgs.shift();
          if (cmdArgs.length === 0) {
            // List all aliases
            for (const [name, value] of this.aliases) {
              writeStdout(`alias ${name}='${value.replace(/'/g, "'\\''")}'\r\n`);
            }
          } else {
            for (const arg of cmdArgs) {
              const eqIdx = arg.indexOf('=');
              if (eqIdx >= 0) {
                this.aliases.set(arg.substring(0, eqIdx), arg.substring(eqIdx + 1));
              } else {
                const val = this.aliases.get(arg);
                if (val !== undefined) {
                  writeStdout(`alias ${arg}='${val.replace(/'/g, "'\\''")}'\r\n`);
                } else {
                  stderrWriter(`tabcomputer: alias: ${arg}: not found\r\n`);
                  exitCode = 1;
                }
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'unalias') {
          if (cmdArgs[0] === '--') cmdArgs.shift();
          if (cmdArgs.length === 0) {
            stderrWriter('unalias: usage: unalias [-a] name ...\r\n');
            exitCode = 1;
          } else if (cmdArgs[0] === '-a') {
            this.aliases.clear();
          } else {
            for (const name of cmdArgs) {
              if (!this.aliases.delete(name)) {
                stderrWriter(`unalias: ${name}: not found\r\n`);
                exitCode = 1;
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: let "expr" — evaluate arithmetic, return 1 if result is 0
        if (!_builtinDisabled && effectiveCmdName === 'let') {
          if (cmdArgs.length === 0) {
            stderrWriter('let: usage: let expression\r\n');
            exitCode = 1;
          } else {
            exitCode = this.arithStatus(cmdArgs, stderrWriter);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: shift — shift positional parameters
        if (!_builtinDisabled && effectiveCmdName === 'shift') {
          const n = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) : 1;
          if (isNaN(n) || n < 0) {
            stderrWriter('shift: numeric argument required\r\n');
            exitCode = 1;
          } else {
            const count = parseInt(this.env['#'] || '0', 10);
            if (n > count) {
              stderrWriter(`shift: shift count (${n}) exceeds positional parameter count (${count})\r\n`);
              exitCode = 1;
            } else {
              const args = this.getPositionalArgs();
              const shifted = args.slice(n);
              // Clear old params
              for (let si = 1; si <= count; si++) delete this.env[String(si)];
              // Set new params
              for (let si = 0; si < shifted.length; si++) this.env[String(si + 1)] = shifted[si];
              this.env['#'] = String(shifted.length);
              this.env['@'] = shifted.join(' ');
              exitCode = 0;
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: unset — remove variables or functions
        if (!_builtinDisabled && effectiveCmdName === 'unset') {
          let unsetFunc = false;
          let unsetRef = false;
          const unsetNames: string[] = [];
          for (const arg of cmdArgs) {
            if (arg === '-f') { unsetFunc = true; continue; }
            if (arg === '-v') { unsetFunc = false; continue; }
            if (arg === '-n') { unsetRef = true; continue; }
            unsetNames.push(arg);
          }
          exitCode = 0;
          for (let name of unsetNames) {
            // unset REF unsets what the nameref refers to; unset -n REF the nameref itself
            if (!unsetFunc && this.namerefs.has(name)) {
              if (unsetRef) { this.namerefs.delete(name); continue; }
              const r = this.derefName(name);
              if (r && r.name !== name) name = r.sub !== undefined ? `${r.name}[${r.sub}]` : r.name;
            }
            if (unsetFunc) {
              delete this.functions[name];
              this.exportedFunctions.delete(name);
            } else {
              // Check for array element: arr[idx]
              const bracketMatch = name.match(/^(\w+)\[(.+)\]$/);
              if (bracketMatch) {
                const arrName = this.refTarget(bracketMatch[1]);
                const idx = bracketMatch[2];
                const assoc = this.assocArrays.get(arrName);
                if (assoc) {
                  assoc.delete(this.assocKey(idx));
                } else if (this.arrays.has(arrName) || this.env[arrName] !== undefined) {
                  try {
                    const n = this.arrayIndex(arrName, idx);
                    if (this.arrays.has(arrName)) delete this.arrays.get(arrName)![n];
                    else if (n === 0) delete this.env[arrName];
                  } catch (e) {
                    if (!(e instanceof ArithError)) throw e;
                    stderrWriter(`tabcomputer: unset: ${e.message}\r\n`);
                    exitCode = 1;
                  }
                }
              } else if (this.readonlyVars.has(name)) {
                stderrWriter(`unset: ${name}: cannot unset: readonly variable\r\n`);
                exitCode = 1;
              } else {
                // A local of a calling function (not the current one) is popped:
                // the value it shadowed comes back (bash's dynamic unset)
                let k = this.localVarStack.length - 1;
                while (k >= 0 && !this.localVarStack[k].has(name)) k--;
                const saved = k >= 0 && k < this.localVarStack.length - 1 ? this.localVarStack[k].get(name)! : null;
                const isVar = name in this.env || this.arrays.has(name) || this.assocArrays.has(name);
                delete this.env[name];
                this.localVars.delete(name);
                this.exportedUnset.delete(name);
                this.namerefs.delete(name);
                this.arrays.delete(name);
                this.assocArrays.delete(name);
                this.varAttrs.delete(name);
                this.declaredNames.delete(name);
                if (saved) {
                  this.localVarStack[k].delete(name);
                  if (saved.env !== undefined) this.env[name] = saved.env;
                  if (saved.arr) this.arrays.set(name, saved.arr);
                  if (saved.assoc) this.assocArrays.set(name, saved.assoc);
                }
                // unset NAME with no such variable unsets the function NAME
                else if (!isVar && k < 0 && this.functions[name]) delete this.functions[name];
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: readonly — mark variables as readonly
        if (!_builtinDisabled && effectiveCmdName === 'readonly') {
          exitCode = 0;
          if (cmdArgs.length === 0 || (cmdArgs.length === 1 && cmdArgs[0] === '-p')) {
            // List readonly variables
            for (const name of [...this.readonlyVars].sort()) writeStdout(`${this.declareLine(name) ?? `declare -r ${name}`}\r\n`);
          } else {
            for (const arg of cmdArgs) {
              if (arg === '-p') continue;
              const eqIdx = arg.indexOf('=');
              if (eqIdx !== -1) {
                const name = arg.slice(0, eqIdx);
                const val = arg.slice(eqIdx + 1);
                if (this.readonlyVars.has(name)) {
                  stderrWriter(`readonly: ${name}: readonly variable\r\n`);
                  exitCode = 1;
                } else {
                  this.setVar(name, val);
                  this.readonlyVars.add(name);
                }
              } else {
                this.readonlyVars.add(arg);
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: export — set/list exported variables
        if (!_builtinDisabled && effectiveCmdName === 'export') {
          exitCode = 0;
          if (cmdArgs.length === 0 || (cmdArgs.length === 1 && cmdArgs[0] === '-p')) {
            // `export NAME="v"` in POSIX mode (sh), bash's `declare -x` otherwise
            const kw = this.invokedAsSh || this.options.has('posix') ? 'export' : 'declare -x';
            const names = Object.keys(this.env)
              .filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !k.startsWith('__') && !this.localVars.has(k))
              .concat([...this.exportedUnset].filter((k) => !(k in this.env)))
              .sort();
            for (const k of names) {
              const v = this.env[k];
              writeStdout(v === undefined ? `${kw} ${k}\r\n` : `${kw} ${k}="${v.replace(/(["\\$`])/g, '\\$1')}"\r\n`);
            }
          } else {
            const flags = cmdArgs.filter((a) => /^-[fnp]+$/.test(a)).join('');
            const unexport = flags.includes('n');
            const fns = flags.includes('f');
            for (const arg of cmdArgs) {
              if (/^-[fnp]+$/.test(arg)) continue;
              // export -f NAME (and -nf): functions, for the shells this one starts
              if (fns) {
                if (!this.functions[arg]) { stderrWriter(`tabcomputer: export: ${arg}: not a function\r\n`); exitCode = 1; continue; }
                if (unexport) this.exportedFunctions.delete(arg);
                else this.exportedFunctions.add(arg);
                continue;
              }
              const eqIdx = arg.indexOf('=');
              const name = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
              if (eqIdx !== -1) {
                const err = this.setVar(name, arg.slice(eqIdx + 1));
                if (err) {
                  stderrWriter(`tabcomputer: export: ${err}\r\n`);
                  exitCode = 1;
                  this.readonlyAssignFailed();
                  continue;
                }
              }
              if (unexport) { if (name in this.env) this.localVars.add(name); this.exportedUnset.delete(name); continue; }
              this.localVars.delete(name);
              if (!(name in this.env)) this.exportedUnset.add(name);
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: set -- args (positional parameter assignment)
        if (!_builtinDisabled && effectiveCmdName === 'set') {
          // Check for -- to set positional parameters; the first word that isn't an
          // option (set a b c) starts them too, as does a lone - (set - a b)
          // Bundled flags are single ones (-euo pipefail = -e -u -o pipefail): each
          // o takes the next word as its option name, as in bash
          {
            const end = cmdArgs.indexOf('--');
            const head = (end < 0 ? cmdArgs : cmdArgs.slice(0, end)).flatMap((a) => /^[-+][A-Za-z]{2,}$/.test(a) && a.includes('o') ? [...a.slice(1)].map((c) => a[0] + c) : [a]);
            cmdArgs.splice(0, end < 0 ? cmdArgs.length : end, ...head);
          }
          let ddIdx = cmdArgs.indexOf('--');
          if (ddIdx < 0) {
            let k = 0;
            for (; k < cmdArgs.length; k++) {
              if (cmdArgs[k] === '-o' || cmdArgs[k] === '+o') { k++; continue; }
              if (!/^[-+]./.test(cmdArgs[k])) break;
            }
            if (k < cmdArgs.length) {
              // options before the parameters still apply
              if (k > 0) await this.execute(`set ${quoteArgsForShell(cmdArgs.slice(0, k))}`, writeStdout, stderrWriter, false, undefined, true);
              cmdArgs.splice(0, k);
              if (cmdArgs[0] === '-') cmdArgs.shift();
              cmdArgs.unshift('--');
              ddIdx = 0;
            }
          }
          if (cmdArgs.length === 0) {
            // Bare `set` lists shell variables, quoted so they can be read back
            const names = Object.keys(this.env).filter(k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !k.startsWith('__')).sort();
            for (const k of names) {
              const v = this.env[k];
              writeStdout(`${k}=${/^[A-Za-z0-9_\-.,/:@%+=]*$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`}\r\n`);
            }
            exitCode = 0;
          } else if (ddIdx >= 0) {
            const newArgs = cmdArgs.slice(ddIdx + 1);
            // Clear old positional params
            const oldCount = parseInt(this.env['#'] || '0', 10);
            for (let si = 1; si <= oldCount; si++) delete this.env[String(si)];
            // Set new positional params
            for (let si = 0; si < newArgs.length; si++) this.env[String(si + 1)] = newArgs[si];
            this.env['#'] = String(newArgs.length);
            this.env['@'] = newArgs.join(' ');
            exitCode = 0;
          } else {
            // Handle set -e, -x, etc. inline
            for (let si = 0; si < cmdArgs.length; si++) {
              const arg = cmdArgs[si];
              if (arg === '-o' || arg === '+o') {
                const optName = cmdArgs[++si];
                if (!optName) {
                  // set -o: a table; set +o: commands that recreate the settings
                  for (const opt of SET_O_OPTIONS) {
                    const on = this.options.has(opt);
                    writeStdout(arg === '-o' ? `${opt.padEnd(15)}\t${on ? 'on' : 'off'}\r\n` : `set ${on ? '-' : '+'}o ${opt}\r\n`);
                  }
                } else {
                  const optMap: Record<string, string> = {
                    errexit: 'errexit', nounset: 'nounset', xtrace: 'xtrace', verbose: 'verbose', noexec: 'noexec', pipefail: 'pipefail',
                    noclobber: 'noclobber', noglob: 'noglob', allexport: 'allexport',
                    // accepted, no effect here
                    monitor: 'monitor', notify: 'notify', hashall: 'hashall', ignoreeof: 'ignoreeof', emacs: 'emacs', vi: 'vi',
                    posix: 'posix', physical: 'physical', braceexpand: 'braceexpand', histexpand: 'histexpand', history: 'history',
                    'interactive-comments': 'interactive-comments', keyword: 'keyword', nolog: 'nolog', onecmd: 'onecmd',
                    errtrace: 'errtrace', functrace: 'functrace', privileged: 'privileged',
                  };
                  const mapped = optMap[optName];
                  if (mapped) {
                    if (arg === '-o') this.options.add(mapped);
                    else this.options.delete(mapped);
                    // vi and emacs editing modes exclude each other
                    if (arg === '-o' && (mapped === 'vi' || mapped === 'emacs')) this.options.delete(mapped === 'vi' ? 'emacs' : 'vi');
                  } else {
                    stderrWriter(`set: ${optName}: invalid option name\r\n`);
                    exitCode = 2;
                    // set is a special builtin: a POSIX (sh) script ends on its error
                    if (this.posixFatal()) throw new ExitSignal(2);
                  }
                }
                continue;
              }
              const shortMap: Record<string, string> = {
                e: 'errexit', u: 'nounset', x: 'xtrace', v: 'verbose', n: 'noexec', C: 'noclobber', f: 'noglob', a: 'allexport',
                m: 'monitor', b: 'notify', h: 'hashall', B: 'braceexpand', H: 'histexpand', P: 'physical', E: 'errtrace', T: 'functrace',
              };
              if (arg.startsWith('-') && arg.length > 1 && arg[1] !== '-') {
                for (let j = 1; j < arg.length; j++) {
                  const mapped = shortMap[arg[j]];
                  if (mapped) this.options.add(mapped);
                }
              } else if (arg.startsWith('+') && arg.length > 1) {
                for (let j = 1; j < arg.length; j++) {
                  const mapped = shortMap[arg[j]];
                  if (mapped) this.options.delete(mapped);
                }
              }
            }
            exitCode = 0;
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: source / . — execute script in current shell scope
        if (!_builtinDisabled && effectiveCmdName === 'source') {
          const srcArgs = cmdArgs[0] === '--' ? cmdArgs.slice(1) : cmdArgs;
          if (srcArgs.length === 0) {
            stderrWriter('source: filename argument required\r\nsource: usage: source filename [arguments]\r\n');
            exitCode = 2;
          } else {
            // A name without / is looked up in PATH first (files, not directories), then here
            let scriptPath = this.fs.resolvePath(srcArgs[0], this.cwd);
            if (!srcArgs[0].includes('/')) {
              for (const dir of (this.env['PATH'] ?? '').split(':').filter(Boolean)) {
                const p = this.fs.resolvePath(srcArgs[0], this.fs.resolvePath(dir, this.cwd));
                const st = await this.fs.stat(p).catch(() => null);
                if (st && !st.isDirectory()) { scriptPath = p; break; }
              }
            }
            // source FILE ARGS: the arguments are $@ while it runs
            const savedPositional = srcArgs.length > 1 ? this.getPositionalArgs() : null;
            if (savedPositional) this.setPositional(srcArgs.slice(1));
            try {
              const raw = await this.fs.readFile(scriptPath);
              const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
              // Save/restore LINENO across source calls
              const savedLine = this.currentLine;
              const savedDepth = this.executeDepth;
              this.executeDepth = 0; // source starts a fresh top-level
              this.sourcing++;
              const popFrame = this.pushCallFrame('source', srcArgs[0]);
              const savedSource = this.sourceFile;
              this.sourceFile = srcArgs[0];
              try {
                exitCode = await this.execute(content, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
              } catch (e) {
                if (!(e instanceof ReturnSignal)) throw e;
                exitCode = e.code; // `return` ends a sourced file
              } finally {
                popFrame();
                this.sourceFile = savedSource;
                this.sourcing--;
                this.currentLine = savedLine;
                this.executeDepth = savedDepth;
              }
              this.env['LINENO'] = String(this.currentLine);
            } catch (e: any) {
              if (isControlSignal(e)) throw e;
              const missing = /ENOENT/.test(e.message);
              stderrWriter(`source: ${srcArgs[0]}: ${missing ? 'No such file or directory' : e.message}\r\n`);
              exitCode = 1;
              // `.` is a special builtin: a POSIX shell (sh) script ends when it fails
              if (missing && this.posixFatal()) throw new ExitSignal(1);
            } finally {
              if (savedPositional) this.setPositional(savedPositional);
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: exec — replace shell with command (in browser, just execute)
        if (!_builtinDisabled && effectiveCmdName === 'exec') {
          // Without a command, exec's redirections change the shell's own fds
          // (exec 3>log, exec >>log 2>&1, exec 3>&1, exec 6<in, exec 3>&-)
          if (cmdArgs.length === 0) {
            const err = await this.applyExecRedirects(redirects);
            if (err) { stderrWriter(err + '\r\n'); exitCode = 1; }
            else exitCode = 0;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            // The redirects now belong to the shell: don't apply them to this (empty) output
            redirects.length = 0;
            continue;
          }
          // exec [-cl] [-a NAME] COMMAND: -a NAME is the program's argv[0] (Claude Code's
          // `(exec -a ugrep "$_cc_bin" …)` multicall), -l prefixes it with '-', -c empties the environment
          let execWords = cmdArgs;
          let argv0: string | undefined;
          let login = false;
          let clearEnv = false;
          while (execWords.length && /^-[acl]+$/.test(execWords[0])) {
            const flags = execWords[0];
            execWords = execWords.slice(1);
            if (flags.includes('c')) clearEnv = true;
            if (flags.includes('l')) login = true;
            if (flags.includes('a')) { argv0 = execWords[0]; execWords = execWords.slice(1); }
          }
          if (execWords[0] === '--') execWords = execWords.slice(1);
          if (cmdArgs.length > 0 && execWords.length === 0) {
            if (argv0 === undefined && cmdArgs.some((a) => a === '-a')) { stderrWriter('exec: -a: option requires an argument\r\n'); exitCode = 2; }
            else exitCode = 0;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          if (execWords.length > 0) {
            if (login) argv0 = '-' + (argv0 ?? execWords[0].replace(/^.*\//, ''));
            const execCmd = quoteArgsForShell(clearEnv ? ['env', '-i', ...execWords] : execWords);
            this.execArgv0 = argv0 !== undefined ? { name: execWords[0], argv0 } : undefined;
            this.injectedStdin = nestedStdin;
            try {
              exitCode = await this.execute(execCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
            } finally {
              this.execArgv0 = undefined;
            }
            // The command replaced the shell: a script or subshell ends with its status
            // (the interactive prompt goes on: it is the session)
            if (this.scriptShell || this.isSubshell) {
              this.lastExitCode = exitCode;
              this.env['?'] = String(exitCode);
              throw new ExitSignal(exitCode);
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: builtin — run builtin ignoring functions
        // command [-p] NAME ARGS: run NAME skipping functions and aliases
        if (!_builtinDisabled && effectiveCmdName === 'command' && cmdArgs.length && !/^-[vV]+$/.test(cmdArgs[0])) {
          const rest = cmdArgs[0] === '-p' || cmdArgs[0] === '--' ? cmdArgs.slice(1) : cmdArgs;
          if (rest.length === 1 && rest[0] === 'exec') {
            // `command exec 8<file`: exec's redirections change the shell's fds, as without `command`
            const err = await this.applyExecRedirects(redirects);
            if (err) stderrWriter(err + '\r\n');
            exitCode = err ? 1 : 0;
            redirects.length = 0;
          } else if (rest.length) {
            const savedFn = this.functions[rest[0]];
            delete this.functions[rest[0]];
            const savedAlias = this.aliases.get(rest[0]);
            this.aliases.delete(rest[0]);
            this.injectedStdin = nestedStdin;
            try {
              exitCode = await this.execute(quoteArgsForShell(rest), writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
            } finally {
              if (savedFn) this.functions[rest[0]] = savedFn;
              if (savedAlias !== undefined) this.aliases.set(rest[0], savedAlias);
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'builtin') {
          if (cmdArgs.length > 0) {
            const builtinCmd = quoteArgsForShell(cmdArgs);
            // Temporarily remove function override (and an installed package's shadowing)
            const savedFn = this.functions[cmdArgs[0]];
            delete this.functions[cmdArgs[0]];
            const savedBypass = this.pkgShadowBypass;
            this.pkgShadowBypass = cmdArgs[0];
            this.injectedStdin = nestedStdin;
            try {
              exitCode = await this.execute(builtinCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
            } finally {
              this.pkgShadowBypass = savedBypass;
            }
            if (savedFn) this.functions[cmdArgs[0]] = savedFn;
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell stubs for commonly expected builtins (no-ops that scripts depend on)
        if (!_builtinDisabled && effectiveCmdName === 'ulimit') {
          // ulimit -n → file descriptor limit, etc.
          if (cmdArgs.includes('-n')) { writeStdout('1024\r\n'); }
          else if (cmdArgs.includes('-s')) { writeStdout('8192\r\n'); }
          else if (cmdArgs.length === 0 || cmdArgs.includes('-f')) { writeStdout('unlimited\r\n'); }
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'umask') {
          // umask [-p] [-S] [MODE] (shell-umask.ts)
          let printable = false, symbolic = false;
          let k = 0;
          exitCode = 0;
          for (; k < cmdArgs.length && /^-./.test(cmdArgs[k]); k++) {
            if (cmdArgs[k] === '--') { k++; break; }
            for (const c of cmdArgs[k].slice(1)) {
              if (c === 'p') printable = true;
              else if (c === 'S') symbolic = true;
              else { stderrWriter(`tabcomputer: umask: -${c}: invalid option\r\numask: usage: umask [-p] [-S] [mode]\r\n`); exitCode = 2; }
            }
          }
          if (exitCode === 0) {
            if (k < cmdArgs.length) {
              const r = parseUmask(cmdArgs[k], this.umask);
              if (typeof r === 'string') { stderrWriter(`tabcomputer: umask: ${r}\r\n`); exitCode = 1; }
              else this.umask = r;
            } else if (symbolic) writeStdout(`${printable ? 'umask -S ' : ''}${symbolicUmask(this.umask)}\r\n`);
            else writeStdout(`${printable ? 'umask ' : ''}${formatUmask(this.umask)}\r\n`);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'compopt') {
          // Bash completion stub — silent no-op
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }
        if (effectiveCmdName === 'enable') {
          // enable [-n] [-a] [-p] [name ...]
          // -n: disable builtins, -a: print all (enabled+disabled), -p: print in reusable format
          let disableMode = false;
          let printAll = false;
          let printMode = false;
          const names: string[] = [];
          for (const a of cmdArgs) {
            if (a === '-n') disableMode = true;
            else if (a === '-a') printAll = true;
            else if (a === '-p') printMode = true;
            else if (!a.startsWith('-')) names.push(a);
          }
          // List of all shell builtins
          const allBuiltins = [
            '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller',
            'cd', 'command', 'compgen', 'complete', 'compopt', 'continue',
            'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec',
            'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help',
            'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile',
            'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly',
            'return', 'select', 'set', 'shift', 'shopt', 'source', 'test',
            'time', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask',
            'unalias', 'unset', 'wait',
          ];
          if (names.length === 0) {
            // Print mode
            if (printAll || printMode) {
              for (const b of allBuiltins) {
                const disabled = this.disabledBuiltins.has(b);
                if (printAll || !disabled) {
                  writeStdout(`enable ${disabled ? '-n ' : ''}${b}\r\n`);
                }
              }
            } else {
              // Default: show enabled builtins
              for (const b of allBuiltins) {
                if (!this.disabledBuiltins.has(b)) {
                  writeStdout(`enable ${b}\r\n`);
                }
              }
            }
          } else {
            // Enable or disable named builtins
            for (const name of names) {
              if (disableMode) {
                this.disabledBuiltins.add(name);
              } else {
                this.disabledBuiltins.delete(name);
              }
            }
          }
          exitCode = 0;
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'complete') {
          // Programmable completion: parse and store specs
          let spec: CompletionSpec = {};
          let printMode = false;
          let removeMode = false;
          const completeCmds: string[] = [];

          for (let ai = 0; ai < cmdArgs.length; ai++) {
            const a = cmdArgs[ai];
            if (a === '-W') {
              const wordStr = cmdArgs[++ai] || '';
              spec.words = wordStr.split(/\s+/).filter(Boolean);
            } else if (a === '-F') {
              spec.funcName = cmdArgs[++ai] || '';
            } else if (a === '-A') {
              spec.action = cmdArgs[++ai] || '';
            } else if (a === '-P') {
              spec.prefix = cmdArgs[++ai] || '';
            } else if (a === '-S') {
              spec.suffix = cmdArgs[++ai] || '';
            } else if (a === '-p') {
              printMode = true;
            } else if (a === '-r') {
              removeMode = true;
            } else if (!a.startsWith('-')) {
              completeCmds.push(a);
            }
          }

          if (printMode) {
            if (completeCmds.length > 0) {
              for (const cmd of completeCmds) {
                const s = this.completionSpecs.get(cmd);
                if (s) writeStdout(this.formatCompleteSpec(cmd, s) + '\r\n');
              }
            } else {
              for (const [cmd, s] of this.completionSpecs) {
                writeStdout(this.formatCompleteSpec(cmd, s) + '\r\n');
              }
            }
          } else if (removeMode) {
            for (const cmd of completeCmds) {
              this.completionSpecs.delete(cmd);
            }
          } else {
            for (const cmd of completeCmds) {
              this.completionSpecs.set(cmd, spec);
            }
          }
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'compgen') {
          let words: string[] = [];
          let prefix = '';
          const builtinNames = ['cd', 'echo', 'read', 'eval', 'set', 'export', 'source', 'shift',
            'declare', 'local', 'typeset', 'true', 'false', 'break', 'continue', 'return',
            'trap', 'getopts', 'printf', 'type', 'command', 'hash', 'mapfile', 'readarray',
            'select', 'alias', 'unalias', 'pushd', 'popd', 'dirs', 'let', 'exec', 'builtin',
            'ulimit', 'umask', 'complete', 'compgen', 'enable', 'disown', 'unset', 'readonly',
            'time', 'caller', 'shopt', 'fc'];
          for (let ai = 0; ai < cmdArgs.length; ai++) {
            const a = cmdArgs[ai];
            if (a === '-W') {
              // Word list — next arg is the list (space-separated words)
              const wordStr = cmdArgs[++ai] || '';
              words.push(...wordStr.split(/\s+/).filter(Boolean));
            } else if (a === '-b') {
              words.push(...builtinNames);
            } else if (a === '-c') {
              // All commands: builtins + registered + functions
              words.push(...builtinNames);
              words.push(...this.commands.list().map((c: { name: string }) => c.name));
              words.push(...Object.keys(this.functions));
            } else if (a === '-a') {
              words.push(...this.aliases.keys());
            } else if (a === '-v') {
              words.push(...Object.keys(this.env));
              words.push(...this.arrays.keys());
              words.push(...this.assocArrays.keys());
            } else if (a === '-e' || a === '-f') {
              // File completion — list files in cwd
              try {
                const entries = await this.fs.readdir(this.cwd);
                words.push(...entries);
              } catch { /* ignore */ }
            } else if (a === '-d') {
              // Directory completion
              try {
                const entries = await this.fs.readdir(this.cwd);
                for (const e of entries) {
                  try {
                    const s = await this.fs.stat(this.fs.resolvePath(e, this.cwd));
                    if (s.type === 'dir') words.push(e);
                  } catch { /* skip */ }
                }
              } catch { /* ignore */ }
            } else if (a === '-A') {
              const action = cmdArgs[++ai] || '';
              if (action === 'function') words.push(...Object.keys(this.functions));
              else if (action === 'alias') words.push(...this.aliases.keys());
              else if (action === 'variable') { words.push(...Object.keys(this.env)); words.push(...this.arrays.keys()); }
              else if (action === 'builtin') words.push(...builtinNames);
              else if (action === 'command') { words.push(...builtinNames); words.push(...this.commands.list().map((c: { name: string }) => c.name)); }
            } else if (!a.startsWith('-')) {
              prefix = a;
            }
          }
          // Filter by prefix
          if (prefix) {
            words = words.filter(w => w.startsWith(prefix));
          }
          // De-duplicate
          words = [...new Set(words)];
          if (words.length > 0) {
            writeStdout(words.join('\r\n') + '\r\n');
          }
          exitCode = words.length > 0 ? 0 : 1;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'coproc') {
          // coproc [NAME] command — run command as coprocess
          // NAME is only recognized if it's an uppercase identifier AND there are further args
          let coprocName = 'COPROC';
          let coprocCmd: string;
          if (cmdArgs.length >= 2 && /^[A-Z_][A-Z0-9_]*$/.test(cmdArgs[0])) {
            coprocName = cmdArgs[0];
            coprocCmd = cmdArgs.slice(1).join(' ');
          } else {
            coprocCmd = cmdArgs.join(' ');
          }
          // Execute command and capture output
          let coprocOutput = '';
          const coprocPid = this.nextJobId++;
          const coprocPromise = this.execute(coprocCmd, (s: string) => { coprocOutput += s; }, stderrWriter, false, undefined, true)
            .then((code) => {
              // Store output in the coproc array
              this.coproc = { name: coprocName, pid: coprocPid, output: coprocOutput };
              this.arrays.set(coprocName, [coprocOutput.replace(/\r\n/g, '\n').trimEnd()]);
              this.env[`${coprocName}_PID`] = String(coprocPid);
              return code;
            });
          // Register as background job
          const job: BackgroundJob = { id: coprocPid, command: `coproc ${coprocCmd}`, promise: coprocPromise, status: 'running', exitCode: 0 };
          this.backgroundJobs.set(coprocPid, job);
          coprocPromise.then((code) => { job.status = 'done'; job.exitCode = code; });
          this.env[`${coprocName}_PID`] = String(coprocPid);
          writeStdout(`[${coprocPid}] coproc started\r\n`);
          exitCode = 0;
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'disown') {
          // disown: remove jobs from job table
          if (cmdArgs.length === 0 || cmdArgs.includes('-a')) {
            // Remove all jobs (or current job)
            if (cmdArgs.includes('-a')) {
              for (const [id, job] of this.backgroundJobs) {
                if (job.status !== 'running') this.backgroundJobs.delete(id);
              }
            }
            // With no args, remove most recent
            else {
              const ids = [...this.backgroundJobs.keys()];
              if (ids.length > 0) this.backgroundJobs.delete(ids[ids.length - 1]);
            }
          } else if (cmdArgs.includes('-r')) {
            // Remove only running jobs
            for (const [id, job] of this.backgroundJobs) {
              if (job.status === 'running') this.backgroundJobs.delete(id);
            }
          } else {
            // Remove specific job(s)
            for (const arg of cmdArgs) {
              if (arg.startsWith('-')) continue;
              const jobId = parseInt(arg.replace('%', ''), 10);
              if (this.backgroundJobs.has(jobId)) {
                this.backgroundJobs.delete(jobId);
              } else {
                stderrWriter(`disown: ${arg}: no such job\r\n`);
                exitCode = 1;
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Handle stdin redirect (<)
        let stdin = i > 0 ? lastOutput : '';
        for (const redir of redirects) {
          if (redir.type === '<') {
            if (redir.target === '/dev/null') {
              stdin = '';
              continue;
            }
            // /dev/stdin reads from pipe input
            if (redir.target === '/dev/stdin') {
              stdin = i > 0 ? lastOutput : (heredocStdin || '');
              continue;
            }
            try {
              stdin = await this.readInputRedirect(redir.target);
            } catch (e: any) {
              stderrWriter(`tabcomputer: ${redir.target}: ${e.message}\r\n`);
              exitCode = 1;
              break;
            }
          }
        }
        if (exitCode !== 0 && i === 0) break;

        // Inject heredoc content as stdin if present and this is the first pipeline segment
        if (heredocStdin && i === 0 && !stdin) {
          stdin = heredocStdin;
        }

        // Here-string (<<<) overrides stdin
        if (hereString) {
          stdin = hereString;
        }

        // Inside a compound command whose input is piped (`… | if …; then cat; fi`,
        // a for/case/function body): a command with no stdin of its own reads the
        // pipe's remainder, once it actually reads (`echo a; cat` leaves it for cat)
        const fromEnclosingPipe = i === 0 && !stdin && !heredocStdin && hereString === undefined &&
          !redirects.some(r => r.type === '<') && '__PIPE_STDIN' in this.env;
        const hasShellStdin = i > 0 || hereString !== undefined || (i === 0 && !!heredocStdin) || redirects.some(r => r.type === '<') || fromEnclosingPipe;
        const live = this.liveStdin(i, heredocStdin, hereString, redirects);

        const pwdBefore = this.env['PWD'], cwdBefore = this.cwd;
        const ctx: CommandContext = {
          args: cmdArgs,
          fs: this.fs,
          cwd: this.cwd,
          env: this.env,
          stdin,
          stdout: '',
          stderr: '',
          shell: this,
          terminal: terminalOverride || this.terminal,
          // (a live stdin is the kernel process's fd 0: a tty when it is the pty)
          stdinIsTTY: !hasShellStdin && (live ? this.kernelStdio!.file(0)?.kind === 'pty' : !!(terminalOverride || this.terminal)),
          // (not when the caller collects stdout: $(...), a builtin's own sink)
          stdoutIsTTY: i === pipeline.length - 1 && !redirects.some(r => r.type === '>' || r.type === '>>') &&
            !(terminalOverride || this.terminal)?.captureStdout,
        };
        if (fromEnclosingPipe) {
          let taken = false;
          let value = '';
          Object.defineProperty(ctx, 'stdin', {
            get: () => {
              if (!taken) {
                taken = true;
                value = this.env['__PIPE_STDIN'] ?? '';
                if ('__PIPE_STDIN' in this.env) this.env['__PIPE_STDIN'] = '';
              }
              return value;
            },
            set: (v: string) => { taken = true; value = v; },
            enumerable: true,
            configurable: true,
          });
        }

        // Check shell functions first
        if (this.functions[effectiveCmdName]) {
          // A function reads the segment's stdin: the first command of its body gets
          // it, and `read`/loops inside consume it line by line. Without stdin of its
          // own it keeps whatever an enclosing piped loop is reading.
          const ownStdin = i > 0 || hereString !== undefined || !!heredocStdin || redirects.some(r => r.type === '<');
          const savedPipeStdin = this.env['__PIPE_STDIN'];
          if (ownStdin) {
            this.env['__PIPE_STDIN'] = stdin;
            this.injectedStdin = stdin;
          }
          try {
            exitCode = await this.execFunction(effectiveCmdName, cmdArgs, writeStdout, stderrWriter);
          } finally {
            this.injectedStdin = null;
            if (ownStdin) {
              if (savedPipeStdin === undefined) delete this.env['__PIPE_STDIN'];
              else this.env['__PIPE_STDIN'] = savedPipeStdin;
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Regular commands return their output in ctx and get the redirect handling
        // below; anything captured so far (xtrace, warnings) goes along with it
        if (capture) {
          const c = capture as { out: string; err: string };
          capture = null;
          writeStdout = outerStdout;
          stderrWriter = outerStderr;
          ctx.stdout = c.out.replace(/\r\n/g, '\n');
          ctx.stderr = c.err.replace(/\r\n/g, '\n');
        }

        // WASM and x86 programs, with the filter builtins piped to and from them, run as one kernel job
        const kernelRun = await this.tryKernelRun(pipeline, i, effectiveCmdName, cmdArgs, redirects, ctx,
          hasShellStdin, writeStdout, stderrWriter, terminalOverride || this.terminal, live);
        if (kernelRun) {
          i = kernelRun.lastIndex;
          exitCode = kernelRun.exitCode;
          lastOutput = await this.applyOutputRedirects(kernelRun.stdout, kernelRun.stderr, kernelRun.redirects,
            i === pipeline.length - 1, writeStdout, stderrWriter);
          pipeExitCodes.push(...kernelRun.statuses);
          continue;
        }
        // A package installed with `pkg install` provides the real program in
        // place of a builtin of the same name (lua, sqlite3, jq, ...)
        let pkgShadowed = !_builtinDisabled && this.pkgShadowBypass !== effectiveCmdName &&
          !!this.commands.get(effectiveCmdName) &&
          packageShadows(this.fs).has(effectiveCmdName);
        // A Debian program that is gone (apt remove) no longer shadows the builtin
        if (pkgShadowed && !pkgOwnShadows(this.fs).has(effectiveCmdName) && !(await this.findExecutableInPath(effectiveCmdName))) pkgShadowed = false;
        // /bin/NAME, /usr/bin/NAME, …: Shiro's NAME when no such file exists (the kernel stats them the same way)
        const binPath = /^\/(?:usr\/)?(?:local\/)?s?bin\/([^/]+)$/.exec(effectiveCmdName);
        const cmd = pkgShadowed ? undefined : this.commands.get(effectiveCmdName)
          ?? (binPath && !(await this.fs.exists(effectiveCmdName)) ? this.commands.get(binPath[1]) : undefined);
        // Commands found by name (not shell builtins) go in the table `hash` shows
        if (!SHELL_BUILTIN_NAMES.has(effectiveCmdName) && !effectiveCmdName.includes('/')) {
          const h = this.hashTable.get(effectiveCmdName);
          if (h) h.hits++;
          else this.hashTable.set(effectiveCmdName, { path: cmd ? `/usr/bin/${effectiveCmdName}` : (await this.findExecutableInPath(effectiveCmdName)) ?? `/usr/bin/${effectiveCmdName}`, hits: 1 });
        }
        if (cmd) {
          try {
            exitCode = live
              ? await this.execWithLiveStdin(cmd, ctx, i === pipeline.length - 1 && !redirects.some(r => r.type !== '<') &&
                writesTo(writeStdout, this.kernelStdio!.out) && writesTo(stderrWriter, this.kernelStdio!.err))
              : await this.runCommand(cmd, ctx);
          } catch (e: any) {
            ctx.stderr += e.message + '\n';
            exitCode = 1;
          }
        } else {
          // Try to find executable in PATH
          const executable = pkgShadowed && pkgOwnShadows(this.fs).has(effectiveCmdName)
            ? `${PKG_BIN_DIR}/${effectiveCmdName}`
            : await this.findExecutableInPath(effectiveCmdName);
          if (executable) {
            try {
              if (live) ctx.liveStdin = true;
              // A script whose output is redirected or piped writes into ctx like
              // a builtin, for the redirects and the next stage to take; only the
              // last stage's unredirected output streams (`./s.sh > /dev/null`
              // and `./s.sh | tr` printed straight to the terminal)
              const outRedirected = redirects.some(r => r.type !== '<' && !(r.type === 'open' && r.mode === '<'));
              // (the shell's writers end lines with \r\n for the terminal)
              const toCtxOut = (t: string) => { ctx.stdout += t.replace(/\r\n/g, '\n'); };
              const toCtxErr = (t: string) => { ctx.stderr += t.replace(/\r\n/g, '\n'); };
              exitCode = await this.executeScript(executable, cmdArgs, ctx,
                outRedirected || i !== pipeline.length - 1 ? toCtxOut : writeStdout,
                outRedirected ? toCtxErr : stderrWriter, effectiveCmdName);
            } catch (e: any) {
              ctx.stderr += e.message + '\n';
              exitCode = 1;
            }
          } else {
            // Like Debian's command-not-found: name the package that has it
            const provider = findEntry(builtinIndex(), effectiveCmdName);
            if (provider && Object.prototype.hasOwnProperty.call(provider.bin, effectiveCmdName)) {
              stderrWriter(`tabcomputer: command not found: ${effectiveCmdName}\r\n`);
              stderrWriter(`  it can be installed with: pkg install ${provider.name}` +
                (packageStatus(provider) === 'blocked' ? ` (needs kernel support tabcomputer doesn't have yet)` : '') + '\r\n');
              exitCode = 127;
              this.lastExitCode = exitCode;
              this.env['?'] = String(exitCode);
              break;
            } else {
              stderrWriter(`tabcomputer: command not found: ${effectiveCmdName}\r\n`);
              exitCode = 127;
              this.lastExitCode = exitCode;
              this.env['?'] = String(exitCode);
              break;
            }
          }
        }

        const output = await this.applyOutputRedirects(ctx.stdout, ctx.stderr, redirects, i === pipeline.length - 1, writeStdout, stderrWriter);

        lastOutput = output;
        pipeExitCodes.push(exitCode);

        // A command that changed $PWD (not cwd) moved the shell
        if (this.env['PWD'] && this.env['PWD'] !== pwdBefore && this.cwd === cwdBefore) this.cwd = this.env['PWD'];
      }

      while (pipeExitCodes.length < segCount) pipeExitCodes.push(exitCode);
      await flushCapture();
      if (this.pendingOutSubs.length) await this.runOutSubs(outerStdout, outerStderr);

      for (const [key, value] of prefixPersists ? [] : prefixEnvSaved) {
        if (value === undefined) delete this.env[key];
        else this.env[key] = value;
        if (prefixWasLocal.has(key) && value !== undefined) this.localVars.add(key);
      }

      if (this.redirectFailed) {
        exitCode = 1;
        this.redirectFailed = false;
        // A redirection error of a special builtin ends a POSIX (sh) script (2.8.1)
        const first = pipeline.length === 1 ? pipeline[0].trim().split(/\s+/)[0] : '';
        if (POSIX_SPECIAL_BUILTINS.has(first) && this.posixFatal()) throw new ExitSignal(1);
      }

      // pipefail: use last non-zero exit code from any pipe segment
      if (this.options.has('pipefail') && pipeExitCodes.length > 1) {
        const lastNonZero = [...pipeExitCodes].reverse().find(c => c !== 0);
        if (lastNonZero !== undefined) exitCode = lastNonZero;
      }

      // Store PIPESTATUS array
      this.arrays.set('PIPESTATUS', pipeExitCodes.map(String));

      // Apply ! negation
      if (negateExit) {
        exitCode = exitCode === 0 ? 1 : 0;
      }

      this.lastExitCode = exitCode;
      this.env['?'] = String(exitCode);

      // ERR trap on a failure, where set -e would act (not in a condition, a
      // && / || list before its last command, or a ! pipeline), and not
      // again while it runs (its own failures don't fire it)
      if (!negateExit) await this.errTrap(exitCode, writeStdout, stderrWriter);

    }
    if (suppressing) this.errexitSuppressed--;
    if (lastRan >= 0) this.checkErrexit(compounds, lastRan, exitCode);

    this.executeDepth--;
    if (isTopLevel) {
      this.abortController = null;
    }
    return exitCode;
  }

  /**
   * Apply a segment's output redirects (2>, 2>>, 2>&1, >, >>) to its stdout/stderr.
   * Writes remaining stderr, and stdout too for the last pipeline segment; returns
   * the stdout that flows to the next segment.
   */
  private async applyOutputRedirects(
    stdout: string, stderr: string, redirects: Redirect[], isLast: boolean,
    writeStdout: (s: string) => void, stderrWriter: (s: string) => void,
  ): Promise<string> {
    // Where fd 1 and fd 2 point, following the redirections left to right
    // (`2>&1 >file` leaves stderr on the old stdout; `>file 2>&1` sends both to file)
    type Target = { kind: 'out' } | { kind: 'err' } | { kind: 'null' } | { kind: 'fd'; n: number } | { kind: 'file'; path: string; shown: string };
    let t1: Target = { kind: 'out' };
    let t2: Target = { kind: 'err' };
    // Files opened (in order), each with whether it was truncated and what it gets
    const files = new Map<string, { truncate: boolean; text: string; shown: string; ok: boolean }>();
    const open = async (target: string, append: boolean, redir: Redirect): Promise<Target | null> => {
      if (target === '/dev/null') return { kind: 'null' };
      const ref = fdOfRef(target);
      if (ref !== null) {
        if (ref === 1) return t1;
        if (ref === 2) return t2;
        if (!this.resolveOutFd(ref)) { stderrWriter(`tabcomputer: ${ref}: Bad file descriptor\r\n`); this.redirectFailed = true; return null; }
        return { kind: 'fd', n: ref };
      }
      if (target === '/dev/stdout') return t1;
      if (target === '/dev/stderr') return t2;
      // > >(cmd): cmd reads what is written, once the command is done
      const ps = /^>\(([\s\S]+)\)$/.exec(target);
      if (ps) {
        const p = `/tmp/.procsub_${Date.now()}_${procSubCounter++}`;
        this.pendingOutSubs.push({ path: p, cmd: ps[1] });
        target = p;
        append = false;
      }
      const path = this.fs.resolvePath(target, this.cwd);
      if (!append && !(await this.clobberOk(redir, path, stderrWriter))) return null;
      const f = files.get(path);
      if (f) { if (!append) { f.truncate = true; f.text = ''; } }
      else files.set(path, { truncate: !append, text: '', shown: target, ok: true });
      return { kind: 'file', path, shown: target };
    };
    for (const r of redirects) {
      if (r.type === '>' || r.type === '>>') {
        const t = await open(r.target, r.type === '>>', r);
        if (!t) { t1 = { kind: 'null' }; continue; }
        t1 = t;
      } else if (r.type === '2>' || r.type === '2>>') {
        const t = await open(r.target, r.type === '2>>', r);
        if (!t) { t2 = { kind: 'null' }; continue; }
        t2 = t;
      } else if (r.type === '2>&1') {
        t2 = t1;
      } else if (r.type === 'open' && r.mode !== '<') {
        // N> file for N >= 3 on an ordinary command: the file is still created
        await open(r.target, r.mode === '>>', r);
      }
    }

    let output = '';
    const send = async (t: Target, text: string) => {
      if (!text) return;
      switch (t.kind) {
        case 'out': output += text; break;
        case 'err': stderrWriter(text.replace(/\r?\n/g, '\r\n')); break;
        case 'null': break;
        case 'fd': await this.writeToFd(t.n, text, writeStdout, stderrWriter); break;
        case 'file': files.get(t.path)!.text += text; break;
      }
    };
    await send(t1, stdout);
    await send(t2, stderr);
    for (const [path, f] of files) {
      await this.redirectWrite(path, f.shown, f.text, !f.truncate, stderrWriter);
    }

    if (isLast && output) {
      writeStdout(output.replace(/\n/g, '\r\n'));
    }
    return output;
  }

  /** Write a redirect's file; a failure (a directory, a bad path) is reported and fails the command */
  private async redirectWrite(path: string, shown: string, text: string, append: boolean, writeStderr: (s: string) => void): Promise<void> {
    try {
      if (await fifo.isFifo(this, path)) { await fifo.writeFifo(this, path, text); return; }
      // A new file is 0666 less the umask (the filesystem's default, 0644, is that for 022)
      const fresh = this.umask !== 0o022 && !(await this.fs.exists(path));
      if (append) await this.fs.appendFile(path, text);
      else await this.fs.writeFile(path, text);
      if (fresh) await this.fs.chmod?.(path, 0o666 & ~this.umask);
    } catch (e: any) {
      const msg = e?.code === 'EISDIR' || /EISDIR/.test(e?.message ?? '') ? 'Is a directory'
        : e?.code === 'ENOENT' || /ENOENT/.test(e?.message ?? '') ? 'No such file or directory' : (e?.message ?? String(e));
      writeStderr(`tabcomputer: ${shown}: ${msg}\r\n`);
      this.redirectFailed = true;
    }
  }

  /** set -o noclobber: `>` (not `>|`) refuses to overwrite an existing regular file */
  private async clobberOk(redir: Redirect, path: string, writeStderr: (s: string) => void): Promise<boolean> {
    if (redir.force || !this.options.has('noclobber')) return true;
    const st = await this.fs.stat(path).catch(() => null);
    if (st && !st.isDirectory() && st.isFile() && !st.isFIFO?.()) {
      writeStderr(`tabcomputer: ${redir.target}: cannot overwrite existing file\r\n`);
      this.redirectFailed = true;
      return false;
    }
    return true;
  }

  /** A redirection failed while applying the current command's output (its status becomes 1) */
  private redirectFailed = false;

  /**
   * Expand brace expressions: {a,b,c} → a b c, {1..5} → 1 2 3 4 5
   * Handles prefix/suffix: pre{a,b}suf → preasuf prebsuf
   * Respects quoting: '{a,b}' is literal.
   */
  private expandBraces(input: string): string {
    // Quick check: no braces at all
    if (!input.includes('{')) return input;

    // Check if any { is unquoted — if all braces are inside quotes, skip expansion
    let hasUnquotedBrace = false;
    let bSQ = false, bDQ = false;
    for (let bi = 0; bi < input.length; bi++) {
      const bc = input[bi];
      if (bc === '\\' && !bSQ) { bi++; continue; }
      if (bc === "'" && !bDQ) { bSQ = !bSQ; continue; }
      if (bc === '"' && !bSQ) { bDQ = !bDQ; continue; }
      if (bc === '{' && !bSQ && !bDQ) {
        // Skip ${...} — parameter expansion, not brace expansion
        if (bi > 0 && input[bi - 1] === '$') continue;
        hasUnquotedBrace = true;
        break;
      }
    }
    if (!hasUnquotedBrace) return input;

    // Expand each word in place, keeping its quotes (they still matter to the tokenizer)
    const expanded: string[] = [];
    for (const word of splitRawWords(input)) {
      expanded.push(...this.expandBraceToken(word));
    }
    return expanded.join(' ');
  }

  private expandBraceToken(token: string): string[] {
    // Don't expand if token contains sentinel-quoted braces or no braces
    if (token.includes('\x01') || !token.includes('{') || !token.includes('}')) return [token];

    // Find the first unquoted { and its matching }, skipping ${...} parameter expansions
    let braceStart = -1;
    let braceEnd = -1;
    let depth = 0;
    let inSQ = false, inDQ = false;
    for (let i = 0; i < token.length; i++) {
      const ch = token[i];
      if (ch === '\\') { i++; continue; }
      if (ch === "'" && !inDQ) { inSQ = !inSQ; continue; }
      if (ch === '"' && !inSQ) { inDQ = !inDQ; continue; }
      if (inSQ || inDQ) continue;
      // Skip ${...} — this is a parameter expansion, not brace expansion
      if (ch === '$' && token[i + 1] === '{') {
        let bd = 1;
        i += 2;
        while (i < token.length && bd > 0) {
          if (token[i] === '{') bd++;
          else if (token[i] === '}') bd--;
          i++;
        }
        i--; // will be incremented by the loop
        continue;
      }
      // Skip $((...)  — arithmetic
      if (ch === '$' && token[i + 1] === '(' && token[i + 2] === '(') {
        i += 2;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) braceStart = i;
        depth++;
      } else if (ch === '}' && depth > 0) {
        // (a } before any { is an ordinary character: }_{a,b})
        depth--;
        if (depth === 0) {
          // {x} (no comma, no ..) is literal: keep looking for a later brace
          const inner = token.slice(braceStart + 1, i);
          if (!/\.\.|,/.test(inner)) { braceStart = -1; continue; }
          braceEnd = i;
          break;
        }
      }
    }
    if (braceStart < 0 || braceEnd < 0) return [token];

    const prefix = token.slice(0, braceStart);
    const body = token.slice(braceStart + 1, braceEnd);
    const suffix = token.slice(braceEnd + 1);

    // Check for range: {a..z}, {1..5}, {01..10}
    const rangeMatch = body.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      // The step's sign is ignored (and 0 is 1): the direction comes from start and end
      const mag = Math.abs(rangeMatch[3] ? parseInt(rangeMatch[3]) : 1) || 1;
      const step = start <= end ? mag : -mag;
      // Zero-padded when an end has a leading zero (01, -05; not a lone 0), to the
      // wider end's width, the sign included
      const padLen = Math.max(rangeMatch[1].length, rangeMatch[2].length);
      const shouldPad = /^-?0\d/.test(rangeMatch[1]) || /^-?0\d/.test(rangeMatch[2]);
      const fmt = (n: number) => !shouldPad ? String(n) : n < 0 ? '-' + String(-n).padStart(padLen - 1, '0') : String(n).padStart(padLen, '0');
      const items: string[] = [];
      if (step > 0) {
        for (let n = start; n <= end; n += step) items.push(fmt(n));
      } else if (step < 0) {
        for (let n = start; n >= end; n += step) items.push(fmt(n));
      }
      const result: string[] = [];
      for (const item of items) {
        result.push(...this.expandBraceToken(prefix + item + suffix));
      }
      return result;
    }

    // Char range: {a..z}
    const charRange = body.match(/^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/);
    if (charRange) {
      const startCode = charRange[1].charCodeAt(0);
      const endCode = charRange[2].charCodeAt(0);
      const mag = Math.abs(charRange[3] ? parseInt(charRange[3]) : 1) || 1;
      const step = startCode <= endCode ? mag : -mag;
      const items: string[] = [];
      for (let c = startCode; step > 0 ? c <= endCode : c >= endCode; c += step) {
        items.push(String.fromCharCode(c));
      }
      const result: string[] = [];
      for (const item of items) {
        result.push(...this.expandBraceToken(prefix + item + suffix));
      }
      return result;
    }

    // Comma separated: {a,b,c}
    // Split on commas at depth 0
    const parts: string[] = [];
    let current = '';
    let partDepth = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '{') partDepth++;
      else if (ch === '}') partDepth--;
      else if (ch === ',' && partDepth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    parts.push(current);

    if (parts.length <= 1) return [token]; // No comma found, not a brace expansion

    const result: string[] = [];
    for (const part of parts) {
      result.push(...this.expandBraceToken(prefix + part + suffix));
    }
    return result;
  }

  private expandVars(line: string, quoted = false): string {
    // Walk through the string character by character, respecting quote context.
    // In single quotes: no expansion at all (bash behavior).
    // In double quotes: expand $VAR and ${VAR} but NOT ~ or $?.
    // Unquoted: expand everything. `quoted`: the whole text is in double-quote context.
    let result = '';
    let inSingle = false;
    let inDouble = quoted;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];

      // Track quotes
      if (ch === "'" && !inDouble) { inSingle = !inSingle; result += ch; i++; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; result += ch; i++; continue; }

      // Inside single quotes: everything is literal
      if (inSingle) { result += ch; i++; continue; }

      // Handle backslash (skip next char)
      if (ch === '\\' && i + 1 < line.length) { result += ch + line[i + 1]; i += 2; continue; }

      // $"…" (locale translation) is plain "…"
      if (ch === '$' && line[i + 1] === '"' && !inDouble) { i++; continue; }

      // Expand $$ (process ID)
      if (ch === '$' && line[i + 1] === '$') {
        result += String(this.shellPid);
        i += 2;
        continue;
      }

      // Expand $? (last exit code)
      if (ch === '$' && line[i + 1] === '?') {
        result += String(this.lastExitCode) + redirGuard(line[i + 2]);
        i += 2;
        continue;
      }

      // Expand $@ and $* (all positional parameters)
      // Bash behavior: "$@" with no args expands to nothing (zero words)
      if (ch === '$' && (line[i + 1] === '@' || line[i + 1] === '*')) {
        const args = this.getPositionalArgs();
        const star = line[i + 1] === '*';
        if (args.length === 0 && inDouble && !star) {
          // "$@" with no arguments is no word at all
          if (result.endsWith('"') && line[i + 2] === '"') {
            result = result.slice(0, -1);
            i += 3;
            inDouble = false;
          } else {
            i += 2;
          }
          continue;
        }
        const ifs = this.env['IFS'];
        if (inDouble) {
          // "$@": one word per argument (close and reopen the quotes between them);
          // "$*": one word, joined with the first character of IFS
          result += star
            ? protectExpansion(args.join(ifs === undefined ? ' ' : ifs.slice(0, 1)))
            : args.map(protectExpansion).join('" "');
        } else {
          result += args.map((a) => splitFields(a, ifs)).filter((f) => f !== '').join(' ');
        }
        i += 2;
        continue;
      }

      // $- (the shell's single-letter options)
      if (ch === '$' && line[i + 1] === '-') {
        result += this.optionFlags();
        i += 2;
        continue;
      }

      // $! (pid of the last background job)
      if (ch === '$' && line[i + 1] === '!') {
        result += this.env['!'] ?? '';
        i += 2;
        continue;
      }

      // Expand $# (number of positional parameters)
      if (ch === '$' && line[i + 1] === '#') {
        result += this.env['#'] ?? '0';
        i += 2;
        continue;
      }

      // Expand $0-$9 (positional parameters)
      if (ch === '$' && line[i + 1] >= '0' && line[i + 1] <= '9') {
        if (this.env[line[i + 1]] === undefined && this.options.has('nounset')) throw new UnboundVariable(line[i + 1]);
        const v = this.env[line[i + 1]] ?? '';
        result += (inDouble ? protectExpansion(v) : splitFields(v, this.fieldIFS())) + redirGuard(line[i + 2]);
        i += 2;
        continue;
      }

      // Expand ${VAR} and parameter expansion operators
      if (ch === '$' && line[i + 1] === '{') {
        // Count brace depth to find matching }
        let depth = 0;
        let j = i + 1;
        let braceInSQ = false, braceInDQ = false;
        while (j < line.length) {
          const bc = line[j];
          if (bc === '\\' && !braceInSQ) { j += 2; continue; }
          if (bc === "'" && !braceInDQ) braceInSQ = !braceInSQ;
          else if (bc === '"' && !braceInSQ) braceInDQ = !braceInDQ;
          else if (!braceInSQ && !braceInDQ) {
            if (bc === '{') depth++;
            else if (bc === '}') { depth--; if (depth === 0) break; }
          }
          j++;
        }
        if (depth === 0 && j < line.length) {
          let inner = line.slice(i + 2, j); // content between ${ and }
          if (!validParamExpansion(inner)) throw new LineAbort(`\${${inner}}: bad substitution`);
          if (this.options.has('nounset')) this.checkBound(inner);
          // ${#} ${?} ${$} ${!} ${-}: the special parameters, braced
          if (/^[#?$!-]$/.test(inner)) {
            result += this.expandVars('$' + inner, inDouble);
            i = j + 1;
            continue;
          }
          // ${!ref} of a nameref: the name it refers to (bash inverts ${!…} for them)
          const refName = /^!([A-Za-z_][A-Za-z0-9_]*)$/.exec(inner);
          if (refName && this.namerefs.has(refName[1])) {
            result += inDouble ? protectExpansion(this.namerefs.get(refName[1])!) : this.namerefs.get(refName[1])!;
            i = j + 1;
            continue;
          }
          // ${!ref…}: the variable named by $ref (ref=a, a[0] or a[@]) with the rest applied
          const ind = /^!([A-Za-z_][A-Za-z0-9_]*(?:\[(?![@*]\])[^\]]*\])?|[0-9]+)((?![@*]$)[\s\S]*)$/.exec(inner);
          if (ind && !/^\[[@*]\]/.test(ind[2]) && !/^![A-Za-z_][A-Za-z0-9_]*[@*]$/.test(inner) && !this.namerefs.has(ind[1])) {
            const sub = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]*)\]$/.exec(ind[1]);
            const target = (sub ? this.getVar(sub[1], sub[2]) : this.getVar(ind[1])) ?? '';
            if (/^[#?$!-]$/.test(target) && !ind[2]) { result += this.expandVars('$' + target, inDouble); i = j + 1; continue; }
            if (/^([A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?|[0-9]+|[@*#?$!-])$/.test(target)) inner = target + ind[2];
            else if (target === '' && /^@[A-Za-z]$/.test(ind[2])) { i = j + 1; continue; } // (bash: nothing)
            else if (target === '' && (sub ? this.getVar(sub[1], sub[2]) : this.getVar(ind[1])) === undefined) throw new LineAbort(`${ind[1]}: invalid indirect expansion`);
            else throw new LineAbort(`${target}: invalid variable name`);
          }
          // ${x:-${a[@]}} / ${x:+"$@"}…: a word that is just a list expansion stays a list
          const listWord = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?(:?)([-+])("?)(?:\$\{([A-Za-z_][A-Za-z0-9_]*\[[@*]\]|[@*])\}|\$([@*]))\5$/.exec(inner);
          if (listWord && (inDouble || !listWord[5])) {
            const v = this.getVar(listWord[1], listWord[2]);
            const set = v !== undefined && (listWord[3] === '' || v !== '');
            if (set === (listWord[4] === '+')) inner = listWord[6] ?? listWord[7];
          }
          // Inside "…" the word of ${x-word} is double-quoted too: its own " only
          // group, ' is literal, \ escapes $ ` " \ } (and the value stays one field)
          const dqOp = inDouble ? /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[#?$!-])(:?)([-=+?])([\s\S]*)$/.exec(inner) : null;
          if (dqOp && /["'$`]|\\\}/.test(dqOp[4])) {
            const [, name, colon, op, operand] = dqOp!;
            const val = this.getVar(name);
            const use = (val === undefined || (colon !== '' && val === '')) !== (op === '+');
            if (!use) {
              result += op === '+' ? '' : protectExpansion(val ?? '');
            } else {
              let text = '';
              for (let k = 0; k < operand.length; k++) {
                if (operand[k] === '\\' && k + 1 < operand.length) { text += operand[k] + operand[++k]; continue; }
                if (operand[k] !== '"') text += operand[k];
              }
              const word = this.expandVars(text, true).replace(/\\([$`"\\}])/g, '$1');
              if (op === '?') throw new Error(`${name}: ${restoreExpansion(word) || 'parameter not set'}`);
              if (op === '=') { const err = this.setVar(name, restoreExpansion(word)); if (err) throw new Error(err); }
              result += protectExpansion(word);
            }
            i = j + 1;
            continue;
          }
          const ref = this.expandArrayRef(inner);
          if (ref && 'list' in ref) {
            const vals = ref.list;
            if (inDouble && !ref.star) {
              if (vals.length === 0 && result.endsWith('"') && line[j + 1] === '"') {
                // "${a[@]}" of no elements is no word at all
                result = result.slice(0, -1);
                inDouble = false;
                i = j + 2;
                continue;
              }
              result += vals.map(protectExpansion).join('" "');
            } else if (inDouble) {
              const ifs = this.env['IFS'];
              result += protectExpansion(vals.join(ifs === undefined ? ' ' : ifs.slice(0, 1)));
            } else {
              result += vals.map((v) => splitFields(v, this.fieldIFS())).filter((f) => f !== '').join(' ');
            }
            i = j + 1;
            continue;
          }
          if (ref) {
            result += ref.raw ? ref.text : inDouble ? protectExpansion(ref.text) : splitFields(ref.text, this.fieldIFS());
            i = j + 1;
            continue;
          }
          // ${x-word} and friends: is the word used (shell text) or the variable's value (data)?
          const wo = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(:?)([-=+?])/.exec(inner);
          let wordUsed = !!wo;
          if (wo && /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/.test(wo[1])) {
            const v = this.getVar(wo[1]);
            const set = v !== undefined && (wo[2] === '' || v !== '');
            wordUsed = wo[3] === '+' ? set : !set;
          }
          const expanded = this.expandParamExpression(inner);
          if (expanded !== null) {
            // The value is data, except for ${x-word} ${x=word} ${x+word} ${x?word},
            // whose word was expanded as shell text (its quotes still to be removed)
            result += wordUsed ? (inDouble ? expanded : this.splitWordText(expanded))
              : inDouble ? protectExpansion(expanded) : splitFields(expanded, this.fieldIFS());
            i = j + 1;
            continue;
          }
        }
      }

      // Expand $VAR (including special dynamic variables)
      if (ch === '$') {
        const m = line.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
        if (m) {
          const varName = m[1];
          // Dynamic special variables
          if (varName === 'RANDOM') { result += String(Math.floor(Math.random() * 32768)); i += m[0].length; continue; }
          if (varName === 'BASH_VERSION') { result += '5.0.0'; i += m[0].length; continue; }
          if (varName === 'HOSTNAME' && this.env['HOSTNAME'] === undefined) { result += activeProfile().hostname; i += m[0].length; continue; }
          if (varName === 'OSTYPE' && this.env['OSTYPE'] === undefined) { result += 'linux-gnu'; i += m[0].length; continue; }
          // Read-only: an assignment or the environment doesn't change them
          if (varName === 'PPID') { result += String(this.parentPid); i += m[0].length; continue; }
          if (varName === 'UID' || varName === 'EUID') { result += '1000'; i += m[0].length; continue; }
          if (varName === 'BASHPID') { result += String(this.bashPid); i += m[0].length; continue; }
          if (varName === 'BASH_SUBSHELL' && this.env['BASH_SUBSHELL'] === undefined) { result += '0'; i += m[0].length; continue; }
          if (varName === 'LINENO') { result += (this.env['LINENO'] || '1'); i += m[0].length; continue; }
          if (varName === 'SECONDS') { result += String(Math.floor(performance.now() / 1000)); i += m[0].length; continue; }
          if (varName === 'EPOCHSECONDS') { result += String(Math.floor(Date.now() / 1000)); i += m[0].length; continue; }
          if (varName === 'EPOCHREALTIME') { const now = Date.now(); result += `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, '0')}`; i += m[0].length; continue; }
          // Resolve namerefs: if varName is a nameref, follow it
          const ref = this.derefName(varName);
          const resolved = ref?.name ?? varName;
          const val = ref?.sub !== undefined ? this.getVar(resolved, ref.sub) : ref ? this.env[resolved] ?? this.scalarOf(resolved) : undefined;
          if (this.options.has('nounset') && val === undefined) throw new UnboundVariable(varName);
          const v = val ?? '';
          result += (inDouble ? protectExpansion(v) : splitFields(v, this.fieldIFS())) + redirGuard(line[i + m[0].length]);
          i += m[0].length;
          continue;
        }
      }

      // Tilde expansion (only unquoted, not inside operators like =~)
      if (ch === '~' && !inDouble) {
        const before = i === 0 ? '' : line[i - 1];
        const after = line[i + 1] || '';
        // Only expand after = in assignment context (VAR=~), not in operators like =~
        const isAssignContext = before === '=' ? (i >= 2 && /[A-Za-z0-9_\]]/.test(line[i - 2])) : true;
        // In an assignment's value a ~ after : expands too (PATH=$PATH:~/bin)
        const wordStart = Math.max(line.lastIndexOf(' ', i), line.lastIndexOf('\t', i), line.lastIndexOf('\n', i)) + 1;
        const afterColon = before === ':' && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(line.slice(wordStart, i));
        if ((i === 0 || /[\s=]/.test(before) || afterColon) && isAssignContext) {
          // ~+ expands to $PWD, ~- expands to $OLDPWD
          if (after === '+' && (/[\/\s;|&>]/.test(line[i + 2] || '') || i + 2 >= line.length)) {
            result += tildeText(this.env['PWD'] || this.cwd);
            i += 2;
            continue;
          }
          if (after === '-' && (/[\/\s;|&>]/.test(line[i + 2] || '') || i + 2 >= line.length)) {
            result += tildeText(this.env['OLDPWD'] || this.cwd);
            i += 2;
            continue;
          }
          if (/[\/\s;|&>]/.test(after) || i + 1 >= line.length || (after === ':' && (afterColon || before === '='))) {
            const home = this.env['HOME'] ?? '/home/user';
            result += tildeText(home);
            i++;
            continue;
          }
        }
      }

      result += ch;
      i++;
    }
    return result;
  }

  /** Element 0 of an array NAME (what $NAME is), undefined if NAME is no array */
  private scalarOf(name: string): string | undefined {
    return this.arrays.get(name)?.[0] ?? this.assocArrays.get(name)?.get('0');
  }

  /** ${NAME[...]...}: a list of words for [@]/[*], text otherwise; null if not an array reference */
  private expandArrayRef(inner: string): { list: string[]; star: boolean } | { text: string; raw: boolean } | null {
    // ${!prefix@} / ${!prefix*}: names of the variables starting with prefix
    const names = /^!([A-Za-z_][A-Za-z0-9_]*)([@*])$/.exec(inner);
    if (names) {
      const all = new Set([...Object.keys(this.env), ...this.arrays.keys(), ...this.assocArrays.keys()]);
      const list = [...all].filter((k) => k.startsWith(names[1]) && /^[A-Za-z_]/.test(k)).sort();
      // (bash joins ${!prefix*} even unquoted when IFS is empty)
      if (names[2] === '*' && this.env['IFS'] === '') return { text: list.join(''), raw: false };
      return { list, star: names[2] === '*' };
    }
    if (inner === '@' || inner === '*') return { list: this.getPositionalArgs(), star: inner === '*' };
    // ${@@Q} ${*@a}…: each positional parameter transformed
    const pop = /^([@*])@([QEPAKkaULu])$/.exec(inner);
    if (pop) return { list: this.getPositionalArgs().map((v) => this.transformParam(pop[2], v, null)), star: pop[1] === '*' };
    // ${@-word} ${@:-word} ${*+word} …: set means at least one parameter
    const pdef = /^([@*])(:?)([-+])([\s\S]*)$/.exec(inner);
    if (pdef) {
      const args = this.getPositionalArgs();
      const star = pdef[1] === '*';
      const unset = args.length === 0;
      const check = pdef[2] ? unset || args.join(star ? (this.env['IFS'] ?? ' ').slice(0, 1) : ' ') === '' : unset;
      if (pdef[3] === '+') return { text: check ? '' : this.expandVars(pdef[4]), raw: true };
      return check ? { text: this.expandVars(pdef[4]), raw: true } : { list: args, star };
    }
    // ${@:off:len} / ${*:off:len}: offset 0 is $0
    if (/^[@*]:(?![-=+?])/.test(inner)) {
      const args = this.getPositionalArgs();
      const pairs: [number, string][] = [[0, this.env['0'] ?? activeProfile().hostname], ...args.map((a, k): [number, string] => [k + 1, a])];
      return { list: this.sliceList(pairs, args.length + 1, inner.slice(2)), star: inner[0] === '*' };
    }
    const m = /^([!#]?)([A-Za-z_][A-Za-z0-9_]*)\[/.exec(inner);
    if (!m) return null;
    let depth = 0, close = m[0].length - 1;
    for (; close < inner.length; close++) {
      if (inner[close] === '[') depth++;
      else if (inner[close] === ']' && --depth === 0) break;
    }
    if (close >= inner.length) return null;
    const [, prefix, rawName] = m;
    const name = this.refTarget(rawName);
    const sub = inner.slice(m[0].length, close);
    const op = inner.slice(close + 1);
    const assoc = this.assocArrays.get(name);
    const arr = this.arrays.get(name);
    let keys: string[];
    let get: (k: string) => string | undefined;
    if (assoc) { keys = [...assoc.keys()]; get = (k) => assoc.get(k); }
    else if (arr) { keys = Object.keys(arr); get = (k) => arr[Number(k)]; }
    else if (this.env[name] !== undefined) { const v = this.env[name]; keys = ['0']; get = (k) => (k === '0' ? v : undefined); }
    else { keys = []; get = () => undefined; }
    const arith = (e: string) => {
      try { return Number(this.evalArithBig(e)); } catch (err) { if (err instanceof ArithError) throw new LineAbort(err.message); throw err; }
    };

    if (sub === '@' || sub === '*') {
      const star = sub === '*';
      if (prefix === '!') {
        const ktr = /^@([QEPAKkaULu])$/.exec(op);
        if (ktr) return { list: keys.map((k) => this.transformParam(ktr[1], k, null)), star };
        return op ? null : { list: keys, star };
      }
      if (prefix === '#') return op ? null : { text: String(keys.length), raw: false };
      const vals = keys.map((k) => get(k)!);
      if (!op) return { list: vals, star };
      const tr = /^@([QEPAKkaULu])$/.exec(op);
      if (tr) {
        if (tr[1] === 'A') return { text: keys.length ? this.declareLine(name) ?? '' : '', raw: false };
        if (tr[1] === 'K' || tr[1] === 'k') {
          const pairs = keys.flatMap((k) => [assoc ? quoteKey(k) : k, dquote(get(k)!)]);
          return tr[1] === 'k' ? { list: pairs, star } : { text: pairs.join(' '), raw: false };
        }
        return { list: vals.map((v) => this.transformParam(tr[1], v, name)), star };
      }
      const slice = /^:(?![-=+?])([\s\S]*)$/.exec(op);
      if (slice) {
        const pairs: [number, string][] = arr ? keys.map((k) => [Number(k), get(k)!]) : vals.map((v, k) => [k, v]);
        return { list: this.sliceList(pairs, arr ? arrayTop(arr) : vals.length, slice[1]), star };
      }
      const def = /^(:?)([-+])([\s\S]*)$/.exec(op);
      if (def) {
        const unset = keys.length === 0;
        const check = def[1] ? unset || vals.join(star ? (this.env['IFS'] ?? ' ').slice(0, 1) : ' ') === '' : unset;
        if (def[2] === '+') return { text: check ? '' : this.expandVars(def[3]), raw: true };
        return check ? { text: this.expandVars(def[3]), raw: true } : { list: vals, star };
      }
      if (/^:?[=?]/.test(op)) return null;
      const out: string[] = [];
      for (const v of vals) {
        const r = this.applyParamOp(v, op);
        if (r === null) return null;
        out.push(restoreExpansion(r));
      }
      return { list: out, star };
    }

    let v: string | undefined;
    try { v = this.getVar(name, sub); } catch (e) { if (e instanceof ArithError) throw new LineAbort(e.message); throw e; }
    if (prefix === '#') return op ? null : { text: String([...(v ?? '')].length), raw: false };
    if (prefix === '!') return null;
    if (!op) return { text: v ?? '', raw: false };
    const tr1 = /^@([QEPAKkaULu])$/.exec(op);
    if (tr1) return { text: v === undefined && tr1[1] !== 'a' ? '' : this.transformParam(tr1[1], v, name), raw: false };
    if (/^:?=/.test(op)) {
      const colon = op.startsWith(':');
      if (v === undefined || (colon && v === '')) {
        const word = restoreExpansion(this.expandVars(op.slice(colon ? 2 : 1)));
        this.setVar(name, word, sub);
        return { text: word, raw: false };
      }
      return { text: v, raw: false };
    }
    const r = this.applyParamOp(v, op);
    return r === null ? null : { text: r, raw: true };
  }

  /** Elements of an [index, value] list from OFFSET[:LENGTH] (arithmetic; a negative offset counts back from top) */
  private sliceList(pairs: [number, string][], top: number, spec: string): string[] {
    const arith = (e: string) => {
      try { return Number(this.evalArithBig(e)); } catch (err) { if (err instanceof ArithError) throw new LineAbort(err.message); throw err; }
    };
    const [offE, lenE] = splitSliceSpec(spec);
    let off = arith(offE);
    if (off < 0) off += top;
    if (off < 0) return [];
    let picked = pairs.filter(([k]) => k >= off).map(([, v]) => v);
    if (lenE !== undefined) {
      const len = arith(lenE);
      if (len < 0) throw new Error(`${lenE.trim()}: substring expression < 0`);
      picked = picked.slice(0, len);
    }
    return picked;
  }

  /**
   * The word of an unquoted ${x-word}/${x:+word}: its unquoted literal text is
   * field-split like an expansion's value (IFS characters separate, other
   * blanks are kept); quoted parts stay as they are.
   */
  private splitWordText(text: string): string {
    const ifs = this.fieldIFS() ?? ' \t\n';
    if (ifs === ' \t\n') return text;
    let out = '';
    let q = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { out += c; if (c === '\\' && q === '"') out += text[++i] ?? ''; else if (c === q) q = ''; continue; }
      if (c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue; }
      if (c === "'" || c === '"') { q = c; out += c; continue; }
      if (ifs.includes(c)) out += ' ';
      else if (c === ' ' || c === '\t' || c === '\n') out += BLANK_PROTECT[c];
      else out += c;
    }
    return out;
  }

  /** ${NAME<op>} applied to a value (an array element) instead of a variable */
  private applyParamOp(value: string | undefined, op: string): string | null {
    const SCRATCH = '__shiro_elem';
    const saved = this.env[SCRATCH];
    if (value === undefined) delete this.env[SCRATCH]; else this.env[SCRATCH] = value;
    try {
      return this.expandParamExpression(SCRATCH + op);
    } finally {
      if (saved === undefined) delete this.env[SCRATCH]; else this.env[SCRATCH] = saved;
    }
  }

  /**
   * ${x@OP} of one value (`name`: the variable it came from, for @a and @A;
   * null for $1, $@, $?…). An unset value expands to nothing.
   */
  private transformParam(op: string, v: string | undefined, name: string | null): string {
    if (op === 'a') return name ? this.attrFlags(name) : '';
    if (v === undefined) return '';
    switch (op) {
      case 'Q': case 'K': case 'k': return quoteReusable(v);
      case 'E': return decodeAnsiC(v);
      case 'P': return this.expandPrompt(v);
      case 'U': return v.toUpperCase();
      case 'u': return v.length > 0 ? v[0].toUpperCase() + v.slice(1) : '';
      case 'L': return v.toLowerCase();
      case 'A': {
        if (!name) return quoteReusable(v);
        const f = this.attrFlags(name);
        return `${f ? `declare -${f} ` : ''}${name}=${quoteReusable(v)}`;
      }
      default: return v;
    }
  }

  /** A variable's attributes as ${x@a} and declare -p list them (bash's order); `deref`: of a nameref's target */
  attrFlags(name: string, deref = true): string {
    const isRef = this.namerefs.has(name);
    if (deref) name = this.refTarget(name);
    const attrs = this.varAttrs.get(name);
    let f = '';
    if (this.arrays.has(name)) f += 'a';
    if (this.assocArrays.has(name)) f += 'A';
    if (attrs?.has('i')) f += 'i';
    if (!deref && isRef) f += 'n';
    if (this.readonlyVars.has(name)) f += 'r';
    if ((this.env[name] !== undefined && !this.localVars.has(name)) || this.exportedUnset.has(name)) f += 'x';
    if (attrs?.has('l')) f += 'l';
    if (attrs?.has('u')) f += 'u';
    return f;
  }

  /** PS1-style prompt expansion (${x@P}): \u \h \H \w \W \$ \n \t \d \s \v \nnn … */
  expandPrompt(text: string): string {
    const home = this.env.HOME;
    const pwd = this.env.PWD ?? this.cwd;
    const host = this.env.HOSTNAME ?? activeProfile().hostname;
    const now = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c !== '\\' || i + 1 >= text.length) { out += c; continue; }
      const e = text[++i];
      switch (e) {
        case 'u': out += this.env.USER ?? 'user'; break;
        case 'h': out += host.split('.')[0]; break;
        case 'H': out += host; break;
        case 'w': out += home && (pwd === home || pwd.startsWith(home + '/')) ? '~' + pwd.slice(home.length) : pwd; break;
        case 'W': out += home && pwd === home ? '~' : pwd === '/' ? '/' : pwd.slice(pwd.lastIndexOf('/') + 1); break;
        case '$': out += (this.env.EUID ?? this.env.UID) === '0' ? '#' : '$'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 'a': out += '\x07'; break;
        case 'e': out += '\x1b'; break;
        case 's': out += 'bash'; break;
        case 'v': out += '5.2'; break;
        case 'V': out += '5.2.21'; break;
        case 't': out += `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`; break;
        case 'T': out += `${two(now.getHours() % 12 || 12)}:${two(now.getMinutes())}:${two(now.getSeconds())}`; break;
        case 'A': out += `${two(now.getHours())}:${two(now.getMinutes())}`; break;
        case 'd': out += now.toDateString().slice(0, 10); break;
        case '[': case ']': break;
        case '\\': out += '\\'; break;
        default:
          if (/[0-7]/.test(e)) {
            const m = /^[0-7]{1,3}/.exec(text.slice(i))![0];
            out += String.fromCharCode(parseInt(m, 8));
            i += m.length - 1;
          } else out += '\\' + e;
      }
    }
    return out;
  }

  /** `declare -p NAME` output, null if NAME is not set */
  private declareLine(name: string): string | null {
    const q = (v: string) => `"${v.replace(/(["\\$`])/g, '\\$1')}"`;
    const flags = (_base: string) => {
      const f = this.attrFlags(name, false);
      return f ? `-${f}` : '--';
    };
    const ref = this.namerefs.get(name);
    if (ref !== undefined) return ref ? `declare ${flags('')} ${name}=${q(ref)}` : `declare ${flags('')} ${name}`;
    const assoc = this.assocArrays.get(name);
    if (assoc) {
      const body = [...assoc].map(([k, v]) => `[${/^[\w.-]+$/.test(k) ? k : q(k)}]=${q(v)} `).join('');
      return `declare ${flags('A')} ${name}=(${body})`;
    }
    const arr = this.arrays.get(name);
    if (arr) {
      const body = Object.keys(arr).map((k) => `[${k}]=${q(arr[Number(k)])}`).join(' ');
      return `declare ${flags('a')} ${name}=(${body})`;
    }
    if (this.env[name] === undefined) {
      return this.declaredNames.has(name) || this.exportedUnset.has(name) ? `declare ${flags('')} ${name}` : null;
    }
    return `declare ${flags('')} ${name}=${q(this.env[name])}`;
  }

  /**
   * Expand advanced ${...} parameter expressions.
   * Supports: ${#VAR}, ${VAR#pat}, ${VAR##pat}, ${VAR%pat}, ${VAR%%pat},
   * ${VAR/pat/rep}, ${VAR//pat/rep}, ${VAR:offset}, ${VAR:offset:length},
   * ${VAR^^}, ${VAR,,}, ${VAR:-default}, ${VAR:=default}, ${VAR:+alt}, ${VAR:?err}
   */
  private expandParamExpression(inner: string): string | null {
    // ${!arr[@]} or ${!arr[*]} — array indices/keys
    const arrKeysMatch = inner.match(/^!([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/);
    if (arrKeysMatch) {
      const name = arrKeysMatch[1];
      const assoc = this.assocArrays.get(name);
      if (assoc) return Array.from(assoc.keys()).join(' ');
      const arr = this.arrays.get(name);
      return arr ? arr.map((_, i) => String(i)).join(' ') : '';
    }

    // ${#arr[@]} or ${#arr[*]} — array length
    const arrLenMatch = inner.match(/^#([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/);
    if (arrLenMatch) {
      const name = arrLenMatch[1];
      const assoc = this.assocArrays.get(name);
      if (assoc) return String(assoc.size);
      const arr = this.arrays.get(name);
      return String(arr ? arr.length : 0);
    }
    // ${#arr[N]} — length of array element
    const arrElemLenMatch = inner.match(/^#([A-Za-z_][A-Za-z0-9_]*)\[(.+)\]$/);
    if (arrElemLenMatch) {
      const name = arrElemLenMatch[1];
      const key = arrElemLenMatch[2];
      const assoc = this.assocArrays.get(name);
      if (assoc) return String((assoc.get(key) ?? '').length);
      const arr = this.arrays.get(name);
      if (arr) {
        const idx = parseInt(key, 10);
        return String((arr[idx] ?? '').length);
      }
      return '0';
    }

    // ${arr[@]:start:len} or ${arr[@]:start} — array slicing
    const arrSliceMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]:(\d+|\s+-?\d+|\(\s*-?\d+\s*\))(?::(\s*-?\d+))?$/);
    if (arrSliceMatch) {
      const name = arrSliceMatch[1];
      const assoc = this.assocArrays.get(name);
      const values = assoc ? Array.from(assoc.values()) : (this.arrays.get(name) ?? []);
      let offset = parseInt(arrSliceMatch[2].replace(/[()\s]/g, ''));
      if (offset < 0) offset = Math.max(0, values.length + offset);
      if (arrSliceMatch[3] !== undefined) {
        const len = parseInt(arrSliceMatch[3]);
        return values.slice(offset, offset + len).join(' ');
      }
      return values.slice(offset).join(' ');
    }

    // ${arr[@]/pattern/replacement} — pattern replacement on all elements
    const arrPatMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\](\/\/?)(#?%?)(.*?)\/(.*)$/);
    if (arrPatMatch) {
      const name = arrPatMatch[1];
      const doubleSlash = arrPatMatch[2] === '//';
      const anchor = arrPatMatch[3]; // # for prefix, % for suffix
      const pattern = arrPatMatch[4];
      const replacement = arrPatMatch[5];
      const assoc = this.assocArrays.get(name);
      const values = assoc ? Array.from(assoc.values()) : (this.arrays.get(name) ?? []);
      const mapped = values.map(v => {
        if (anchor === '#') {
          // Prefix replacement
          const re = new RegExp('^' + this.globToRegex(pattern));
          return v.replace(re, replacement);
        } else if (anchor === '%') {
          // Suffix replacement
          const re = new RegExp(this.globToRegex(pattern) + '$');
          return v.replace(re, replacement);
        } else if (doubleSlash) {
          // Replace all
          const re = new RegExp(this.globToRegex(pattern), 'g');
          return v.replace(re, replacement);
        } else {
          // Replace first
          const re = new RegExp(this.globToRegex(pattern));
          return v.replace(re, replacement);
        }
      });
      return mapped.join(' ');
    }

    // ${arr[@]} or ${arr[*]} — all array elements (space-separated)
    const arrAllMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/);
    if (arrAllMatch) {
      const name = arrAllMatch[1];
      const assoc = this.assocArrays.get(name);
      if (assoc) return Array.from(assoc.values()).join(' ');
      const arr = this.arrays.get(name);
      return arr ? arr.join(' ') : '';
    }

    // ${arr[key]} — indexed or associative array access
    const arrIdxMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.+)\]$/);
    if (arrIdxMatch) {
      const name = arrIdxMatch[1];
      const key = arrIdxMatch[2];
      // Associative array?
      const assoc = this.assocArrays.get(name);
      if (assoc) return assoc.get(key) ?? '';
      // Indexed array (support negative indices: arr[-1] = last element)
      const arr = this.arrays.get(name);
      let idx = parseInt(key, 10);
      if (arr && !isNaN(idx)) {
        if (idx < 0) idx = arr.length + idx;
        if (idx >= 0 && idx < arr.length) return arr[idx];
      }
      return '';
    }

    // ${#VAR} — string length
    const lenMatch = inner.match(/^#([A-Za-z_][A-Za-z0-9_]*)$/);
    if (lenMatch) {
      // (an array's is its element 0's)
      return String([...(this.getVar(lenMatch[1]) ?? '')].length);
    }

    // ${!prefix*} or ${!prefix@} — list variable names matching prefix
    const prefixMatch = inner.match(/^!([A-Za-z_][A-Za-z0-9_]*)[*@]$/);
    if (prefixMatch) {
      const prefix = prefixMatch[1];
      const matching = Object.keys(this.env).filter(k => k.startsWith(prefix)).sort();
      return matching.join(' ');
    }

    // ${!VAR} — indirect expansion (value of variable named by VAR's value)
    const indirectMatch = inner.match(/^!([A-Za-z_][A-Za-z0-9_]*)$/);
    if (indirectMatch) {
      const ref = this.env[indirectMatch[1]] ?? '';
      return this.env[ref] ?? '';
    }

    // ${VAR^^pattern} — uppercase all (matching pattern, default: ?)
    const ucMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\^\^(.*)$/);
    if (ucMatch) {
      const val = this.env[ucMatch[1]] ?? '';
      const pat = ucMatch[2] || '?';
      const re = new RegExp('^' + this.globToRegex(pat) + '$');
      return val.split('').map(c => re.test(c) ? c.toUpperCase() : c).join('');
    }

    // ${VAR^pattern} — capitalize first matching character (default: ?)
    const ucFirstMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\^(.*)$/);
    if (ucFirstMatch) {
      const val = this.env[ucFirstMatch[1]] ?? '';
      if (val.length === 0) return '';
      const pat = ucFirstMatch[2] || '?';
      const re = new RegExp('^' + this.globToRegex(pat) + '$');
      return (re.test(val[0]) ? val[0].toUpperCase() : val[0]) + val.slice(1);
    }

    // ${VAR,,pattern} — lowercase all (matching pattern, default: ?)
    const lcMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*),,(.*)$/);
    if (lcMatch) {
      const val = this.env[lcMatch[1]] ?? '';
      const pat = lcMatch[2] || '?';
      const re = new RegExp('^' + this.globToRegex(pat) + '$');
      return val.split('').map(c => re.test(c) ? c.toLowerCase() : c).join('');
    }

    // ${VAR,pattern} — lowercase first matching character (default: ?)
    const lcFirstMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*),(.*)$/);
    if (lcFirstMatch) {
      const val = this.env[lcFirstMatch[1]] ?? '';
      if (val.length === 0) return '';
      const pat = lcFirstMatch[2] || '?';
      const re = new RegExp('^' + this.globToRegex(pat) + '$');
      return (re.test(val[0]) ? val[0].toLowerCase() : val[0]) + val.slice(1);
    }

    // ${VAR:offset} and ${VAR:offset:length} — substring (arithmetic; a negative
    // offset counts from the end, a negative length is an end position from the end).
    // ${x:-1} is a default value: a negative offset is written ${x: -1} or ${x:(-1)}
    const subMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+):(?![-=+?])([\s\S]*)$/);
    if (subMatch) {
      const chars = [...(this.env[subMatch[1]] ?? this.scalarOf(subMatch[1]) ?? '')];
      const [offE, lenE] = splitSliceSpec(subMatch[2]);
      const arith = (e: string) => {
        try { return Number(this.evalArithBig(e)); } catch (err) { if (err instanceof ArithError) throw new LineAbort(err.message); throw err; }
      };
      let offset = arith(offE);
      if (offset < 0) offset += chars.length;
      if (offset < 0 || offset > chars.length) return '';
      if (lenE === undefined) return chars.slice(offset).join('');
      let end = arith(lenE);
      end = end < 0 ? chars.length + end : offset + end;
      if (end < offset) throw new Error(`${lenE.trim()}: substring expression < 0`);
      return chars.slice(offset, end).join('');
    }

    // ${VAR/pat/rep}, ${VAR//pat/rep}, ${VAR/#pat/rep}, ${VAR/%pat/rep}
    const subst = inner.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+)\/([/#%]?)((?:[^/\\]|\\.)*)(?:\/([\s\S]*))?$/);
    if (subst) {
      const [, name, mode, pat, repRaw] = subst;
      const val = this.env[name] ?? this.scalarOf(name) ?? '';
      const src = this.patternRegex(pat);
      const rep = this.replacementParts(repRaw ?? '');
      if (mode === '#' || mode === '%') {
        const m = new RegExp(mode === '#' ? `^(?:${src})` : `(?:${src})$`, 's').exec(val);
        if (!m) return val;
        return val.slice(0, m.index) + rep(m[0]) + val.slice(m.index + m[0].length);
      }
      if (!pat) return val;
      const re = new RegExp(`(?:${src})`, 'sy');
      let out = '';
      let done = false;
      for (let i = 0; i < val.length;) {
        re.lastIndex = i;
        const m = done ? null : re.exec(val);
        if (m && m[0].length > 0) {
          out += rep(m[0]);
          i += m[0].length;
          if (mode !== '/') done = true;
        } else {
          out += val[i++];
        }
      }
      return out;
    }

    // ${VAR#pat}, ${VAR##pat}, ${VAR%pat}, ${VAR%%pat}
    const strip = inner.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+)(##?|%%?)([\s\S]+)$/);
    if (strip) {
      const [, name, op, pat] = strip;
      const val = this.env[name] ?? this.scalarOf(name) ?? '';
      const re = new RegExp(`^(?:${this.patternRegex(pat)})$`, 's');
      const n = val.length;
      if (op === '#') { for (let k = 0; k <= n; k++) if (re.test(val.slice(0, k))) return val.slice(k); }
      else if (op === '##') { for (let k = n; k >= 0; k--) if (re.test(val.slice(0, k))) return val.slice(k); }
      else if (op === '%') { for (let k = n; k >= 0; k--) if (re.test(val.slice(k))) return val.slice(0, k); }
      else { for (let k = 0; k <= n; k++) if (re.test(val.slice(k))) return val.slice(0, k); }
      return val;
    }

    // ${VAR:-default}, ${VAR:=default}, ${VAR:+alt}, ${VAR:?err}
    const opMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!])(:?)([-=+?])(.*)$/s);
    if (opMatch) {
      const [, varName, colon, op, operand] = opMatch;
      const val = this.env[varName] ?? this.scalarOf(varName);
      const isUnset = val === undefined;
      const isEmpty = val === '';
      const check = colon ? (isUnset || isEmpty) : isUnset;
      const expandedOperand = this.expandVars(operand);
      switch (op) {
        case '-': return check ? expandedOperand : (val ?? '');
        case '=':
          if (check) {
            // The variable gets the word's value: its quotes removed
            const err = this.setVar(varName, restoreExpansion(removeQuoting(expandedOperand)));
            if (err) throw new Error(err);
            return expandedOperand;
          }
          return val ?? '';
        case '+': return check ? '' : expandedOperand;
        case '?':
          if (check) throw new Error(`${varName}: ${restoreExpansion(removeQuoting(expandedOperand)) || 'parameter not set'}`);
          return val ?? '';
      }
    }

    // ${NAME@op}, ${?@a}…: transformations (arrays and $@ go through expandArrayRef)
    const atMatch = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[#?$!-])@([QEPAKkaULu])$/.exec(inner);
    if (atMatch) {
      const [, name, op] = atMatch;
      if (/^[A-Za-z_]/.test(name)) {
        const target = this.refTarget(name);
        if (this.arrays.has(target) || this.assocArrays.has(target)) {
          const ref = this.expandArrayRef(`${name}[0]@${op}`);
          return ref && 'text' in ref ? ref.text : '';
        }
        return this.transformParam(op, this.getVar(name), target);
      }
      const v = /^[0-9]+$/.test(name) ? this.env[name] : this.expandVars('$' + name);
      return this.transformParam(op, v, null);
    }

    // Simple ${VAR}
    const simpleMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/);
    if (simpleMatch) {
      return this.env[simpleMatch[1]] ?? this.scalarOf(simpleMatch[1]) ?? '';
    }

    return null; // not recognized
  }

  /** Convert a shell glob pattern to a regex string (supports extglob when enabled) */
  /** A ${…} pattern operand as regex source: expanded; quoted parts and \\x literal, the rest glob */
  private patternRegex(raw: string): string {
    const t = this.expandVars(raw);
    let glob = '';
    let q = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      const lit = EXPANSION_RESTORE[c] ?? c;
      if (q === "'") { if (c === "'") q = ''; else glob += '\\' + lit; continue; }
      if (q === '"') {
        if (c === '"') { q = ''; continue; }
        if (c === '\\' && /[\\"$`]/.test(t[i + 1] ?? '')) { glob += '\\' + t[++i]; continue; }
        glob += '\\' + lit;
        continue;
      }
      if (c === '$' && t[i + 1] === "'") { const e = ansiCEnd(t, i); glob += [...decodeAnsiC(t.slice(i + 2, e - 1))].map((x) => '\\' + x).join(''); i = e - 1; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '\\') { glob += '\\' + (t[++i] ?? '\\'); continue; }
      glob += lit !== c ? '\\' + lit : c;
    }
    return this.globToRegex(glob);
  }

  /** The replacement of ${VAR/pat/rep}: expanded, quotes removed; an unquoted & is the match */
  private replacementParts(raw: string): (match: string) => string {
    const t = this.expandVars(raw);
    const parts: (string | null)[] = [''];
    let q = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q === "'") { if (c === "'") q = ''; else parts[parts.length - 1] += c; continue; }
      if (q === '"') {
        if (c === '"') { q = ''; continue; }
        if (c === '\\' && /[\\"$`]/.test(t[i + 1] ?? '')) { parts[parts.length - 1] += t[++i]; continue; }
        parts[parts.length - 1] += c;
        continue;
      }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '\\') { parts[parts.length - 1] += t[++i] ?? '\\'; continue; }
      if (c === '&') { parts.push(null, ''); continue; }
      parts[parts.length - 1] += c;
    }
    const fixed = parts.map((p) => (p === null ? null : restoreExpansion(p)));
    return (m) => fixed.map((p) => p ?? m).join('');
  }

  private globToRegex(pattern: string): string {
    const extglob = this.shoptopts.has('extglob');
    let result = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      // Extended glob: ?(pat|pat), *(pat|pat), +(pat|pat), @(pat|pat), !(pat|pat)
      if (extglob && '?*+@!'.includes(ch) && pattern[i + 1] === '(') {
        const close = this.findMatchingParen(pattern, i + 1);
        if (close >= 0) {
          const inner = pattern.slice(i + 2, close);
          // Recursively convert each alternative
          const alts = this.splitExtglobAlts(inner).map(a => this.globToRegex(a)).join('|');
          switch (ch) {
            case '?': result += `(?:${alts})?`; break;  // zero or one
            case '*': result += `(?:${alts})*`; break;   // zero or more
            case '+': result += `(?:${alts})+`; break;   // one or more
            case '@': result += `(?:${alts})`; break;    // exactly one
            case '!': result += `(?!(?:${alts})$).*`; break; // none of
          }
          i = close;
          continue;
        }
      }
      // A quoted character (marked by the caller) is literal
      if (ch === '\x01' && i + 1 < pattern.length) { result += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); continue; }
      if (ch === '*') { result += '.*'; continue; }
      if (ch === '?') { result += '.'; continue; }
      if (ch === '[') {
        const b = bracketToRegex(pattern, i, true);
        if (!b) { result += '\\['; continue; } // no closing ]: a literal [
        result += b.re;
        i = b.end;
        continue;
      }
      // \x matches x literally
      if (ch === '\\' && i + 1 < pattern.length) { const n = pattern[++i]; result += /[\w\s]/.test(n) ? n : '\\' + n; continue; }
      // Escape regex special characters
      if ('.+^${}()|\\[]'.includes(ch)) { result += '\\' + ch; continue; }
      result += ch;
    }
    return result;
  }

  /** Find matching closing paren for extglob, handling nesting */
  private findMatchingParen(s: string, openPos: number): number {
    let depth = 1;
    for (let i = openPos + 1; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  /** Split extglob alternatives on top-level | (not inside nested parens) */
  private splitExtglobAlts(s: string): string[] {
    const alts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      else if (s[i] === '|' && depth === 0) {
        alts.push(s.slice(start, i));
        start = i + 1;
      }
    }
    alts.push(s.slice(start));
    return alts;
  }

  private parseHeredoc(input: string): { command: string; body: string } | null {
    // Match <<DELIM, <<'DELIM', <<"DELIM", or <<-DELIM patterns
    const lines = input.split(/\r?\n/);
    if (lines.length < 2) return null;

    // Find <<DELIM on the first line (could be anywhere in the command)
    const heredocMatch = lines[0].match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|(\S+))/);
    if (!heredocMatch) return null;

    const delimiter = heredocMatch[1] || heredocMatch[2] || heredocMatch[3];
    const quoted = !!(heredocMatch[1] || heredocMatch[2]);
    const stripTabs = lines[0].match(/<<-/) !== null;

    // Remove the <<DELIM token from the command line
    const command = lines[0].replace(/<<-?\s*(?:'[^']+'|"[^"]+"|(\S+))/, '').trim();

    // Collect body lines until we find the delimiter on its own line
    const bodyLines: string[] = [];
    let found = false;
    let delimiterIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
      if (line.trim() === delimiter) {
        found = true;
        delimiterIndex = i;
        break;
      }
      bodyLines.push(line);
    }

    if (!found) return null;

    // Capture any commands after the closing delimiter line
    let finalCommand = command;
    const remaining = lines.slice(delimiterIndex + 1).map(l => l.trim()).filter(Boolean);
    if (remaining.length > 0) {
      finalCommand = finalCommand + ' && ' + remaining.join(' && ');
    }

    let body = bodyLines.join('\n');
    // If delimiter was not quoted, expand variables
    if (!quoted) {
      body = restoreExpansion(this.expandVars(body));
    }
    // Add trailing newline (standard heredoc behavior)
    body += '\n';

    return { command: finalCommand, body };
  }

  private parseCompound(line: string): { operator: '' | '&&' | '||' | ';'; command: string }[] {
    const result: { operator: '' | '&&' | '||' | ';'; command: string }[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let currentOp: '' | '&&' | '||' | ';' = '';
    let depth = 0; // track control structure nesting (do/done, then/fi, {/})
    let braceDepth = 0; // track only { } brace groups (not ${VAR})
    let parenDepth = 0; // track subshell ( ... ) nesting separately
    let cmdPos = true; // the next word starts a command, so it may be a reserved word
    let i = 0;

    while (i < line.length) {
      const ch = line[i];

      if (ch === '\\' && !inSingle && i + 1 < line.length) {
        current += ch + line[i + 1];
        i += 2;
        continue;
      }

      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }
      // ${…} is one word: ; & | inside it are not operators
      if (ch === '$' && line[i + 1] === '{' && !inSingle) {
        const end = skipParamBrace(line, i + 1);
        current += line.slice(i, end);
        i = end;
        cmdPos = false;
        continue;
      }
      // So is `…`
      if (ch === '`' && !inSingle) {
        let end = i + 1;
        while (end < line.length && line[end] !== '`') end += line[end] === '\\' ? 2 : 1;
        if (end < line.length) {
          current += line.slice(i, end + 1);
          i = end + 1;
          cmdPos = false;
          continue;
        }
      }

      // [[ … ]] is one command: && || ( ) inside it belong to the expression
      if (!inSingle && !inDouble && cmdPos && ch === '[' && line[i + 1] === '[') {
        const end = doubleBracketEnd(line, i);
        if (end > 0) { current += line.slice(i, end); i = end; cmdPos = false; continue; }
      }

      if (!inSingle && !inDouble) {
        // Track subshell parenthesized groups: ( ... )
        // Only count '(' at operator positions (after whitespace/;/start), not after $ or word chars
        const prevCh = i > 0 ? line[i - 1] : ' ';
        if (ch === '(' && !/\w/.test(prevCh)) {
          parenDepth++;
          cmdPos = true; // a command (maybe `case`) starts inside ( or $(
          current += ch; i++; continue;
        }
        if (ch === ')' && parenDepth > 0) {
          parenDepth--;
          cmdPos = true; // after a subshell or a `( pattern )`: a command or keyword
          current += ch; i++; continue;
        }

        // Track {/} brace groups and function bodies
        if (ch === '{') {
          // A brace group's { is a word of its own (not ${VAR} or {a,b})
          const prevBrace = i > 0 ? line[i - 1] : ' ';
          if ((/[\s;)|&]/.test(prevBrace) || i === 0) && /^[\s]/.test(line[i + 1] ?? '')) { depth++; braceDepth++; }
          current += ch; i++; continue;
        }
        if (ch === '}') {
          // Its } ends a command list (`{ echo }; }`: the first } is an argument)
          const before = current.replace(/[ \t]+$/, '');
          const closes = /(^|[;&\n{}]|\bdone|\bfi|\besac)$/.test(before) && /^($|[\s;&|)<>])/.test(line.slice(i + 1));
          if (braceDepth > 0 && closes) { depth--; braceDepth--; }
          current += ch; i++; continue;
        }

        // Track control structure keywords to avoid splitting inside them. Only
        // words in command position are keywords (`echo done` is an argument).
        if ((/[\s;&|()]/.test(prevCh) || i === 0) && !/[\s;&|()]/.test(ch)) {
          const word = (/^[^\s;&|()<>]+/.exec(line.slice(i)) || [''])[0];
          if (cmdPos) {
            if (word === 'for' || word === 'while' || word === 'until' || word === 'select' || word === 'if' || word === 'case') depth++;
            else if (word === 'done' || word === 'fi' || word === 'esac') depth--;
          }
          cmdPos = cmdPos && ['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time'].includes(word);
        } else if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
          cmdPos = true;
        }

        if (depth <= 0 && parenDepth <= 0) {
          if (ch === '&' && line[i + 1] === '&') {
            if (trimCommand(current)) result.push({ operator: currentOp, command: trimCommand(current) });
            currentOp = '&&';
            current = '';
            i += 2;
            continue;
          }
          if (ch === '|' && line[i + 1] === '|') {
            if (trimCommand(current)) result.push({ operator: currentOp, command: trimCommand(current) });
            currentOp = '||';
            current = '';
            i += 2;
            continue;
          }
          if (ch === ';') {
            if (trimCommand(current)) result.push({ operator: currentOp, command: trimCommand(current) });
            currentOp = ';';
            current = '';
            i++;
            continue;
          }
          // `cmd & next`: cmd runs in the background (it keeps its trailing &)
          if (ch === '&' && line[i + 1] !== '>' && !/[<>&|]/.test(line[i - 1] ?? '') && line.slice(i + 1).trim()) {
            if (trimCommand(current)) result.push({ operator: currentOp, command: trimCommand(current) + ' &' });
            currentOp = ';';
            current = '';
            i++;
            continue;
          }
        }
      }

      current += ch;
      i++;
    }

    if (trimCommand(current)) result.push({ operator: currentOp, command: trimCommand(current) });
    return result;
  }

  private parsePipeline(line: string): string[] {
    const segments: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let extglobDepth = 0;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\' && !inSingle) { current += ch + (line[i + 1] ?? ''); i++; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
      // Track extglob paren depth: ?(, *(, +(, @(, !(
      if (!inSingle && !inDouble && this.shoptopts.has('extglob') && '?*+@!'.includes(ch) && line[i + 1] === '(') {
        extglobDepth++;
        current += ch + '(';
        i++; // skip the '(' — handled as unit with prefix
        continue;
      }
      if (!inSingle && !inDouble && extglobDepth > 0 && ch === '(') {
        extglobDepth++;
        current += ch;
        continue;
      }
      if (!inSingle && !inDouble && extglobDepth > 0 && ch === ')') {
        extglobDepth--;
        current += ch;
        continue;
      }
      // Single | but not || and not >| (clobber redirect) and not inside extglob
      if (ch === '|' && line[i + 1] !== '|' && line[i - 1] !== '>' && !inSingle && !inDouble && extglobDepth === 0) {
        segments.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    segments.push(current);
    return segments;
  }

  private parseSegment(segment: string): { args: string[], redirects: Redirect[], hereString?: string } {
    const tokens = this.tokenize(segment);
    const args: string[] = [];
    const redirects: Redirect[] = [];
    let hereString: string | undefined;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === '<<<' && i + 1 < tokens.length) {
        // Here-string: <<< "string" — set as stdin
        hereString = unmark(tokens[i + 1]) + '\n';
        i++;
        continue;
      }
      if ((tok === '&>' || tok === '&>>') && i + 1 < tokens.length) {
        redirects.push({ type: tok === '&>' ? '>' : '>>', target: unmark(tokens[++i]) });
        redirects.push({ type: '2>&1', target: '' });
        continue;
      }
      const m = /^(\d*|\{[A-Za-z_][A-Za-z0-9_]*\})(>>|>\||>|<>|<)(?:&(\d+-?|-))?$/.exec(tok);
      if (!m || (m[3] === undefined && i + 1 >= tokens.length)) { args.push(tok); continue; }
      const op = m[2];
      let fd = m[1] !== '' ? parseInt(m[1], 10) : op === '<' || op === '<>' ? 0 : 1;
      if (m[1].startsWith('{')) {
        // {name}>file: a new fd (10 and up) whose number goes into $name; {name}>&- closes $name
        const name = m[1].slice(1, -1);
        if (m[3] === '-') fd = parseInt(this.getVar(name) ?? '', 10);
        else {
          fd = 10;
          while (this.userFds.has(fd) || this.fileDescriptors.has(fd)) fd++;
          this.setVar(name, String(fd));
        }
        if (isNaN(fd)) { args.push(tok); continue; }
      }
      let dupOf: string | undefined = m[3];
      let target = '';
      if (dupOf === undefined) {
        target = unmark(tokens[++i]);
        // `>& 2` / `>& $fd` written apart
        if (target === '&' && i + 1 < tokens.length) target = '&' + unmark(tokens[++i]);
        const t = /^&(\d+-?|-)$/.exec(target);
        if (t) dupOf = t[1];
        else if (target.startsWith('&') && op === '>' && m[1] === '') {
          // bash's `>&file` / `>& file`: stdout and stderr to the file (= &>)
          redirects.push({ type: '>', target: target.slice(1) });
          redirects.push({ type: '2>&1', target: '' });
          continue;
        }
      }
      if (dupOf === '-') { redirects.push({ type: '>&-', target: '', fd }); continue; }
      // N>&M- moves M to N: a dup, then M closes
      const move = dupOf !== undefined && dupOf.endsWith('-');
      if (move) dupOf = dupOf!.slice(0, -1);
      if (move && parseInt(dupOf!, 10) !== fd) {
        redirects.push({ type: 'dup', fd, target: dupOf! });
        redirects.push({ type: '>&-', target: '', fd: parseInt(dupOf!, 10) });
        continue;
      }
      if (dupOf !== undefined) {
        const to = parseInt(dupOf, 10);
        if (fd === 1 && to === 2 && op !== '<') {
          // Redirects apply left to right: `2>x >&2` sends stdout to x too
          const stderrRedir = [...redirects].reverse().find(r => r.type === '2>' || r.type === '2>>');
          redirects.push({ type: '>', target: stderrRedir ? stderrRedir.target : '/dev/stderr' });
        } else if (fd === 2 && to === 1) redirects.push({ type: '2>&1', target: '' });
        else if (fd === to) { /* N>&N: nothing */ }
        else if (fd === 1 && to === 0) { /* >&0: the terminal */ }
        else if (fd === 1) redirects.push({ type: '>>', target: fdRef(to) });
        else if (fd === 2) redirects.push({ type: '2>>', target: fdRef(to) });
        else if (fd === 0) redirects.push({ type: '<', target: fdRef(to) });
        else redirects.push({ type: 'dup', fd, target: String(to) });
        continue;
      }
      const force = op === '>|';
      const kind = op === '>|' ? '>' : op === '<>' ? '<' : op;
      if (fd === 2 && kind !== '<') redirects.push({ type: kind === '>>' ? '2>>' : '2>', target, force });
      else if (fd === 1 && kind !== '<') redirects.push({ type: kind as '>' | '>>', target, force });
      else if (fd === 0 && kind === '<') redirects.push({ type: '<', target });
      else redirects.push({ type: 'open', mode: kind as '>' | '>>' | '<', target, fd, force });
    }

    return {
      args: args.map(restoreWord),
      redirects: redirects.map((r) => ({ ...r, target: restoreWord(r.target) })),
      hereString: hereString === undefined ? undefined : restoreWord(hereString),
    };
  }

  private tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let quoted = false; // the current word had quotes, so it's a word even if empty ('' or "")
    let i = 0;

    while (i < input.length) {
      const ch = input[i];

      // Skip ${...} parameter expansions verbatim (don't sentinel-mark glob chars inside)
      if (!inSingle && ch === '$' && input[i + 1] === '{') {
        current += '${';
        let depth = 1;
        let j = i + 2;
        while (j < input.length && depth > 0) {
          if (input[j] === '{') depth++;
          else if (input[j] === '}') depth--;
          if (depth > 0) current += input[j];
          j++;
        }
        current += '}';
        i = j;
        continue;
      }

      if (ch === '\\' && !inSingle && i + 1 < input.length) {
        const next = input[i + 1];
        if (inDouble) {
          // Inside double quotes: only \$ \" \\ \` are escapes; keep backslash for others
          if (next === '$' || next === '"' || next === '\\' || next === '`') {
            current += next;
          } else if (next === '*' || next === '?' || next === '[') {
            current += '\\\x01' + next; // the backslash stays; the glob char is quoted (sentinel)
          } else {
            current += '\\' + next; // keep backslash literally
          }
        } else {
          // Outside quotes: backslash escapes the next character
          if (next === '*' || next === '?' || next === '[' || next === '<' || next === '>') {
            current += '\x01' + next; // sentinel: quoted glob char
          } else {
            current += next;
          }
        }
        i += 2;
        continue;
      }

      // $'...' ANSI-C quoting: process escape sequences
      if (ch === '$' && input[i + 1] === "'" && !inSingle && !inDouble) {
        quoted = true;
        i += 2; // skip $'
        while (i < input.length && input[i] !== "'") {
          if (input[i] === '\\' && i + 1 < input.length) {
            const esc = input[i + 1];
            switch (esc) {
              case 'n': current += '\n'; i += 2; break;
              case 't': current += '\t'; i += 2; break;
              case 'r': current += '\r'; i += 2; break;
              case '\\': current += '\\'; i += 2; break;
              case "'": current += "'"; i += 2; break;
              case '"': current += '"'; i += 2; break;
              case 'a': current += '\x07'; i += 2; break;
              case 'b': current += '\b'; i += 2; break;
              case 'e': case 'E': current += '\x1b'; i += 2; break;
              case 'f': current += '\f'; i += 2; break;
              case 'v': current += '\v'; i += 2; break;
              case 'x': {
                const hex = input.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{1,2}/);
                if (hex) { current += String.fromCharCode(parseInt(hex[0], 16)); i += 2 + hex[0].length; }
                else { current += '\\x'; i += 2; }
                break;
              }
              case 'u': {
                const uni = input.slice(i + 2, i + 6).match(/^[0-9a-fA-F]{1,4}/);
                if (uni) { current += String.fromCodePoint(parseInt(uni[0], 16)); i += 2 + uni[0].length; }
                else { current += '\\u'; i += 2; }
                break;
              }
              default:
                if (esc >= '0' && esc <= '7') {
                  const oct = input.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
                  if (oct) { current += String.fromCharCode(parseInt(oct[0], 8)); i += 1 + oct[0].length; }
                  else { current += '\\'; i++; }
                } else {
                  current += '\\' + esc; i += 2;
                }
            }
          } else {
            current += input[i]; i++;
          }
        }
        if (i < input.length) i++; // skip closing '
        continue;
      }

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        quoted = true;
        i++;
        continue;
      }

      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        quoted = true;
        i++;
        continue;
      }

      if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
        if (current || quoted) {
          tokens.push(current);
          current = '';
        }
        quoted = false;
        i++;
        continue;
      }

      // Mark glob chars inside quotes so they won't be expanded
      // (and < > in quotes, so a quoted '<' is a word, not a redirect)
      if ((inSingle || inDouble) && (ch === '*' || ch === '?' || ch === '[' || ch === '<' || ch === '>')) {
        current += '\x01' + ch;
        i++;
        continue;
      }

      // &> FILE / &>> FILE: stdout and stderr
      if (ch === '&' && input[i + 1] === '>' && !inSingle && !inDouble) {
        if (current || quoted) { tokens.push(current); current = ''; } quoted = false;
        const two = input[i + 2] === '>';
        tokens.push(two ? '&>>' : '&>');
        i += two ? 3 : 2;
        continue;
      }

      // >(cmd): output process substitution, one word
      if (ch === '>' && input[i + 1] === '(' && !inSingle && !inDouble && !current && !quoted) {
        let depth = 1;
        let j = i + 2;
        while (j < input.length && depth > 0) {
          if (input[j] === '(') depth++;
          else if (input[j] === ')') depth--;
          j++;
        }
        tokens.push(input.slice(i, j));
        i = j;
        continue;
      }

      // >, >>, >| and N>, N>>, N>&M, N>&-, >&M (an all-digit word right before > is the fd)
      if (ch === '>' && !inSingle && !inDouble) {
        const fdPrefix = !quoted && /^(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(current) ? current : '';
        if (fdPrefix) current = '';
        if (current || quoted) { tokens.push(current); current = ''; } quoted = false;
        let op = '>';
        i++;
        if (input[i] === '>') { op = '>>'; i++; } else if (input[i] === '|') { op = '>|'; i++; }
        const dup = input[i] === '&' ? /^&(\d+-?|-)/.exec(input.slice(i)) : null;
        if (dup && op !== '>|') { tokens.push(fdPrefix + op + dup[0]); i += dup[0].length; continue; }
        tokens.push(fdPrefix + op);
        continue;
      }

      // Handle <<< here-string, << heredoc (already handled elsewhere), < stdin redirect
      // But NOT <( which is process substitution
      if (ch === '<' && !inSingle && !inDouble) {
        if (input[i + 1] === '<' && input[i + 2] === '<') {
          if (current || quoted) { tokens.push(current); current = ''; } quoted = false;
          tokens.push('<<<');
          i += 3;
          continue;
        }
        // <( is process substitution — keep as part of arg, find matching )
        if (input[i + 1] === '(') {
          let depth = 1;
          let j = i + 2;
          while (j < input.length && depth > 0) {
            if (input[j] === '(') depth++;
            else if (input[j] === ')') depth--;
            j++;
          }
          const procSub = input.slice(i, j);
          if (current || quoted) { tokens.push(current); current = ''; } quoted = false;
          tokens.push(procSub);
          i = j;
          continue;
        }
        // <, N<, <&M, N<&M, N<&-, <> (an all-digit word right before < is the fd)
        const fdPrefix = !quoted && /^(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(current) ? current : '';
        if (fdPrefix) current = '';
        if (current || quoted) { tokens.push(current); current = ''; } quoted = false;
        i++;
        let op = '<';
        if (input[i] === '>') { op = '<>'; i++; }
        const dup = op === '<' && input[i] === '&' ? /^&(\d+|-)/.exec(input.slice(i)) : null;
        if (dup) { tokens.push(fdPrefix + op + dup[0]); i += dup[0].length; continue; }
        tokens.push(fdPrefix + op);
        continue;
      }

      current += ch;
      i++;
    }

    if (current || quoted) tokens.push(current);
    return tokens;
  }

  // ─── COMMAND SUBSTITUTION ─────────────────────────────────────────────────

  private async expandCommandSubstitution(input: string, stderrWriter: (s: string) => void, quoted = false): Promise<string> {
    const result: string[] = [];
    let i = 0;
    // Quote context of the text around substitutions: nothing expands inside
    // single quotes, and a backslash escapes a following ` or $ (\` is a literal backtick)
    let outerSQ = false, outerDQ = false;
    while (i < input.length) {
      const oc = input[i];
      if (oc === "'" && !outerDQ) { outerSQ = !outerSQ; result.push(oc); i++; continue; }
      if (outerSQ) { result.push(oc); i++; continue; }
      if (oc === '"') { outerDQ = !outerDQ; result.push(oc); i++; continue; }
      if (oc === '\\' && i + 1 < input.length) { result.push(oc + input[i + 1]); i += 2; continue; }
      if (input[i] === '$' && input[i + 1] === '(' && input[i + 2] === '(') {
        // Skip arithmetic expansion $((…)) — handled by expandArithmetic
        result.push(input[i]);
        i++;
      } else if (input[i] === '$' && input[i + 1] === '(') {
        let depth = 1;
        let j = i + 2;
        let subSQ = false, subDQ = false;
        let caseOpen = 0;
        while (j < input.length && depth > 0) {
          const sc = input[j];
          if (sc === '\\' && !subSQ) { j += 2; continue; }
          if (sc === "'" && !subDQ) { subSQ = !subSQ; j++; continue; }
          if (sc === '"' && !subSQ) { subDQ = !subDQ; j++; continue; }
          if (!subSQ && !subDQ) {
            // case … esac inside: a pattern's ) doesn't close the $( (one level of case)
            if (/[a-z]/.test(sc) && !/[\w]/.test(input[j - 1] ?? ' ')) {
              const w = /^[a-z]+/.exec(input.slice(j))![0];
              if (w === 'case' && /^\s/.test(input[j + 4] ?? '')) caseOpen++;
              else if (w === 'esac' && caseOpen > 0) caseOpen--;
              j += w.length;
              continue;
            }
            if (sc === '(') depth++;
            if (sc === ')' && !(depth === 1 && caseOpen > 0)) depth--;
          }
          j++;
        }
        const subCmd = input.slice(i + 2, j - 1);
        // $(< file) shorthand: read file contents directly
        const fileReadMatch = subCmd.trim().match(/^<(?![<&(])\s*((?:"[^"]*"|'[^']*'|\\.|[^\s;&|<>"'\\])+)$/);
        let subOut: string;
        if (fileReadMatch) {
          const filePath = restoreExpansion(this.expandVars(fileReadMatch[1].trim())).replace(/^["']|["']$/g, '').replace(/\\(.)/g, '$1');
          const resolved = this.fs.resolvePath(filePath, this.cwd);
          try {
            subOut = await this.fs.readFile(resolved, 'utf8') as string;
            subOut = subOut.replace(/[\r\n]+$/, '');
          } catch {
            stderrWriter(`${filePath}: No such file or directory\r\n`);
            subOut = '';
          }
        } else {
          const subResult = await this.subshellExec(subCmd);
          if (subResult.stderr) stderrWriter(subResult.stderr);
          subOut = subResult.stdout.replace(/\r\n/g, '\n').replace(/\n+$/, '');
        }
        // If $() appears as the RHS of a variable assignment (VAR=$(...)), wrap the
        // output in double-quotes so tokenize() preserves spaces. This matches bash
        // semantics: VAR=$(cmd) preserves spaces, bare $(cmd) word-splits.
        subOut = this.substitutionText(subOut, result.join(''), outerDQ || quoted);
        result.push(subOut);
        i = j;
      } else if (input[i] === '`') {
        // The body ends at the next unescaped `; in it \\ \$ \` (and \" inside
        // double quotes) lose their backslash, other backslashes stay
        let j = i + 1;
        while (j < input.length && input[j] !== '`') j += input[j] === '\\' ? 2 : 1;
        if (j >= input.length) { result.push(input.slice(i)); break; }
        const subCmd = input.slice(i + 1, j).replace(outerDQ || quoted ? /\\([\\$`"])/g : /\\([\\$`])/g, '$1');
        const subResult = await this.subshellExec(subCmd);
        if (subResult.stderr) stderrWriter(subResult.stderr);
        const subOut = this.substitutionText(subResult.stdout.replace(/\r\n/g, '\n').replace(/\n+$/, ''), result.join(''), outerDQ || quoted);
        result.push(subOut);
        i = j + 1;
      } else {
        result.push(input[i]);
        i++;
      }
    }
    return result.join('');
  }

  // ─── GLOB EXPANSION ──────────────────────────────────────────────────────

  /**
   * Expand glob patterns in args. Tokens containing \x01-prefixed glob chars
   * Process substitution: <(cmd) runs cmd, writes output to a temp file, replaces with path.
   * >(cmd) creates a temp file, runs cmd with stdin from that file after main command writes it.
   * For simplicity, we only implement <(cmd) (input process substitution).
   */
  private async expandProcessSubstitution(args: string[], writeStderr: (s: string) => void): Promise<string[]> {
    const result: string[] = [];
    for (const arg of args) {
      const m = /^([<>])\(([\s\S]+)\)$/.exec(arg);
      if (!m) { result.push(arg); continue; }
      const path = `/tmp/.procsub_${Date.now()}_${procSubCounter++}`;
      if (m[1] === '<') {
        // <(cmd): a file holding cmd's output (cmd runs in a subshell)
        await this.fs.writeFile(path, await this.procSubOutput(m[2], writeStderr));
      } else {
        // >(cmd): a file the command writes; cmd reads it once the command is done
        await this.fs.writeFile(path, '');
        this.pendingOutSubs.push({ path, cmd: m[2] });
      }
      result.push(path);
    }
    return result;
  }

  /** The output of a <(cmd) process substitution */
  private async procSubOutput(cmd: string, writeStderr: (s: string) => void): Promise<string> {
    const r = await this.fork().exec(cmd);
    if (r.stderr) writeStderr(r.stderr);
    return r.stdout.replace(/\r\n/g, '\n');
  }

  /** exec > >(cmd): the files collecting the shell's output for each cmd, run when the script ends */
  private execOutSubs: { path: string; cmd: string }[] = [];

  /** Run exec's >(cmd) commands on what was written to them (the end of a script) */
  private async runExecOutSubs(writeStdout: (s: string) => void, writeStderr: (s: string) => void): Promise<void> {
    // (the shell's fds that wrote to them point back at its own stdout and stderr: cmd writes there)
    const paths = new Set(this.execOutSubs.map((o) => this.fs.resolvePath(o.path, this.cwd)));
    for (const [n, e] of [...this.userFds]) if (e && 'path' in e && paths.has(e.path)) this.userFds.delete(n);
    while (this.execOutSubs.length) {
      const { path, cmd } = this.execOutSubs.shift()!;
      const data = await this.fs.readFile(path, 'utf8').catch(() => '') as string;
      await this.fs.unlink(path).catch(() => {});
      await this.inSubshell((sub) => sub.executeWithStdin(cmd, data, writeStdout, writeStderr));
    }
  }

  /** >(cmd) substitutions waiting for their command to finish */
  private pendingOutSubs: { path: string; cmd: string }[] = [];

  /** Run the >(cmd) readers on what was written to their files */
  private async runOutSubs(writeStdout: (s: string) => void, writeStderr: (s: string) => void): Promise<void> {
    while (this.pendingOutSubs.length) {
      const { path, cmd } = this.pendingOutSubs.shift()!;
      const data = await this.fs.readFile(path, 'utf8').catch(() => '') as string;
      await this.inSubshell((sub) => sub.executeWithStdin(cmd, data, writeStdout, writeStderr));
      await this.fs.unlink(path).catch(() => {});
    }
  }

  /**
   * (from quoted strings) are NOT expanded — the sentinel is stripped instead.
   * Follows bash behavior: no matches = keep the literal pattern.
   */
  private async expandGlobs(args: string[], writeStderr?: (s: string) => void, command = false): Promise<string[] | null> {
    const result: string[] = [];
    // A command's leading NAME=value words, and NAME=value arguments of
    // declaration builtins, are assignments: no pathname expansion
    const assignWord = (a: string) => /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(a);
    let lead = 0;
    if (command) while (lead < args.length && assignWord(args[lead])) lead++;
    const decl = command && ['export', 'declare', 'typeset', 'local', 'readonly'].includes(args[lead] ?? '');
    for (const [k, arg] of args.entries()) {
      const literal = unmark(arg);
      if (this.options.has('noglob') || (command && (k < lead || (decl && assignWord(arg))))
        || !hasUnquotedGlob(arg, this.shoptopts.has('extglob'))) {
        result.push(literal);
        continue;
      }
      let matches: string[] = [];
      try {
        matches = await this.globPath(arg);
      } catch { /* treat as no match */ }
      if (matches.length > 0) { result.push(...matches); continue; }
      if (this.shoptopts.has('failglob')) {
        if (writeStderr) writeStderr(`-bash: no match: ${literal}\r\n`);
        return null;
      }
      // nullglob: nothing; default: the pattern itself
      if (!this.shoptopts.has('nullglob')) result.push(literal);
    }
    return result;
  }

  /**
   * Pathname expansion of one word, directory by directory: `*`, `?`, `[…]`
   * (and extglob), with quoted characters (marked \x01 by the tokenizer)
   * literal. Matches directories too; a trailing `/` matches only them;
   * names starting with `.` need a literal `.` (or dotglob); `**` with
   * globstar crosses directories. Results are sorted.
   */
  private async globPath(word: string): Promise<string[]> {
    const absolute = word.startsWith('/');
    const parts = word.split('/');
    if (absolute) parts.shift();
    const trailingSlash = parts.length > 1 && parts[parts.length - 1] === '';
    if (trailingSlash) parts.pop();
    const extglob = this.shoptopts.has('extglob');
    const nocase = this.shoptopts.has('nocaseglob');
    const dotglob = this.shoptopts.has('dotglob');
    const isDir = async (p: string) => (await this.fs.stat(p).catch(() => null))?.isDirectory() ?? false;
    // Each candidate: the path shown, and the absolute path behind it
    let cands: { shown: string; abs: string }[] = [{ shown: absolute ? '/' : '', abs: absolute ? '/' : this.cwd }];
    const join = (base: string, name: string) => (base === '' ? name : base.endsWith('/') ? base + name : base + '/' + name);
    for (let pi = 0; pi < parts.length; pi++) {
      const seg = parts[pi];
      const last = pi === parts.length - 1;
      const next: { shown: string; abs: string }[] = [];
      if (!hasUnquotedGlob(seg, extglob)) {
        const name = unmark(seg);
        for (const c of cands) next.push({ shown: join(c.shown, name), abs: join(c.abs, name) });
      } else if (seg === '**' && this.shoptopts.has('globstar')) {
        // Zero or more directories
        const walk = async (c: { shown: string; abs: string }) => {
          next.push(c);
          const names = (await this.fs.readdir(c.abs).catch(() => [] as string[])).filter((n) => dotglob || !n.startsWith('.')).sort();
          for (const n of names) {
            const child = { shown: join(c.shown, n), abs: join(c.abs, n) };
            if (await isDir(child.abs)) await walk(child);
            else if (last) next.push(child);
          }
        };
        for (const c of cands) await walk(c);
      } else {
        const re = new RegExp('^' + this.globSegmentRegex(seg) + '$', nocase ? 'is' : 's');
        const explicitDot = unmark(seg).startsWith('.');
        for (const c of cands) {
          const names = await this.fs.readdir(c.abs).catch(() => [] as string[]);
          // . and .. are entries too, unless globskipdots (bash 5.2's default) hides them
          if (explicitDot && !this.shoptopts.has('globskipdots')) names.unshift('.', '..');
          for (const n of [...names].sort()) {
            if (n.startsWith('.') && !explicitDot && !dotglob) continue;
            if (!re.test(n)) continue;
            next.push({ shown: join(c.shown, n), abs: join(c.abs, n) });
          }
        }
      }
      // Only directories lead further (or end a pattern written with a trailing /)
      const needDir = !last || trailingSlash;
      cands = [];
      for (const c of next) {
        if (needDir ? await isDir(c.abs) : await this.fs.exists(c.abs)) cands.push(c);
      }
      if (!cands.length) return [];
    }
    const out = cands.map((c) => (trailingSlash ? c.shown + '/' : c.shown));
    return [...new Set(out)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  }

  /** Regex source for one path segment of a glob; \x01-marked characters are literal */
  private globSegmentRegex(seg: string): string {
    if (this.shoptopts.has('extglob') && !seg.includes('\x01')) return this.globToRegex(seg).replace(/\.\*/g, '[^/]*');
    let out = '';
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (c === '\x01') { out += (seg[i + 1] ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); i++; continue; }
      if (c === '*') { out += '[^/]*'; continue; }
      if (c === '?') { out += '[^/]'; continue; }
      if (c === '[') {
        const b = bracketToRegex(seg, i);
        if (b) { out += b.re; i = b.end; continue; }
      }
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
    return out;
  }

  // ─── ARITHMETIC EXPANSION ─────────────────────────────────────────────────

  private expandArithmetic(input: string): string {
    if (!input.includes('$((')) return input;
    let result = '';
    let i = 0;
    let inSingle = false, inDouble = false;
    while (i < input.length) {
      const ch = input[i];
      // Nothing expands inside single quotes
      if (ch === '\\' && !inSingle) { result += input.slice(i, i + 2); i += 2; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; result += ch; i++; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; result += ch; i++; continue; }
      if (!inSingle && input[i] === '$' && input[i + 1] === '(' && input[i + 2] === '(') {
        // The matching )) by single-paren depth: $((a,(b+1))), $((!(1||2)))
        let depth = 0;
        let j = i + 3;
        while (j < input.length) {
          if (input[j] === '(') depth++;
          else if (input[j] === ')') {
            if (depth === 0 && input[j + 1] === ')') break;
            if (depth > 0) depth--;
          }
          j++;
        }
        let expr = input.slice(i + 3, j);
        // Parameter expansions inside are expanded first: $(( ${n:-0} + 1 )), $(( $((1+2)) * 2 ))
        try {
          result += String(this.evalArithBig(expr));
        } catch (e) {
          // An arithmetic error aborts the command (and a script, as in bash)
          if (e instanceof ArithError) throw new LineAbort(e.message);
          throw e;
        }
        i = j + 2;
      } else {
        result += input[i];
        i++;
      }
    }
    return result;
  }

  /** Arithmetic on the shell's variables (utils/arith.ts); errors throw ArithError */
  private evalArithBig(expr: string): bigint {
    // $x, ${x…}, $(…) inside are expanded first; bare names are read by the evaluator
    if (/[$`]/.test(expr)) expr = restoreExpansion(this.expandVars(this.expandArithmetic(expr), true));
    return evalArith(expr, this.arithEnv);
  }

  /** Arithmetic value; an error counts as 0 (callers that report errors use evalArithBig) */
  private evalArithmetic(expr: string): number {
    try {
      return Number(this.evalArithBig(expr));
    } catch (e) {
      if (e instanceof ArithError) return 0;
      throw e;
    }
  }

  /** Status of `(( expr ))` / `let`: 0 if non-zero, 1 if zero or on an error (reported) */
  private arithStatus(exprs: string[], writeStderr: (s: string) => void): number {
    try {
      let v = 0n;
      for (const e of exprs) v = this.evalArithBig(e);
      return v !== 0n ? 0 : 1;
    } catch (e) {
      if (!(e instanceof ArithError)) throw e;
      writeStderr(`tabcomputer: ${e.message}\r\n`);
      return 1;
    }
  }

  /** Variables as arithmetic sees them: NAME, NAME[SUB] (indexed or associative) */
  private arithEnv: ArithEnv = {
    get: (name, sub) => {
      const v = this.getVar(name, sub);
      if (v === undefined && this.options.has('nounset')) throw new UnboundVariable(name);
      return v;
    },
    set: (name, value, sub) => {
      const err = this.setVar(name, value, sub);
      if (err) throw new ArithError(err);
    },
  };

  /** Key of an associative array subscript: expanded, quotes removed */
  private assocKey(sub: string): string {
    return restoreExpansion(this.expandVars(sub).replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g,
      (_m, sq, dq, bs) => sq ?? (dq !== undefined ? dq.replace(/\\([\\"$`])/g, '$1') : bs)));
  }

  /**
   * Index of an indexed array subscript (arithmetic; negative counts from the
   * end). Out of range below 0: an error when assigning, -1 (unset) when reading.
   */
  private arrayIndex(name: string, sub: string, forRead = false): number {
    let n = Number(this.evalArithBig(sub));
    if (n < 0) {
      const arr = this.arrays.get(name);
      const top = arr ? arrayTop(arr) : (this.env[name] !== undefined ? 1 : 0);
      if (n + top < 0) {
        if (forRead) return -1;
        throw new ArithError(`${name}[${sub}]: bad array subscript`);
      }
      n += top;
    }
    return n;
  }

  /** Value of NAME (element 0 of an array) or NAME[SUB]; undefined if unset */
  getVar(name: string, sub?: string): string | undefined {
    if (this.namerefs.has(name)) {
      const ref = this.derefName(name);
      if (!ref) return undefined;
      name = ref.name;
      if (ref.sub !== undefined && sub === undefined) sub = ref.sub;
    }
    const assoc = this.assocArrays.get(name);
    if (sub === undefined || sub === '@' || sub === '*') {
      if (sub !== undefined) {
        const vals = assoc ? [...assoc.values()] : this.arrays.has(name) ? arrayValues(this.arrays.get(name)!) : this.env[name] !== undefined ? [this.env[name]] : [];
        return vals.length ? vals.join(' ') : undefined;
      }
      if (this.env[name] !== undefined) return this.env[name];
      return assoc ? assoc.get('0') : this.arrays.get(name)?.[0];
    }
    if (assoc) return assoc.get(this.assocKey(sub));
    const idx = this.arrayIndex(name, sub, true);
    if (idx < 0) return undefined;
    const arr = this.arrays.get(name);
    if (arr) return arr[idx];
    return idx === 0 ? this.env[name] : undefined;
  }

  /** Assign NAME (element 0 of an array) or NAME[SUB]; returns an error message or null */
  setVar(name: string, value: string, sub?: string): string | null {
    // (a nameref with no target yet takes VALUE as its target, as in bash)
    if (this.namerefs.has(name)) {
      if (this.namerefs.get(name) === '' && sub === undefined) { this.namerefs.set(name, value); return null; }
      const ref = this.derefName(name);
      if (!ref) return `${name}: circular name reference`;
      if (ref.sub !== undefined) {
        if (sub !== undefined) return `\`${this.namerefs.get(name)}': not a valid identifier`;
        sub = ref.sub;
      }
      name = ref.name;
    }
    if (this.readonlyVars.has(name)) return `${name}: readonly variable`;
    const attrs = this.varAttrs.get(name);
    if (attrs) {
      if (attrs.has('i')) {
        try { value = String(this.evalArithBig(value || '0')); } catch (e) { if (e instanceof ArithError) return e.message; throw e; }
      }
      if (attrs.has('l')) value = value.toLowerCase();
      else if (attrs.has('u')) value = value.toUpperCase();
    }
    this.declaredNames.delete(name);
    const assoc = this.assocArrays.get(name);
    if (sub === undefined) {
      if (assoc) assoc.set('0', value);
      else if (this.arrays.has(name)) this.arrays.get(name)![0] = value;
      else {
        // A new variable is not exported (unless `export NAME` came first); set -a exports every assignment
        if (this.options.has('allexport')) { this.localVars.delete(name); this.exportedUnset.delete(name); }
        else if (!(name in this.env) && !this.exportedUnset.delete(name)) this.localVars.add(name);
        this.env[name] = value;
      }
      return null;
    }
    if (assoc) { assoc.set(this.assocKey(sub), value); return null; }
    const idx = this.arrayIndex(name, sub);
    this.toArray(name)[idx] = value;
    return null;
  }

  /** NAME as an indexed array, converting a scalar to element 0 */
  private toArray(name: string): string[] {
    let arr = this.arrays.get(name);
    if (!arr) {
      arr = [];
      if (this.env[name] !== undefined) arr[0] = this.env[name];
      delete this.env[name];
      this.arrays.set(name, arr);
    }
    return arr;
  }

  // ─── SHELL FUNCTIONS ──────────────────────────────────────────────────────

  private parseFunctionDef(input: string): { name: string; body: string } | null {
    // NAME() BODY or function NAME [()] BODY; bash allows - . : in names (test-hyphen() { … }).
    // BODY is any compound command: { … }, ( … ), a loop, if, case, [[ ]], (( )),
    // possibly followed by redirections ({ cat; } <<EOF)
    const m = /^(function\s+)?([^\s()<>;&|'"`$\\{}]+)\s*(\(\s*\))?\s*([\s\S]+)$/.exec(input);
    if (!m || (!m[1] && !m[3])) return null;
    const rest = m[4].trim();
    if (!/^(\{\s|\(|(if|for|while|until|case|select)\s|\[\[\s)/.test(rest)) return null;
    // A plain { … }: its inside is the body
    if (isBraceGroup(rest) && compoundEnd(rest) === rest.length) {
      return { name: m[2], body: rest.slice(1, rest.lastIndexOf('}')).trim().replace(/;$/, '').trim() };
    }
    // The compound must be all there is, apart from redirections after it
    const end = rest.startsWith('[[') ? rest.indexOf(']]') + 2 : compoundEnd(rest);
    if (end <= 0) return null;
    const after = rest.slice(end).trim();
    if (after && !/^(\d*[<>]|&>)/.test(after)) return null;
    return { name: m[2], body: rest };
  }

  private async execFunction(
    name: string, args: string[],
    writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const func = this.functions[name];
    if (!func) return 127;

    // Save and set positional parameters
    // The function's positional parameters replace the caller's ($0 stays the script name)
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(this.env)) if (/^[1-9]\d*$/.test(k)) saved[k] = this.env[k];
    for (let i = 1; i <= args.length; i++) saved[String(i)] = this.env[String(i)];
    saved['#'] = this.env['#'];
    saved['@'] = this.env['@'];
    this.setPositional(args);

    // FUNCNAME, BASH_SOURCE and BASH_LINENO; LINENO counts in the body's own lines
    const popFrame0 = this.pushCallFrame(name, func.source ?? 'main');
    const callerLine = this.currentLine;
    if (func.line !== undefined) { this.currentLine = func.line; this.env['LINENO'] = String(func.line); }
    const popFrame = () => {
      popFrame0();
      this.currentLine = callerLine;
      this.env['LINENO'] = String(callerLine);
    };

    // Push local variable frame for `local` declarations
    this.localVarStack.push(new Map());

    // Execute body — catch ReturnSignal for `return [N]`. Like bash, break and
    // continue in a function don't reach the caller's loops.
    let exitCode = 0;
    const outerLoopDepth = this.loopDepth;
    this.loopDepth = 0;
    try {
      exitCode = await this.execute(func.body, writeStdout, writeStderr, false, undefined, true);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        exitCode = e.code;
      } else {
        // Restore before re-throwing
        this.restoreLocalVars();
        popFrame();
        for (const key of Object.keys(saved)) {
          if (saved[key] === undefined) delete this.env[key];
          else this.env[key] = saved[key]!;
        }
        throw e;
      }
    } finally {
      this.loopDepth = outerLoopDepth;
    }

    // Pop local variable frame — restore saved values
    this.restoreLocalVars();

    popFrame();

    // Restore positional params
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete this.env[key];
      else this.env[key] = saved[key]!;
    }

    return exitCode;
  }

  // ─── CONTROL STRUCTURES ───────────────────────────────────────────────────

  /** Stdin for the next execute() call's first command (runHeadedPipeline, functions, eval, sh -c) */
  private injectedStdin: string | null = null;

  /** execute() with `stdin` as the input of its first command, like `… | sh -c CMD`. */
  executeWithStdin(
    line: string, stdin: string,
    writeStdout: (s: string) => void, writeStderr?: (s: string) => void,
  ): Promise<number> {
    this.injectedStdin = stdin;
    this.env['__PIPE_STDIN'] = stdin; // read takes it record by record, in any statement
    this.kernelStdinLive = false;
    return this.execute(line, writeStdout, writeStderr, false, undefined, true);
  }

  private async runHeadedPipeline(
    parts: string[], stdin: string,
    writeStdout: (s: string) => void, writeStderr: (s: string) => void, terminalOverride?: any,
  ): Promise<number> {
    const head = parts[0].trim();
    let captured = '';
    const capture = (s: string) => { captured += s; };
    let code: number;
    if (head.startsWith('(') && head.endsWith(')')) {
      const result = await this.fork().exec(head.slice(1, -1).trim());
      captured = result.stdout;
      if (result.stderr) writeStderr(result.stderr.replace(/\n/g, '\r\n'));
      code = result.exitCode;
    } else {
      // Every element of a pipeline is a subshell: exit, cd and variables stay in it
      code = await this.inSubshell((sub) => stdin
        ? sub.execControlStructurePiped(head, stdin, capture, writeStderr)
        : sub.execControlStructure(head, capture, writeStderr));
    }
    if (this.abortController?.signal.aborted) return 130;
    const rest = parts.slice(1).map((p) => p.trim()).join(' | ');
    let restCode: number;
    if (parts.length === 2 && (this.isControlStructure(parts[1].trim()) || /^\((?!\()/.test(parts[1].trim()))) {
      const last = parts[1].trim();
      const input = captured.replace(/\r\n/g, '\n');
      const lastpipe = this.shoptopts.has('lastpipe') && !last.startsWith('(');
      restCode = lastpipe ? await this.execControlStructurePiped(last, input, writeStdout, writeStderr) : await this.inSubshell((sub) => (last.startsWith('(')
        ? sub.executeWithStdin(last.slice(1, -1), input, writeStdout, writeStderr).then((c) => sub.finishSubshell(c, writeStdout, writeStderr))
        : sub.execControlStructurePiped(last, input, writeStdout, writeStderr)));
      this.arrays.set('PIPESTATUS', [String(code), String(restCode)]);
    } else {
      this.injectedStdin = captured.replace(/\r\n/g, '\n');
      restCode = await this.execute(rest, writeStdout, writeStderr, false, terminalOverride || this.terminal, true);
      this.injectedStdin = null;
      this.arrays.set('PIPESTATUS', [String(code), ...(this.arrays.get('PIPESTATUS') ?? [String(restCode)])]);
    }
    if (this.options.has('pipefail')) {
      const all = this.arrays.get('PIPESTATUS')!.map(Number);
      const lastBad = [...all].reverse().find((c) => c !== 0);
      return lastBad ?? 0;
    }
    return restCode;
  }

  /** Run fn on a forked child; exit (and a stray break/continue) end only the child */
  /**
   * set -u: throw UnboundVariable when ${INNER} reads an unset scalar or
   * positional parameter: ${x}, ${#x}, ${x%pat}, ${x/a/b}, ${x:1}... but not
   * ${x-w} ${x=w} ${x+w} ${x?w} (with or without :), arrays or special parameters.
   */
  private checkBound(inner: string): void {
    const m = /^(#?)([A-Za-z_][A-Za-z0-9_]*|[1-9][0-9]*)([\s\S]*)$/.exec(inner);
    if (!m) return;
    const [, len, name, rest] = m;
    if (rest.startsWith('[') || /^:?[-=+?]/.test(rest) || (len && rest)) return;
    const target = this.refTarget(name);
    if (this.env[target] !== undefined || this.arrays.has(target) || this.assocArrays.has(target)) return;
    throw new UnboundVariable(name);
  }

  /**
   * `a=1 b=$a cmd` (or just `a=1 b=$a`): the other words are expanded first,
   * then each assignment's value in order, seeing the ones before it (POSIX
   * 2.9.1). Returns the expanded command text, or null when there's nothing
   * to order (fewer than two assignments, or none uses an expansion).
   */
  private async expandPrefixAssignments(cmd: string, writeStderr: (s: string) => void): Promise<string | null> {
    const words = splitAssignWords(cmd.trim());
    if (!words) return null;
    let k = 0;
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=(?!\()/.test(words[k])) k++;
    if (k < 2 || !words.slice(1, k).some((w) => /[$`]/.test(w))) return null;
    const rest = k < words.length ? await this.expandWords(words.slice(k).join(' '), writeStderr) : '';
    const saved = new Map<string, string | undefined>();
    const parts: string[] = [];
    try {
      for (const w of words.slice(0, k)) {
        const text = await this.expandWords(quoteAssignmentValues(w), writeStderr);
        parts.push(text);
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=([\s\S]*)$/.exec(text);
        if (!m) continue;
        if (!saved.has(m[1])) saved.set(m[1], this.env[m[1]]);
        const value = restoreExpansion(removeQuoting(m[3]));
        this.env[m[1]] = m[2] ? (this.env[m[1]] ?? '') + value : value;
      }
    } finally {
      for (const [n, v] of saved) { if (v === undefined) delete this.env[n]; else this.env[n] = v; }
    }
    return rest ? parts.join(' ') + ' ' + rest : parts.join(' ');
  }

  /** Does every for/while/until/select/if/case in `src` have its done/fi/esac (and nothing close what isn't open)? */
  private compoundsBalanced(src: string): boolean {
    const close: Record<string, string> = { for: 'done', while: 'done', until: 'done', select: 'done', if: 'fi', case: 'esac' };
    const stack: string[] = [];
    for (const { word } of this.shellTokenScan(src)) {
      if (close[word]) stack.push(close[word]);
      else if (word === 'done' || word === 'fi' || word === 'esac') { if (stack.pop() !== word) return false; }
    }
    return stack.length === 0;
  }

  /** A subshell has finished with `code`: its EXIT trap runs now (an `exit` in it already ran it) */
  /** Run `inner` as this (forked) shell's ( … ) body: an expansion error (set -u, ${x?msg}, bad substitution) ends just the subshell */
  async runSubshell(inner: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void, terminal = this.terminal): Promise<number> {
    try {
      return await this.finishSubshell(await this.execute(inner, writeStdout, writeStderr, false, terminal, true), writeStdout, writeStderr);
    } catch (e) {
      if (e instanceof ExitSignal || e instanceof ReturnSignal) return e.code;
      if (e instanceof Error && e.name !== 'AbortError') { writeStderr(`tabcomputer: ${e.message}\r\n`); return 1; }
      throw e;
    }
  }

  async finishSubshell(code: number, writeStdout: (s: string) => void, writeStderr: (s: string) => void): Promise<number> {
    if (this.traps.has('EXIT')) {
      this.lastExitCode = code;
      this.env['?'] = String(code);
      code = (await this.runExitTrap(writeStdout, writeStderr)) ?? code;
    }
    this.closeOwnFds();
    return code;
  }

  /** This shell is done: close the named pipe ends it opened (exec 3>fifo), so their readers see EOF */
  closeOwnFds(): void {
    for (const n of [...this.userFds.keys()]) {
      this.dropFd(n);
      const e = this.userFds.get(n);
      if (e && 'fifo' in e && e.owner === this) this.userFds.delete(n);
    }
  }

  private async inSubshell(fn: (sub: Shell) => Promise<number>): Promise<number> {
    const child = this.fork();
    try {
      return await fn(child);
    } catch (e) {
      if (e instanceof ExitSignal) return e.code;
      if (e instanceof BreakSignal || e instanceof ContinueSignal) return 0;
      throw e;
    }
  }

  private isControlStructure(input: string): boolean {
    return /^if\s+/.test(input) || /^while\s+/.test(input) || /^until\s+/.test(input) || /^for\s+/.test(input) || /^case\s+/.test(input) || /^select\s+/.test(input)
      || isBraceGroup(input);
  }

  /** Brace, arithmetic, command-substitution, and variable expansion of command text */
  private async expandWords(text: string, writeStderr: (s: string) => void): Promise<string> {
    // <(…) and >(…) bodies expand in their own subshell, not here
    const procSubs: string[] = [];
    if (/[<>]\(/.test(text)) text = hideProcSubs(text, procSubs);
    let expanded = this.expandBraces(text);
    // (command substitutions first: $(( $(echo 1) + `echo 2` )))
    expanded = await this.expandCommandSubstitution(expanded, writeStderr);
    expanded = this.expandArithmetic(expanded);
    expanded = this.expandVars(expanded);
    return procSubs.length ? expanded.replace(/\uE030(\d+)\uE031/g, (_m, n) => procSubs[Number(n)]) : expanded;
  }

  /**
   * Run a control structure, applying redirections written after its closing
   * keyword (`done < file`, `fi > out`, `done 2>/dev/null`, ...).
   */
  private async execControlStructure(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void,
    pipeStdin?: string,
  ): Promise<number> {
    const { compound, redirects } = splitCompoundRedirects(input);
    if (!redirects.length) {
      return pipeStdin === undefined
        ? this.execControlStructureCore(compound, writeStdout, writeStderr)
        : this.execControlStructureWithStdin(compound, pipeStdin, writeStdout, writeStderr);
    }
    let stdin = pipeStdin;
    let out = writeStdout, err = writeStderr;
    let outFile: { path: string; append: boolean } | null = null;
    let errFile: { path: string; append: boolean } | null = null;
    // > >(cmd) / 2> >(cmd): cmd reads what the compound wrote, once it is done
    let outSub: string | null = null;
    let errSub: string | null = null;
    let captured = '';
    let capturedErr = '';
    // Descriptors 3-9 redirected for the compound: set with exec, put back after it
    const fdSaved = new Map<number, { inp: any; out: any }>();
    for (const r of redirects) {
      if (r.op !== 'fd' || fdSaved.has(r.fd!)) continue;
      fdSaved.set(r.fd!, { inp: this.fileDescriptors.get(r.fd!), out: this.userFds.get(r.fd!) });
    }
    const restoreFds = () => {
      for (const [n, s] of fdSaved) {
        this.dropFd(n, s.out);
        if (s.inp === undefined) this.fileDescriptors.delete(n); else this.fileDescriptors.set(n, s.inp);
        if (s.out === undefined) this.userFds.delete(n); else this.userFds.set(n, s.out);
      }
    };
    for (const r of redirects) {
      if (r.op === 'fd') {
        const code = await this.execute(`exec ${r.target}`, writeStdout, writeStderr, false, undefined, true);
        if (code !== 0) { restoreFds(); return code; }
        continue;
      }
      const target = restoreExpansion(this.expandVars(r.target));
      if (r.op === '<') {
        try {
          stdin = await this.readInputRedirect(target);
        } catch {
          writeStderr(`tabcomputer: ${target}: No such file or directory\r\n`);
          return 1;
        }
      } else if (r.op === '2>&1') {
        err = (s) => out(s);
      } else if (r.op === '2>' || r.op === '2>>') {
        if (target === '/dev/null') { err = () => {}; continue; }
        const ps = /^>\(([\s\S]+)\)$/.exec(target);
        if (ps) errSub = ps[1];
        else errFile = { path: this.fs.resolvePath(target, this.cwd), append: r.op === '2>>' };
        err = (s) => { capturedErr += s; };
      } else if (r.op === '>' || r.op === '>>' || r.op === '&>') {
        if (r.op === '&>') err = (s) => out(s);
        if (target === '/dev/null') { out = () => {}; continue; }
        const ps = /^>\(([\s\S]+)\)$/.exec(target);
        if (ps) outSub = ps[1];
        else outFile = { path: this.fs.resolvePath(target, this.cwd), append: r.op === '>>' };
        out = (s) => { captured += s; };
      }
    }
    let code: number;
    try {
      code = stdin === undefined
        ? await this.execControlStructureCore(compound, out, err)
        : await this.execControlStructureWithStdin(compound, stdin, out, err);
    } finally {
      restoreFds();
    }
    for (const [file, text] of [[outFile, captured], [errFile, capturedErr]] as const) {
      if (!file) continue;
      try {
        const t = text.replace(/\r\n/g, '\n');
        if (file.append) await this.fs.appendFile(file.path, t);
        else await this.fs.writeFile(file.path, t);
      } catch (e: any) {
        writeStderr(`tabcomputer: ${file.path}: ${/EISDIR/.test(e?.message ?? '') ? 'Is a directory' : /ENOENT/.test(e?.message ?? '') ? 'No such file or directory' : e?.message ?? e}\r\n`);
        return 1;
      }
    }
    for (const [cmd, text] of [[outSub, captured], [errSub, capturedErr]] as const) {
      if (cmd) await this.inSubshell((sub) => sub.executeWithStdin(cmd, text.replace(/\r\n/g, '\n'), writeStdout, writeStderr));
    }
    return code;
  }

  private async execControlStructureCore(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    if (/^if\s+/.test(input)) return this.execIf(input, writeStdout, writeStderr);
    if (/^(while|until|for)\s+/.test(input)) {
      this.loopDepth++;
      try {
        if (/^while\s+/.test(input)) return await this.execWhile(input, writeStdout, writeStderr);
        if (/^until\s+/.test(input)) return await this.execUntil(input, writeStdout, writeStderr);
        return await this.execFor(input, writeStdout, writeStderr);
      } finally {
        this.loopDepth--;
      }
    }
    if (/^case\s+/.test(input)) return this.execCase(input, writeStdout, writeStderr);
    if (/^select\s+/.test(input)) {
      this.loopDepth++;
      try { return await this.execSelect(input, writeStdout, writeStderr); } finally { this.loopDepth--; }
    }
    if (input.startsWith('((') && input.endsWith('))')) return this.arithStatus([input.slice(2, -2).trim()], writeStderr);
    if (/^\((?!\()/.test(input) && input.endsWith(')')) {
      // ( list ) runs in a child shell
      const child = this.fork();
      child.injectedStdin = this.injectedStdin;
      if (this.injectedStdin) child.kernelStdinLive = false;
      this.injectedStdin = null;
      const inner = input.slice(1, -1).trim();
      return inner ? child.runSubshell(inner, writeStdout, writeStderr, this.terminal) : 0;
    }
    if (isBraceGroup(input)) {
      // { list; } runs in the current shell
      const inner = input.slice(1, input.lastIndexOf('}')).trim().replace(/;\s*$/, '');
      return inner ? this.execute(inner, writeStdout, writeStderr, false, undefined, true) : 0;
    }
    return 0;
  }

  /**
   * Execute a control structure as a pipeline segment with piped stdin.
   * Used for patterns like: echo "data" | while read line; do ...; done
   */
  private async execControlStructurePiped(
    input: string, pipeStdin: string,
    writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    return this.execControlStructure(input, writeStdout, writeStderr, pipeStdin);
  }

  private async execControlStructureWithStdin(
    input: string, pipeStdin: string,
    writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    if (/^while\s+/.test(input)) {
      this.loopDepth++;
      try { return await this.execWhile(input, writeStdout, writeStderr, pipeStdin); } finally { this.loopDepth--; }
    }
    // For other control structures, set __PIPE_STDIN env and delegate
    const saved = this.env['__PIPE_STDIN'];
    this.env['__PIPE_STDIN'] = pipeStdin;
    // A brace group's or subshell's first command reads the pipe too: `… | { cat; }`
    if (isBraceGroup(input) || /^\((?!\()/.test(input)) this.injectedStdin = pipeStdin;
    const result = await this.execControlStructureCore(input, writeStdout, writeStderr);
    if (saved === undefined) delete this.env['__PIPE_STDIN'];
    else this.env['__PIPE_STDIN'] = saved;
    return result;
  }

  /**
   * The condition of if/while/until, ready for evalCondition. One with [[ … ]]
   * is left as written: [[ expands each operand itself, and an unquoted empty
   * expansion is still an operand there (`if [[ -n ${ZSH_VERSION:-} ]]`),
   * not a word that disappears.
   */
  private async conditionText(condition: string, writeStderr: (s: string) => void): Promise<string> {
    if (condition.includes('[[')) return condition;
    return this.expandVars(await this.expandCommandSubstitution(this.expandArithmetic(condition), writeStderr));
  }

  private async evalCondition(
    condition: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    this.errexitSuppressed++;
    try {
      return await this.evalConditionInner(condition, writeStdout, writeStderr);
    } finally {
      this.errexitSuppressed--;
    }
  }

  private async evalConditionInner(
    condition: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const trimmed = condition.trim();
    // [[ ... ]] syntax (bash double-bracket test)
    if (doubleBracketEnd(trimmed, 0) === trimmed.length) {
      return this.evalDoubleBracket(trimmed.slice(2, -2), writeStderr);
    }
    // `[ … ]` and `test …` run as the test command (posix-test.ts), with real argument words
    // (( expr )) — arithmetic condition
    if (trimmed.startsWith('((') && trimmed.endsWith('))')) {
      return this.arithStatus([trimmed.slice(2, -2).trim()], writeStderr);
    }
    // Execute as command
    return this.execute(trimmed, writeStdout, writeStderr, false, undefined, true);
  }

  private async evalTest(args: string): Promise<number> {
    // Expanded values arrive with stand-ins for quotes/operators (protectExpansion)
    const tokens = args.split(/\s+/).map(restoreExpansion);
    if (tokens.length === 0) return 1;

    // Strip surrounding quotes from each token (vars already expanded by caller)
    const strip = (t: string) => {
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    };

    // Handle compound expressions with -a (AND) and -o (OR)
    const oIdx = tokens.indexOf('-o');
    if (oIdx > 0 && oIdx < tokens.length - 1) {
      const left = await this.evalTest(tokens.slice(0, oIdx).join(' '));
      const right = await this.evalTest(tokens.slice(oIdx + 1).join(' '));
      return (left === 0 || right === 0) ? 0 : 1;
    }
    const aIdx = tokens.indexOf('-a');
    if (aIdx > 0 && aIdx < tokens.length - 1) {
      const left = await this.evalTest(tokens.slice(0, aIdx).join(' '));
      const right = await this.evalTest(tokens.slice(aIdx + 1).join(' '));
      return (left === 0 && right === 0) ? 0 : 1;
    }

    // Single arg: true if non-empty string
    if (tokens.length === 1) {
      return strip(tokens[0]) !== '' ? 0 : 1;
    }

    // ! EXPR (any length: `[ ! "$a" = "$b" ]`)
    if (tokens[0] === '!') return (await this.evalTest(tokens.slice(1).join(' '))) === 0 ? 1 : 0;

    if (tokens.length === 2) {
      const op = tokens[0];
      const expanded = strip(tokens[1]);
      switch (op) {
        case '-z': return expanded === '' ? 0 : 1;
        case '-n': return expanded !== '' ? 0 : 1;
        case '-e': case '-r': case '-w': case '-x':
          try { await this.fs.stat(this.fs.resolvePath(expanded, this.cwd)); return 0; } catch { return 1; }
        case '-f':
          try { const s = await this.fs.stat(this.fs.resolvePath(expanded, this.cwd)); return s.type === 'file' ? 0 : 1; } catch { return 1; }
        case '-d':
          try { const s = await this.fs.stat(this.fs.resolvePath(expanded, this.cwd)); return s.type === 'dir' ? 0 : 1; } catch { return 1; }
        case '-s':
          try {
            const s = await this.fs.stat(this.fs.resolvePath(expanded, this.cwd));
            return s.type === 'file' && (s.size ?? 0) > 0 ? 0 : 1;
          } catch { return 1; }
        case '-L': case '-h':
          try {
            const s = await this.fs.stat(this.fs.resolvePath(expanded, this.cwd));
            return s.type === 'symlink' ? 0 : 1;
          } catch { return 1; }
        case '-v': return (expanded in this.env) ? 0 : 1;
        case '-R': return this.namerefs.has(expanded) ? 0 : 1;
        case '!': return (await this.evalTest(tokens.slice(1).join(' '))) === 0 ? 1 : 0;
      }
    }

    if (tokens.length === 3) {
      const left = strip(tokens[0]);
      const op = tokens[1];
      const right = strip(tokens[2]);
      switch (op) {
        case '=': case '==': {
          // Support glob patterns (and extglob) in [[ ]] (*, ?, [...], ?()|*()...)
          const hasGlob = right.includes('*') || right.includes('?') || right.includes('[') ||
            (this.shoptopts.has('extglob') && /[?*+@!]\(/.test(right));
          if (hasGlob) {
            const re = new RegExp('^' + this.globToRegex(right) + '$');
            return re.test(left) ? 0 : 1;
          }
          return left === right ? 0 : 1;
        }
        case '!=': {
          const hasGlob2 = right.includes('*') || right.includes('?') || right.includes('[') ||
            (this.shoptopts.has('extglob') && /[?*+@!]\(/.test(right));
          if (hasGlob2) {
            const re = new RegExp('^' + this.globToRegex(right) + '$');
            return re.test(left) ? 1 : 0;
          }
          return left !== right ? 0 : 1;
        }
        case '-eq': return parseInt(left) === parseInt(right) ? 0 : 1;
        case '-ne': return parseInt(left) !== parseInt(right) ? 0 : 1;
        case '-lt': return parseInt(left) < parseInt(right) ? 0 : 1;
        case '-le': return parseInt(left) <= parseInt(right) ? 0 : 1;
        case '-gt': return parseInt(left) > parseInt(right) ? 0 : 1;
        case '-ge': return parseInt(left) >= parseInt(right) ? 0 : 1;
        case '=~': {
          // Regex match (bash [[ =~ ]])
          try {
            const re = new RegExp(right);
            const match = left.match(re);
            if (match) {
              // Set BASH_REMATCH array
              this.arrays.set('BASH_REMATCH', match.map(m => m ?? ''));
              return 0;
            }
            return 1;
          } catch { return 1; }
        }
        case '<': return left < right ? 0 : 1;
        case '>': return left > right ? 0 : 1;
      }
    }

    return args.trim() !== '' ? 0 : 1;
  }

  private async execIf(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    // Normalize to semicolons for easier parsing: a newline separates commands,
    // except after a case item's terminator (;; ;& ;;&), which must survive
    // whole (collapsing `;;` to `;` broke every case with two items in an if)
    const joined = input.replace(/(;;&?|;&)?[ \t]*\r?\n/g, (_m, term) => (term ? `${term} ` : '; ')).replace(/;\s+;/g, ';');

    // Parse if/elif/else/fi with depth tracking for nested if blocks
    interface IfBranch { condition: string; body: string; }
    const branches: IfBranch[] = [];
    let elseBody = '';

    const tokens = this.shellTokenScan(joined);
    // Find the structure at depth 0
    type Marker = { word: string; pos: number };
    const depth0: Marker[] = [];
    let ifDepth = 0;
    for (const tok of tokens) {
      if (tok.word === 'if') {
        if (ifDepth === 0) depth0.push(tok);
        ifDepth++;
      } else if (tok.word === 'fi') {
        ifDepth--;
        if (ifDepth === 0) depth0.push(tok);
      } else if (ifDepth === 1 && (tok.word === 'then' || tok.word === 'elif' || tok.word === 'else')) {
        depth0.push(tok);
      }
    }

    // Parse structure: if COND then BODY [elif COND then BODY]* [else BODY] fi
    let i = 0;
    while (i < depth0.length) {
      const cur = depth0[i];
      if (cur.word === 'if' || cur.word === 'elif') {
        // Find the 'then' after this
        const thenMarker = depth0[i + 1];
        if (!thenMarker || thenMarker.word !== 'then') { writeStderr('if: syntax error\r\n'); return 1; }
        const condStr = joined.slice(cur.pos + cur.word.length, thenMarker.pos).trim().replace(/^;\s*/, '').replace(/;\s*$/, '').trim();
        // Find the next elif/else/fi
        const nextMarker = depth0[i + 2];
        const bodyEnd = nextMarker ? nextMarker.pos : joined.length;
        const bodyStr = joined.slice(thenMarker.pos + 4, bodyEnd).trim().replace(/^;\s*/, '').replace(/;\s*$/, '').trim();
        branches.push({ condition: condStr, body: bodyStr });
        i += 2;
      } else if (cur.word === 'else') {
        const nextMarker = depth0[i + 1]; // should be fi
        const bodyEnd = nextMarker ? nextMarker.pos : joined.length;
        elseBody = joined.slice(cur.pos + 4, bodyEnd).trim().replace(/^;\s*/, '').replace(/;\s*$/, '').trim();
        i++;
      } else if (cur.word === 'fi') {
        break;
      } else {
        i++;
      }
    }

    if (branches.length === 0) { writeStderr('if: syntax error\r\n'); return 1; }

    // Evaluate branches in order
    for (const branch of branches) {
      const expandedCond = await this.conditionText(branch.condition, writeStderr);
      const condResult = await this.evalCondition(expandedCond, writeStdout, writeStderr);
      if (condResult === 0) {
        return branch.body.trim() ? this.execute(branch.body, writeStdout, writeStderr, false, undefined, true) : 0;
      }
    }

    // No branch matched, try else
    if (elseBody) {
      return this.execute(elseBody, writeStdout, writeStderr, false, undefined, true);
    }
    return 0;
  }

  /**
   * Parse a loop construct (while/until/for) extracting condition and body.
   * Handles nested loops by tracking do/done depth.
   */
  private parseLoopConstruct(input: string, keyword: string): { condition: string; body: string } | null {
    // Find '; do ' or standalone 'do' with depth tracking
    const joined = input.replace(/\r?\n/g, '; ');
    // Scan for 'do' at depth 0 (not inside nested for/while/until)
    let depth = 0;
    let doPos = -1;
    let donePos = -1;
    const tokens = this.shellTokenScan(joined);
    for (const tok of tokens) {
      if (tok.word === 'for' || tok.word === 'while' || tok.word === 'until' || tok.word === 'select') {
        if (tok.pos > 0) depth++; // nested loop (skip the outermost keyword)
      } else if (tok.word === 'do') {
        // the first do outside nested loops is ours (a nested loop's do opens nothing new)
        if (depth === 0 && doPos < 0) doPos = tok.pos;
      } else if (tok.word === 'done') {
        if (doPos >= 0 && depth === 0) { donePos = tok.pos; break; }
        else if (depth > 0) depth--; // nested done
      }
    }
    if (doPos < 0) return null;

    // Condition: between keyword and 'do'
    let condStart = keyword.length;
    let condEnd = doPos;
    // Handle "; do" — strip trailing semicolons
    let condStr = joined.slice(condStart, condEnd).trim().replace(/;\s*$/, '').trim();

    // Body: between 'do' and last 'done'
    let bodyStart = doPos + 2; // length of 'do'
    let bodyEnd = donePos >= 0 ? donePos : joined.length;
    let bodyStr = joined.slice(bodyStart, bodyEnd).trim().replace(/^;\s*/, '').replace(/;\s*$/, '').trim();

    return { condition: condStr, body: bodyStr };
  }

  /**
   * Scan input for shell keywords at word boundaries, respecting quotes.
   */
  /**
   * Find reserved words (for/while/until/select/do/done/if/then/elif/else/fi/
   * case/esac/in) where the grammar recognizes them: in command position, not
   * as arguments (`echo then`), inside quotes, or inside $(…). `in` is
   * reported after `for NAME` / `case WORD` / `select NAME`.
   */
  private shellTokenScan(input: string): { word: string; pos: number }[] {
    const results: { word: string; pos: number }[] = [];
    const keywords = new Set(['for', 'while', 'until', 'select', 'do', 'done', 'if', 'then', 'elif', 'else', 'fi', 'case', 'esac']);
    const leadsToCommand = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time']);
    let cmdPos = true;
    let wordsSinceHeader = -1; // counts words after for/case/select, to spot their `in`
    let i = 0;
    const n = input.length;
    while (i < n) {
      const ch = input[i];
      if (ch === '\\') { i += 2; cmdPos = false; continue; }
      if (ch === "'") { const e = input.indexOf("'", i + 1); i = e === -1 ? n : e + 1; cmdPos = false; continue; }
      if (ch === '"') {
        i++;
        while (i < n && input[i] !== '"') i += input[i] === '\\' ? 2 : 1;
        i++; cmdPos = false; continue;
      }
      if (ch === '`') {
        i++;
        while (i < n && input[i] !== '`') i += input[i] === '\\' ? 2 : 1;
        i++; cmdPos = false; continue;
      }
      if (ch === '$' && input[i + 1] === '(') {
        // Skip a command substitution / arithmetic expansion
        let depth = 0;
        let j = i + 1;
        for (; j < n; j++) {
          const c = input[j];
          if (c === '\\') { j++; continue; }
          if (c === "'") { const e = input.indexOf("'", j + 1); j = e === -1 ? n : e; continue; }
          if (c === '"') { j++; while (j < n && input[j] !== '"') j += input[j] === '\\' ? 2 : 1; continue; }
          if (c === '(') depth++;
          else if (c === ')' && --depth === 0) break;
        }
        i = j + 1; cmdPos = false; continue;
      }
      if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')' || ch === '\n') { i++; cmdPos = true; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
      // A word
      let j = i;
      while (j < n && !/[\s;&|()<>'"`\\]/.test(input[j]) && !(input[j] === '$' && input[j + 1] === '(')) j++;
      if (j === i) { i++; cmdPos = false; continue; }
      const word = input.slice(i, j);
      const glued = j < n && /['"`\\$]/.test(input[j]);
      if (wordsSinceHeader >= 0) {
        wordsSinceHeader++;
        if (wordsSinceHeader === 2) {
          if (word === 'in' && !glued) results.push({ word, pos: i });
          wordsSinceHeader = -1;
          if (word === 'in') { cmdPos = false; i = j; continue; }
        }
      }
      if (cmdPos && !glued && keywords.has(word)) {
        results.push({ word, pos: i });
        if (word === 'for' || word === 'case' || word === 'select') wordsSinceHeader = 0;
      }
      // (a brace group's } may be followed by a reserved word: `if { …; } then`)
      cmdPos = cmdPos && !glued && (leadsToCommand.has(word) || word === '}');
      i = j;
    }
    return results;
  }

  private async execWhile(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void,
    pipeStdin?: string,
  ): Promise<number> {
    const parsed = this.parseLoopConstruct(input, 'while');
    if (!parsed) { writeStderr('while: syntax error\r\n'); return 1; }

    // If piped stdin is provided, store remaining lines for `read` to consume
    const savedPipeStdin = this.env['__PIPE_STDIN'];
    if (pipeStdin !== undefined) {
      this.env['__PIPE_STDIN'] = pipeStdin;
    }

    const status = await this.runCondLoop(parsed, false, writeStdout, writeStderr);

    // Restore
    if (pipeStdin !== undefined) {
      if (savedPipeStdin === undefined) delete this.env['__PIPE_STDIN'];
      else this.env['__PIPE_STDIN'] = savedPipeStdin;
    }
    return status;
  }

  /**
   * The iterations of while (until: untilMode) — break and continue may come
   * from the condition too. The status is the body's last (0 if it never ran).
   */
  private async runCondLoop(
    parsed: { condition: string; body: string }, untilMode: boolean,
    writeStdout: (s: string) => void, writeStderr: (s: string) => void,
  ): Promise<number> {
    let status = 0;
    let iter = 0;
    while (iter++ < LOOP_ITERATION_LIMIT) {
      if (iter % 1000 === 0) await yieldToEventLoop(); // keep the page responsive in long loops
      try {
        // Expand vars in condition each iteration (loop vars like $X change)
        const expandedCond = await this.conditionText(parsed.condition, writeStderr);
        if (((await this.evalCondition(expandedCond, writeStdout, writeStderr)) === 0) === untilMode) break;
        status = 0;
        if (parsed.body.trim()) status = await this.execute(parsed.body, writeStdout, writeStderr, false, undefined, true);
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1 && this.loopDepth > 1) throw new BreakSignal(e.levels - 1); status = 0; break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1 && this.loopDepth > 1) throw new ContinueSignal(e.levels - 1); status = 0; continue; }
        throw e;
      }
    }
    return status;
  }

  private async execUntil(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const parsed = this.parseLoopConstruct(input, 'until');
    if (!parsed) { writeStderr('until: syntax error\r\n'); return 1; }

    return this.runCondLoop(parsed, true, writeStdout, writeStderr);
  }

  private async execFor(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const parsed = this.parseLoopConstruct(input, 'for');
    if (!parsed) { writeStderr('for: syntax error\r\n'); return 1; }

    // C-style for loop: for ((init; test; update))
    const cStyleMatch = parsed.condition.match(/^\(\((.+)\)\)$/s);
    if (cStyleMatch) {
      const parts = cStyleMatch[1].split(';').map(s => s.trim());
      if (parts.length !== 3) { writeStderr('for: syntax error in arithmetic\r\n'); return 1; }
      const [init, test, update] = parts;
      // Execute init expression
      this.evalArithmetic(init);
      // Loop (its status is the body's last; 0 if the body never ran)
      let status = 0;
      let iter = 0;
      while (iter++ < LOOP_ITERATION_LIMIT) {
        if (iter % 1000 === 0) await yieldToEventLoop();
        // Evaluate test — 0 means false (stop)
        if (test && this.evalArithmetic(test) === 0) break;
        // Execute body
        try {
          if (parsed.body.trim()) status = await this.execute(parsed.body, writeStdout, writeStderr, false, undefined, true);
        } catch (e) {
          if (e instanceof BreakSignal) { if (e.levels > 1 && this.loopDepth > 1) throw new BreakSignal(e.levels - 1); status = 0; break; }
          if (e instanceof ContinueSignal) { if (e.levels > 1 && this.loopDepth > 1) throw new ContinueSignal(e.levels - 1); status = 0; /* fall through to update */ }
          else throw e;
        }
        // Execute update
        if (update) this.evalArithmetic(update);
      }
      return status;
    }

    // Parse "VAR in item1 item2 item3" from condition
    // `for NAME in WORDS`, `for NAME in` (no words) or `for NAME` ("$@")
    const forMatch = parsed.condition.match(/^(\w+)(?:\s+in(?:\s+([\s\S]*))?)?$/);
    if (!forMatch) { writeStderr('for: syntax error\r\n'); return 1; }

    const varName = forMatch[1];
    const items = /\sin(\s|$)/.test(parsed.condition)
      ? await this.expandWordList(forMatch[2] ?? '', writeStderr)
      : this.getPositionalArgs();
    let status = 0;
    for (const item of items) {
      const err = this.setVar(varName, item);
      if (err) {
        writeStderr(`tabcomputer: ${err}\r\n`);
        this.readonlyAssignFailed();
        return 1;
      }
      try {
        if (parsed.body.trim()) status = await this.execute(parsed.body, writeStdout, writeStderr, false, undefined, true);
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1 && this.loopDepth > 1) throw new BreakSignal(e.levels - 1); status = 0; break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1 && this.loopDepth > 1) throw new ContinueSignal(e.levels - 1); status = 0; continue; }
        throw e;
      }
    }
    return status;
  }

  /** The words of a `for`/`select` list, expanded like command arguments (quotes, splitting, globs) */
  /** `[[ … ]]`: 0 true, 1 false, 2 on a syntax error or bad regex */
  private async evalDoubleBracket(src: string, writeStderr: (s: string) => void): Promise<number> {
    let tree: DbNode;
    try {
      tree = parseDoubleBracket(src);
    } catch (e) {
      if (!(e instanceof DbSyntaxError)) throw e;
      writeStderr(`tabcomputer: [[: ${e.message}\r\n`);
      if (this.scriptShell) throw new ExitSignal(2);
      return 2;
    }
    try {
      return (await this.dbEval(tree, writeStderr)) ? 0 : 1;
    } catch (e) {
      if (e instanceof RegexSyntaxError) { writeStderr(`tabcomputer: [[: invalid regular expression\r\n`); return 2; }
      if (e instanceof ArithError) { writeStderr(`tabcomputer: ${e.message}\r\n`); return 1; }
      throw e;
    }
  }

  private async dbEval(n: DbNode, writeStderr: (s: string) => void): Promise<boolean> {
    switch (n.t) {
      case 'and': return (await this.dbEval(n.a, writeStderr)) && this.dbEval(n.b, writeStderr);
      case 'or': return (await this.dbEval(n.a, writeStderr)) || this.dbEval(n.b, writeStderr);
      case 'not': return !(await this.dbEval(n.a, writeStderr));
      case 'word': return (await this.expandScalar(n.w, writeStderr)) !== '';
      case 'unary': {
        const v = await this.expandScalar(n.w, writeStderr);
        if (n.op === '-v') {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/s.exec(v);
          if (!m) return false;
          if (m[2] === '@' || m[2] === '*') return (this.getVar(m[1], m[2]) ?? undefined) !== undefined;
          return this.getVar(m[1], m[2]) !== undefined;
        }
        if (n.op === '-o') return this.options.has(v);
        if (n.op === '-R') return this.namerefs.has(v);
        if (n.op === '-a') return new TestEval([], this.fs, this.cwd).unary('-e', v);
        return new TestEval([], this.fs, this.cwd).unary(n.op, v);
      }
      case 'binary': {
        const l = await this.expandScalar(n.l, writeStderr);
        switch (n.op) {
          case '=': case '==': case '!=': {
            const re = await this.dbPattern(n.r, writeStderr);
            return re.test(l) !== (n.op === '!=');
          }
          case '=~': {
            const re = await this.dbRegex(n.r, writeStderr);
            const m = re.exec(l);
            if (!m) { this.arrays.delete('BASH_REMATCH'); return false; }
            this.arrays.set('BASH_REMATCH', m.map((x) => x ?? ''));
            return true;
          }
        }
        const r = await this.expandScalar(n.r, writeStderr);
        switch (n.op) {
          case '<': return l < r;
          case '>': return l > r;
          case '-eq': case '-ne': case '-lt': case '-le': case '-gt': case '-ge': {
            const a = this.evalArithBig(l || '0'), b = this.evalArithBig(r || '0');
            return n.op === '-eq' ? a === b : n.op === '-ne' ? a !== b : n.op === '-lt' ? a < b
              : n.op === '-le' ? a <= b : n.op === '-gt' ? a > b : a >= b;
          }
        }
        return new TestEval([], this.fs, this.cwd).binary(l, n.op, r);
      }
    }
  }

  /** The right side of [[ x == PATTERN ]]: quoted parts literal, extglob on */
  private async dbPattern(raw: string, writeStderr: (s: string) => void): Promise<RegExp> {
    if (/\$\(|`/.test(raw)) raw = await this.expandCommandSubstitution(raw, writeStderr);
    const had = this.shoptopts.has('extglob');
    this.shoptopts.add('extglob');
    try {
      return new RegExp(`^(?:${this.patternRegex(raw)})$`, 's');
    } finally {
      if (!had) this.shoptopts.delete('extglob');
    }
  }

  /** The right side of [[ x =~ REGEX ]]: an ERE whose quoted parts match literally */
  private async dbRegex(raw: string, writeStderr: (s: string) => void): Promise<RegExp> {
    if (/\$\(|`/.test(raw)) raw = await this.expandCommandSubstitution(raw, writeStderr);
    const t = this.expandVars(raw);
    const esc = (c: string) => (/[\\^$.*+?()[\]{}|]/.test(c) ? '\\' + c : c);
    let src = '';
    let q = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      const lit = EXPANSION_RESTORE[c];
      if (q === "'") { if (c === "'") q = ''; else src += esc(lit ?? c); continue; }
      if (q === '"') {
        if (c === '"') { q = ''; continue; }
        if (c === '\\' && /[\\"$`]/.test(t[i + 1] ?? '')) { src += esc(t[++i]); continue; }
        src += esc(lit ?? c);
        continue;
      }
      if (c === '$' && t[i + 1] === "'") { const e = ansiCEnd(t, i); src += [...decodeAnsiC(t.slice(i + 2, e - 1))].map(esc).join(''); i = e - 1; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '\\') { src += '\\' + (t[++i] ?? '\\'); continue; }
      // an unquoted expansion is regex text
      src += lit ?? c;
    }
    return posixRegExp(src, { extended: true });
  }

  /** One word, expanded without field splitting or globbing (an assignment value) */
  private async expandScalar(raw: string, writeStderr: (s: string) => void): Promise<string> {
    if (!/[$`'"\\~]/.test(raw)) return raw;
    this.suppressSplit++;
    try {
      const args = this.parseSegment(await this.expandWords(raw, writeStderr)).args;
      return args.map((a) => unmark(a)).join(' ');
    } finally {
      this.suppressSplit--;
    }
  }

  /**
   * Statements that assign arrays (a=(…), a+=(…), a[i]=v, a[i]+=v, and
   * declare/local/typeset/readonly/export with them), handled from the raw
   * text so each element keeps its own quoting. Null if cmd is not one.
   */
  private async tryArrayAssignment(cmd: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void): Promise<number | null> {
    if (!cmd.includes('=')) return null;
    const words = splitAssignWords(cmd);
    if (!words || !words.length) return null;
    const decl = ['declare', 'typeset', 'local', 'readonly', 'export'].includes(words[0]) ? words[0] : null;
    const rest = decl ? words.slice(1) : words;
    const parsed = rest.map((w) => (decl && /^[-+]/.test(w) ? null : parseAssignWord(w)));
    const isArrayWord = (a: AssignWord | null): boolean => !!a && (a.list || a.sub !== undefined);
    if (!parsed.some(isArrayWord)) return null;
    if (!decl && parsed.some((a) => !a)) {
      // `a[0]=x cmd`: not ours; `B=(b b) cmd`: bash passes the text as a plain string
      const first = parsed.findIndex((a) => !a);
      if (!parsed.slice(0, first).some((a) => a?.list)) return null;
      const quoted = rest.map((w, k) => {
        if (k >= first || !parsed[k]?.list) return w;
        const eq = w.indexOf('=') + 1;
        return w.slice(0, eq) + "'" + w.slice(eq).replace(/'/g, "'\\''") + "'";
      });
      return this.execute(quoted.join(' '), writeStdout, writeStderr, false, undefined, true);
    }
    this.substStatus = null;
    let status = 0;
    // The declaration itself (attributes, local scope) with the array words cut to their names
    const declare = async () => {
      // (declare -r: readonly once the values are in, below)
      const declWords = rest.map((w, k) => (isArrayWord(parsed[k]) ? parsed[k]!.name
        : decl !== 'readonly' && /^-[A-Za-z]*r/.test(w) ? w.replace(/r/g, '') : w)).filter((w) => w !== '-');
      if (rest.some((w) => /^-\w*A/.test(w))) {
        for (const a of parsed) if (a && isArrayWord(a) && !this.assocArrays.has(a.name)) { this.arrays.delete(a.name); delete this.env[a.name]; }
      }
      const fresh = parsed.filter((a) => a && a.append && this.getVar(a.name) === undefined && !this.arrays.has(a.name) && !this.assocArrays.has(a.name));
      const st = await this.execute([decl, ...declWords].join(' '), writeStdout, writeStderr, false, undefined, true);
      // (declaring NAME doesn't give it a value for NAME+=(…) to append to)
      for (const a of fresh) if (this.env[a!.name] === '' && !this.arrays.has(a!.name)) delete this.env[a!.name];
      return st;
    };
    // readonly (and declare -r) marks the variables after assigning them
    const roLater = decl === 'readonly' || rest.some((w) => /^-[A-Za-z]*r/.test(w));
    if (decl && decl !== 'readonly') {
      status = await declare();
      if (status !== 0) return status;
    }
    for (const a of parsed) {
      if (!a) continue;
      let err: string | null = null;
      try {
        if (isArrayWord(a)) err = await this.assignArrayWord(a, writeStderr);
        else if (!decl) {
          const value = await this.expandScalar(a.value, writeStderr);
          err = a.append ? this.appendVar(a.name, value) : this.setVar(a.name, value);
        }
      } catch (e) {
        if (!(e instanceof ArithError)) throw e;
        err = e.message;
      }
      if (err) { writeStderr(`tabcomputer: ${err}\r\n`); status = 1; }
    }
    if (decl === 'readonly') status = (await declare()) || status;
    else if (roLater) for (const a of parsed) if (a) this.readonlyVars.add(this.refTarget(a.name));
    return status || (this.substStatus ?? 0);
  }

  /** Apply one a=(…), a+=(…), a[i]=v or a[i]+=v */
  private async assignArrayWord(a: AssignWord, writeStderr: (s: string) => void): Promise<string | null> {
    const name = this.refTarget(a.name);
    if (this.readonlyVars.has(name)) return `${name}: readonly variable`;
    if (!a.list) {
      const value = await this.expandScalar(a.value, writeStderr);
      return a.append ? this.appendVar(name, value, a.sub) : this.setVar(name, value, a.sub);
    }
    if (a.sub !== undefined) return `${a.name}[${a.sub}]: cannot assign list to array member`;
    const items = splitListWords(a.value);
    if (!items) return `syntax error in array assignment: (${a.value})`;
    // Expand every element before the array changes (a=(x "${a[@]}"))
    const assoc = this.assocArrays.get(name);
    const expanded: { sub?: string; values: string[]; append: boolean }[] = [];
    for (const it of items) {
      if (it.sub !== undefined) expanded.push({ sub: it.sub, values: [await this.expandScalar(it.word, writeStderr)], append: /^\[[^\]]*\]\+=/.test(it.word) });
      else expanded.push({ values: assoc ? [await this.expandScalar(it.word, writeStderr)] : await this.expandWordList(it.word, writeStderr), append: false });
    }
    if (assoc) {
      const next = a.append ? assoc : new Map<string, string>();
      for (let k = 0; k < expanded.length; k++) {
        const e = expanded[k];
        if (e.sub !== undefined) next.set(this.assocKey(e.sub), e.values[0]);
        else {
          // bash 5.1: a list of key value pairs
          const key = e.values[0];
          const val = expanded[k + 1]?.sub === undefined ? expanded[++k]?.values[0] ?? '' : '';
          next.set(key, val);
        }
      }
      this.assocArrays.set(name, next);
      delete this.env[name];
      return null;
    }
    const arr: string[] = a.append ? copyArray(this.arrays.get(name) ?? (this.env[name] !== undefined ? [this.env[name]] : [])) : [];
    let next = arrayTop(arr);
    for (const e of expanded) {
      if (e.sub !== undefined) {
        let idx = Number(this.evalArithBig(e.sub));
        if (idx < 0) idx += arrayTop(arr);
        if (idx < 0) return `${name}[${e.sub}]: bad array subscript`;
        arr[idx] = e.values[0];
        next = idx + 1;
      } else {
        for (const v of e.values) arr[next++] = v;
      }
    }
    this.arrays.set(name, arr);
    delete this.env[name];
    return null;
  }

  private async expandWordList(text: string, writeStderr: (s: string) => void): Promise<string[]> {
    const expanded = await this.expandWords(text, writeStderr);
    return (await this.expandGlobs(this.parseSegment(expanded).args, writeStderr)) ?? [];
  }

  private async execSelect(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const parsed = this.parseLoopConstruct(input, 'select');
    if (!parsed) { writeStderr('select: syntax error\r\n'); return 1; }

    // Parse "VAR in item1 item2 item3" from condition
    const selMatch = parsed.condition.match(/^(\w+)\s+in\s+(.+)$/);
    if (!selMatch) { writeStderr('select: syntax error\r\n'); return 1; }

    const varName = selMatch[1];
    const items = await this.expandWordList(selMatch[2], writeStderr);

    // Display menu
    for (let idx = 0; idx < items.length; idx++) {
      writeStdout(`${idx + 1}) ${items[idx]}\r\n`);
    }

    // Read selection from stdin (__PIPE_STDIN or REPLY)
    const ps3 = this.env['PS3'] || '#? ';
    const hasPipeStdin = '__PIPE_STDIN' in this.env;
    let readInput = hasPipeStdin ? this.env['__PIPE_STDIN'] : '';

    let iter = 0;
    while (iter++ < 100) {
      // Get one line of input
      const firstNewline = readInput.indexOf('\n');
      let choice: string;
      if (firstNewline >= 0) {
        choice = readInput.slice(0, firstNewline).trim();
        readInput = readInput.slice(firstNewline + 1);
        if (hasPipeStdin) this.env['__PIPE_STDIN'] = readInput;
      } else if (readInput.trim()) {
        choice = readInput.trim();
        readInput = '';
        if (hasPipeStdin) delete this.env['__PIPE_STDIN'];
      } else {
        break; // no more input
      }

      this.env['REPLY'] = choice;
      const num = parseInt(choice, 10);
      if (num >= 1 && num <= items.length) {
        this.env[varName] = items[num - 1];
      } else {
        this.env[varName] = '';
      }

      try {
        if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr, false, undefined, true);
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1 && this.loopDepth > 1) throw new BreakSignal(e.levels - 1); break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1 && this.loopDepth > 1) throw new ContinueSignal(e.levels - 1); continue; }
        throw e;
      }

      // In non-interactive (piped) mode, process one selection then stop
      if (!hasPipeStdin) break;
    }

    return 0;
  }

  /** >0 while expanding words that are never field-split (case words and patterns) */
  private suppressSplit = 0;

  /** IFS for field splitting: '' (no splitting) inside case words and patterns */
  private fieldIFS(): string | undefined {
    return this.suppressSplit > 0 ? '' : this.env['IFS'];
  }

  /** Expand $…, ${…}, $(…), `…`, $((…)) in quote-free text: no field splitting or globbing */
  private async expandFragment(text: string): Promise<string> {
    if (!/[$`]/.test(text)) return text;
    this.suppressSplit++;
    try {
      let t = this.expandArithmetic(text);
      t = await this.expandCommandSubstitution(t, () => {}, true);
      t = this.expandVars(t, true);
      return restoreExpansion(t);
    } finally {
      this.suppressSplit--;
    }
  }

  /**
   * Split a case word or pattern into parts: quoted text is literal; unquoted
   * text is a glob (in a pattern), with $-expansions expanded and still glob.
   */
  private async caseParts(raw: string): Promise<{ text: string; literal: boolean }[]> {
    const parts: { text: string; literal: boolean }[] = [];
    let i = 0;
    const n = raw.length;
    let glob = '';
    const flushGlob = () => { if (glob) { parts.push({ text: glob, literal: false }); glob = ''; } };
    while (i < n) {
      const c = raw[i];
      if (c === '\\' && i + 1 < n) { flushGlob(); parts.push({ text: raw[i + 1], literal: true }); i += 2; continue; }
      if (c === "'") {
        const e = raw.indexOf("'", i + 1);
        const end = e < 0 ? n : e;
        flushGlob();
        parts.push({ text: raw.slice(i + 1, end), literal: true });
        i = end + 1;
        continue;
      }
      if (c === '$' && raw[i + 1] === "'") {
        let j = i + 2;
        while (j < n && raw[j] !== "'") j += raw[j] === '\\' ? 2 : 1;
        flushGlob();
        parts.push({ text: this.tokenize(raw.slice(i, j + 1)).join(''), literal: true });
        i = j + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        let inner = '';
        while (j < n && raw[j] !== '"') {
          if (raw[j] === '\\' && '$`"\\'.includes(raw[j + 1] ?? '')) { inner += EXPANSION_PROTECT[raw[j + 1]] ?? raw[j + 1]; j += 2; continue; }
          if (raw[j] === '$' && raw[j + 1] === '(') { const e = this.skipBalancedParen(raw, j + 1); inner += raw.slice(j, e); j = e; continue; }
          inner += raw[j];
          j++;
        }
        flushGlob();
        parts.push({ text: await this.expandFragment(inner), literal: true });
        i = j + 1;
        continue;
      }
      if (c === '$' || c === '`') {
        // An unquoted expansion: its value is still a pattern
        let j = i + 1;
        if (c === '`') { while (j < n && raw[j] !== '`') j += raw[j] === '\\' ? 2 : 1; j++; }
        else if (raw[j] === '(') j = this.skipBalancedParen(raw, j);
        else if (raw[j] === '{') { let d = 0; for (; j < n; j++) { if (raw[j] === '{') d++; else if (raw[j] === '}' && --d === 0) { j++; break; } } }
        else if (/[A-Za-z_]/.test(raw[j] ?? '')) { while (j < n && /\w/.test(raw[j])) j++; }
        else if (j < n) j++;
        flushGlob();
        parts.push({ text: await this.expandFragment(raw.slice(i, j)), literal: false });
        i = j;
        continue;
      }
      if (c === '~' && i === 0 && (n === 1 || raw[1] === '/')) { glob += this.env['HOME'] || '/home/user'; i++; continue; }
      glob += c;
      i++;
    }
    flushGlob();
    return parts;
  }

  /** Index just past the `)` matching the `(` at s[j] */
  private skipBalancedParen(s: string, j: number): number {
    let depth = 0;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === "'") { const e = s.indexOf("'", j + 1); j = e < 0 ? s.length : e; continue; }
      if (c === '"') { j++; while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j + 1;
    }
    return s.length;
  }

  /**
   * case WORD in [(]PATTERN[|PATTERN]...) LIST ;; ... esac — the word and the
   * patterns are expanded when matched (no field splitting); quoted parts of
   * a pattern match literally. ;& falls through, ;;& keeps testing.
   */
  private async execCase(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const src = input.trim();
    const n = src.length;
    let i = 4; // after `case`
    const skipBlanks = (alsoSemis: boolean) => {
      while (i < n && (/\s/.test(src[i]) || (alsoSemis && src[i] === ';'))) i++;
    };
    // A shell word: up to an unquoted blank (or `;`/`)`/`|` when stopAt says so)
    const readWord = (stop: RegExp): string => {
      const start = i;
      while (i < n && !stop.test(src[i])) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === "'") { const e = src.indexOf("'", i + 1); i = e < 0 ? n : e + 1; continue; }
        if (c === '"') { i++; while (i < n && src[i] !== '"') i += src[i] === '\\' ? 2 : 1; i++; continue; }
        if (c === '`') { i++; while (i < n && src[i] !== '`') i += src[i] === '\\' ? 2 : 1; i++; continue; }
        if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) {
          if (src[i + 1] === '(') { i = this.skipBalancedParen(src, i + 1); continue; }
          let d = 0;
          for (i++; i < n; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) { i++; break; } }
          continue;
        }
        if (c === '(' && this.shoptopts.has('extglob') && i > start && '?*+@!'.includes(src[i - 1])) { i = this.skipBalancedParen(src, i); continue; }
        i++;
      }
      return src.slice(start, i);
    };
    skipBlanks(false);
    const rawWord = readWord(/[\s;]/);
    skipBlanks(true);
    if (!rawWord || src.slice(i, i + 2) !== 'in' || /[^\s;]/.test(src[i + 2] ?? ' ')) {
      writeStderr(`${this.env['0'] || 'sh'}: syntax error near unexpected token \`${src.slice(i, i + 10)}'\r\n`);
      return 2;
    }
    i += 2;
    const word = (await this.caseParts(rawWord)).map((p) => p.text).join('');

    let exitCode = 0;
    let fallthrough = false;
    for (;;) {
      skipBlanks(true);
      if (i >= n) break;
      if (src.startsWith('esac', i) && !/[\w]/.test(src[i + 4] ?? '')) break;
      if (src[i] === '(') i++;
      // Patterns up to the clause's `)`
      const patterns: string[] = [];
      for (;;) {
        skipBlanks(false);
        patterns.push(readWord(/[\s|)]/));
        skipBlanks(false);
        if (src[i] === '|') { i++; continue; }
        break;
      }
      if (src[i] !== ')') { writeStderr(`${this.env['0'] || 'sh'}: syntax error in case pattern\r\n`); return 2; }
      i++;
      // The clause's commands, up to ;; ;& ;;& or esac (skipping nested case, quotes, parens)
      const bodyStart = i;
      let sep = '';
      let depth = 0;
      let nested = 0;
      let cmdPos = true;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { i += 2; cmdPos = false; continue; }
        if (c === "'" || c === '"' || c === '`') {
          if (c === "'") { const e = src.indexOf("'", i + 1); i = e < 0 ? n : e + 1; }
          else { i++; while (i < n && src[i] !== c) i += src[i] === '\\' ? 2 : 1; i++; }
          cmdPos = false;
          continue;
        }
        if (c === '$' && src[i + 1] === '(') { i = this.skipBalancedParen(src, i + 1); cmdPos = false; continue; }
        if (c === ';' && depth === 0 && nested === 0 && (src[i + 1] === ';' || src[i + 1] === '&')) {
          sep = src.startsWith(';;&', i) ? ';;&' : src.startsWith(';;', i) ? ';;' : ';&';
          break;
        }
        if (c === '(') { depth++; i++; cmdPos = true; continue; }
        if (c === ')') { if (depth > 0) depth--; i++; cmdPos = nested > 0; continue; }
        if (/[;&|\n]/.test(c)) { i++; cmdPos = true; continue; }
        if (/\s/.test(c)) { i++; continue; }
        const m = /^[^\s;&|()<>'"`\\]+/.exec(src.slice(i));
        const w = m ? m[0] : c;
        if (cmdPos && depth === 0 && w === 'esac') {
          if (nested === 0) break;
          nested--;
        } else if (cmdPos && w === 'case') nested++;
        cmdPos = cmdPos && ['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time', 'in'].includes(w);
        if (w === 'in' && nested > 0) cmdPos = false;
        i += w.length;
      }
      const body = src.slice(bodyStart, i).trim().replace(/;\s*$/, '');
      if (sep) i += sep.length;

      let matched = fallthrough;
      for (const p of matched ? [] : patterns) {
        const parts = await this.caseParts(p);
        // Quoted characters are marked literal, so a bracket can span them (*["$t"]*)
        const marked = parts.map((x) => (x.literal ? x.text.replace(/[\s\S]/g, '\x01$&') : x.text)).join('');
        const re = new RegExp('^' + this.globToRegex(marked) + '$', 's');
        if (re.test(word)) { matched = true; break; }
      }
      if (!matched) continue;
      exitCode = body ? await this.execute(body, writeStdout, writeStderr, false, undefined, true) : 0;
      if (sep === ';&') { fallthrough = true; continue; }
      fallthrough = false;
      if (sep === ';;&') continue;
      return exitCode;
    }
    return exitCode;
  }

  // ─── PATH EXECUTION ─────────────────────────────────────────────────────────

  /** Run a registered command whose stdin is this shell's fd 0 (execLazyStdin); `stream`: give it writers to fds 1 and 2 */
  private async execWithLiveStdin(cmd: Command, ctx: CommandContext, stream: boolean): Promise<number> {
    const ks = this.kernelStdio!;
    if (stream) { ctx.streamStdout = ks.out; ctx.streamStderr = ks.err; }
    const { execLazyStdin } = await import('./shell-stdio');
    return this.runCommand({ exec: (c) => execLazyStdin(cmd, c, () => ks.readAll()) }, ctx);
  }

  /**
   * Does pipeline segment `i` read this shell's own stdin, fd 0 of the kernel
   * process it runs as (shell-stdio.ts)? Not when a pipe, here-doc, here-string,
   * `<` or an enclosing piped loop gives it a string instead.
   */
  private liveStdin(i: number, heredocStdin: string, hereString: string | undefined, redirects: Redirect[]): boolean {
    return !!this.kernelStdio && this.kernelStdinLive && i === 0 && !heredocStdin && hereString === undefined &&
      !redirects.some(r => r.type === '<') && !('__PIPE_STDIN' in this.env);
  }

  /**
   * Run segment `i` (and the kernel programs piped right after it) as kernel
   * processes when it is a WASM or x86 program (src/shell-kernel.ts). Null when
   * it isn't one, so the caller falls back to the in-page paths.
   */
  private async tryKernelRun(
    pipeline: string[], i: number, name: string, args: string[], redirects: Redirect[], ctx: CommandContext,
    hasShellStdin: boolean, writeStdout: (s: string) => void, writeStderr: (s: string) => void, terminal: any,
    liveStdin = false,
  ): Promise<{ lastIndex: number; redirects: Redirect[]; exitCode: number; statuses: number[]; stdout: string; stderr: string } | null> {
    const { mayBeKernelProgram, resolveKernelProgram, builtinStage, runKernelPipeline } = _shellKernel ?? await loadShellKernel();
    const progress = (m: string) => writeStderr(`  ${m}\r\n`);
    const stageFor = async (n: string, a: string[]) =>
      builtinStage(this, n, a) ?? (mayBeKernelProgram(this, n) ? await resolveKernelProgram(this, n, a, progress) : null);
    // Cheap exit for the common case: neither a filter builtin nor something to look up on PATH
    const firstIsFilter = !!builtinStage(this, name, args);
    if (!firstIsFilter && !mayBeKernelProgram(this, name)) return null;
    if (firstIsFilter && i === pipeline.length - 1) return null;
    const first = await stageFor(name, args);
    if (!first) return null;
    // exec -a NAME: the program runs with NAME as argv[0]
    const a0 = this.execArgv0;
    if (a0 && a0.name === name && !first.builtin) {
      this.execArgv0 = undefined;
      first.path = first.path ?? first.argv[0];
      first.argv = [a0.argv0, ...first.argv.slice(1)];
    }
    const hasOutRedirect = (r: Redirect[]) => r.some(x => x.type !== '<');
    const programs = [first];
    let last = i;
    let lastRedirects = redirects;
    if (!hasOutRedirect(redirects)) {
      for (let j = i + 1; j < pipeline.length; j++) {
        const seg = pipeline[j].trim();
        if (splitEnvPrefix(seg) || this.isControlStructure(seg) || seg.startsWith('(') || seg.startsWith('{')) break;
        const parsed = this.parseSegment(seg);
        if (parsed.args.length === 0 || parsed.hereString !== undefined || parsed.redirects.some(r => r.type === '<')) break;
        if (parsed.args.some(a => /^[<>]\(/.test(a))) break; // process substitution
        const words = await this.expandGlobs(parsed.args);
        if (!words) break;
        const prog = await stageFor(words[0], words.slice(1));
        if (!prog) break;
        programs.push(prog);
        last = j;
        lastRedirects = parsed.redirects;
        if (hasOutRedirect(parsed.redirects)) break;
      }
    }
    // Only worth it when a real kernel program is involved
    if (!programs.some(p => !p.builtin)) return null;
    // `> file`, `>> file`, `2> file`, `2>&1` on the last stage: the kernel opens
    // the files and the programs write them directly (binary-safe, streamed)
    let stdoutTo: { path: string; append: boolean } | undefined;
    let stderrTo: { path: string; append: boolean } | 'stdout' | undefined;
    let handled = false;
    if (lastRedirects.length && lastRedirects.every(x =>
      x.type === '2>&1' || ((x.type === '>' || x.type === '>>' || x.type === '2>' || x.type === '2>>') && x.target && !x.target.startsWith('&') && (x.fd === undefined || x.fd === 1 || x.fd === 2)))) {
      handled = true;
      for (const x of lastRedirects) {
        const file = { path: this.fs.resolvePath(x.target, this.cwd), append: x.type.endsWith('>>') };
        if (x.type === '2>&1') { if (stdoutTo) stderrTo = 'stdout'; else handled = false; }
        else if (x.type.startsWith('2') || x.fd === 2) stderrTo = file;
        else stdoutTo = file;
      }
      if (!handled) { stdoutTo = undefined; stderrTo = undefined; }
    }
    if (handled) lastRedirects = [];
    const crlf = (w: (s: string) => void) => (t: string) => w(t.replace(/\r?\n/g, '\r\n'));
    const captureStdout = last < pipeline.length - 1 || hasOutRedirect(lastRedirects) || (!stdoutTo && !!terminal?.captureStdout);
    const captureStderr = hasOutRedirect(lastRedirects);
    // In a shell that is a kernel process the programs get its own fds when
    // nothing in between needs the data as a string (shell-stdio.ts)
    const ks = this.kernelStdio;
    let fds: { 0?: OpenFile; 1?: OpenFile; 2?: OpenFile } | undefined;
    if (ks) {
      fds = {
        0: liveStdin && !hasShellStdin ? ks.file(0) : undefined,
        1: !captureStdout && writesTo(writeStdout, ks.out) ? ks.file(1) : undefined,
        2: !captureStderr && writesTo(writeStderr, ks.err) ? ks.file(2) : undefined,
      };
      await ks.flush();
    }
    const r = await runKernelPipeline(this, programs, {
      stdin: hasShellStdin ? ctx.stdin : undefined,
      stdoutTo, stderrTo,
      captureStdout,
      captureStderr,
      writeStdout: crlf(writeStdout),
      writeStderr: crlf(writeStderr),
      // (a shell on its own pty does job control there; one on pipes uses its fds)
      terminal: this.kernelTty ?? (ks ? undefined : terminal),
      fds,
      command: pipeline.slice(i, last + 1).map(x => x.trim()).join(' | '),
      cwd: this.cwd,
      env: this.exportedEnv(),
      inheritFds: this.inheritableFds(writeStdout, writeStderr),
    });
    return { lastIndex: last, redirects: lastRedirects, ...r, stdout: ctx.stdout + r.stdout, stderr: ctx.stderr + r.stderr };
  }

  /**
   * `cmd &` where every stage is a kernel program: a real background job in
   * the terminal's session (output to the tty, SIGTTIN if it reads). False
   * when the pipeline has anything else, so the in-page background path runs it.
   */
  private async launchKernelBackground(command: string, writeStdout: (s: string) => void, term: any): Promise<boolean> {
    // A shell that is a kernel process: on its pty (an interactive sh in a
    // screen window), or on its own fds when its output goes there (a script)
    const ks = this.kernelStdio;
    if (this.kernelTty) term = this.kernelTty;
    else if (ks) term = undefined;
    const onFds = !term && !!ks && writesTo(writeStdout, ks.out);
    if ((!term?.tty && !onFds) || /[;&]|\|\||\$\(|`/.test(command)) return false;
    const { mayBeKernelProgram, resolveKernelProgram, runKernelPipeline } = _shellKernel ?? await loadShellKernel();
    const segments = this.parsePipeline(await this.expandWords(command, () => {}));
    const programs = [];
    for (const seg of segments) {
      const t = seg.trim();
      if (!t || splitEnvPrefix(t) || this.isControlStructure(t) || t.startsWith('(')) return false;
      const parsed = this.parseSegment(t);
      if (parsed.redirects.length || parsed.hereString !== undefined || parsed.args.length === 0) return false;
      const words = await this.expandGlobs(parsed.args);
      if (!words || !mayBeKernelProgram(this, words[0])) return false;
      const prog = await resolveKernelProgram(this, words[0], words.slice(1));
      if (!prog) return false;
      programs.push(prog);
    }
    if (programs.length === 0) return false;
    if (onFds) await ks!.flush();
    // Without job control a background job's stdin is /dev/null (POSIX 2.9.3.1); a script prints no [N] pid
    const quiet = onFds && !this.options.has('monitor') && !this.interactiveFlag;
    await runKernelPipeline(this, programs, {
      captureStdout: false, captureStderr: false,
      writeStdout: quiet ? () => {} : writeStdout, writeStderr: quiet ? () => {} : writeStdout,
      stdin: onFds && !this.options.has('monitor') ? '' : undefined,
      fds: onFds ? { 0: ks!.file(0), 1: ks!.file(1), 2: ks!.file(2) } : undefined,
      terminal: term, command, background: true, cwd: this.cwd, env: this.exportedEnv(),
      inheritFds: onFds ? this.inheritableFds(writeStdout, writeStdout) : undefined,
    });
    const job = [...this.backgroundJobs.values()].pop();
    if (job?.pids?.length) this.env['!'] = String(job.pids[job.pids.length - 1]);
    return true;
  }

  /**
   * Search PATH directories for an executable file.
   * Also checks node_modules/.bin relative to cwd.
   */
  async findExecutableInPath(name: string): Promise<string | null> {
    // If name contains '/', treat it as a path
    if (name.includes('/')) {
      const resolved = this.fs.resolvePath(name, this.cwd);
      try {
        const stat = await this.fs.stat(resolved);
        if (stat.type === 'file') return resolved;
      } catch {
        return null;
      }
      return null;
    }

    // Build search path: node_modules/.bin first, then PATH
    const pathDirs: string[] = [];

    // Add node_modules/.bin from cwd (most specific first)
    let dir = this.cwd;
    while (dir !== '/') {
      pathDirs.push(`${dir}/node_modules/.bin`);
      const parent = dir.substring(0, dir.lastIndexOf('/')) || '/';
      if (parent === dir) break;
      dir = parent;
    }
    pathDirs.push('/node_modules/.bin');

    // Add PATH directories
    const envPath = this.env['PATH'] || '';
    if (envPath) {
      pathDirs.push(...envPath.split(':').filter(Boolean));
    }

    // Search each directory (also check for .wasm extension)
    for (const pathDir of pathDirs) {
      for (const suffix of ['', '.wasm']) {
        // (a relative PATH entry is relative to the current directory)
        const candidate = this.fs.resolvePath(`${pathDir}/${name}${suffix}`, this.cwd);
        try {
          const stat = await this.fs.stat(candidate);
          if (stat.type === 'file' || stat.type === 'symlink') {
            return candidate;
          }
        } catch {
          // Not found, continue
        }
      }
    }

    return null;
  }

  /**
   * Execute a script file, following symlinks and handling shebangs.
   */
  private async executeScript(
    filePath: string,
    args: string[],
    ctx: CommandContext,
    writeStdout: (s: string) => void,
    writeStderr: (s: string) => void,
    /** argv[0] as the caller gave it (the command word); a symlink is followed for the binary only, as on Linux */
    argv0: string = filePath,
  ): Promise<number> {
    // Only a shell script reads the shell's live fd 0 as it goes; anything else gets it as ctx.stdin
    const fillStdin = async () => {
      if (!ctx.liveStdin || !this.kernelStdio) return;
      ctx.liveStdin = false;
      ctx.stdin = await this.kernelStdio.readAll();
    };
    // Installed packages (/usr/bin/<cmd> -> /usr/lib/pkg/<name>/...) run with
    // the arguments and preloads their package records
    try {
      const real = await this.fs.realpath(filePath);
      // (a package's script launchers, like ruby's gem, and x86-64 programs
      // run in Blink, like perl, take the paths below)
      if (packageOfPath(real) && await this.isWasmFile(real)) {
        await fillStdin();
        return await runPackageBinary(real, filePath.split('/').pop() || filePath, args, ctx,
          filePath.startsWith('/') ? filePath : this.fs.resolvePath(filePath, this.cwd));
      }
    } catch { /* fall through to the generic path */ }

    // Resolve symlinks
    let resolvedPath = filePath;
    try {
      const stat = await this.fs.stat(filePath);
      if (stat.type === 'symlink') {
        const linkTarget = await this.fs.readlink(filePath);
        // Resolve relative symlink targets
        if (!linkTarget.startsWith('/')) {
          const linkDir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
          resolvedPath = this.fs.resolvePath(linkTarget, linkDir);
        } else {
          resolvedPath = linkTarget;
        }
      }
    } catch (e: any) {
      writeStderr(`tabcomputer: ${filePath}: ${e.message}\r\n`);
      return 1;
    }

    // Read script content
    let content: string;
    try {
      content = await this.fs.readFile(resolvedPath, 'utf8') as string;
    } catch (e: any) {
      writeStderr(`tabcomputer: ${resolvedPath}: ${e.message}\r\n`);
      return 1;
    }
    {
      const m = /^#!\s*(\S+)(?:\s+(?:-S\s+)?(\S+))?/.exec(content);
      const base = (p?: string) => p?.slice(p.lastIndexOf('/') + 1) ?? '';
      const interp = m ? (base(m[1]) === 'env' ? base(m[2]) : base(m[1])) : '';
      // No #! line: a shell script (the default below) unless it turns out to be WASM or JavaScript
      if (m && !((interp === 'sh' || interp === 'bash') && !packageShadows(this.fs).has(interp))) await fillStdin();
    }

    // Check if this is a WASM binary — run through WASI runtime
    if (content.charCodeAt(0) === 0x00 && content.charCodeAt(1) === 0x61 &&
        content.charCodeAt(2) === 0x73 && content.charCodeAt(3) === 0x6d) {
      await fillStdin();
      return this.executeWasmBinary(resolvedPath, args, ctx, writeStdout, writeStderr, argv0);
    }

    // Check for #!wasi-pkg stub — load from package cache
    if (content.startsWith('#!wasi-pkg ')) {
      const pkgName = content.split('\n')[0].substring('#!wasi-pkg '.length).trim();
      try {
        const wasmModule = await getCompiledModule(pkgName, (msg) => {
          writeStderr(`  ${msg}\r\n`);
        });
        const { runWasiProgram } = await import('./wasi/run-command');
        return await runWasiProgram(ctx, {
          module: wasmModule, argv: [pkgName, ...args], cwd: this.cwd, env: { ...this.env },
        });
      } catch (e: any) {
        const { WasiExit } = await loadWasiRuntime();
        if (e instanceof WasiExit) return e.code;
        writeStderr(`tabcomputer: ${pkgName}: ${e.message}\r\n`);
        return 1;
      }
    }

    // Check for #!x86-pkg stub — load from x86 ELF package cache
    if (content.startsWith('#!x86-pkg ')) {
      const parts = content.split('\n')[0].substring('#!x86-pkg '.length).trim().split(/\s+/);
      const pkgName = parts[0];
      const appletName = parts[1]; // undefined if not a multi-call binary
      try {
        const { getX86Binary } = await import('./x86-packages');
        const elfData = await getX86Binary(pkgName, (msg) => {
          writeStderr(`  ${msg}\r\n`);
        });
        const { executeElfFromBytes } = await import('./x86/runtime');
        const argv0 = appletName || pkgName;
        return executeElfFromBytes(elfData, argv0, args, {
          fs: this.fs, cwd: this.cwd, args, env: this.env,
          stdin: ctx.stdin || '', writeStdout: writeStdout, writeStderr: writeStderr,
        });
      } catch (e: any) {
        writeStderr(`tabcomputer: ${pkgName}: ${e.message}\r\n`);
        return 1;
      }
    }

    // Detect ELF binaries → run in x86-64 emulator
    if (content.charCodeAt(0) === 0x7f && content.charCodeAt(1) === 0x45 /* E */ &&
        content.charCodeAt(2) === 0x4c /* L */ && content.charCodeAt(3) === 0x46 /* F */) {
      // Blink (wasm) when the page can run it, else the built-in src/x86.
      await fillStdin();
      const { runElf } = await import('./x86-engine');
      return runElf(resolvedPath, args, {
        fs: this.fs, cwd: this.cwd, args, env: this.env, shell: this,
        stdin: ctx.stdin || '', writeStdout: writeStdout, writeStderr: writeStderr,
      }, undefined, argv0);
    }

    // Reject other binary files (Mach-O, etc.) that can't be interpreted
    if (content.charCodeAt(0) === 0x7f || content.includes('\0')) {
      writeStderr(`tabcomputer: ${resolvedPath}: cannot execute binary file\n`);
      return 126;
    }

    // Check for shebang
    const firstLine = content.split('\n')[0];
    if (firstLine.startsWith('#!')) {
      const shebang = firstLine.substring(2).trim();
      const [interpreter, ...interpArgs] = shebang.split(/\s+/);

      // `#!/usr/bin/env [-S] [NAME=value...] prog args` looks prog up on PATH
      const interpBase = interpreter.slice(interpreter.lastIndexOf('/') + 1);
      let interp = interpreter;
      let viaEnv = false;
      if (interpBase === 'env') {
        while (interpArgs.length && (interpArgs[0] === '-S' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(interpArgs[0]))) interpArgs.shift();
        interp = interpArgs.shift() || '';
        viaEnv = true;
      }
      const base = interp.slice(interp.lastIndexOf('/') + 1);
      if (base === 'node' || base === 'nodejs') {
        return this.executeNodeScript(resolvedPath, content, args, ctx, writeStdout, writeStderr);
      } else if ((base === 'sh' || base === 'bash') && !packageShadows(this.fs).has(base)) {
        return this.executeShellScript(content, args, ctx, writeStdout, writeStderr, filePath);
      }
      return this.runInterpreter(interp, viaEnv, [...interpArgs, filePath, ...args], ctx, writeStdout, writeStderr);
    }

    // No shebang - try to detect file type
    // Check if content is just a path to another file (npm bin stubs)
    const trimmedContent = content.trim();
    if (!trimmedContent.includes('\n') && !trimmedContent.includes(' ') &&
        (trimmedContent.endsWith('.js') || trimmedContent.endsWith('.mjs') || trimmedContent.endsWith('.ts'))) {
      try {
        const targetContent = await this.fs.readFile(trimmedContent, 'utf8') as string;
        await fillStdin();
        return this.executeNodeScript(trimmedContent, targetContent, args, ctx, writeStdout, writeStderr);
      } catch (e: any) {
        // Target doesn't exist, fall through
      }
    }

    // If it looks like JavaScript, run with node
    if (resolvedPath.endsWith('.js') || resolvedPath.endsWith('.mjs') ||
        content.trimStart().startsWith('const ') ||
        content.trimStart().startsWith('import ') ||
        content.trimStart().startsWith('var ') ||
        content.trimStart().startsWith('let ')) {
      await fillStdin();
      return this.executeNodeScript(resolvedPath, content, args, ctx, writeStdout, writeStderr);
    }

    // Default to shell script
    return this.executeShellScript(content, args, ctx, writeStdout, writeStderr, filePath);
  }

  /** Is `path` a WebAssembly module? */
  private async isWasmFile(path: string): Promise<boolean> {
    try {
      const d = await this.fs.readFile(path);
      return typeof d !== 'string' && d[0] === 0x00 && d[1] === 0x61 && d[2] === 0x73 && d[3] === 0x6d;
    } catch { return false; }
  }

  /**
   * Run a shebang interpreter: an existing absolute path runs as itself
   * (packages, WASM, ELF, nested scripts); otherwise its name is looked up
   * like a command, so `#!/usr/bin/python3` and `#!/usr/bin/env python3`
   * both reach a builtin or an installed package.
   */
  private async runInterpreter(
    interp: string,
    viaEnv: boolean,
    argv: string[],
    ctx: CommandContext,
    writeStdout: (s: string) => void,
    writeStderr: (s: string) => void,
  ): Promise<number> {
    if (!interp) {
      writeStderr('tabcomputer: env: missing interpreter in #! line\n');
      return 126;
    }
    if (interp.includes('/') && !viaEnv && await this.fs.exists(interp)) {
      return this.executeScript(interp, argv, ctx, writeStdout, writeStderr);
    }
    // A builtin's file on PATH (path-shims.ts ALWAYS_SHIMS): run that builtin
    if (interp === BUILTIN_SHIM_INTERP && argv.length) {
      const named = this.commands.get(argv[0].slice(argv[0].lastIndexOf('/') + 1));
      if (named) { ctx.args = argv.slice(1); return this.runCommand(named, ctx); }
    }
    const base = interp.slice(interp.lastIndexOf('/') + 1);
    const cmd = this.commands.get(base);
    if (cmd && !packageShadows(this.fs).has(base)) {
      ctx.args = argv;
      return this.runCommand(cmd, ctx);
    }
    const found = cmd ? `${PKG_BIN_DIR}/${base}` : await this.findExecutableInPath(base);
    if (found) return this.executeScript(found, argv, ctx, writeStdout, writeStderr);
    writeStderr(`tabcomputer: ${interp}: bad interpreter: No such file or directory\n`);
    return 126;
  }

  /**
   * Execute a WASM+WASI binary through the WasiRT.
   */
  private async executeWasmBinary(
    filePath: string,
    args: string[],
    ctx: CommandContext,
    writeStdout: (s: string) => void,
    writeStderr: (s: string) => void,
    argv0: string = filePath,
  ): Promise<number> {
    try {
      const data = await this.fs.readFile(filePath) as Uint8Array;
      const image = new Uint8Array(data);
      const wasmModule = await WebAssembly.compile(image);

      // (the name the program was run by, not a symlink's target: multi-call binaries pick their applet by it)
      const programName = argv0.split('/').pop() || argv0;
      const { runWasiProgram } = await import('./wasi/run-command');
      return await runWasiProgram(ctx, {
        module: wasmModule, image, argv: [programName, ...args], cwd: this.cwd, env: { ...this.env },
      });
    } catch (e: any) {
      const { WasiExit } = await loadWasiRuntime();
      if (e instanceof WasiExit) {
        return e.code;
      }
      writeStderr(`tabcomputer: ${filePath}: ${e.message}\n`);
      return 1;
    }
  }

  /**
   * Execute content as a Node.js script using the 'node' command.
   */
  private async executeNodeScript(
    filePath: string,
    content: string,
    args: string[],
    ctx: CommandContext,
    writeStdout: (s: string) => void,
    writeStderr: (s: string) => void,
  ): Promise<number> {
    // Use the existing 'node' command with the script path
    const nodeCmd = this.commands.get('node');
    if (!nodeCmd) {
      writeStderr('tabcomputer: node command not available\r\n');
      return 127;
    }

    // Run bin symlinks (e.g. /usr/local/bin/claude) under their real path so
    // __dirname, relative requires, and per-package runtime tweaks see the package.
    try { filePath = await this.fs.realpath(filePath); } catch { /* keep as given */ }

    const nodeCtx: CommandContext = {
      args: [filePath, ...args],
      fs: ctx.fs,
      cwd: ctx.cwd,
      env: ctx.env,
      stdin: ctx.stdin,
      stdout: '',
      stderr: '',
      shell: ctx.shell,
      terminal: ctx.terminal,
    };

    const exitCode = await nodeCmd.exec(nodeCtx);
    if (nodeCtx.stdout) writeStdout(nodeCtx.stdout.replace(/\n/g, '\r\n'));
    if (nodeCtx.stderr) writeStderr(nodeCtx.stderr.replace(/\n/g, '\r\n'));
    return exitCode;
  }

  /**
   * Execute content as a shell script.
   */
  /**
   * Run a script in a child shell (its variables, functions, traps, options
   * and cwd don't leak into this one), like `sh FILE ARGS…`. `argv0` becomes $0.
   */
  async executeShellScript(
    content: string,
    args: string[],
    ctx: CommandContext,
    writeStdout: (s: string) => void,
    writeStderr: (s: string) => void,
    argv0?: string,
  ): Promise<number> {
    const child = this.fork();
    child.startProcess();
    child.setPositional(args, argv0);
    if (argv0 !== undefined) child.setScriptSource(argv0);
    // Its first command reads the script's stdin, unless that is the shell's fd 0
    if (!ctx.liveStdin) child.setInjectedStdin(ctx.stdin);
    return child.runScriptText(content, ctx.terminal, writeStdout, writeStderr);
  }

  /** Stdin for the next command this shell runs (`… | sh -c CMD`) */
  setInjectedStdin(stdin: string): void {
    this.injectedStdin = stdin;
    // `read` in any statement takes it record by record (a script's first
    // statement isn't always the one that reads: `exec 3>&1; read x`)
    this.env['__PIPE_STDIN'] = stdin;
    this.kernelStdinLive = false;
  }

  /** Replace $1… (and $0 when given), as on entry to a script or `set --`. */
  setPositional(args: string[], argv0?: string): void {
    for (const k of Object.keys(this.env)) {
      if (/^[1-9]\d*$/.test(k)) delete this.env[k];
    }
    if (argv0 !== undefined) this.env['0'] = argv0;
    for (let i = 0; i < args.length; i++) this.env[String(i + 1)] = args[i];
    this.env['#'] = String(args.length);
    this.env['@'] = args.join(' ');
  }

  /** Run script text in this shell as its main program: `exit` ends it, then the EXIT trap runs. */
  async runScriptText(
    content: string, terminal: any,
    writeStdout: (s: string) => void, writeStderr: (s: string) => void,
  ): Promise<number> {
    const depth = this.executeDepth;
    this.scriptShell = true;
    // Statements run nested, so exit/errexit unwind to here rather than to each statement
    this.executeDepth++;
    if (!this.abortController) this.abortController = this.inheritedAbort ?? new AbortController();
    let exitCode = 0;
    try {
      for (const stmt of groupStatements(stripComments(content))) {
        if (this.abortController?.signal.aborted) { exitCode = 130; break; }
        // set -n (noexec): a non-interactive shell reads the rest without running it
        if (this.options.has('noexec') && !this.interactiveFlag) break;
        this.currentLine = stmt.line;
        this.env['LINENO'] = String(stmt.line);
        try {
          exitCode = await this.execute(stmt.text, writeStdout, writeStderr, false, terminal, true);
        } catch (e) {
          if (!(e instanceof LineAbort)) throw e;
          writeStderr(`tabcomputer: line ${stmt.line}: ${e.message}\r\n`);
          exitCode = 1;
          this.lastExitCode = 1;
          this.env['?'] = '1';
        }
      }
    } catch (e) {
      if (e instanceof ExitSignal || e instanceof ReturnSignal) exitCode = e.code;
      // An expansion error (${x?msg}, bad substitution, set -u) ends the script with status 1
      // (bash: 127 for an unbound variable under -c, 1 in a script file)
      else if (e instanceof Error && e.name !== 'AbortError') { writeStderr(`tabcomputer: ${e.message}\r\n`); exitCode = e instanceof UnboundVariable && this.commandStringFlag ? e.code : 1; }
      else if (!(e instanceof BreakSignal || e instanceof ContinueSignal)) throw e;
    } finally {
      this.executeDepth = depth;
    }
    this.lastExitCode = exitCode;
    this.env['?'] = String(exitCode);
    const trapExit = await this.runExitTrap(writeStdout, writeStderr, terminal);
    if (trapExit !== undefined) { exitCode = trapExit; this.env['?'] = String(exitCode); }
    if (this.execOutSubs.length) {
      if (this.flushFdWrites) await this.flushFdWrites();
      await this.runExecOutSubs(writeStdout, writeStderr);
    }
    this.closeOwnFds();
    this.endProcess();
    return exitCode;
  }

  /** Format a completion spec for `complete -p` output */
  private formatCompleteSpec(cmd: string, spec: CompletionSpec): string {
    let parts = ['complete'];
    if (spec.words) parts.push(`-W '${spec.words.join(' ')}'`);
    if (spec.funcName) parts.push(`-F ${spec.funcName}`);
    if (spec.action) parts.push(`-A ${spec.action}`);
    if (spec.prefix) parts.push(`-P '${spec.prefix}'`);
    if (spec.suffix) parts.push(`-S '${spec.suffix}'`);
    parts.push(cmd);
    return parts.join(' ');
  }

  /** Resolve fc history reference: number (1-based abs or negative relative) or string prefix */
  private fcResolveRef(ref: string, hist: string[]): number {
    const num = parseInt(ref, 10);
    if (!isNaN(num)) {
      return num > 0 ? num - 1 : num; // 1-based → 0-based for positive; negative stays as-is
    }
    // String prefix search — find most recent matching entry
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].startsWith(ref)) return i;
    }
    return hist.length - 1;
  }
}

/**
 * Split a command on pipes that are outside quotes, $( ), ( ), { }, and compound
 * commands (for/while/until/select … done, if … fi, case … esac), so the pipe
 * after `done` or a subshell is found but pipes inside the body are not.
 */
export function splitTopLevelPipes(cmd: string): string[] {
  const parts: string[] = [];
  let current = '';
  let paren = 0, brace = 0;
  const blocks: string[] = []; // expected closers: done / fi / esac
  let inSingle = false, inDouble = false;
  let cmdPos = true; // at a position where a command (and so a keyword) can start
  let i = 0;
  const OPEN: Record<string, string> = { for: 'done', while: 'done', until: 'done', select: 'done', if: 'fi', case: 'esac' };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (inSingle) { current += ch; if (ch === "'") inSingle = false; i++; continue; }
    if (ch === '\\') { current += ch + (cmd[i + 1] ?? ''); i += 2; cmdPos = false; continue; }
    if (inDouble) { current += ch; if (ch === '"') inDouble = false; i++; continue; }
    if (ch === "'") { inSingle = true; current += ch; i++; cmdPos = false; continue; }
    if (ch === '"') { inDouble = true; current += ch; i++; cmdPos = false; continue; }
    if (ch === '$' && cmd[i + 1] === '{') { const e = skipParamBrace(cmd, i + 1); current += cmd.slice(i, e); i = e; cmdPos = false; continue; }
    if (ch === '`') {
      let e = i + 1;
      while (e < cmd.length && cmd[e] !== '`') e += cmd[e] === '\\' ? 2 : 1;
      if (e < cmd.length) { current += cmd.slice(i, e + 1); i = e + 1; cmdPos = false; continue; }
    }
    if (cmdPos && ch === '[' && cmd[i + 1] === '[') {
      const e = doubleBracketEnd(cmd, i);
      if (e > 0) { current += cmd.slice(i, e); i = e; cmdPos = false; continue; }
    }
    if (ch === '(') { paren++; current += ch; i++; cmdPos = true; continue; }
    // After `)` (a subshell, or a case pattern) a command or keyword can start
    if (ch === ')') { if (paren > 0) paren--; current += ch; i++; cmdPos = true; continue; }
    if (ch === '|' && cmd[i + 1] === '|') { current += '||'; i += 2; cmdPos = true; continue; }
    if (ch === '|' && cmd[i - 1] !== '>') {
      if (paren === 0 && brace === 0 && blocks.length === 0) { parts.push(current); current = ''; }
      else current += ch;
      i++; cmdPos = true; continue;
    }
    if (ch === ';' || ch === '&' || ch === '\n') { current += ch; i++; cmdPos = true; continue; }
    if (/\s/.test(ch)) { current += ch; i++; continue; }
    // A word
    let j = i;
    while (j < cmd.length && !/[\s;&|()'"\\]/.test(cmd[j])) j++;
    const word = cmd.slice(i, j) || ch;
    if (j === i) j = i + 1;
    if (paren === 0) {
      if (cmdPos && OPEN[word]) blocks.push(OPEN[word]);
      else if (cmdPos && blocks.length && word === blocks[blocks.length - 1]) blocks.pop();
      else if (cmdPos && word === '{') brace++;
      else if (cmdPos && word === '}' && brace > 0) brace--;
    }
    cmdPos = ['do', 'then', 'else', 'elif', '{', '!', 'if', 'while', 'until', 'time'].includes(word);
    current += cmd.slice(i, j);
    i = j;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p, idx, arr) => p || arr.length === 1);
}

/** printf formatting shared by the `printf` command and the shell's `printf -v` (src/utils/printf.ts) */
export function formatPrintf(fmt: string, fmtArgs: string[]): string {
  return printfFormat(fmt, fmtArgs).out;
}

/** A redirection after a compound command; `fd` is any other `N<…`/`N>…`/`N<&-` (target: its text, fd: N) */
export interface CompoundRedirect { op: '<' | '>' | '>>' | '&>' | '2>' | '2>>' | '2>&1' | 'fd'; target: string; fd?: number }

/**
 * Split redirections off the end of a compound command:
 * `while read l; do …; done < in.txt > out.txt` → the loop, plus [<in.txt, >out.txt].
 */
export function splitCompoundRedirects(cmd: string): { compound: string; redirects: CompoundRedirect[] } {
  const end = compoundEnd(cmd);
  if (end < 0 || end >= cmd.length) return { compound: cmd, redirects: [] };
  const suffix = cmd.slice(end);
  const redirects: CompoundRedirect[] = [];
  // (a target may be a process substitution: `done < <(cmd)`)
  const re = /\s*(2>&1|&>|2>>|2>|>>|>|<)\s*([<>]\((?:[^()]|\([^()]*\))*\)|'[^']*'|"[^"]*"|[^\s<>]+)?/y;
  // N<file, N>file, N>>file, N<&M, N>&M, N<&-, N>&- for a descriptor other than 0-2
  const fdRe = /\s*(([3-9])(?:<&-|>&-|<&\d|>&\d|>>|<|>)\s*(?:'[^']*'|"[^"]*"|[^\s<>&]+)?)/y;
  let pos = 0;
  while (pos < suffix.length) {
    if (!suffix.slice(pos).trim()) break;
    fdRe.lastIndex = pos;
    const f = fdRe.exec(suffix);
    if (f) {
      redirects.push({ op: 'fd', target: f[1].trim(), fd: Number(f[2]) });
      pos = fdRe.lastIndex;
      continue;
    }
    re.lastIndex = pos;
    const m = re.exec(suffix);
    if (!m) return { compound: cmd, redirects: [] }; // not just redirections: leave it alone
    const op = m[1] as CompoundRedirect['op'];
    let target = m[2] ?? '';
    if (op !== '2>&1' && !target) return { compound: cmd, redirects: [] };
    if (/^['"]/.test(target)) target = target.slice(1, -1);
    redirects.push({ op, target });
    pos = re.lastIndex;
  }
  return { compound: cmd.slice(0, end).trim(), redirects };
}

/**
 * Split command text on unquoted blanks into raw words, keeping quotes,
 * backslashes and $(…)/${…}/`…` intact (for brace expansion).
 */
function splitRawWords(text: string): string[] {
  const words: string[] = [];
  let cur = '';
  let i = 0;
  const n = text.length;
  const skipBalanced = (j: number, open: string, close: string): number => {
    let depth = 0;
    for (; j < n; j++) {
      const c = text[j];
      if (c === '\\') { j++; continue; }
      if (c === "'") { const e = text.indexOf("'", j + 1); j = e === -1 ? n : e; continue; }
      if (c === '"') { j++; while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j + 1;
    }
    return n;
  };
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      if (cur) { words.push(cur); cur = ''; }
      i++;
      continue;
    }
    let j = i + 1;
    if (c === '\\') j = i + 2;
    else if (c === "'") { const e = text.indexOf("'", i + 1); j = e === -1 ? n : e + 1; }
    else if (c === '"') {
      j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '$' && text[j + 1] === '(') { j = skipBalanced(j + 1, '(', ')'); continue; }
        j++;
      }
      j++;
    } else if (c === '`') { j = i + 1; while (j < n && text[j] !== '`') j += text[j] === '\\' ? 2 : 1; j++; }
    else if (c === '$' && text[i + 1] === '(') j = skipBalanced(i + 1, '(', ')');
    else if (c === '$' && text[i + 1] === '{') j = skipBalanced(i + 1, '{', '}');
    cur += text.slice(i, Math.min(j, n));
    i = j;
  }
  if (cur) words.push(cur);
  return words;
}

/**
 * `y=$x` is not word-split in bash, but this shell expands into the command text
 * before tokenizing. Double-quote simple unquoted assignment values that expand
 * something (`y=$x`, `export P=$HOME/bin:$PATH`), for leading assignments and
 * declaration builtins; anything with quotes, parens, or spaces outside ${…} is left alone.
 */
export function quoteAssignmentValues(cmd: string): string {
  const lead = cmd.match(/^\s*(?:(?:local|export|declare|typeset|readonly)(?:\s+-\w+)*\s+)?/)![0];
  let out = lead;
  let pos = lead.length;
  const re = /([A-Za-z_][A-Za-z0-9_]*\+?=)((?:\$\{[^}'"`]*\}|[^\s'"\\()<>|;&`{}])*)(\s+|$)/y;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(cmd);
    if (!m || m[0] === '') break;
    let value = m[2];
    if (value.includes('$')) value = `"${value}"`;
    out += m[1] + value + m[3];
    pos = re.lastIndex;
    if (!m[3]) break;
  }
  return out + cmd.slice(pos);
}

/** Index just past the `}` closing the `${` whose `{` is at s[i] (quotes inside respected) */
function skipParamBrace(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) return s.length; i = e; continue; }
    if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return s.length;
}

/** OFFSET and LENGTH of ${x:OFFSET:LENGTH} (the : of an arithmetic ?: is not the separator) */
function splitSliceSpec(spec: string): [string, string | undefined] {
  let depth = 0, ternary = 0;
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && c === '?') ternary++;
    else if (depth === 0 && c === ':') {
      if (ternary > 0) { ternary--; continue; }
      return [spec.slice(0, i), spec.slice(i + 1)];
    }
  }
  return [spec, undefined];
}

/** `{ list; }`, possibly followed by redirections */
function isBraceGroup(cmd: string): boolean {
  return /^\{\s/.test(cmd) && compoundEnd(cmd) > 0;
}

/** Index just past the keyword that closes the compound command starting cmd, or -1. */
function compoundEnd(cmd: string): number {
  const OPEN: Record<string, string> = { for: 'done', while: 'done', until: 'done', select: 'done', if: 'fi', case: 'esac' };
  const blocks: string[] = [];
  let paren = 0, inSingle = false, inDouble = false, cmdPos = true;
  // A `( … )` subshell ends at its matching paren
  const subshell = /^\s*\(/.test(cmd); // (also (( … )))
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (inSingle) { if (ch === "'") inSingle = false; i++; continue; }
    if (ch === '\\') { i += 2; cmdPos = false; continue; }
    if (inDouble) { if (ch === '"') inDouble = false; i++; continue; }
    if (ch === "'") { inSingle = true; i++; cmdPos = false; continue; }
    if (ch === '"') { inDouble = true; i++; cmdPos = false; continue; }
    if (ch === '(') { paren++; i++; cmdPos = true; continue; }
    if (ch === ')') {
      if (paren > 0) paren--;
      // A command or keyword can follow: a function body after `name()`, a case
      // pattern's commands, `fi` after `(list)`
      i++; cmdPos = true;
      if (subshell && paren === 0 && blocks.length === 0) return i;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') { i++; cmdPos = true; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    let j = i;
    while (j < cmd.length && !/[\s;&|()'"\\]/.test(cmd[j])) j++;
    if (j === i) j = i + 1;
    const word = cmd.slice(i, j);
    if (paren === 0 && cmdPos) {
      if (OPEN[word]) blocks.push(OPEN[word]);
      else if (word === '{') blocks.push('}');
      else if (blocks.length && word === blocks[blocks.length - 1]) {
        blocks.pop();
        if (!blocks.length) return j;
      }
    }
    cmdPos = ['do', 'then', 'else', 'elif', '{', '!', 'if', 'while', 'until', 'time'].includes(word);
    i = j;
  }
  return -1;
}
