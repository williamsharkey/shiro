import { stripComments } from './shell-comments';
import { groupStatements } from './shell-statements';
import { printfFormat } from './utils/printf';
import { evalArith, ArithError, type ArithEnv } from './utils/arith';
import { readRecord, recordText, splitRecord } from './shell-read';
import { parseDoubleBracket, doubleBracketEnd, DbSyntaxError, decodeAnsiC, ansiCEnd, type DbNode } from './shell-dbracket';
import { TestEval } from './commands/posix-test';
import { posixRegExp, RegexSyntaxError } from './utils/posix-regex';
import { arrayValues, arrayTop, copyArray, splitRawWords as splitAssignWords, parseAssignWord, splitListWords, type AssignWord } from './shell-arrays';
import { HeredocStore, extractHeredocs, hasHeredoc } from './shell-heredoc';
import { FileSystem } from './filesystem';
import { CommandRegistry, CommandContext } from './commands/index';
import type { ShiroTerminal } from './terminal';
import { getCompiledModule } from './wasi-packages';
import { builtinIndex, findEntry, packageStatus, packageShadows, loadPackageShadows, packageOfPath, runPackageBinary, PKG_BIN_DIR } from './pkg-manager';

// Lazy-load the WASI runtime (~960 lines) only when WASM execution is needed
let _wasiRuntime: typeof import('./wasi-runtime') | null = null;
async function loadWasiRuntime() {
  if (!_wasiRuntime) _wasiRuntime = await import('./wasi-runtime');
  return _wasiRuntime;
}

// shell-kernel is loaded on first use and then reached synchronously: a
// dynamic import() per command (through Vite's preload helper) was a large
// part of every builtin's cost
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
    if (c === '[' && word.indexOf(']', i + 2) > i) return true;
    if (extglob && '+@!'.includes(c) && word[i + 1] === '(') return true;
  }
  return false;
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: '0-9a-zA-Z', upper: 'A-Z', lower: 'a-z', space: '\\s',
  blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f',
};

/** Redirect target naming an open shell fd (`>&3`, `<&6`) rather than a file */
const FD_REF = '\uE020';
const fdRef = (n: number) => FD_REF + n;
const fdOfRef = (target: string): number | null => (target.startsWith(FD_REF) ? Number(target.slice(1)) : null);

/** An output fd of the shell: a file, or a copy of the shell's own stdout/stderr */
type OutFd = { path: string } | { dup: 1 | 2 };

export interface BackgroundJob {
  id: number;
  command: string;
  promise: Promise<number>;
  status: 'running' | 'stopped' | 'done' | 'failed';
  exitCode: number;
  abortController?: AbortController;
  /** In-page jobs: the made-up pid that $! holds */
  pid?: number;
  /** Kernel jobs: the process group (signals, fg/bg, Ctrl-Z) and its members */
  pgid?: number;
  pids?: number[];
  /** Kernel jobs: tty modes saved when the job stopped */
  termios?: import('./kernel/pty').Termios;
}

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

/** Pids for in-page background jobs ($!), above any kernel pid in practice */
let nextInPagePid = 40000;

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

class BreakSignal { constructor(public levels: number = 1) {} }
/** Sentinel thrown by `continue [N]` inside loops */
class ContinueSignal { constructor(public levels: number = 1) {} }
/** Sentinel thrown by `return [N]` inside functions */
class ReturnSignal { constructor(public code: number = 0) {} }
/** Sentinel thrown by `exit [N]`; caught by the outermost execute() of the shell */
export class ExitSignal { constructor(public code: number = 0) {} }
function isControlSignal(e: unknown): boolean {
  return e instanceof ExitSignal || e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal;
}

const ENV_PREFIX_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)=((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s'"|;&<>()])*)(?=\s)/;

/**
 * Split leading `NAME=value` assignments off a command segment.
 * Returns null unless at least one assignment is followed by a command.
 */
export function splitEnvPrefix(segment: string): { assignments: [string, string][]; rest: string } | null {
  const assignments: [string, string][] = [];
  let rest = segment;
  for (let m = ENV_PREFIX_RE.exec(rest); m; m = ENV_PREFIX_RE.exec(rest)) {
    const value = m[2].replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (_all, dq, sq) =>
      dq !== undefined ? dq.replace(/\\(["\\$`])/g, '$1') : sq);
    assignments.push([m[1], value]);
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
function capturingStdout<T extends object>(term: T): T {
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
};
/** Blanks inside one field of an unquoted expansion (IFS doesn't split them) */
const BLANK_PROTECT: Record<string, string> = { ' ': '\uE00A', '\t': '\uE00B', '\n': '\uE00C' };
const EXPANSION_RESTORE: Record<string, string> = Object.fromEntries(
  [...Object.entries(EXPANSION_PROTECT), ...Object.entries(BLANK_PROTECT)].map(([k, v]) => [v, k]));

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
  return /["'\\$`|<>&;]/.test(value) ? value.replace(/["'\\$`|<>&;]/g, (c) => EXPANSION_PROTECT[c]) : value;
}
export function restoreExpansion(text: string): string {
  return /[\uE000-\uE00C]/.test(text) ? text.replace(/[\uE000-\uE00C]/g, (c) => EXPANSION_RESTORE[c]) : text;
}

/** Re-quote already-parsed args so a command can be run again verbatim (time, env, exec, aliases). */
export function quoteArgsForShell(args: string[]): string {
  return args.map((a) => (/^[A-Za-z0-9_\-.,/:=@%+]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

export class Shell {
  fs: FileSystem;
  cwd: string = '/home/user';
  env: Record<string, string> = {};
  history: string[] = [];
  commands: CommandRegistry;
  lastExitCode: number = 0;
  functions: Record<string, { body: string }> = {};
  backgroundJobs: Map<number, BackgroundJob> = new Map();
  /** Shell options: errexit (-e), xtrace (-x), nounset (-u), verbose (-v) */
  options: Set<string> = new Set();
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
  /** Directory stack for pushd/popd */
  dirStack: string[] = [];
  /** Local variable frames for function scoping — stack of {varName → savedValue|undefined} */
  private localVarStack: Map<string, { env?: string; arr?: string[]; assoc?: Map<string, string> }>[] = [];
  /** Readonly variable names */
  readonlyVars: Set<string> = new Set();
  /** Call stack for BASH_SOURCE/caller: {funcName, source} */
  callStack: { funcName: string; source: string }[] = [];
  /** Bash shopt options: extglob, nocaseglob, nullglob, dotglob, globstar, etc. */
  shoptopts: Set<string> = new Set();
  /** Programmable completion specs: command name → spec */
  completionSpecs: Map<string, CompletionSpec> = new Map();
  /** Builtins disabled via `enable -n` */
  disabledBuiltins: Set<string> = new Set();
  /** `builtin NAME` runs Shiro's NAME even when a package provides NAME */
  pkgShadowBypass: string | null = null;
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
    // Which builtins installed packages replace (read once, kept current by pkg)
    loadPackageShadows(fs).catch(() => {});
    this.env = {
      HOME: '/home/user',
      USER: 'user',
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
    for (const [varName, saved] of frame) {
      if (saved.env === undefined) delete this.env[varName];
      else this.env[varName] = saved.env;
      if (saved.arr) this.arrays.set(varName, saved.arr); else this.arrays.delete(varName);
      if (saved.assoc) this.assocArrays.set(varName, saved.assoc); else this.assocArrays.delete(varName);
    }
  }

  /** The parent's Ctrl-C controller, so interrupting the parent stops a forked child */
  private inheritedAbort: AbortController | null = null;

  fork(): Shell {
    const child = new Shell(this.fs, this.commands);
    child.inheritedAbort = this.abortController ?? this.inheritedAbort;
    child.heredocs = this.heredocs;
    child.userFds = new Map(this.userFds);
    child.fileDescriptors = new Map(this.fileDescriptors);
    child.cwd = this.cwd;
    child.env = { ...this.env };
    child.functions = { ...this.functions };
    child.options = new Set(this.options);
    child.arrays = new Map(Array.from(this.arrays.entries()).map(([k, v]) => [k, copyArray(v)]));
    child.assocArrays = new Map(Array.from(this.assocArrays.entries()).map(([k, v]) => [k, new Map(v)]));
    // A subshell starts with the traps reset, except ignored ones (trap '' SIG)
    child.traps = new Map([...this.traps].filter(([, v]) => v === ''));
    child.aliases = new Map(this.aliases);
    child.namerefs = new Map(this.namerefs);
    child.dirStack = [...this.dirStack];
    child.history = this.history; // share history array reference
    child.completionSpecs = new Map(this.completionSpecs);
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
    const r = await child.exec(cmd);
    this.substStatus = r.exitCode;
    return r;
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
    const job: BackgroundJob = {
      id: jobId,
      command,
      status: 'running',
      exitCode: 0,
      pid,
      // Runs in a child shell (its variables and cd stay there), output to ours.
      // No tty for in-page background work: kernel programs inside it must not take the terminal
      promise: this.fork().execute(command, writeStdout, stderrWriter, false, this.terminal ? withoutTty(this.terminal) : undefined).then(
        (code) => {
          job.status = code === 0 ? 'done' : 'failed';
          job.exitCode = code;
          return code;
        },
        (err) => {
          job.status = 'failed';
          job.exitCode = 1;
          return 1;
        },
      ),
    };
    this.backgroundJobs.set(jobId, job);
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
    const depth = this.executeDepth;
    const suppressed = this.errexitSuppressed;
    // After `exec >file` / `exec 2>file`, default output goes there. The outermost
    // call routes it, looking the fds up at write time (exec can change them mid-line)
    if (!this.fdRouting) {
      const base1 = writeStdout;
      const base2 = writeStderr || writeStdout;
      const pending = new Map<string, string>();
      const route = (n: 1 | 2) => (s: string) => {
        const e = this.userFds.get(n);
        if (!e) (n === 1 ? base1 : base2)(s);
        else if ('dup' in e) (e.dup === 1 ? base1 : base2)(s);
        else pending.set(e.path, (pending.get(e.path) ?? '') + s);
      };
      const flush = async () => {
        for (const [path, text] of [...pending]) {
          pending.delete(path);
          await this.fs.appendFile(path, text.replace(/\r\n/g, '\n'));
        }
      };
      this.fdRouting = true;
      this.flushFdWrites = flush;
      try {
        return await this.execute(line, route(1), route(2), remote, terminalOverride, skipHistory);
      } finally {
        this.fdRouting = false;
        this.flushFdWrites = null;
        await flush();
      }
    }
    // A file write per statement keeps output in order for the commands that read it
    if (this.flushFdWrites) await this.flushFdWrites();
    try {
      return await this.executeImpl(line, writeStdout, writeStderr, remote, terminalOverride, skipHistory);
    } catch (e) {
      // `exit` unwinds to the outermost execute() of this shell (a script, `sh -c`,
      // a subshell or $(...) each run in their own Shell), which runs the EXIT trap
      if (e instanceof ExitSignal && depth === 0 && this.sourcing === 0) {
        this.executeDepth = 0;
        await this.runExitTrap(writeStdout, writeStderr || writeStdout, terminalOverride);
        this.lastExitCode = e.code;
        this.env['?'] = String(e.code);
        return e.code;
      }
      throw e;
    } finally {
      // break/continue/return/exit unwind through nested execute() calls
      this.executeDepth = depth;
      this.errexitSuppressed = suppressed;
      if (depth === 0) this.abortController = null;
    }
  }

  /** trap [-lp] [[ACTION] SIGNAL...] */
  private trapBuiltin(args: string[], writeStdout: (s: string) => void, writeStderr: (s: string) => void, subshell = false): number {
    if (args[0] === '--') args = args.slice(1);
    if (args[0] === '-l') {
      writeStdout(SIGNALS.map((n, k) => (n ? `${k}) SIG${n}` : '')).filter(Boolean).join(' ') + '\r\n');
      return 0;
    }
    const show = (keys: string[]) => {
      for (const k of keys) {
        const cmd = this.traps.get(k);
        // In a pipeline trap runs in a subshell, where only ignored signals stay set
        if (cmd === undefined || (subshell && cmd !== '')) continue;
        writeStdout(`trap -- '${cmd.replace(/'/g, "'\\''")}' ${SIGNALS.includes(k) && k !== 'EXIT' ? 'SIG' + k : k}\r\n`);
      }
    };
    if (args.length === 0 || args[0] === '-p') {
      const keys = args.length > 1 ? args.slice(1).map(trapKey).filter((k): k is string => !!k)
        : [...SIGNALS.filter(Boolean), 'DEBUG', 'ERR', 'RETURN'];
      show(keys);
      return 0;
    }
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
  async runExitTrap(writeStdout: (s: string) => void, writeStderr: (s: string) => void, terminal?: any): Promise<void> {
    if (!this.traps.has('EXIT')) return;
    const exitCmd = this.traps.get('EXIT')!;
    this.traps.delete('EXIT'); // prevent re-entry
    const saved = this.lastExitCode;
    try {
      await this.execute(exitCmd, writeStdout, writeStderr, false, terminal, true);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
    this.lastExitCode = saved;
  }

  /** >0 while running a context where `set -e` doesn't apply (if/while/until conditions) */
  errexitSuppressed = 0;

  /**
   * `set -e`: a command that failed exits the shell, unless it is followed by
   * && or ||, negated with !, or runs inside a condition.
   */
  private checkErrexit(compounds: { operator: string; command: string }[], idx: number, exitCode: number): void {
    if (exitCode === 0 || !this.options.has('errexit') || this.errexitSuppressed > 0) return;
    const nextOp = compounds[idx + 1]?.operator;
    if (nextOp === '&&' || nextOp === '||') return;
    if (/^!\s/.test(compounds[idx].command.trim())) return;
    throw new ExitSignal(exitCode);
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
    const data = await this.fs.readFile(this.fs.resolvePath(target, this.cwd), 'utf8');
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

  /** Where output to fd n goes: a file, or the shell's stdout/stderr; null if not open */
  resolveOutFd(n: number): OutFd | null {
    const e = this.userFds.get(n);
    if (e) return e;
    if (n === 1) return { dup: 1 };
    if (n === 2) return { dup: 2 };
    return null;
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
        this.userFds.set(fd, e);
        return null;
      }
      if (target === '/dev/stdout') { this.userFds.set(fd, this.resolveOutFd(1)!); return null; }
      if (target === '/dev/stderr') { this.userFds.set(fd, this.resolveOutFd(2)!); return null; }
      const path = this.fs.resolvePath(target, this.cwd);
      if (truncate) pending.push(this.fs.writeFile(path, ''));
      else pending.push(this.fs.appendFile(path, ''));
      this.userFds.set(fd, { path });
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
            else this.userFds.set(r.fd!, e);
          }
          break;
        }
        case '>&-': this.userFds.delete(r.fd!); this.fileDescriptors.delete(r.fd!); break;
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

  /** Write command output to fd n's target */
  private async writeToFd(n: number, text: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void): Promise<boolean> {
    const e = this.resolveOutFd(n);
    if (!e) return false;
    if ('dup' in e) {
      (e.dup === 1 ? writeStdout : writeStderr)(text.replace(/\r?\n/g, '\r\n'));
      return true;
    }
    await this.pendingFdOps;
    if (text) await this.fs.appendFile(e.path, text.replace(/\r\n/g, '\n'));
    return true;
  }

  /** Aliases being expanded right now */
  private expandingAliases = new Set<string>();

  /** getopts' position inside a bundled option word (-abc), valid while OPTIND is unchanged */
  private getoptsState = { optind: 1, char: 1 };

  /** `source` nesting: exit inside a sourced file leaves the sourcing shell too */
  private sourcing = 0;

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
    const source = line.trim();
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
    if (statements.length <= 1 && /[^&]&$/.test(trimmed) && this.parseCompound(trimmed).length === 1) {
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
      this.functions[funcDef.name] = { body: funcDef.body };
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
    const compounds = this.parseCompound(effectiveLine);
    let exitCode = 0;
    let lastRan = -1; // index of the last compound that ran, for errexit
    let suppressing = false;

    for (let ci = 0; ci < compounds.length; ci++) {
      const compound = compounds[ci];
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

      // `cmd &` before more commands on the line
      if (/[^&]&$/.test(compound.command) && compounds.length > 1) {
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
        this.functions[compFuncDef.name] = { body: compFuncDef.body };
        continue;
      }

      const trimmedCmd = compound.command.trim();

      // Check for (( expr )) arithmetic command in compound
      if (trimmedCmd.startsWith('((') && trimmedCmd.endsWith('))')) {
        const expr = trimmedCmd.slice(2, -2).trim();
        exitCode = this.arithStatus([expr], stderrWriter);
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
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

      // A subshell followed by redirections: (cmds) > file
      if (/^\((?!\()/.test(trimmedCmd) && !trimmedCmd.endsWith(')') && splitCompoundRedirects(trimmedCmd).redirects.length) {
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
          exitCode = await child.execute(inner, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
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
        pipeline = this.parsePipeline(await this.expandWords(quoteAssignmentValues(compound.command), stderrWriter));
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

      for (let i = 0; i < pipeline.length; i++) {
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
          for (const [key, value] of envPrefix.assignments) {
            if (!prefixEnvSaved.has(key)) {
              prefixEnvSaved.set(key, Object.prototype.hasOwnProperty.call(this.env, key) ? this.env[key] : undefined);
            }
            this.env[key] = value;
          }
          segment = envPrefix.rest;
        }

        // A subshell after a pipe: `echo abc | (cat)`
        const trimmedSeg = segment.trim();
        if (i > 0 && trimmedSeg.startsWith('(') && trimmedSeg.endsWith(')') && !trimmedSeg.startsWith('((')) {
          const pipeStdin = lastOutput;
          lastOutput = '';
          startCapture([], i === pipeline.length - 1);
          exitCode = await this.fork().executeWithStdin(trimmedSeg.slice(1, -1).trim(), pipeStdin, writeStdout, stderrWriter);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          continue;
        }

        // Check if this pipeline segment is a control structure (e.g. `echo foo | while ...`)
        if (this.isControlStructure(segment.trim())) {
          const pipeStdin = i > 0 ? lastOutput : '';
          lastOutput = '';
          if (i < pipeline.length - 1) startCapture([], false);
          exitCode = await this.execControlStructurePiped(segment.trim(), pipeStdin, writeStdout, stderrWriter);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          continue;
        }

        const { args, redirects, hereString } = this.parseSegment(segment);

        if (args.length === 0) continue;

        // Builtins and functions write straight to the writers; when this segment
        // feeds a pipe or has output redirects, collect that output instead
        const isLastSegment = i === pipeline.length - 1;
        if (!isLastSegment || redirects.some(r => r.type !== '<')) startCapture(redirects, isLastSegment);
        // Stdin for builtins that run commands in a nested execute (eval, sh -c, aliases, functions)
        const nestedStdin = i > 0 ? lastOutput : (hereString ?? heredocStdin);

        // Expand glob patterns in args (but not quoted ones marked with \x01)
        const globResult = await this.expandGlobs(args, stderrWriter);
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
          const cIdx = cmdArgs.findIndex(a => /^-\w*c$/.test(a));
          if (cIdx >= 0 && cIdx + 1 < cmdArgs.length) {
            // /bin/sh -c "command" → execute command
            // `sh -c CMD [NAME ARGS...]`: only CMD is the command string
            const shellCmd = cmdArgs[cIdx + 1];
            const child = this.fork();
            const rest = cmdArgs.slice(cIdx + 2);
            child.setPositional(rest.slice(1), rest[0] ?? cmdName);
            child.injectedStdin = nestedStdin;
            exitCode = await child.runScriptText(shellCmd, terminalOverride || this.terminal, writeStdout, stderrWriter);
          } else {
            // /bin/sh script.sh or /bin/sh (no args)
            const scripts = cmdArgs.filter(a => !a.startsWith('-'));
            if (scripts.length > 0) {
              const scriptPath = this.fs.resolvePath(scripts[0], this.cwd);
              try {
                const content = await this.fs.readFile(scriptPath, 'utf8') as string;
                const shCtx: CommandContext = { args: scripts.slice(1), fs: this.fs, cwd: this.cwd, env: this.env, stdin: '', stdout: '', stderr: '', shell: this, terminal: terminalOverride || this.terminal };
                exitCode = await this.executeShellScript(content, scripts.slice(1), shCtx, writeStdout, stderrWriter, scripts[0]);
              } catch (e: any) {
                stderrWriter(`shiro: ${scripts[0]}: ${e.message}\r\n`);
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
        if (this.aliases.has(cmdName) && !this.expandingAliases.has(cmdName)) {
          const aliasValue = this.aliases.get(cmdName)!;
          const fullCmd = aliasValue + (cmdArgs.length > 0 ? ' ' + quoteArgsForShell(cmdArgs) : '');
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
            existing.push(...newElems.map(a => a.replace(/\x01/g, '')));
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
            this.arrays.set(key, arr.map(a => a.replace(/\x01/g, '')));
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
            const err = this.setVar(name, (this.getVar(name) ?? '') + val);
            if (err) stderrWriter(`shiro: ${err}\r\n`);
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
            continue;
          }
          if (this.arrays.has(key) || this.assocArrays.has(key)) this.setVar(key, val);
          else this.env[key] = val;
          if (key === 'PWD') this.cwd = val;
          // An assignment-only command's status is that of its last $(...)
          exitCode = this.substStatus ?? 0;
          // `a=1 b=2` assigns both
          for (const extra of cmdArgs) {
            const em = extra.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
            if (!em) break;
            if (this.readonlyVars.has(em[1])) { stderrWriter(`${em[1]}: readonly variable\r\n`); exitCode = 1; continue; }
            this.env[em[1]] = em[2];
          }
          // Persist API keys to localStorage
          const persistKeys: Record<string, string> = {
            ANTHROPIC_API_KEY: 'shiro_anthropic_key',
            OPENAI_API_KEY: 'shiro_openai_key',
            GOOGLE_API_KEY: 'shiro_google_key',
          };
          if (persistKeys[key] && typeof localStorage !== 'undefined') {
            localStorage.setItem(persistKeys[key], val);
          }
          continue;
        }

        // Check if this builtin has been disabled via `enable -n`
        // If disabled, skip the builtin dispatch and fall through to external command lookup
        const _builtinDisabled = this.disabledBuiltins.has(effectiveCmdName);

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
          const frameNum = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) : 0;
          if (this.callStack.length > frameNum) {
            const frame = this.callStack[this.callStack.length - 1 - frameNum];
            writeStdout(`1 ${frame.funcName} ${frame.source}\r\n`);
            exitCode = 0;
          } else {
            exitCode = 1;
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtins: eval, setopt, shopt
        if (!_builtinDisabled && effectiveCmdName === 'eval') {
          // Execute remaining args as a shell command
          const evalCmd = stripComments(cmdArgs.join(' '));
          if (evalCmd) {
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
          const allShopts = ['extglob', 'nocaseglob', 'nullglob', 'dotglob', 'globstar',
            'failglob', 'nocasematch', 'lastpipe', 'expand_aliases', 'sourcepath',
            'checkwinsize', 'histappend', 'cmdhist', 'lithist', 'xpg_echo'];
          let mode: 's' | 'u' | 'p' | 'q' | null = null;
          const optNames: string[] = [];
          for (const a of cmdArgs) {
            if (a === '-s') mode = 's';
            else if (a === '-u') mode = 'u';
            else if (a === '-p') mode = 'p';
            else if (a === '-q') mode = 'q';
            else optNames.push(a);
          }
          if (mode === 's') {
            for (const opt of optNames) {
              if (!allShopts.includes(opt)) { stderrWriter(`shopt: ${opt}: invalid shell option name\r\n`); exitCode = 1; continue; }
              this.shoptopts.add(opt);
            }
          } else if (mode === 'u') {
            for (const opt of optNames) {
              if (!allShopts.includes(opt)) { stderrWriter(`shopt: ${opt}: invalid shell option name\r\n`); exitCode = 1; continue; }
              this.shoptopts.delete(opt);
            }
          } else if (mode === 'q') {
            // Query: exit 0 if all named options are set, 1 otherwise
            exitCode = 0;
            for (const opt of optNames) {
              if (!this.shoptopts.has(opt)) { exitCode = 1; break; }
            }
          } else {
            // Print: -p or default (no mode flag)
            const toShow = optNames.length > 0 ? optNames : allShopts;
            for (const opt of toShow) {
              if (!allShopts.includes(opt)) { stderrWriter(`shopt: ${opt}: invalid shell option name\r\n`); exitCode = 1; continue; }
              writeStdout(`${opt}\t\t${this.shoptopts.has(opt) ? 'on' : 'off'}\r\n`);
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && (effectiveCmdName === 'declare' || effectiveCmdName === 'typeset' || effectiveCmdName === 'local')) {
          // local NAME: save the caller's variable (scalar or array) and start a fresh one
          if (effectiveCmdName === 'local' && this.localVarStack.length > 0 && !cmdArgs.some(a => /^-\w*g/.test(a))) {
            const frame = this.localVarStack[this.localVarStack.length - 1];
            for (const arg of cmdArgs) {
              if (arg.startsWith('-')) continue;
              const varName = arg.replace(/\+?=[\s\S]*$/, '');
              if (frame.has(varName)) continue;
              frame.set(varName, { env: this.env[varName], arr: this.arrays.get(varName), assoc: this.assocArrays.get(varName) });
              if (!arg.includes('=')) delete this.env[varName];
              this.arrays.delete(varName);
              this.assocArrays.delete(varName);
            }
          }
          // declare -n ref=target → nameref
          if (cmdArgs.includes('-n')) {
            for (const arg of cmdArgs) {
              if (arg.startsWith('-')) continue;
              const eqIdx = arg.indexOf('=');
              if (eqIdx >= 0) {
                this.namerefs.set(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
              }
            }
            continue;
          }
          // declare -A name → associative array
          if (cmdArgs.includes('-A')) {
            for (const arg of cmdArgs) {
              if (arg.startsWith('-')) continue;
              if (!this.assocArrays.has(arg)) this.assocArrays.set(arg, new Map());
            }
            continue;
          }
          // declare -a name → indexed array
          if (cmdArgs.includes('-a')) {
            for (const arg of cmdArgs) {
              if (arg.startsWith('-')) continue;
              if (!this.arrays.has(arg)) this.arrays.set(arg, []);
            }
            continue;
          }
          // Parse flags for declare/typeset/local
          const isLocal = effectiveCmdName === 'local';
          let declFlags = '';
          const declPositional: string[] = [];
          for (const arg of cmdArgs) {
            if (arg.startsWith('-') && /^-[xrilupg]+$/.test(arg)) { declFlags += arg.slice(1); continue; }
            if (arg.startsWith('-')) continue; // skip other flags
            declPositional.push(arg);
          }
          // declare -p: show variable values
          if (declFlags.includes('p') && declPositional.length > 0) {
            exitCode = 0;
            for (const name of declPositional) {
              const line = this.declareLine(name);
              if (line === null) { stderrWriter(`shiro: declare: ${name}: not found\r\n`); exitCode = 1; }
              else writeStdout(line + '\r\n');
            }
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            continue;
          }
          for (const arg of declPositional) {
            const eqIdx = arg.indexOf('=');
            const varName = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
            let value = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined;
            // Apply type transformations
            if (value !== undefined) {
              if (declFlags.includes('i')) value = String(parseInt(value) || 0);
              if (declFlags.includes('l')) value = value.toLowerCase();
              if (declFlags.includes('u')) value = value.toUpperCase();
            }
            if (value !== undefined) {
              this.env[varName] = value;
            } else {
              if (!(varName in this.env)) this.env[varName] = '';
            }
            // declare -r marks variable readonly
            if (declFlags.includes('r')) {
              this.readonlyVars.add(varName);
            }
          }
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
            stderrWriter(`shiro: read: ${badOpt}\r\n`);
            exitCode = 2;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          // Read one line from stdin — prefer FD, then the command's own <<< / <,
          // then piped stdin (__PIPE_STDIN), then pipe, then heredoc
          let readInput = '';
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
              stderrWriter(`shiro: ${stdinRedirect.target}: ${e.message}\r\n`);
              exitCode = 1;
              this.lastExitCode = 1;
              this.env['?'] = '1';
              lastOutput = '';
              continue;
            }
          }
          // An explicit redirect doesn't consume the enclosing loop's piped stdin
          const hasPipeStdin = redirectInput === undefined && '__PIPE_STDIN' in this.env;
          // read -u N with N opened on this command (read -u 3 3<file)
          const fdOpen = readFd >= 0 ? redirects.find(r => r.type === 'open' && r.mode === '<' && r.fd === readFd) : undefined;
          if (fdOpen) {
            try {
              readInput = await this.readInputRedirect(fdOpen.target);
            } catch (e: any) {
              stderrWriter(`shiro: ${fdOpen.target}: ${e.message}\r\n`);
            }
          } else if (readFd >= 0 && this.fileDescriptors.has(readFd)) {
            // Read from file descriptor
            const fd = this.fileDescriptors.get(readFd)!;
            readInput = fd.content.slice(fd.offset);
          } else if (redirectInput !== undefined) {
            readInput = redirectInput;
          } else if (hasPipeStdin) {
            readInput = this.env['__PIPE_STDIN'];
          } else {
            readInput = i > 0 ? lastOutput : (heredocStdin || '');
          }
          // Input from a file, pipe or here-doc (not the terminal): -t never times out
          const hasSource = !!fdOpen || readFd >= 0 || redirectInput !== undefined || hasPipeStdin || i > 0 || !!heredocStdin;
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
          if (readErr) stderrWriter(`shiro: read: ${readErr}\r\n`);
          exitCode = readErr ? (readErr.includes('identifier') ? 2 : 1) : rec.complete ? 0 : 1;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: mapfile / readarray
        if (!_builtinDisabled && (effectiveCmdName === 'mapfile' || effectiveCmdName === 'readarray')) {
          // Parse flags: -t (strip), -d (delimiter), -s (skip N lines), -n (count), -C callback, -c quantum
          let mapDelim = '\n';
          let mapSkip = 0;
          let mapCount = -1;
          let mapCallback = '';
          let mapQuantum = 5000;
          let arrName = 'MAPFILE';
          for (let mi = 0; mi < cmdArgs.length; mi++) {
            if (cmdArgs[mi] === '-d' && mi + 1 < cmdArgs.length) { mapDelim = cmdArgs[++mi]; }
            else if (cmdArgs[mi].startsWith('-d') && cmdArgs[mi].length > 2) { mapDelim = cmdArgs[mi].slice(2); }
            else if (cmdArgs[mi] === '-s' && mi + 1 < cmdArgs.length) { mapSkip = parseInt(cmdArgs[++mi], 10) || 0; }
            else if (cmdArgs[mi] === '-n' && mi + 1 < cmdArgs.length) { mapCount = parseInt(cmdArgs[++mi], 10) || -1; }
            else if (cmdArgs[mi] === '-C' && mi + 1 < cmdArgs.length) { mapCallback = cmdArgs[++mi]; }
            else if (cmdArgs[mi] === '-c' && mi + 1 < cmdArgs.length) { mapQuantum = parseInt(cmdArgs[++mi], 10) || 5000; }
            else if (cmdArgs[mi] === '-t') { /* strip - already default */ }
            else if (!cmdArgs[mi].startsWith('-')) { arrName = cmdArgs[mi]; }
          }
          let mapInput = '';
          const hasPipeStdin = '__PIPE_STDIN' in this.env;
          if (hasPipeStdin) {
            mapInput = this.env['__PIPE_STDIN'];
            delete this.env['__PIPE_STDIN'];
          } else {
            mapInput = i > 0 ? lastOutput : (heredocStdin || '');
          }
          let lines = mapInput.split(mapDelim);
          // Remove trailing empty element from trailing delimiter
          if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
          // Apply skip
          if (mapSkip > 0) lines = lines.slice(mapSkip);
          // Apply count
          if (mapCount >= 0) lines = lines.slice(0, mapCount);
          this.arrays.set(arrName, lines);
          // Invoke -C callback every -c quantum lines
          if (mapCallback && this.functions[mapCallback]) {
            for (let li = 0; li < lines.length; li++) {
              if ((li % mapQuantum) === 0) {
                await this.execFunction(mapCallback, [String(li), lines[li]], writeStdout, stderrWriter);
              }
            }
          }
          exitCode = 0;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtins: break and continue (throw sentinels caught by loop handlers)
        if (effectiveCmdName === 'break') {
          const levels = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) || 1 : 1;
          throw new BreakSignal(levels);
        }
        if (effectiveCmdName === 'continue') {
          const levels = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) || 1 : 1;
          throw new ContinueSignal(levels);
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
        if (effectiveCmdName === 'return') {
          const code = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) || 0 : this.lastExitCode;
          throw new ReturnSignal(code);
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
          for (const name of cmdArgs) {
            if (name in this.functions) {
              writeStdout(`${name} is a function\r\n`);
            } else if (['cd', 'echo', 'read', 'eval', 'set', 'export', 'source', 'shift',
                         'declare', 'local', 'typeset', 'true', 'false', 'break', 'continue',
                         'return', 'trap', 'getopts', 'printf', 'type', 'command', 'hash',
                         'mapfile', 'readarray', 'select', 'alias', 'unalias', 'pushd', 'popd',
                         'dirs', 'let', 'exec', 'builtin', 'ulimit', 'umask',
                         'complete', 'compgen', 'enable', 'disown', 'unset', 'readonly', 'time', 'caller', 'shopt', 'fc'].includes(name)) {
              writeStdout(`${name} is a shell builtin\r\n`);
            } else if (this.commands.get(name)) {
              writeStdout(`${name} is a registered command\r\n`);
            } else {
              stderrWriter(`type: ${name}: not found\r\n`);
              exitCode = 1;
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'command') {
          if (cmdArgs[0] === '-v') {
            // command -v: like which
            for (const name of cmdArgs.slice(1)) {
              if (name in this.functions || this.commands.get(name) ||
                  ['cd', 'echo', 'read', 'eval', 'set', 'export', 'source', 'shift',
                   'true', 'false', 'break', 'continue', 'return', 'trap', 'printf',
                   'type', 'command', 'hash', 'mapfile', 'readarray', 'alias', 'unalias',
                   'pushd', 'popd', 'dirs', 'let', 'exec', 'builtin', 'ulimit', 'umask',
                   'complete', 'compgen', 'enable', 'disown', 'unset', 'readonly', 'time', 'caller', 'shopt', 'fc'].includes(name)) {
                writeStdout(`${name}\r\n`);
              } else {
                exitCode = 1;
              }
            }
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          // command NAME args: execute command bypassing functions
          // Just fall through to normal execution
        }
        if (!_builtinDisabled && effectiveCmdName === 'hash') {
          // hash -r: clear hash table (no-op, we don't cache)
          writeStdout('hash: hash table empty\r\n');
          exitCode = 0;
          this.lastExitCode = 0;
          this.env['?'] = '0';
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
              this.env[printfVarName] = r.out;
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
              this.env[varName] = '?';
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
                this.env[varName] = '?';
                if (silent) this.env['OPTARG'] = opt;
                else { delete this.env['OPTARG']; stderrWriter(`${this.env['0'] || 'sh'}: illegal option -- ${opt}\r\n`); }
                advance();
              } else if (optstring[pos + 1] === ':') {
                // Option takes an argument: the rest of this word, or the next word
                if (charIdx + 1 < arg.length) {
                  this.env[varName] = opt;
                  this.env['OPTARG'] = arg.slice(charIdx + 1);
                  optind++;
                } else if (optind < args.length) {
                  this.env[varName] = opt;
                  this.env['OPTARG'] = args[optind];
                  optind += 2;
                } else if (silent) {
                  this.env[varName] = ':';
                  this.env['OPTARG'] = opt;
                  optind++;
                } else {
                  this.env[varName] = '?';
                  delete this.env['OPTARG'];
                  stderrWriter(`${this.env['0'] || 'sh'}: option requires an argument -- ${opt}\r\n`);
                  optind++;
                }
                charIdx = 1;
              } else {
                this.env[varName] = opt;
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
          if (cmdArgs.length === 0) {
            // List all aliases
            for (const [name, value] of this.aliases) {
              writeStdout(`alias ${name}='${value}'\r\n`);
            }
          } else {
            for (const arg of cmdArgs) {
              const eqIdx = arg.indexOf('=');
              if (eqIdx >= 0) {
                this.aliases.set(arg.substring(0, eqIdx), arg.substring(eqIdx + 1));
              } else {
                const val = this.aliases.get(arg);
                if (val !== undefined) {
                  writeStdout(`alias ${arg}='${val}'\r\n`);
                } else {
                  stderrWriter(`alias: ${arg}: not found\r\n`);
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

        // Shell builtin: pushd / popd / dirs
        if (!_builtinDisabled && effectiveCmdName === 'pushd') {
          if (cmdArgs.length === 0) {
            // Swap top two entries
            if (this.dirStack.length === 0) {
              stderrWriter('pushd: no other directory\r\n');
              exitCode = 1;
            } else {
              const top = this.dirStack.pop()!;
              this.dirStack.push(this.cwd);
              try {
                const resolved = this.fs.resolvePath(top, this.cwd);
                await this.fs.stat(resolved);
                this.cwd = resolved;
                this.env['PWD'] = resolved;
              } catch {
                stderrWriter(`pushd: ${top}: No such file or directory\r\n`);
                exitCode = 1;
              }
            }
          } else {
            const dir = cmdArgs[0];
            const resolved = this.fs.resolvePath(dir, this.cwd);
            try {
              await this.fs.stat(resolved);
              this.dirStack.push(this.cwd);
              this.cwd = resolved;
              this.env['PWD'] = resolved;
            } catch {
              stderrWriter(`pushd: ${dir}: No such file or directory\r\n`);
              exitCode = 1;
            }
          }
          if (exitCode === 0) {
            writeStdout(`${this.cwd} ${this.dirStack.slice().reverse().join(' ')}\r\n`);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'popd') {
          if (this.dirStack.length === 0) {
            stderrWriter('popd: directory stack empty\r\n');
            exitCode = 1;
          } else {
            const dir = this.dirStack.pop()!;
            this.cwd = dir;
            this.env['PWD'] = dir;
            writeStdout(`${this.cwd} ${this.dirStack.slice().reverse().join(' ')}\r\n`);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (!_builtinDisabled && effectiveCmdName === 'dirs') {
          const stack = [this.cwd, ...this.dirStack.slice().reverse()];
          writeStdout(stack.join(' ') + '\r\n');
          this.lastExitCode = 0;
          this.env['?'] = '0';
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
          const unsetNames: string[] = [];
          for (const arg of cmdArgs) {
            if (arg === '-f') { unsetFunc = true; continue; }
            if (arg === '-v') { unsetFunc = false; continue; }
            unsetNames.push(arg);
          }
          exitCode = 0;
          for (const name of unsetNames) {
            if (unsetFunc) {
              delete this.functions[name];
            } else {
              // Check for array element: arr[idx]
              const bracketMatch = name.match(/^(\w+)\[(.+)\]$/);
              if (bracketMatch) {
                const arrName = this.namerefs.get(bracketMatch[1]) ?? bracketMatch[1];
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
                    stderrWriter(`shiro: unset: ${e.message}\r\n`);
                    exitCode = 1;
                  }
                }
              } else if (this.readonlyVars.has(name)) {
                stderrWriter(`unset: ${name}: cannot unset: readonly variable\r\n`);
                exitCode = 1;
              } else {
                delete this.env[name];
                this.namerefs.delete(name);
                this.arrays.delete(name);
                this.assocArrays.delete(name);
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
            for (const name of [...this.readonlyVars].sort()) {
              const val = this.env[name];
              writeStdout(`declare -r ${name}${val !== undefined ? `="${val}"` : ''}\r\n`);
            }
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
                  this.env[name] = val;
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
            const lines = Object.entries(this.env)
              .filter(([k]) => !k.match(/^[0-9?#@*!_$]$/))
              .map(([k, v]) => `declare -x ${k}="${v}"`)
              .sort();
            for (const l of lines) writeStdout(l + '\r\n');
          } else {
            for (const arg of cmdArgs) {
              if (arg === '-p' || arg === '-n') continue;
              const eqIdx = arg.indexOf('=');
              if (eqIdx !== -1) {
                const name = arg.slice(0, eqIdx);
                const val = arg.slice(eqIdx + 1);
                this.env[name] = val;
              }
              // In browser shell, all variables are effectively exported
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: set -- args (positional parameter assignment)
        if (!_builtinDisabled && effectiveCmdName === 'set') {
          // Check for -- to set positional parameters
          const ddIdx = cmdArgs.indexOf('--');
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
                  const allOpts = ['allexport', 'errexit', 'noclobber', 'noexec', 'noglob', 'nounset', 'pipefail', 'verbose', 'xtrace'];
                  for (const opt of allOpts) {
                    writeStdout(`${opt}\t\t${this.options.has(opt) ? 'on' : 'off'}\r\n`);
                  }
                } else {
                  const optMap: Record<string, string> = {
                    errexit: 'errexit', nounset: 'nounset', xtrace: 'xtrace', verbose: 'verbose', noexec: 'noexec', pipefail: 'pipefail',
                    noclobber: 'noclobber', noglob: 'noglob', allexport: 'allexport',
                    // accepted, no effect here
                    monitor: 'monitor', notify: 'notify', hashall: 'hashall', ignoreeof: 'ignoreeof', emacs: 'emacs', vi: 'vi',
                    posix: 'posix', physical: 'physical', braceexpand: 'braceexpand', histexpand: 'histexpand', history: 'history',
                    interactive_comments: 'interactive_comments', keyword: 'keyword', nolog: 'nolog', onecmd: 'onecmd',
                    errtrace: 'errtrace', functrace: 'functrace', privileged: 'privileged',
                  };
                  const mapped = optMap[optName];
                  if (mapped) {
                    if (arg === '-o') this.options.add(mapped);
                    else this.options.delete(mapped);
                  } else {
                    stderrWriter(`set: ${optName}: invalid option name\r\n`);
                    exitCode = 1;
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
          if (cmdArgs.length === 0) {
            stderrWriter('source: filename argument required\r\n');
            exitCode = 1;
          } else {
            const scriptPath = this.fs.resolvePath(cmdArgs[0], this.cwd);
            try {
              const raw = await this.fs.readFile(scriptPath);
              const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
              // Save/restore LINENO across source calls
              const savedLine = this.currentLine;
              const savedDepth = this.executeDepth;
              this.executeDepth = 0; // source starts a fresh top-level
              this.sourcing++;
              try {
                exitCode = await this.execute(content, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
              } catch (e) {
                if (!(e instanceof ReturnSignal)) throw e;
                exitCode = e.code; // `return` ends a sourced file
              } finally {
                this.sourcing--;
                this.currentLine = savedLine;
                this.executeDepth = savedDepth;
              }
              this.env['LINENO'] = String(this.currentLine);
            } catch (e: any) {
              if (isControlSignal(e)) throw e;
              stderrWriter(`source: ${cmdArgs[0]}: ${e.message}\r\n`);
              exitCode = 1;
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
          if (cmdArgs.length > 0) {
            const execCmd = quoteArgsForShell(cmdArgs);
            this.injectedStdin = nestedStdin;
            exitCode = await this.execute(execCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: builtin — run builtin ignoring functions
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
          if (cmdArgs.length === 0) {
            writeStdout('0022\r\n');
          }
          this.lastExitCode = 0;
          this.env['?'] = '0';
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
              stderrWriter(`shiro: ${redir.target}: ${e.message}\r\n`);
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
          stdoutIsTTY: i === pipeline.length - 1 && !redirects.some(r => r.type === '>' || r.type === '>>'),
        };

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
        const hasShellStdin = i > 0 || hereString !== undefined || (i === 0 && !!heredocStdin) || redirects.some(r => r.type === '<');
        const kernelRun = await this.tryKernelRun(pipeline, i, effectiveCmdName, cmdArgs, redirects, ctx,
          hasShellStdin, writeStdout, stderrWriter, terminalOverride || this.terminal);
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
        const pkgShadowed = !_builtinDisabled && this.pkgShadowBypass !== effectiveCmdName &&
          !!this.commands.get(effectiveCmdName) &&
          packageShadows(this.fs).has(effectiveCmdName);
        const cmd = pkgShadowed ? undefined : this.commands.get(effectiveCmdName);
        if (cmd) {
          try {
            exitCode = await cmd.exec(ctx);
          } catch (e: any) {
            ctx.stderr += e.message + '\n';
            exitCode = 1;
          }
        } else {
          // Try to find executable in PATH
          const executable = pkgShadowed
            ? `${PKG_BIN_DIR}/${effectiveCmdName}`
            : await this.findExecutableInPath(effectiveCmdName);
          if (executable) {
            try {
              exitCode = await this.executeScript(executable, cmdArgs, ctx, writeStdout, stderrWriter);
            } catch (e: any) {
              ctx.stderr += e.message + '\n';
              exitCode = 1;
            }
          } else {
            // Like Debian's command-not-found: name the package that has it
            const provider = findEntry(builtinIndex(), effectiveCmdName);
            if (provider && Object.prototype.hasOwnProperty.call(provider.bin, effectiveCmdName)) {
              stderrWriter(`shiro: command not found: ${effectiveCmdName}\r\n`);
              stderrWriter(`  it can be installed with: pkg install ${provider.name}` +
                (packageStatus(provider) === 'blocked' ? ` (needs kernel support Shiro doesn't have yet)` : '') + '\r\n');
              exitCode = 127;
              this.lastExitCode = exitCode;
              this.env['?'] = String(exitCode);
              break;
            } else {
              stderrWriter(`shiro: command not found: ${effectiveCmdName}\r\n`);
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

        // Update cwd from env
        this.cwd = this.env['PWD'] || this.cwd;
      }

      await flushCapture();

      for (const [key, value] of prefixEnvSaved) {
        if (value === undefined) delete this.env[key];
        else this.env[key] = value;
      }

      if (this.redirectFailed) { exitCode = 1; this.redirectFailed = false; }

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

      // Fire ERR trap on non-zero exit code
      if (exitCode !== 0 && this.traps.has('ERR')) {
        const errCmd = this.traps.get('ERR')!;
        await this.execute(errCmd, writeStdout, stderrWriter, false, undefined, true);
      }

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
    // Check if stderr should be redirected to stdout (2>&1)
    const redirectStderrToStdout = redirects.some(r => r.type === '2>&1');

    // Handle stderr output and redirects
    let stderrOutput = stderr;
    for (const redir of redirects) {
      if (redir.type === '2>' || redir.type === '2>>') {
        if (redir.target === '/dev/null') {
          stderrOutput = '';
          continue;
        }
        // 2>&N: the shell's fd N
        const ref = fdOfRef(redir.target);
        if (ref !== null) {
          if (!(await this.writeToFd(ref, stderrOutput, writeStdout, stderrWriter))) stderrWriter(`shiro: ${ref}: Bad file descriptor\r\n`);
          stderrOutput = '';
          continue;
        }
        // 2>/dev/stderr → default behavior (let it through)
        if (redir.target === '/dev/stderr') continue;
        // 2>/dev/stdout → redirect stderr to stdout
        if (redir.target === '/dev/stdout') {
          stdout += stderrOutput;
          stderrOutput = '';
          continue;
        }
        const targetPath = this.fs.resolvePath(redir.target, this.cwd);
        if (redir.type === '2>' && !(await this.clobberOk(redir, targetPath, stderrWriter))) { stderrOutput = ''; continue; }
        if (redir.type === '2>') {
          await this.fs.writeFile(targetPath, stderrOutput);
        } else {
          await this.fs.appendFile(targetPath, stderrOutput);
        }
        stderrOutput = '';
      }
    }

    // Handle stdout redirects
    let output = stdout;

    // If 2>&1, merge stderr into stdout BEFORE processing stdout redirects
    if (redirectStderrToStdout && stderrOutput) {
      output += stderrOutput;
      stderrOutput = '';
    }

    // Now write any remaining stderr to the error stream
    if (stderrOutput) {
      stderrWriter(stderrOutput.replace(/\n/g, '\r\n'));
    }
    for (const redir of redirects) {
      if (redir.type === '>' || redir.type === '>>') {
        if (redir.target === '/dev/null') {
          output = '';
          continue;
        }
        // >&N: the shell's fd N
        const ref = fdOfRef(redir.target);
        if (ref !== null) {
          if (!(await this.writeToFd(ref, output, writeStdout, stderrWriter))) stderrWriter(`shiro: ${ref}: Bad file descriptor\r\n`);
          output = '';
          continue;
        }
        // /dev/stdout → write to stdout (default behavior, just let it through)
        if (redir.target === '/dev/stdout') continue;
        // /dev/stderr → redirect stdout content to stderr
        if (redir.target === '/dev/stderr') {
          stderrWriter(output.replace(/\n/g, '\r\n'));
          output = '';
          continue;
        }
        const targetPath = this.fs.resolvePath(redir.target, this.cwd);
        if (redir.type === '>' && !(await this.clobberOk(redir, targetPath, stderrWriter))) { output = ''; continue; }
        if (redir.type === '>') {
          await this.fs.writeFile(targetPath, output);
        } else {
          await this.fs.appendFile(targetPath, output);
        }
        output = '';
      }
    }

    // N> file for N >= 3 on an ordinary command: the file is still created
    for (const redir of redirects) {
      if (redir.type === 'open' && redir.mode !== '<') {
        const path = this.fs.resolvePath(redir.target, this.cwd);
        if (redir.mode === '>') await this.fs.writeFile(path, '');
        else await this.fs.appendFile(path, '');
      }
    }

    if (isLast && output) {
      writeStdout(output.replace(/\n/g, '\r\n'));
    }
    return output;
  }

  /** set -o noclobber: `>` (not `>|`) refuses to overwrite an existing regular file */
  private async clobberOk(redir: Redirect, path: string, writeStderr: (s: string) => void): Promise<boolean> {
    if (redir.force || !this.options.has('noclobber')) return true;
    const st = await this.fs.stat(path).catch(() => null);
    if (st && !st.isDirectory() && st.isFile()) {
      writeStderr(`shiro: ${redir.target}: cannot overwrite existing file\r\n`);
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
      } else if (ch === '}') {
        depth--;
        if (depth === 0) { braceEnd = i; break; }
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
      const step = rangeMatch[3] ? parseInt(rangeMatch[3]) : (start <= end ? 1 : -1);
      const padLen = Math.max(rangeMatch[1].length, rangeMatch[2].length);
      const shouldPad = rangeMatch[1].startsWith('0') || rangeMatch[2].startsWith('0');
      const items: string[] = [];
      if (step > 0) {
        for (let n = start; n <= end; n += step) {
          items.push(shouldPad ? String(n).padStart(padLen, '0') : String(n));
        }
      } else if (step < 0) {
        for (let n = start; n >= end; n += step) {
          items.push(shouldPad ? String(Math.abs(n)).padStart(padLen, '0') : String(n));
        }
      }
      const result: string[] = [];
      for (const item of items) {
        result.push(...this.expandBraceToken(prefix + item + suffix));
      }
      return result;
    }

    // Char range: {a..z}
    const charRange = body.match(/^([a-zA-Z])\.\.([a-zA-Z])$/);
    if (charRange) {
      const startCode = charRange[1].charCodeAt(0);
      const endCode = charRange[2].charCodeAt(0);
      const step = startCode <= endCode ? 1 : -1;
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
        result += '1';
        i += 2;
        continue;
      }

      // Expand $? (last exit code)
      if (ch === '$' && line[i + 1] === '?') {
        result += String(this.lastExitCode);
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
        const v = this.env[line[i + 1]] ?? '';
        result += inDouble ? protectExpansion(v) : splitFields(v, this.fieldIFS());
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
          if (bc === "'" && !braceInDQ) braceInSQ = !braceInSQ;
          else if (bc === '"' && !braceInSQ) braceInDQ = !braceInDQ;
          else if (!braceInSQ && !braceInDQ) {
            if (bc === '{') depth++;
            else if (bc === '}') { depth--; if (depth === 0) break; }
          }
          j++;
        }
        if (depth === 0 && j < line.length) {
          const inner = line.slice(i + 2, j); // content between ${ and }
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
          const expanded = this.expandParamExpression(inner);
          if (expanded !== null) {
            // The value is data, except for ${x-word} ${x=word} ${x+word} ${x?word},
            // whose word was expanded as shell text (its quotes still to be removed)
            const wordOp = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-]):?[-=+?]/.test(inner);
            result += wordOp ? expanded
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
          if (varName === 'HOSTNAME') { result += 'shiro'; i += m[0].length; continue; }
          if (varName === 'PPID') { result += '0'; i += m[0].length; continue; }
          if (varName === 'LINENO') { result += (this.env['LINENO'] || '1'); i += m[0].length; continue; }
          if (varName === 'SECONDS') { result += String(Math.floor(performance.now() / 1000)); i += m[0].length; continue; }
          if (varName === 'EPOCHSECONDS') { result += String(Math.floor(Date.now() / 1000)); i += m[0].length; continue; }
          if (varName === 'EPOCHREALTIME') { const now = Date.now(); result += `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, '0')}`; i += m[0].length; continue; }
          // Resolve namerefs: if varName is a nameref, follow it
          const resolved = this.namerefs.has(varName) ? this.namerefs.get(varName)! : varName;
          const v = this.env[resolved] ?? this.scalarOf(resolved) ?? '';
          result += inDouble ? protectExpansion(v) : splitFields(v, this.fieldIFS());
          i += m[0].length;
          continue;
        }
      }

      // Tilde expansion (only unquoted, not inside operators like =~)
      if (ch === '~' && !inDouble) {
        const before = i === 0 ? '' : line[i - 1];
        const after = line[i + 1] || '';
        // Only expand after = in assignment context (VAR=~), not in operators like =~
        const isAssignContext = before === '=' ? (i >= 2 && /[A-Za-z0-9_]/.test(line[i - 2])) : true;
        if ((i === 0 || /[\s=]/.test(before)) && isAssignContext) {
          // ~+ expands to $PWD, ~- expands to $OLDPWD
          if (after === '+' && (/[\/\s;|&>]/.test(line[i + 2] || '') || i + 2 >= line.length)) {
            result += this.env['PWD'] || this.cwd;
            i += 2;
            continue;
          }
          if (after === '-' && (/[\/\s;|&>]/.test(line[i + 2] || '') || i + 2 >= line.length)) {
            result += this.env['OLDPWD'] || this.cwd;
            i += 2;
            continue;
          }
          if (/[\/\s;|&>]/.test(after) || i + 1 >= line.length) {
            const home = this.env['HOME'] ?? '/home/user';
            result += splitFields(home, ''); // a tilde expansion is one field
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
      return { list: [...all].filter((k) => k.startsWith(names[1]) && /^[A-Za-z_]/.test(k)).sort(), star: names[2] === '*' };
    }
    // ${@:off:len} / ${*:off:len}: offset 0 is $0
    if (/^[@*]:(?![-=+?])/.test(inner)) {
      const args = this.getPositionalArgs();
      const pairs: [number, string][] = [[0, this.env['0'] ?? 'shiro'], ...args.map((a, k): [number, string] => [k + 1, a])];
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
    const name = this.namerefs.get(rawName) ?? rawName;
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
      try { return Number(this.evalArithBig(e)); } catch (err) { if (err instanceof ArithError) throw new Error(err.message); throw err; }
    };

    if (sub === '@' || sub === '*') {
      const star = sub === '*';
      if (prefix === '!') return op ? null : { list: keys, star };
      if (prefix === '#') return op ? null : { text: String(keys.length), raw: false };
      const vals = keys.map((k) => get(k)!);
      if (!op) return { list: vals, star };
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
    try { v = this.getVar(name, sub); } catch (e) { if (e instanceof ArithError) throw new Error(e.message); throw e; }
    if (prefix === '#') return op ? null : { text: String([...(v ?? '')].length), raw: false };
    if (prefix === '!') return null;
    if (!op) return { text: v ?? '', raw: false };
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
      try { return Number(this.evalArithBig(e)); } catch (err) { if (err instanceof ArithError) throw new Error(err.message); throw err; }
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

  /** `declare -p NAME` output, null if NAME is not set */
  private declareLine(name: string): string | null {
    const q = (v: string) => `"${v.replace(/(["\\$`])/g, '\\$1')}"`;
    const flags = (base: string) => {
      let f = base;
      if (this.readonlyVars.has(name)) f += 'r';
      return f ? `-${f}` : '--';
    };
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
    if (this.env[name] === undefined) return null;
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

    // ${arr[@]@Q} — quote all array elements
    const arrAtOpMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]@([QEUuLA])$/);
    if (arrAtOpMatch) {
      const name = arrAtOpMatch[1];
      const op = arrAtOpMatch[2];
      const assoc = this.assocArrays.get(name);
      const values = assoc ? Array.from(assoc.values()) : (this.arrays.get(name) ?? []);
      const mapped = values.map(v => {
        switch (op) {
          case 'Q': return `'${v.replace(/'/g, "'\\''")}'`;
          case 'E': return v.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
          case 'U': return v.toUpperCase();
          case 'u': return v.length > 0 ? v[0].toUpperCase() + v.slice(1) : '';
          case 'L': return v.toLowerCase();
          case 'A': return v;
          default: return v;
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
      return String((this.env[lenMatch[1]] ?? '').length);
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
        try { return Number(this.evalArithBig(e)); } catch (err) { if (err instanceof ArithError) throw new Error(err.message); throw err; }
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
          if (check) { this.env[varName] = expandedOperand; return expandedOperand; }
          return val ?? '';
        case '+': return check ? '' : expandedOperand;
        case '?':
          if (check) throw new Error(`${varName}: ${expandedOperand || 'parameter not set'}`);
          return val ?? '';
      }
    }

    // ${VAR@op} — variable transformations
    const atMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)@([QEUuLaAK])$/);
    if (atMatch) {
      const val = this.env[atMatch[1]] ?? '';
      switch (atMatch[2]) {
        case 'Q': return `'${val.replace(/'/g, "'\\''")}'`; // quote for reuse
        case 'E': return val.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\\\/g, '\\'); // interpret escapes
        case 'U': return val.toUpperCase();
        case 'u': return val.length > 0 ? val[0].toUpperCase() + val.slice(1) : '';
        case 'L': return val.toLowerCase();
        case 'a': {
          // Return actual variable attributes
          const vname = atMatch[1];
          let attrs = '';
          if (this.readonlyVars.has(vname)) attrs += 'r';
          if (this.namerefs.has(vname)) attrs += 'n';
          if (this.arrays.has(vname)) attrs += 'a';
          if (this.assocArrays.has(vname)) attrs += 'A';
          return attrs;
        }
        case 'A': return `declare -- ${atMatch[1]}="${val}"`; // assignment form
        case 'K': return val; // display as key-value (stub)
        default: return val;
      }
    }

    // Simple ${VAR}
    const simpleMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
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
      if (ch === '*') { result += '.*'; continue; }
      if (ch === '?') { result += '.'; continue; }
      if (ch === '[') {
        // Character class: pass through until ]
        let j = i + 1;
        const neg = pattern[j] === '!' || pattern[j] === '^';
        if (neg) j++;
        let body = '';
        // A ] first in the class is literal (bash: not after ^)
        if (pattern[j] === ']' && pattern[j - 1] !== '^') { body += '\\]'; j++; }
        while (j < pattern.length && pattern[j] !== ']') {
          const pc = /^\[:(\w+):\]/.exec(pattern.slice(j));
          if (pc) { body += POSIX_CLASSES[pc[1]] ?? ''; j += pc[0].length; continue; }
          if (pattern[j] === '\\' && j + 1 < pattern.length) { body += '\\' + pattern[j + 1]; j += 2; continue; }
          body += pattern[j] === '[' || pattern[j] === '^' ? '\\' + pattern[j] : pattern[j];
          j++;
        }
        if (j >= pattern.length) { result += '\\['; continue; } // no closing ]: a literal [
        result += (neg ? '[^' : '[') + body + ']';
        i = j;
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
          current += ch; i++; continue;
        }
        if (ch === ')' && parenDepth > 0) {
          parenDepth--;
          current += ch; i++; continue;
        }

        // Track {/} brace groups and function bodies
        if (ch === '{') {
          // Only count as depth if preceded by whitespace/; (not in ${VAR})
          const prevBrace = i > 0 ? line[i - 1] : ' ';
          if (/[\s;)]/.test(prevBrace) || i === 0) { depth++; braceDepth++; }
          current += ch; i++; continue;
        }
        if (ch === '}') {
          // Only decrement if we have a matching brace-group { (not ${VAR})
          if (braceDepth > 0) { depth--; braceDepth--; }
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
            if (current.trim()) result.push({ operator: currentOp, command: current.trim() });
            currentOp = '&&';
            current = '';
            i += 2;
            continue;
          }
          if (ch === '|' && line[i + 1] === '|') {
            if (current.trim()) result.push({ operator: currentOp, command: current.trim() });
            currentOp = '||';
            current = '';
            i += 2;
            continue;
          }
          if (ch === ';') {
            if (current.trim()) result.push({ operator: currentOp, command: current.trim() });
            currentOp = ';';
            current = '';
            i++;
            continue;
          }
          // `cmd & next`: cmd runs in the background (it keeps its trailing &)
          if (ch === '&' && line[i + 1] !== '>' && !/[<>&|]/.test(line[i - 1] ?? '') && line.slice(i + 1).trim()) {
            if (current.trim()) result.push({ operator: currentOp, command: current.trim() + ' &' });
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

    if (current.trim()) result.push({ operator: currentOp, command: current.trim() });
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
        hereString = tokens[i + 1].replace(/\x01/g, '') + '\n';
        i++;
        continue;
      }
      if ((tok === '&>' || tok === '&>>') && i + 1 < tokens.length) {
        redirects.push({ type: tok === '&>' ? '>' : '>>', target: tokens[++i].replace(/\x01/g, '') });
        redirects.push({ type: '2>&1', target: '' });
        continue;
      }
      const m = /^(\d*)(>>|>\||>|<>|<)(?:&(\d+|-))?$/.exec(tok);
      if (!m || (m[3] === undefined && i + 1 >= tokens.length)) { args.push(tok); continue; }
      const op = m[2];
      const fd = m[1] !== '' ? parseInt(m[1], 10) : op === '<' || op === '<>' ? 0 : 1;
      let dupOf: string | undefined = m[3];
      let target = '';
      if (dupOf === undefined) {
        target = tokens[++i].replace(/\x01/g, '');
        // `> &2` / `>& 2` written apart, or bash's `>&file` (= &> file)
        const t = /^&(\d+|-)$/.exec(target);
        if (t) dupOf = t[1];
      }
      if (dupOf === '-') { redirects.push({ type: '>&-', target: '', fd }); continue; }
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
      args: args.map(restoreExpansion),
      redirects: redirects.map((r) => ({ ...r, target: restoreExpansion(r.target) })),
      hereString: hereString === undefined ? undefined : restoreExpansion(hereString),
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
            current += '\x01' + next; // sentinel: quoted glob char
          } else {
            current += '\\' + next; // keep backslash literally
          }
        } else {
          // Outside quotes: backslash escapes the next character
          if (next === '*' || next === '?' || next === '[') {
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
      if ((inSingle || inDouble) && (ch === '*' || ch === '?' || ch === '[')) {
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

      // >, >>, >| and N>, N>>, N>&M, N>&-, >&M (an all-digit word right before > is the fd)
      if (ch === '>' && !inSingle && !inDouble) {
        const fdPrefix = !quoted && /^\d+$/.test(current) ? current : '';
        if (fdPrefix) current = '';
        if (current || quoted) { tokens.push(current); current = ''; } quoted = false;
        let op = '>';
        i++;
        if (input[i] === '>') { op = '>>'; i++; } else if (input[i] === '|') { op = '>|'; i++; }
        const dup = input[i] === '&' ? /^&(\d+|-)/.exec(input.slice(i)) : null;
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
        const fdPrefix = !quoted && /^\d+$/.test(current) ? current : '';
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
        while (j < input.length && depth > 0) {
          const sc = input[j];
          if (sc === '\\' && !subSQ) { j += 2; continue; }
          if (sc === "'" && !subDQ) { subSQ = !subSQ; j++; continue; }
          if (sc === '"' && !subSQ) { subDQ = !subDQ; j++; continue; }
          if (!subSQ && !subDQ) {
            if (sc === '(') depth++;
            if (sc === ')') depth--;
          }
          j++;
        }
        const subCmd = input.slice(i + 2, j - 1);
        // $(< file) shorthand: read file contents directly
        const fileReadMatch = subCmd.trim().match(/^<\s*(.+)$/);
        let subOut: string;
        if (fileReadMatch) {
          const filePath = restoreExpansion(this.expandVars(fileReadMatch[1].trim())).replace(/^["']|["']$/g, '');
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
    let tmpCounter = 0;
    for (const arg of args) {
      // Match <(command) — must be the entire arg or standalone
      const match = arg.match(/^<\((.+)\)$/);
      if (match) {
        const subcmd = match[1];
        try {
          const { stdout } = await this.exec(subcmd);
          const tmpPath = `/tmp/.procsub_${Date.now()}_${tmpCounter++}`;
          await this.fs.writeFile(tmpPath, stdout);
          result.push(tmpPath);
        } catch (e: any) {
          writeStderr(`shiro: process substitution failed: ${e.message}\r\n`);
          result.push(arg);
        }
      } else {
        result.push(arg);
      }
    }
    return result;
  }

  /**
   * (from quoted strings) are NOT expanded — the sentinel is stripped instead.
   * Follows bash behavior: no matches = keep the literal pattern.
   */
  private async expandGlobs(args: string[], writeStderr?: (s: string) => void): Promise<string[] | null> {
    const result: string[] = [];
    for (const arg of args) {
      const literal = arg.replace(/\x01/g, '');
      if (this.options.has('noglob') || !hasUnquotedGlob(arg, this.shoptopts.has('extglob'))) {
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
        const name = seg.replace(/\x01/g, '');
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
        const explicitDot = seg.replace(/\x01/g, '').startsWith('.');
        for (const c of cands) {
          const names = await this.fs.readdir(c.abs).catch(() => [] as string[]);
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
        const end = seg.indexOf(']', i + (seg[i + 1] === ']' || (seg[i + 1] === '!' && seg[i + 2] === ']') ? 3 : 2));
        if (end > i) {
          let body = seg.slice(i + 1, end).replace(/\x01/g, '');
          if (body.startsWith('!')) body = '^' + body.slice(1);
          out += '[' + body.replace(/\\/g, '\\\\').replace(/\[:(\w+):\]/g, (_m, k) => POSIX_CLASSES[k] ?? '') + ']';
          i = end;
          continue;
        }
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
        let depth = 1;
        let j = i + 3;
        while (j < input.length - 1 && depth > 0) {
          if (input[j] === '(' && input[j + 1] === '(') { depth++; j += 2; continue; }
          if (input[j] === ')' && input[j + 1] === ')') { depth--; if (depth === 0) break; j += 2; continue; }
          j++;
        }
        let expr = input.slice(i + 3, j);
        // Parameter expansions inside are expanded first: $(( ${n:-0} + 1 )), $(( $((1+2)) * 2 ))
        try {
          result += String(this.evalArithBig(expr));
        } catch (e) {
          // An arithmetic error aborts the command (and a script, as in bash)
          if (e instanceof ArithError) throw new Error(e.message);
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
      writeStderr(`shiro: ${e.message}\r\n`);
      return 1;
    }
  }

  /** Variables as arithmetic sees them: NAME, NAME[SUB] (indexed or associative) */
  private arithEnv: ArithEnv = {
    get: (name, sub) => this.getVar(name, sub),
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
    name = this.namerefs.get(name) ?? name;
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
    name = this.namerefs.get(name) ?? name;
    if (this.readonlyVars.has(name)) return `${name}: readonly variable`;
    const assoc = this.assocArrays.get(name);
    if (sub === undefined) {
      if (assoc) assoc.set('0', value);
      else if (this.arrays.has(name)) this.arrays.get(name)![0] = value;
      else this.env[name] = value;
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
    // bash allows - . : in function names (test-hyphen() { … })
    let match = input.match(/^([A-Za-z_][\w.:-]*)\s*\(\)\s*\{([\s\S]*)\}$/);
    if (!match) match = input.match(/^function\s+([A-Za-z_][\w.:-]*)\s*(?:\(\))?\s*\{([\s\S]*)\}$/);
    if (match) return { name: match[1], body: match[2].trim() };
    return null;
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

    // Track FUNCNAME and BASH_SOURCE stacks
    const prevFuncname = this.arrays.get('FUNCNAME') || [];
    this.arrays.set('FUNCNAME', [name, ...prevFuncname]);
    const prevBashSource = this.arrays.get('BASH_SOURCE') || [];
    this.arrays.set('BASH_SOURCE', ['main', ...prevBashSource]);
    this.callStack.push({ funcName: name, source: 'main' });

    // Push local variable frame for `local` declarations
    this.localVarStack.push(new Map());

    // Execute body — catch ReturnSignal for `return [N]`
    let exitCode = 0;
    try {
      exitCode = await this.execute(func.body, writeStdout, writeStderr, false, undefined, true);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        exitCode = e.code;
      } else {
        // Restore before re-throwing
        this.restoreLocalVars();
        this.arrays.set('FUNCNAME', prevFuncname);
        this.arrays.set('BASH_SOURCE', prevBashSource);
        this.callStack.pop();
        for (const key of Object.keys(saved)) {
          if (saved[key] === undefined) delete this.env[key];
          else this.env[key] = saved[key]!;
        }
        throw e;
      }
    }

    // Pop local variable frame — restore saved values
    this.restoreLocalVars();

    // Restore FUNCNAME and BASH_SOURCE stacks
    this.arrays.set('FUNCNAME', prevFuncname);
    this.arrays.set('BASH_SOURCE', prevBashSource);
    this.callStack.pop();

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
    } else if (stdin) {
      code = await this.execControlStructurePiped(head, stdin, capture, writeStderr);
    } else {
      code = await this.execControlStructure(head, capture, writeStderr);
    }
    if (this.abortController?.signal.aborted) return 130;
    this.injectedStdin = captured.replace(/\r\n/g, '\n');
    const rest = parts.slice(1).join('|');
    const restCode = await this.execute(rest, writeStdout, writeStderr, false, terminalOverride || this.terminal, true);
    this.injectedStdin = null;
    return this.options.has('pipefail') && code !== 0 && restCode === 0 ? code : restCode;
  }

  private isControlStructure(input: string): boolean {
    return /^if\s+/.test(input) || /^while\s+/.test(input) || /^until\s+/.test(input) || /^for\s+/.test(input) || /^case\s+/.test(input) || /^select\s+/.test(input)
      || isBraceGroup(input);
  }

  /** Brace, arithmetic, command-substitution, and variable expansion of command text */
  private async expandWords(text: string, writeStderr: (s: string) => void): Promise<string> {
    let expanded = this.expandBraces(text);
    expanded = this.expandArithmetic(expanded);
    expanded = await this.expandCommandSubstitution(expanded, writeStderr);
    return this.expandVars(expanded);
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
    let captured = '';
    for (const r of redirects) {
      const target = restoreExpansion(this.expandVars(r.target));
      if (r.op === '<') {
        try {
          stdin = await this.readInputRedirect(target);
        } catch {
          writeStderr(`shiro: ${target}: No such file or directory\r\n`);
          return 1;
        }
      } else if (r.op === '2>&1') {
        err = (s) => out(s);
      } else if (r.op === '2>' || r.op === '2>>') {
        err = target === '/dev/null' ? () => {} : writeStderr;
      } else if (r.op === '>' || r.op === '>>' || r.op === '&>') {
        if (r.op === '&>') err = (s) => out(s);
        if (target === '/dev/null') { out = () => {}; continue; }
        outFile = { path: this.fs.resolvePath(target, this.cwd), append: r.op === '>>' };
        out = (s) => { captured += s; };
      }
    }
    const code = stdin === undefined
      ? await this.execControlStructureCore(compound, out, err)
      : await this.execControlStructureWithStdin(compound, stdin, out, err);
    if (outFile) {
      const text = captured.replace(/\r\n/g, '\n');
      if (outFile.append) await this.fs.appendFile(outFile.path, text);
      else await this.fs.writeFile(outFile.path, text);
    }
    return code;
  }

  private async execControlStructureCore(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    if (/^if\s+/.test(input)) return this.execIf(input, writeStdout, writeStderr);
    if (/^while\s+/.test(input)) return this.execWhile(input, writeStdout, writeStderr);
    if (/^until\s+/.test(input)) return this.execUntil(input, writeStdout, writeStderr);
    if (/^for\s+/.test(input)) return this.execFor(input, writeStdout, writeStderr);
    if (/^case\s+/.test(input)) return this.execCase(input, writeStdout, writeStderr);
    if (/^select\s+/.test(input)) return this.execSelect(input, writeStdout, writeStderr);
    if (/^\((?!\()/.test(input) && input.endsWith(')')) {
      // ( list ) runs in a child shell
      const child = this.fork();
      child.injectedStdin = this.injectedStdin;
      this.injectedStdin = null;
      const inner = input.slice(1, -1).trim();
      return inner ? child.execute(inner, writeStdout, writeStderr, false, this.terminal, true) : 0;
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
    if (/^while\s+/.test(input)) return this.execWhile(input, writeStdout, writeStderr, pipeStdin);
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
    // Normalize to semicolons for easier parsing
    const joined = input.replace(/\r?\n/g, '; ').replace(/;\s*;/g, ';');

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
      const expandedCond = this.expandVars(await this.expandCommandSubstitution(this.expandArithmetic(branch.condition), writeStderr));
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
        if (depth === 0) { doPos = tok.pos; }
        else depth--; // absorb do for the nested loop
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
      cmdPos = cmdPos && !glued && leadsToCommand.has(word);
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

    let iter = 0;
    while (iter++ < LOOP_ITERATION_LIMIT) {
      if (iter % 1000 === 0) await yieldToEventLoop(); // keep the page responsive in long loops
      // Expand vars in condition each iteration (loop vars like $X change)
      const expandedCond = this.expandVars(await this.expandCommandSubstitution(this.expandArithmetic(parsed.condition), writeStderr));
      if ((await this.evalCondition(expandedCond, writeStdout, writeStderr)) !== 0) break;
      try {
        if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr, false, undefined, true);
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); continue; }
        throw e;
      }
    }

    // Restore
    if (pipeStdin !== undefined) {
      if (savedPipeStdin === undefined) delete this.env['__PIPE_STDIN'];
      else this.env['__PIPE_STDIN'] = savedPipeStdin;
    }
    return 0;
  }

  private async execUntil(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const parsed = this.parseLoopConstruct(input, 'until');
    if (!parsed) { writeStderr('until: syntax error\r\n'); return 1; }

    let iter = 0;
    while (iter++ < LOOP_ITERATION_LIMIT) {
      if (iter % 1000 === 0) await yieldToEventLoop();
      const expandedCond = this.expandVars(await this.expandCommandSubstitution(this.expandArithmetic(parsed.condition), writeStderr));
      if ((await this.evalCondition(expandedCond, writeStdout, writeStderr)) === 0) break;
      try {
        if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr, false, undefined, true);
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); continue; }
        throw e;
      }
    }
    return 0;
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
      // Loop
      let iter = 0;
      while (iter++ < LOOP_ITERATION_LIMIT) {
        if (iter % 1000 === 0) await yieldToEventLoop();
        // Evaluate test — 0 means false (stop)
        if (test && this.evalArithmetic(test) === 0) break;
        // Execute body
        try {
          if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr, false, undefined, true);
        } catch (e) {
          if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); break; }
          if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); /* fall through to update */ }
          else throw e;
        }
        // Execute update
        if (update) this.evalArithmetic(update);
      }
      return 0;
    }

    // Parse "VAR in item1 item2 item3" from condition
    // `for NAME in WORDS`, `for NAME in` (no words) or `for NAME` ("$@")
    const forMatch = parsed.condition.match(/^(\w+)(?:\s+in(?:\s+([\s\S]*))?)?$/);
    if (!forMatch) { writeStderr('for: syntax error\r\n'); return 1; }

    const varName = forMatch[1];
    const items = /\sin(\s|$)/.test(parsed.condition)
      ? await this.expandWordList(forMatch[2] ?? '', writeStderr)
      : this.getPositionalArgs();
    for (const item of items) {
      this.env[varName] = item;
      try {
        if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr, false, undefined, true);
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); continue; }
        throw e;
      }
    }
    return 0;
  }

  /** The words of a `for`/`select` list, expanded like command arguments (quotes, splitting, globs) */
  /** `[[ … ]]`: 0 true, 1 false, 2 on a syntax error or bad regex */
  private async evalDoubleBracket(src: string, writeStderr: (s: string) => void): Promise<number> {
    let tree: DbNode;
    try {
      tree = parseDoubleBracket(src);
    } catch (e) {
      if (!(e instanceof DbSyntaxError)) throw e;
      writeStderr(`shiro: [[: ${e.message}\r\n`);
      if (this.scriptShell) throw new ExitSignal(2);
      return 2;
    }
    try {
      return (await this.dbEval(tree, writeStderr)) ? 0 : 1;
    } catch (e) {
      if (e instanceof RegexSyntaxError) { writeStderr(`shiro: [[: invalid regular expression\r\n`); return 2; }
      if (e instanceof ArithError) { writeStderr(`shiro: ${e.message}\r\n`); return 1; }
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
      return args.map((a) => a.replace(/\x01/g, '')).join(' ');
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
    if (!decl && parsed.some((a) => !a)) return null; // `a[0]=x cmd`: not ours
    this.substStatus = null;
    let status = 0;
    if (decl) {
      // The declaration itself (attributes, local scope) with the array words cut to their names
      const declWords = rest.map((w, k) => (isArrayWord(parsed[k]) ? parsed[k]!.name : w));
      if (rest.some((w) => /^-\w*A/.test(w))) {
        for (const a of parsed) if (a && isArrayWord(a) && !this.assocArrays.has(a.name)) { this.arrays.delete(a.name); delete this.env[a.name]; }
      }
      status = await this.execute([decl, ...declWords].join(' '), writeStdout, writeStderr, false, undefined, true);
      if (status !== 0) return status;
    }
    for (const a of parsed) {
      if (!a) continue;
      let err: string | null = null;
      try {
        if (isArrayWord(a)) err = await this.assignArrayWord(a, writeStderr);
        else if (!decl) {
          const value = await this.expandScalar(a.value, writeStderr);
          err = this.setVar(a.name, a.append ? (this.getVar(a.name) ?? '') + value : value);
        }
      } catch (e) {
        if (!(e instanceof ArithError)) throw e;
        err = e.message;
      }
      if (err) { writeStderr(`shiro: ${err}\r\n`); status = 1; }
    }
    return status || (this.substStatus ?? 0);
  }

  /** Apply one a=(…), a+=(…), a[i]=v or a[i]+=v */
  private async assignArrayWord(a: AssignWord, writeStderr: (s: string) => void): Promise<string | null> {
    const name = this.namerefs.get(a.name) ?? a.name;
    if (this.readonlyVars.has(name)) return `${name}: readonly variable`;
    if (!a.list) {
      const value = await this.expandScalar(a.value, writeStderr);
      return this.setVar(name, a.append ? (this.getVar(name, a.sub) ?? '') + value : value, a.sub);
    }
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
        if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); continue; }
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
        const re = new RegExp('^' + parts.map((x) => (x.literal ? x.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : this.globToRegex(x.text))).join('') + '$', 's');
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

  /**
   * Run segment `i` (and the kernel programs piped right after it) as kernel
   * processes when it is a WASM or x86 program (src/shell-kernel.ts). Null when
   * it isn't one, so the caller falls back to the in-page paths.
   */
  private async tryKernelRun(
    pipeline: string[], i: number, name: string, args: string[], redirects: Redirect[], ctx: CommandContext,
    hasShellStdin: boolean, writeStdout: (s: string) => void, writeStderr: (s: string) => void, terminal: any,
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
    const crlf = (w: (s: string) => void) => (t: string) => w(t.replace(/\r?\n/g, '\r\n'));
    const r = await runKernelPipeline(this, programs, {
      stdin: hasShellStdin ? ctx.stdin : undefined,
      captureStdout: last < pipeline.length - 1 || hasOutRedirect(lastRedirects) || !!terminal?.captureStdout,
      captureStderr: hasOutRedirect(lastRedirects),
      writeStdout: crlf(writeStdout),
      writeStderr: crlf(writeStderr),
      terminal,
      command: pipeline.slice(i, last + 1).map(x => x.trim()).join(' | '),
      cwd: this.cwd,
      env: this.env,
    });
    return { lastIndex: last, redirects: lastRedirects, ...r, stdout: ctx.stdout + r.stdout, stderr: ctx.stderr + r.stderr };
  }

  /**
   * `cmd &` where every stage is a kernel program: a real background job in
   * the terminal's session (output to the tty, SIGTTIN if it reads). False
   * when the pipeline has anything else, so the in-page background path runs it.
   */
  private async launchKernelBackground(command: string, writeStdout: (s: string) => void, term: any): Promise<boolean> {
    if (!term?.tty || /[;&]|\|\||\$\(|`/.test(command)) return false;
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
    await runKernelPipeline(this, programs, {
      captureStdout: false, captureStderr: false, writeStdout, writeStderr: writeStdout,
      terminal: term, command, background: true, cwd: this.cwd, env: this.env,
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
        const candidate = `${pathDir}/${name}${suffix}`;
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
  ): Promise<number> {
    // Installed packages (/usr/bin/<cmd> -> /usr/lib/pkg/<name>/...) run with
    // the arguments and preloads their package records
    try {
      const real = await this.fs.realpath(filePath);
      // (a package's script launchers, like ruby's gem, and x86-64 programs
      // run in Blink, like perl, take the paths below)
      if (packageOfPath(real) && await this.isWasmFile(real)) {
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
      writeStderr(`shiro: ${filePath}: ${e.message}\r\n`);
      return 1;
    }

    // Read script content
    let content: string;
    try {
      content = await this.fs.readFile(resolvedPath, 'utf8') as string;
    } catch (e: any) {
      writeStderr(`shiro: ${resolvedPath}: ${e.message}\r\n`);
      return 1;
    }

    // Check if this is a WASM binary — run through WASI runtime
    if (content.charCodeAt(0) === 0x00 && content.charCodeAt(1) === 0x61 &&
        content.charCodeAt(2) === 0x73 && content.charCodeAt(3) === 0x6d) {
      return this.executeWasmBinary(resolvedPath, args, ctx, writeStdout, writeStderr);
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
        writeStderr(`shiro: ${pkgName}: ${e.message}\r\n`);
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
        writeStderr(`shiro: ${pkgName}: ${e.message}\r\n`);
        return 1;
      }
    }

    // Detect ELF binaries → run in x86-64 emulator
    if (content.charCodeAt(0) === 0x7f && content.charCodeAt(1) === 0x45 /* E */ &&
        content.charCodeAt(2) === 0x4c /* L */ && content.charCodeAt(3) === 0x46 /* F */) {
      // Blink (wasm) when the page can run it, else the built-in src/x86.
      const { runElf } = await import('./x86-engine');
      return runElf(resolvedPath, args, {
        fs: this.fs, cwd: this.cwd, args, env: this.env, shell: this,
        stdin: ctx.stdin || '', writeStdout: writeStdout, writeStderr: writeStderr,
      });
    }

    // Reject other binary files (Mach-O, etc.) that can't be interpreted
    if (content.charCodeAt(0) === 0x7f || content.includes('\0')) {
      writeStderr(`shiro: ${resolvedPath}: cannot execute binary file\n`);
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
      writeStderr('shiro: env: missing interpreter in #! line\n');
      return 126;
    }
    if (interp.includes('/') && !viaEnv && await this.fs.exists(interp)) {
      return this.executeScript(interp, argv, ctx, writeStdout, writeStderr);
    }
    const base = interp.slice(interp.lastIndexOf('/') + 1);
    const cmd = this.commands.get(base);
    if (cmd && !packageShadows(this.fs).has(base)) {
      ctx.args = argv;
      return cmd.exec(ctx);
    }
    const found = cmd ? `${PKG_BIN_DIR}/${base}` : await this.findExecutableInPath(base);
    if (found) return this.executeScript(found, argv, ctx, writeStdout, writeStderr);
    writeStderr(`shiro: ${interp}: bad interpreter: No such file or directory\n`);
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
  ): Promise<number> {
    try {
      const data = await this.fs.readFile(filePath) as Uint8Array;
      const image = new Uint8Array(data);
      const wasmModule = await WebAssembly.compile(image);

      const programName = filePath.split('/').pop() || filePath;
      const { runWasiProgram } = await import('./wasi/run-command');
      return await runWasiProgram(ctx, {
        module: wasmModule, image, argv: [programName, ...args], cwd: this.cwd, env: { ...this.env },
      });
    } catch (e: any) {
      const { WasiExit } = await loadWasiRuntime();
      if (e instanceof WasiExit) {
        return e.code;
      }
      writeStderr(`shiro: ${filePath}: ${e.message}\n`);
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
      writeStderr('shiro: node command not available\r\n');
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
    child.setPositional(args, argv0);
    return child.runScriptText(content, ctx.terminal, writeStdout, writeStderr);
  }

  /** Stdin for the next command this shell runs (`… | sh -c CMD`) */
  setInjectedStdin(stdin: string): void {
    this.injectedStdin = stdin;
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
        this.currentLine = stmt.line;
        this.env['LINENO'] = String(stmt.line);
        exitCode = await this.execute(stmt.text, writeStdout, writeStderr, false, terminal, true);
      }
    } catch (e) {
      if (e instanceof ExitSignal || e instanceof ReturnSignal) exitCode = e.code;
      else if (!(e instanceof BreakSignal || e instanceof ContinueSignal)) throw e;
    } finally {
      this.executeDepth = depth;
    }
    this.lastExitCode = exitCode;
    this.env['?'] = String(exitCode);
    await this.runExitTrap(writeStdout, writeStderr, terminal);
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
    if (cmdPos && ch === '[' && cmd[i + 1] === '[') {
      const e = doubleBracketEnd(cmd, i);
      if (e > 0) { current += cmd.slice(i, e); i = e; cmdPos = false; continue; }
    }
    if (ch === '(') { paren++; current += ch; i++; cmdPos = true; continue; }
    if (ch === ')') { if (paren > 0) paren--; current += ch; i++; cmdPos = false; continue; }
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

export interface CompoundRedirect { op: '<' | '>' | '>>' | '&>' | '2>' | '2>>' | '2>&1'; target: string }

/**
 * Split redirections off the end of a compound command:
 * `while read l; do …; done < in.txt > out.txt` → the loop, plus [<in.txt, >out.txt].
 */
export function splitCompoundRedirects(cmd: string): { compound: string; redirects: CompoundRedirect[] } {
  const end = compoundEnd(cmd);
  if (end < 0 || end >= cmd.length) return { compound: cmd, redirects: [] };
  const suffix = cmd.slice(end);
  const redirects: CompoundRedirect[] = [];
  const re = /\s*(2>&1|&>|2>>|2>|>>|>|<)\s*('[^']*'|"[^"]*"|[^\s<>]+)?/y;
  let pos = 0;
  while (pos < suffix.length) {
    if (!suffix.slice(pos).trim()) break;
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
  const subshell = /^\s*\((?!\()/.test(cmd);
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
      i++; cmdPos = false;
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
