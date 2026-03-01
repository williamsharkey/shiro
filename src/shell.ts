import { FileSystem } from './filesystem';
import { CommandRegistry, CommandContext } from './commands/index';
import type { ShiroTerminal } from './terminal';
import { recordCommand } from './favicon';
import { isAvailableAsPackage, getCompiledModule } from './wasi-packages';

// Lazy-load the WASI runtime (~960 lines) only when WASM execution is needed
let _wasiRuntime: typeof import('./wasi-runtime') | null = null;
async function loadWasiRuntime() {
  if (!_wasiRuntime) _wasiRuntime = await import('./wasi-runtime');
  return _wasiRuntime;
}

interface Redirect {
  type: '>' | '>>' | '<' | '2>' | '2>>' | '2>&1';
  target: string;
}

export interface BackgroundJob {
  id: number;
  command: string;
  promise: Promise<number>;
  status: 'running' | 'done' | 'failed';
  exitCode: number;
}

// Env var names whose values should be masked in terminal output
const SECRET_ENV_KEYS = [
  'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY',
  'API_KEY', 'SECRET_KEY', 'ACCESS_TOKEN', 'AUTH_TOKEN',
];

/** Sentinel thrown by `break [N]` inside loops */
class BreakSignal { constructor(public levels: number = 1) {} }
/** Sentinel thrown by `continue [N]` inside loops */
class ContinueSignal { constructor(public levels: number = 1) {} }
/** Sentinel thrown by `return [N]` inside functions */
class ReturnSignal { constructor(public code: number = 0) {} }

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
  private localVarStack: Map<string, string | undefined>[] = [];
  private nextJobId = 1;
  private terminal?: ShiroTerminal;

  constructor(fs: FileSystem, commands: CommandRegistry) {
    this.fs = fs;
    this.commands = commands;
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
    const count = parseInt(this.env['#'] || '0', 10);
    const args: string[] = [];
    for (let i = 1; i <= count; i++) args.push(this.env[String(i)] || '');
    return args;
  }

  /** Pop and restore local variable frame */
  private restoreLocalVars(): void {
    const frame = this.localVarStack.pop();
    if (!frame) return;
    for (const [varName, savedValue] of frame) {
      if (savedValue === undefined) delete this.env[varName];
      else this.env[varName] = savedValue;
    }
  }

  fork(): Shell {
    const child = new Shell(this.fs, this.commands);
    child.cwd = this.cwd;
    child.env = { ...this.env };
    child.functions = { ...this.functions };
    child.options = new Set(this.options);
    child.arrays = new Map(Array.from(this.arrays.entries()).map(([k, v]) => [k, [...v]]));
    child.assocArrays = new Map(Array.from(this.assocArrays.entries()).map(([k, v]) => [k, new Map(v)]));
    child.traps = new Map(this.traps);
    child.aliases = new Map(this.aliases);
    child.namerefs = new Map(this.namerefs);
    child.dirStack = [...this.dirStack];
    child.history = this.history; // share history array reference
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

  // Execute a command string and return { stdout, stderr, exitCode }
  async exec(input: string, remote: boolean = false): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let stdout = '';
    let stderr = '';
    const exitCode = await this.execute(
      input,
      (s) => { stdout += s; },
      (s) => { stderr += s; },
      remote,
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
    const job: BackgroundJob = {
      id: jobId,
      command,
      status: 'running',
      exitCode: 0,
      promise: this.execute(command, () => {}, stderrWriter).then(
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
    writeStdout(`[${jobId}] started\n`);
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
    // Handle backslash line continuations: \<newline> joins lines
    const joined = line.replace(/\\\n/g, '');
    const trimmed = joined.trim();
    if (!trimmed || trimmed.startsWith('#')) return 0;

    // Record command for title display
    recordCommand(trimmed, remote);

    // Check for background execution (&)
    if (trimmed.endsWith('&') && !trimmed.endsWith('&&')) {
      const bgCmd = trimmed.slice(0, -1).trim();
      if (bgCmd) {
        return this.executeBackground(bgCmd, writeStdout, writeStderr);
      }
    }

    // Split multi-line input into individual statements (respecting heredoc blocks)
    const statements = this.splitStatements(trimmed);
    if (statements.length > 1) {
      let lastExit = 0;
      for (const stmt of statements) {
        if (!stmt.trim()) continue;
        lastExit = await this.execute(stmt, writeStdout, writeStderr, remote, terminalOverride, true);
        // errexit: abort on non-zero exit code
        if (this.options.has('errexit') && lastExit !== 0) break;
      }
      this.lastExitCode = lastExit;
      this.env['?'] = String(lastExit);
      return lastExit;
    }

    // Handle heredocs before anything else
    const heredoc = this.parseHeredoc(trimmed);
    const effectiveLine = heredoc ? heredoc.command : trimmed;
    const heredocStdin = heredoc ? heredoc.body : '';

    // Strip control characters from history entries (ink UI can leak ANSI/DEL chars)
    // Only record user-typed commands (not programmatic calls from child_process, spawn, etc.)
    if (!skipHistory) {
      const sanitized = trimmed.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      if (sanitized.trim()) {
        this.history.push(sanitized);
        this.saveHistory(); // Persist to disk (async, don't await)
      }
    }

    const stderrWriter = writeStderr || writeStdout;

    // Check for function definition: name() { ... } or function name { ... }
    const funcDef = this.parseFunctionDef(effectiveLine);
    if (funcDef) {
      this.functions[funcDef.name] = { body: funcDef.body };
      return 0;
    }

    // NOTE: Control structures, (( )), and subshells are handled inside the
    // parseCompound loop below. This ensures that semicolons AFTER a control
    // structure closing keyword (fi, done, esac) are properly split.
    // e.g., "if [ $x -eq 1 ]; then break; fi; echo $x" → two compounds.

    // Split into compound commands: &&, ||, ;
    const compounds = this.parseCompound(effectiveLine);
    let exitCode = 0;

    for (const compound of compounds) {
      // Check conditional
      if (compound.operator === '&&' && exitCode !== 0) continue;
      if (compound.operator === '||' && exitCode === 0) continue;

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
        exitCode = this.evalArithmetic(expr) !== 0 ? 0 : 1;
        this.lastExitCode = exitCode;
        this.env['?'] = String(exitCode);
        continue;
      }

      // Check if compound is a subshell: (commands)
      if (trimmedCmd.startsWith('(') && trimmedCmd.endsWith(')')) {
        const inner = trimmedCmd.slice(1, -1).trim();
        if (inner) {
          const child = this.fork();
          const result = await child.exec(inner);
          if (result.stdout) writeStdout(result.stdout.replace(/\n/g, '\r\n'));
          if (result.stderr) stderrWriter(result.stderr.replace(/\n/g, '\r\n'));
          exitCode = result.exitCode;
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

      // Expand braces, arithmetic, command substitution, and environment variables
      let expanded = this.expandBraces(compound.command);
      expanded = this.expandArithmetic(expanded);
      expanded = await this.expandCommandSubstitution(expanded, stderrWriter);
      expanded = this.expandVars(expanded);

      // Parse pipeline
      const pipeline = this.parsePipeline(expanded);

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

      for (let i = 0; i < pipeline.length; i++) {
        const segment = pipeline[i];

        // Check if this pipeline segment is a control structure (e.g. `echo foo | while ...`)
        if (this.isControlStructure(segment.trim())) {
          const pipeStdin = i > 0 ? lastOutput : '';
          exitCode = await this.execControlStructurePiped(segment.trim(), pipeStdin, writeStdout, stderrWriter);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        const { args, redirects, hereString } = this.parseSegment(segment);

        if (args.length === 0) continue;

        // Expand glob patterns in args (but not quoted ones marked with \x01)
        let expandedArgs = await this.expandGlobs(args);

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
            const shellCmd = cmdArgs.slice(cIdx + 1).join(' ');
            exitCode = await this.execute(shellCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          } else {
            // /bin/sh script.sh or /bin/sh (no args)
            const scripts = cmdArgs.filter(a => !a.startsWith('-'));
            if (scripts.length > 0) {
              const scriptPath = this.fs.resolvePath(scripts[0], this.cwd);
              try {
                const content = await this.fs.readFile(scriptPath, 'utf8') as string;
                const shCtx: CommandContext = { args: scripts.slice(1), fs: this.fs, cwd: this.cwd, env: this.env, stdin: '', stdout: '', stderr: '', shell: this, terminal: terminalOverride || this.terminal };
                exitCode = await this.executeShellScript(content, scripts.slice(1), shCtx, writeStdout, stderrWriter);
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
            const envCmd = cmdArgs.join(' ');
            exitCode = await this.execute(envCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          } else {
            // bare env → print environment
            exitCode = await this.execute('env', writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Alias expansion: if cmdName matches an alias, replace it
        if (this.aliases.has(cmdName)) {
          const aliasValue = this.aliases.get(cmdName)!;
          const fullCmd = aliasValue + (cmdArgs.length > 0 ? ' ' + cmdArgs.join(' ') : '');
          exitCode = await this.execute(fullCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
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

          // Regular variable assignment: FOO=bar
          this.env[key] = val;
          if (key === 'PWD') this.cwd = val;
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

        // Shell builtins: eval, setopt, shopt
        if (effectiveCmdName === 'eval') {
          // Execute remaining args as a shell command
          const evalCmd = cmdArgs.join(' ');
          if (evalCmd) {
            exitCode = await this.execute(evalCmd, writeStdout, stderrWriter);
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }
        if (effectiveCmdName === 'setopt' || effectiveCmdName === 'shopt') {
          // zsh/bash shell options — no-op in Shiro
          continue;
        }
        if (effectiveCmdName === 'declare' || effectiveCmdName === 'typeset' || effectiveCmdName === 'local') {
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
          // Basic declare/typeset/local support
          const isLocal = effectiveCmdName === 'local';
          for (const arg of cmdArgs) {
            if (arg === '-x' || arg === '-r' || arg === '-i' || arg === '-f' || arg === '-p') continue;
            if (arg.startsWith('-')) continue; // skip other flags
            const eqIdx = arg.indexOf('=');
            const varName = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
            // Save old value in local var frame if inside a function
            if (isLocal && this.localVarStack.length > 0) {
              const frame = this.localVarStack[this.localVarStack.length - 1];
              if (!frame.has(varName)) {
                frame.set(varName, varName in this.env ? this.env[varName] : undefined);
              }
            }
            if (eqIdx >= 0) {
              this.env[varName] = arg.slice(eqIdx + 1);
            } else {
              if (!(varName in this.env)) this.env[varName] = '';
            }
          }
          continue;
        }

        // Shell builtin: read
        if (effectiveCmdName === 'read') {
          // Parse flags: -r (raw), -a (array), -p (prompt), -d (delimiter), -n (nchars), -s (silent)
          let rawMode = false;
          let arrayMode = false;
          let readDelim = '\n';
          let readNchars = -1;
          const readVars: string[] = [];
          for (let ri = 0; ri < cmdArgs.length; ri++) {
            const a = cmdArgs[ri];
            if (a === '-r') rawMode = true;
            else if (a === '-a') arrayMode = true;
            else if (a === '-s') { /* silent - no-op in non-interactive */ }
            else if (a === '-p' && ri + 1 < cmdArgs.length) { ri++; /* skip prompt text */ }
            else if (a === '-d' && ri + 1 < cmdArgs.length) { readDelim = cmdArgs[++ri]; }
            else if (a === '-n' && ri + 1 < cmdArgs.length) { readNchars = parseInt(cmdArgs[++ri], 10) || -1; }
            else if (a.startsWith('-n') && a.length > 2) { readNchars = parseInt(a.slice(2), 10) || -1; }
            else if (a.startsWith('-d') && a.length > 2) { readDelim = a.slice(2); }
            else if (!a.startsWith('-')) readVars.push(a);
          }
          // Read one line from stdin — prefer piped stdin (__PIPE_STDIN), then pipe, then heredoc
          let readInput = '';
          const hasPipeStdin = '__PIPE_STDIN' in this.env;
          if (hasPipeStdin) {
            readInput = this.env['__PIPE_STDIN'];
          } else {
            readInput = i > 0 ? lastOutput : (heredocStdin || '');
          }
          let readLine: string;
          let remaining: string;
          if (readNchars > 0) {
            readLine = readInput.slice(0, readNchars);
            remaining = readInput.slice(readNchars);
          } else {
            const delimIdx = readInput.indexOf(readDelim);
            if (delimIdx >= 0) {
              readLine = readInput.slice(0, delimIdx);
              remaining = readInput.slice(delimIdx + readDelim.length);
            } else {
              readLine = readInput;
              remaining = '';
            }
          }
          // Consume the line from __PIPE_STDIN so next read gets the next line
          if (hasPipeStdin) {
            this.env['__PIPE_STDIN'] = remaining;
          }
          const processed = rawMode ? readLine : readLine.replace(/\\(.)/g, '$1');
          if (arrayMode) {
            const arrName = readVars[0] || 'MAPFILE';
            const words = processed.split(/\s+/).filter(Boolean);
            this.arrays.set(arrName, words);
            exitCode = readLine.length > 0 ? 0 : 1;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            lastOutput = '';
            continue;
          }
          if (readVars.length === 0) {
            this.env['REPLY'] = processed;
          } else if (readVars.length === 1) {
            this.env[readVars[0]] = processed;
          } else {
            // Split into words, last var gets the remainder
            const words = processed.split(/\s+/);
            for (let vi = 0; vi < readVars.length; vi++) {
              if (vi === readVars.length - 1) {
                this.env[readVars[vi]] = words.slice(vi).join(' ');
              } else {
                this.env[readVars[vi]] = words[vi] || '';
              }
            }
          }
          exitCode = readLine.length > 0 ? 0 : 1;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: mapfile / readarray
        if (effectiveCmdName === 'mapfile' || effectiveCmdName === 'readarray') {
          const arrName = cmdArgs.find(a => !a.startsWith('-')) || 'MAPFILE';
          let mapInput = '';
          const hasPipeStdin = '__PIPE_STDIN' in this.env;
          if (hasPipeStdin) {
            mapInput = this.env['__PIPE_STDIN'];
            delete this.env['__PIPE_STDIN'];
          } else {
            mapInput = i > 0 ? lastOutput : (heredocStdin || '');
          }
          const lines = mapInput.split('\n');
          // Remove trailing empty line from trailing newline
          if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
          // By default, mapfile preserves trailing newlines on each element
          // -t flag strips them (we strip by default like bash's common usage)
          const stripNewlines = cmdArgs.includes('-t') || true;
          this.arrays.set(arrName, stripNewlines ? lines : lines.map(l => l + '\n'));
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

        // Shell builtin: return (throw sentinel caught by execFunction)
        if (effectiveCmdName === 'return') {
          const code = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) || 0 : this.lastExitCode;
          throw new ReturnSignal(code);
        }

        // Shell builtin: trap
        if (effectiveCmdName === 'trap') {
          if (cmdArgs.length === 0) {
            // List all traps
            for (const [sig, cmd] of this.traps) {
              writeStdout(`trap -- '${cmd}' ${sig}\r\n`);
            }
            exitCode = 0;
            this.lastExitCode = 0;
            this.env['?'] = '0';
            lastOutput = '';
            continue;
          }
          if (cmdArgs.length === 1) {
            // trap SIGNAL — reset trap
            const sig = cmdArgs[0].toUpperCase();
            this.traps.delete(sig);
          } else {
            // trap 'command' SIGNAL [SIGNAL...]
            const cmd = cmdArgs[0];
            for (let si = 1; si < cmdArgs.length; si++) {
              const sig = cmdArgs[si].toUpperCase();
              if (cmd === '' || cmd === '-') {
                this.traps.delete(sig); // reset to default
              } else {
                this.traps.set(sig, cmd);
              }
            }
          }
          exitCode = 0;
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }

        // Shell builtins: type, command -v, hash
        if (effectiveCmdName === 'type') {
          for (const name of cmdArgs) {
            if (name in this.functions) {
              writeStdout(`${name} is a function\r\n`);
            } else if (['cd', 'echo', 'read', 'eval', 'set', 'export', 'source', 'shift',
                         'declare', 'local', 'typeset', 'true', 'false', 'break', 'continue',
                         'return', 'trap', 'getopts', 'printf', 'type', 'command', 'hash',
                         'mapfile', 'readarray', 'select', 'alias', 'unalias', 'pushd', 'popd',
                         'dirs', 'let', 'exec', 'builtin', 'ulimit', 'umask',
                         'complete', 'compgen', 'enable', 'disown'].includes(name)) {
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
        if (effectiveCmdName === 'command') {
          if (cmdArgs[0] === '-v') {
            // command -v: like which
            for (const name of cmdArgs.slice(1)) {
              if (name in this.functions || this.commands.get(name) ||
                  ['cd', 'echo', 'read', 'eval', 'set', 'export', 'source', 'shift',
                   'true', 'false', 'break', 'continue', 'return', 'trap', 'printf',
                   'type', 'command', 'hash', 'mapfile', 'readarray', 'alias', 'unalias',
                   'pushd', 'popd', 'dirs', 'let', 'exec', 'builtin', 'ulimit', 'umask',
                   'complete', 'compgen', 'enable', 'disown'].includes(name)) {
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
        if (effectiveCmdName === 'hash') {
          // hash -r: clear hash table (no-op, we don't cache)
          writeStdout('hash: hash table empty\r\n');
          exitCode = 0;
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }

        // Shell builtin: printf FORMAT [ARGS...]
        if (effectiveCmdName === 'printf') {
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
            const fmt = printfCmdArgs[0];
            const fmtArgs = printfCmdArgs.slice(1);
            let argIdx = 0;
            let result = '';
            let fi = 0;
            while (fi < fmt.length) {
              if (fmt[fi] === '\\') {
                // Escape sequences
                fi++;
                if (fi >= fmt.length) { result += '\\'; break; }
                switch (fmt[fi]) {
                  case 'n': result += '\n'; break;
                  case 't': result += '\t'; break;
                  case 'r': result += '\r'; break;
                  case '\\': result += '\\'; break;
                  case '"': result += '"'; break;
                  case "'": result += "'"; break;
                  case '0': {
                    // Octal
                    let oct = '';
                    fi++;
                    while (fi < fmt.length && /[0-7]/.test(fmt[fi]) && oct.length < 3) { oct += fmt[fi]; fi++; }
                    result += String.fromCharCode(parseInt(oct || '0', 8));
                    fi--;
                    break;
                  }
                  default: result += '\\' + fmt[fi];
                }
                fi++;
                continue;
              }
              if (fmt[fi] === '%') {
                fi++;
                if (fi >= fmt.length) { result += '%'; break; }
                if (fmt[fi] === '%') { result += '%'; fi++; continue; }
                // Parse flags, width, precision
                let flags = '';
                while (fi < fmt.length && '-+ 0#'.includes(fmt[fi])) { flags += fmt[fi]; fi++; }
                let width = '';
                while (fi < fmt.length && /\d/.test(fmt[fi])) { width += fmt[fi]; fi++; }
                let precision = '';
                if (fi < fmt.length && fmt[fi] === '.') {
                  fi++;
                  while (fi < fmt.length && /\d/.test(fmt[fi])) { precision += fmt[fi]; fi++; }
                }
                const spec = fi < fmt.length ? fmt[fi] : '';
                fi++;
                const arg = argIdx < fmtArgs.length ? fmtArgs[argIdx++] : '';
                let formatted = '';
                switch (spec) {
                  case 's': formatted = arg; break;
                  case 'd': case 'i': formatted = String(parseInt(arg) || 0); break;
                  case 'f': {
                    const num = parseFloat(arg) || 0;
                    formatted = precision ? num.toFixed(parseInt(precision)) : num.toFixed(6);
                    break;
                  }
                  case 'x': formatted = (parseInt(arg) || 0).toString(16); break;
                  case 'X': formatted = (parseInt(arg) || 0).toString(16).toUpperCase(); break;
                  case 'o': formatted = (parseInt(arg) || 0).toString(8); break;
                  case 'c': formatted = arg ? arg[0] : ''; break;
                  default: formatted = '%' + spec;
                }
                // Apply width
                if (width) {
                  const w = parseInt(width);
                  if (flags.includes('-')) formatted = formatted.padEnd(w);
                  else if (flags.includes('0') && /[dioxXf]/.test(spec)) formatted = formatted.padStart(w, '0');
                  else formatted = formatted.padStart(w);
                }
                result += formatted;
                continue;
              }
              result += fmt[fi];
              fi++;
            }
            if (printfVarName) {
              this.env[printfVarName] = result;
            } else {
              writeStdout(result.replace(/\n/g, '\r\n'));
            }
            exitCode = 0;
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: getopts OPTSTRING VAR [args...]
        if (effectiveCmdName === 'getopts') {
          if (cmdArgs.length < 2) {
            stderrWriter('getopts: usage: getopts optstring name [arg ...]\r\n');
            exitCode = 1;
          } else {
            const optstring = cmdArgs[0];
            const varName = cmdArgs[1];
            // Use positional params if no extra args
            const args = cmdArgs.length > 2 ? cmdArgs.slice(2) : this.getPositionalArgs();
            const optind = parseInt(this.env['OPTIND'] || '1', 10);

            if (optind > args.length) {
              // No more arguments
              this.env[varName] = '?';
              exitCode = 1;
            } else {
              const arg = args[optind - 1];
              if (arg.startsWith('-') && arg.length > 1 && arg !== '--') {
                const opt = arg[1];
                const colonIdx = optstring.indexOf(opt);
                if (colonIdx < 0) {
                  // Unknown option
                  this.env[varName] = '?';
                  this.env['OPTARG'] = opt;
                  stderrWriter(`getopts: illegal option -- ${opt}\r\n`);
                  this.env['OPTIND'] = String(optind + 1);
                  exitCode = 0;
                } else if (optstring[colonIdx + 1] === ':') {
                  // Option requires argument
                  if (arg.length > 2) {
                    // Argument attached: -fvalue
                    this.env[varName] = opt;
                    this.env['OPTARG'] = arg.slice(2);
                    this.env['OPTIND'] = String(optind + 1);
                  } else if (optind < args.length) {
                    // Next argument is the value
                    this.env[varName] = opt;
                    this.env['OPTARG'] = args[optind];
                    this.env['OPTIND'] = String(optind + 2);
                  } else {
                    // Missing argument
                    this.env[varName] = '?';
                    stderrWriter(`getopts: option requires an argument -- ${opt}\r\n`);
                    this.env['OPTIND'] = String(optind + 1);
                  }
                  exitCode = 0;
                } else {
                  // Boolean option
                  this.env[varName] = opt;
                  delete this.env['OPTARG'];
                  // Handle bundled options: -abc
                  if (arg.length > 2) {
                    // Rewrite arg to remaining options for next call
                    args[optind - 1] = '-' + arg.slice(2);
                  } else {
                    this.env['OPTIND'] = String(optind + 1);
                  }
                  exitCode = 0;
                }
              } else {
                // Non-option argument or --
                this.env[varName] = '?';
                if (arg === '--') this.env['OPTIND'] = String(optind + 1);
                exitCode = 1;
              }
            }
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: alias / unalias
        if (effectiveCmdName === 'alias') {
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
        if (effectiveCmdName === 'unalias') {
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
        if (effectiveCmdName === 'pushd') {
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
        if (effectiveCmdName === 'popd') {
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
        if (effectiveCmdName === 'dirs') {
          const stack = [this.cwd, ...this.dirStack.slice().reverse()];
          writeStdout(stack.join(' ') + '\r\n');
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }

        // Shell builtin: let "expr" — evaluate arithmetic, return 1 if result is 0
        if (effectiveCmdName === 'let') {
          if (cmdArgs.length === 0) {
            stderrWriter('let: usage: let expression\r\n');
            exitCode = 1;
          } else {
            let result = 0;
            for (const expr of cmdArgs) {
              result = this.evalArithmetic(expr);
            }
            exitCode = result === 0 ? 1 : 0;
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: shift — shift positional parameters
        if (effectiveCmdName === 'shift') {
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

        // Shell builtin: set -- args (positional parameter assignment)
        if (effectiveCmdName === 'set') {
          // Check for -- to set positional parameters
          const ddIdx = cmdArgs.indexOf('--');
          if (ddIdx >= 0) {
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
                  const allOpts = ['errexit', 'nounset', 'xtrace', 'verbose', 'noexec', 'pipefail'];
                  for (const opt of allOpts) {
                    writeStdout(`${opt}\t\t${this.options.has(opt) ? 'on' : 'off'}\r\n`);
                  }
                } else {
                  const optMap: Record<string, string> = { errexit: 'errexit', nounset: 'nounset', xtrace: 'xtrace', verbose: 'verbose', noexec: 'noexec', pipefail: 'pipefail' };
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
              const shortMap: Record<string, string> = { e: 'errexit', u: 'nounset', x: 'xtrace', v: 'verbose', n: 'noexec' };
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
        if (effectiveCmdName === 'source') {
          if (cmdArgs.length === 0) {
            stderrWriter('source: filename argument required\r\n');
            exitCode = 1;
          } else {
            const scriptPath = this.fs.resolvePath(cmdArgs[0], this.cwd);
            try {
              const raw = await this.fs.readFile(scriptPath);
              const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
              exitCode = await this.execute(content, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
            } catch (e: any) {
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
        if (effectiveCmdName === 'exec') {
          if (cmdArgs.length > 0) {
            const execCmd = cmdArgs.join(' ');
            exitCode = await this.execute(execCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
          }
          // exec with no args can be used for fd redirects only (handled by redirect processing)
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell builtin: builtin — run builtin ignoring functions
        if (effectiveCmdName === 'builtin') {
          if (cmdArgs.length > 0) {
            const builtinCmd = cmdArgs.join(' ');
            // Temporarily remove function override
            const savedFn = this.functions[cmdArgs[0]];
            delete this.functions[cmdArgs[0]];
            exitCode = await this.execute(builtinCmd, writeStdout, stderrWriter, false, terminalOverride || this.terminal, true);
            if (savedFn) this.functions[cmdArgs[0]] = savedFn;
          }
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        // Shell stubs for commonly expected builtins (no-ops that scripts depend on)
        if (effectiveCmdName === 'ulimit') {
          // ulimit -n → file descriptor limit, etc.
          if (cmdArgs.includes('-n')) { writeStdout('1024\r\n'); }
          else if (cmdArgs.includes('-s')) { writeStdout('8192\r\n'); }
          else if (cmdArgs.length === 0 || cmdArgs.includes('-f')) { writeStdout('unlimited\r\n'); }
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }
        if (effectiveCmdName === 'umask') {
          if (cmdArgs.length === 0) {
            writeStdout('0022\r\n');
          }
          this.lastExitCode = 0;
          this.env['?'] = '0';
          lastOutput = '';
          continue;
        }
        if (effectiveCmdName === 'complete' || effectiveCmdName === 'compgen' ||
            effectiveCmdName === 'compopt' || effectiveCmdName === 'enable' ||
            effectiveCmdName === 'disown') {
          // Bash completion and job management stubs — silent no-op
          this.lastExitCode = 0;
          this.env['?'] = '0';
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
            const targetPath = this.fs.resolvePath(redir.target, this.cwd);
            try {
              stdin = await this.fs.readFile(targetPath, 'utf8') as string;
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
        };

        // Check shell functions first
        if (this.functions[effectiveCmdName]) {
          exitCode = await this.execFunction(effectiveCmdName, cmdArgs, writeStdout, stderrWriter);
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          lastOutput = '';
          continue;
        }

        const cmd = this.commands.get(effectiveCmdName);
        if (cmd) {
          try {
            exitCode = await cmd.exec(ctx);
          } catch (e: any) {
            ctx.stderr += e.message + '\n';
            exitCode = 1;
          }
        } else {
          // Try to find executable in PATH
          const executable = await this.findExecutableInPath(effectiveCmdName);
          if (executable) {
            try {
              exitCode = await this.executeScript(executable, cmdArgs, ctx, writeStdout, stderrWriter);
            } catch (e: any) {
              ctx.stderr += e.message + '\n';
              exitCode = 1;
            }
          } else {
            // Check if a WASM package is available for this command
            const wasmPkg = isAvailableAsPackage(effectiveCmdName);
            if (wasmPkg) {
              try {
                stderrWriter(`shiro: '${effectiveCmdName}' not installed. Installing ${wasmPkg.name}...\r\n`);
                const wasmModule = await getCompiledModule(wasmPkg.name, (msg) => {
                  stderrWriter(`  ${msg}\r\n`);
                });
                const { WasiRT, WasiExit } = await loadWasiRuntime();
                const config = {
                  fs: this.fs,
                  cwd: this.cwd,
                  args: [wasmPkg.name, ...cmdArgs],
                  env: { ...this.env },
                  stdin: ctx.stdin || '',
                  onStdout: (text: string) => { ctx.stdout += text; },
                  onStderr: (text: string) => { ctx.stderr += text; },
                  preopens: { '/': '/', '.': this.cwd },
                };
                const wasi = new WasiRT(config);
                await wasi.preloadTree(this.cwd, 3, 100);
                exitCode = await wasi.run(wasmModule);
                // Write PATH stubs so future runs skip auto-install
                await this.writeWasiPkgStubs(wasmPkg.name, wasmPkg.aliases);
              } catch (e: any) {
                const { WasiExit } = await loadWasiRuntime();
                if (e instanceof WasiExit) {
                  exitCode = e.code;
                  // Still write stubs on non-zero exit — package is installed
                  await this.writeWasiPkgStubs(wasmPkg.name, wasmPkg.aliases);
                } else {
                  stderrWriter(`shiro: failed to run ${wasmPkg.name}: ${e.message}\r\n`);
                  exitCode = 1;
                }
              }
            } else {
              stderrWriter(`shiro: command not found: ${effectiveCmdName}\r\n`);
              exitCode = 127;
              this.lastExitCode = exitCode;
              this.env['?'] = String(exitCode);
              break;
            }
          }
        }

        // Check if stderr should be redirected to stdout (2>&1)
        const redirectStderrToStdout = redirects.some(r => r.type === '2>&1');

        // Handle stderr output and redirects
        let stderrOutput = ctx.stderr;
        for (const redir of redirects) {
          if (redir.type === '2>' || redir.type === '2>>') {
            if (redir.target === '/dev/null') {
              stderrOutput = '';
              continue;
            }
            // 2>/dev/stderr → default behavior (let it through)
            if (redir.target === '/dev/stderr') continue;
            // 2>/dev/stdout → redirect stderr to stdout
            if (redir.target === '/dev/stdout') {
              ctx.stdout += stderrOutput;
              stderrOutput = '';
              continue;
            }
            const targetPath = this.fs.resolvePath(redir.target, this.cwd);
            if (redir.type === '2>') {
              await this.fs.writeFile(targetPath, stderrOutput);
            } else {
              await this.fs.appendFile(targetPath, stderrOutput);
            }
            stderrOutput = '';
          }
        }

        // Handle stdout redirects
        let output = ctx.stdout;

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
            // /dev/stdout → write to stdout (default behavior, just let it through)
            if (redir.target === '/dev/stdout') continue;
            // /dev/stderr → redirect stdout content to stderr
            if (redir.target === '/dev/stderr') {
              stderrWriter(output.replace(/\n/g, '\r\n'));
              output = '';
              continue;
            }
            const targetPath = this.fs.resolvePath(redir.target, this.cwd);
            if (redir.type === '>') {
              await this.fs.writeFile(targetPath, output);
            } else {
              await this.fs.appendFile(targetPath, output);
            }
            output = '';
          }
        }

        if (i === pipeline.length - 1 && output) {
          writeStdout(output.replace(/\n/g, '\r\n'));
        }

        lastOutput = output;
        pipeExitCodes.push(exitCode);

        // Update cwd from env
        this.cwd = this.env['PWD'] || this.cwd;
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

      // Fire ERR trap on non-zero exit code
      if (exitCode !== 0 && this.traps.has('ERR')) {
        const errCmd = this.traps.get('ERR')!;
        await this.execute(errCmd, writeStdout, stderrWriter);
      }

      // errexit: abort on non-zero exit from commands NOT in && / || chains
      if (this.options.has('errexit') && exitCode !== 0 && !negateExit) {
        // Don't abort if this command is part of a && or || chain
        const compIdx = compounds.indexOf(compound);
        const thisOp = compound.operator;
        const nextOp = compIdx + 1 < compounds.length ? compounds[compIdx + 1].operator : '';
        const inChain = thisOp === '&&' || thisOp === '||' || nextOp === '&&' || nextOp === '||';
        if (!inChain) break;
      }
    }

    return exitCode;
  }

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

    // Tokenize respecting quotes, then expand each token
    const tokens = this.tokenize(input);
    const expanded: string[] = [];
    for (const tok of tokens) {
      expanded.push(...this.expandBraceToken(tok));
    }
    // Reconstruct: join with spaces, but preserve redirect tokens
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

  private expandVars(line: string): string {
    // Walk through the string character by character, respecting quote context.
    // In single quotes: no expansion at all (bash behavior).
    // In double quotes: expand $VAR and ${VAR} but NOT ~ or $?.
    // Unquoted: expand everything.
    let result = '';
    let inSingle = false;
    let inDouble = false;
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
        const val = this.env['@'] ?? '';
        if (val === '' && inDouble) {
          // Remove the opening quote already appended
          if (result.endsWith('"')) result = result.slice(0, -1);
          i += 2;
          // Consume the closing quote
          if (i < line.length && line[i] === '"') { inDouble = false; i++; }
        } else {
          result += val;
          i += 2;
        }
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
        result += this.env[line[i + 1]] ?? '';
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
          const expanded = this.expandParamExpression(inner);
          if (expanded !== null) {
            result += expanded;
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
          if (varName === 'LINENO') { result += '1'; i += m[0].length; continue; }
          if (varName === 'SECONDS') { result += String(Math.floor(performance.now() / 1000)); i += m[0].length; continue; }
          // Resolve namerefs: if varName is a nameref, follow it
          const resolved = this.namerefs.has(varName) ? this.namerefs.get(varName)! : varName;
          result += this.env[resolved] ?? '';
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
        if ((i === 0 || /[\s=]/.test(before)) && isAssignContext && (/[\/\s;|&>]/.test(after) || i + 1 >= line.length)) {
          const home = this.env['HOME'] || '/home/user';
          result += home;
          i++;
          continue;
        }
      }

      result += ch;
      i++;
    }
    return result;
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
    const arrSliceMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]:\s*(-?\d+)(?::(-?\d+))?$/);
    if (arrSliceMatch) {
      const name = arrSliceMatch[1];
      const assoc = this.assocArrays.get(name);
      const values = assoc ? Array.from(assoc.values()) : (this.arrays.get(name) ?? []);
      let offset = parseInt(arrSliceMatch[2]);
      if (offset < 0) offset = Math.max(0, values.length + offset);
      if (arrSliceMatch[3] !== undefined) {
        const len = parseInt(arrSliceMatch[3]);
        return values.slice(offset, offset + len).join(' ');
      }
      return values.slice(offset).join(' ');
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
      // Indexed array
      const arr = this.arrays.get(name);
      const idx = parseInt(key, 10);
      if (arr && !isNaN(idx) && idx >= 0 && idx < arr.length) return arr[idx];
      return '';
    }

    // ${#VAR} — string length
    const lenMatch = inner.match(/^#([A-Za-z_][A-Za-z0-9_]*)$/);
    if (lenMatch) {
      return String((this.env[lenMatch[1]] ?? '').length);
    }

    // ${!VAR} — indirect expansion (value of variable named by VAR's value)
    const indirectMatch = inner.match(/^!([A-Za-z_][A-Za-z0-9_]*)$/);
    if (indirectMatch) {
      const ref = this.env[indirectMatch[1]] ?? '';
      return this.env[ref] ?? '';
    }

    // ${VAR^^} — uppercase all
    const ucMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\^\^$/);
    if (ucMatch) return (this.env[ucMatch[1]] ?? '').toUpperCase();

    // ${VAR^} — capitalize first character
    const ucFirstMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\^$/);
    if (ucFirstMatch) {
      const val = this.env[ucFirstMatch[1]] ?? '';
      return val.length > 0 ? val[0].toUpperCase() + val.slice(1) : '';
    }

    // ${VAR,,} — lowercase all
    const lcMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*),,$/);
    if (lcMatch) return (this.env[lcMatch[1]] ?? '').toLowerCase();

    // ${VAR,} — lowercase first character
    const lcFirstMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*),$/);
    if (lcFirstMatch) {
      const val = this.env[lcFirstMatch[1]] ?? '';
      return val.length > 0 ? val[0].toLowerCase() + val.slice(1) : '';
    }

    // ${VAR:offset} and ${VAR:offset:length} — substring
    const subMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*):(-?\d+)(?::(-?\d+))?$/);
    if (subMatch) {
      const val = this.env[subMatch[1]] ?? '';
      let offset = parseInt(subMatch[2]);
      if (offset < 0) offset = Math.max(0, val.length + offset);
      if (subMatch[3] !== undefined) {
        const len = parseInt(subMatch[3]);
        return len < 0 ? val.slice(offset, Math.max(0, val.length + len)) : val.slice(offset, offset + len);
      }
      return val.slice(offset);
    }

    // ${VAR//pattern/replacement} — replace all
    const repAllMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\/\/((?:[^/]|\\\/)*)\/([\s\S]*)$/);
    if (repAllMatch) {
      const val = this.env[repAllMatch[1]] ?? '';
      const pat = repAllMatch[2].replace(/\\\//g, '/');
      const rep = this.expandVars(repAllMatch[3]);
      const re = new RegExp(this.globToRegex(pat), 'g');
      return val.replace(re, rep);
    }

    // ${VAR/pattern/replacement} — replace first
    const repMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\/((?:[^/]|\\\/)*)\/([\s\S]*)$/);
    if (repMatch) {
      const val = this.env[repMatch[1]] ?? '';
      const pat = repMatch[2].replace(/\\\//g, '/');
      const rep = this.expandVars(repMatch[3]);
      const re = new RegExp(this.globToRegex(pat));
      return val.replace(re, rep);
    }

    // ${VAR##pattern} — remove longest prefix
    const rmPrefLong = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)##(.+)$/);
    if (rmPrefLong) {
      const val = this.env[rmPrefLong[1]] ?? '';
      const reStr = this.globToRegex(rmPrefLong[2]);
      // Greedy: find longest prefix matching the pattern
      for (let len = val.length; len >= 0; len--) {
        const prefix = val.slice(0, len);
        if (new RegExp('^' + reStr + '$').test(prefix)) return val.slice(len);
      }
      return val;
    }

    // ${VAR#pattern} — remove shortest prefix
    const rmPrefShort = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)#(.+)$/);
    if (rmPrefShort) {
      const val = this.env[rmPrefShort[1]] ?? '';
      const reStr = this.globToRegex(rmPrefShort[2]);
      for (let len = 0; len <= val.length; len++) {
        const prefix = val.slice(0, len);
        if (new RegExp('^' + reStr + '$').test(prefix)) return val.slice(len);
      }
      return val;
    }

    // ${VAR%%pattern} — remove longest suffix
    const rmSufLong = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)%%(.+)$/);
    if (rmSufLong) {
      const val = this.env[rmSufLong[1]] ?? '';
      const reStr = this.globToRegex(rmSufLong[2]);
      for (let start = 0; start <= val.length; start++) {
        const suffix = val.slice(start);
        if (new RegExp('^' + reStr + '$').test(suffix)) return val.slice(0, start);
      }
      return val;
    }

    // ${VAR%pattern} — remove shortest suffix
    const rmSufShort = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)%(.+)$/);
    if (rmSufShort) {
      const val = this.env[rmSufShort[1]] ?? '';
      const reStr = this.globToRegex(rmSufShort[2]);
      for (let start = val.length; start >= 0; start--) {
        const suffix = val.slice(start);
        if (new RegExp('^' + reStr + '$').test(suffix)) return val.slice(0, start);
      }
      return val;
    }

    // ${VAR:-default}, ${VAR:=default}, ${VAR:+alt}, ${VAR:?err}
    const opMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)(:?)([-=+?])(.*)$/s);
    if (opMatch) {
      const [, varName, colon, op, operand] = opMatch;
      const val = this.env[varName];
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

    // Simple ${VAR}
    const simpleMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
    if (simpleMatch) {
      return this.env[simpleMatch[1]] ?? '';
    }

    return null; // not recognized
  }

  /** Convert a shell glob pattern to a regex string */
  private globToRegex(pattern: string): string {
    return pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  }

  /** Split multi-line input into statements, keeping heredoc blocks and quoted strings intact. */
  private splitStatements(input: string): string[] {
    const lines = input.split(/\r?\n/);
    if (lines.length <= 1) return [input];

    const statements: string[] = [];
    let i = 0;
    let accumulator = '';
    let quoteChar: string | null = null; // track open quote across lines

    while (i < lines.length) {
      const line = lines[i];

      // If we're inside an open quote from a previous line, accumulate
      if (quoteChar) {
        accumulator += '\n' + line;
        // Check if this line closes the quote
        if (this.lineClosesQuote(line, quoteChar)) {
          quoteChar = null;
          // Check if MORE quotes open after the close on this line
          const afterClose = this.unclosedQuote(accumulator);
          if (afterClose) quoteChar = afterClose;
        }
        if (!quoteChar) {
          statements.push(accumulator);
          accumulator = '';
        }
        i++;
        continue;
      }

      // Check if this line starts a heredoc
      const heredocMatch = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|(\S+))/);
      if (heredocMatch) {
        const delimiter = heredocMatch[1] || heredocMatch[2] || heredocMatch[3];
        let block = line;
        i++;
        while (i < lines.length) {
          block += '\n' + lines[i];
          if (lines[i].trim() === delimiter) break;
          i++;
        }
        statements.push(block);
        i++;
        continue;
      }

      // Check if this line has an unclosed quote
      const openQuote = this.unclosedQuote(line);
      if (openQuote) {
        accumulator = line;
        quoteChar = openQuote;
        i++;
        continue;
      }

      statements.push(line);
      i++;
    }

    // Flush any remaining accumulated content
    if (accumulator) statements.push(accumulator);

    return statements;
  }

  /** Check if a line has an unclosed quote. Returns the quote char or null. */
  private unclosedQuote(line: string): string | null {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\' && inDouble) { i++; continue; }
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
    }
    if (inSingle) return "'";
    if (inDouble) return '"';
    return null;
  }

  /** Check if a line closes a specific quote character. */
  private lineClosesQuote(line: string, quote: string): boolean {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\' && quote === '"') { i++; continue; }
      if (ch === quote) return true;
    }
    return false;
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
      body = this.expandVars(body);
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

      if (!inSingle && !inDouble) {
        // Track subshell parenthesized groups: ( ... )
        // Only count '(' at operator positions (after whitespace/;/start), not after $ or word chars
        const prevCh = i > 0 ? line[i - 1] : ' ';
        if (ch === '(' && !/\w/.test(prevCh) && prevCh !== '$') {
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

        // Track control structure keywords to avoid splitting inside them
        // Only match at word boundary: beginning of string or after whitespace/;
        if (/[\s;]/.test(prevCh) || i === 0) {
          const rest = line.slice(i);
          const wordMatch = rest.match(/^(for|while|until|select|if|case|do|then|done|fi|esac)\b/);
          if (wordMatch) {
            const word = wordMatch[1];
            if (word === 'for' || word === 'while' || word === 'until' || word === 'select' || word === 'if' || word === 'case') depth++;
            else if (word === 'done' || word === 'fi' || word === 'esac') depth--;
          }
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

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
      // Single | but not || and not >| (clobber redirect)
      if (ch === '|' && line[i + 1] !== '|' && line[i - 1] !== '>' && !inSingle && !inDouble) {
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
      if (tokens[i] === '2>&1') {
        redirects.push({ type: '2>&1', target: '' });
      } else if (tokens[i] === '<<<' && i + 1 < tokens.length) {
        // Here-string: <<< "string" — set as stdin
        hereString = tokens[i + 1].replace(/\x01/g, '') + '\n';
        i++;
      } else if ((tokens[i] === '>' || tokens[i] === '>>' || tokens[i] === '<' || tokens[i] === '2>' || tokens[i] === '2>>') && i + 1 < tokens.length) {
        redirects.push({ type: tokens[i] as Redirect['type'], target: tokens[i + 1].replace(/\x01/g, '') });
        i++;
      } else {
        args.push(tokens[i]);
      }
    }

    return { args, redirects, hereString };
  }

  private tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
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

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        i++;
        continue;
      }

      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        i++;
        continue;
      }

      if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
        if (current) {
          tokens.push(current);
          current = '';
        }
        i++;
        continue;
      }

      // Mark glob chars inside quotes so they won't be expanded
      if ((inSingle || inDouble) && (ch === '*' || ch === '?' || ch === '[')) {
        current += '\x01' + ch;
        i++;
        continue;
      }

      // Handle 2>&1, 2>>, and 2> stderr redirects
      if (ch === '2' && !inSingle && !inDouble && (input[i + 1] === '>')) {
        if (current) { tokens.push(current); current = ''; }
        if (input[i + 2] === '&' && input[i + 3] === '1') {
          tokens.push('2>&1');
          i += 4;
        } else if (input[i + 2] === '>') {
          tokens.push('2>>');
          i += 3;
        } else {
          tokens.push('2>');
          i += 2;
        }
        continue;
      }

      // Handle >>, >| and > redirects (>| is zsh clobber, treated as >)
      if (ch === '>' && !inSingle && !inDouble) {
        if (current) { tokens.push(current); current = ''; }
        if (input[i + 1] === '>') {
          tokens.push('>>');
          i += 2;
        } else if (input[i + 1] === '|') {
          tokens.push('>');
          i += 2;
        } else {
          tokens.push('>');
          i++;
        }
        continue;
      }

      // Handle <<< here-string, << heredoc (already handled elsewhere), < stdin redirect
      // But NOT <( which is process substitution
      if (ch === '<' && !inSingle && !inDouble) {
        if (input[i + 1] === '<' && input[i + 2] === '<') {
          if (current) { tokens.push(current); current = ''; }
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
          if (current) { tokens.push(current); current = ''; }
          tokens.push(procSub);
          i = j;
          continue;
        }
        if (current) { tokens.push(current); current = ''; }
        tokens.push('<');
        i++;
        continue;
      }

      current += ch;
      i++;
    }

    if (current) tokens.push(current);
    return tokens;
  }

  // ─── COMMAND SUBSTITUTION ─────────────────────────────────────────────────

  private async expandCommandSubstitution(input: string, stderrWriter: (s: string) => void): Promise<string> {
    const result: string[] = [];
    let i = 0;
    while (i < input.length) {
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
        const subResult = await this.exec(subCmd);
        if (subResult.stderr) stderrWriter(subResult.stderr);
        let subOut = subResult.stdout.replace(/[\r\n]+$/, '');
        // If $() appears as the RHS of a variable assignment (VAR=$(...)), wrap the
        // output in double-quotes so tokenize() preserves spaces. This matches bash
        // semantics: VAR=$(cmd) preserves spaces, bare $(cmd) word-splits.
        const preceding = result.join('');
        if (/[A-Za-z_][A-Za-z0-9_]*=$/.test(preceding)) {
          subOut = '"' + subOut.replace(/"/g, '\\"') + '"';
        }
        result.push(subOut);
        i = j;
      } else if (input[i] === '`') {
        let j = input.indexOf('`', i + 1);
        if (j === -1) { result.push(input.slice(i)); break; }
        const subCmd = input.slice(i + 1, j);
        const subResult = await this.exec(subCmd);
        if (subResult.stderr) stderrWriter(subResult.stderr);
        let subOut = subResult.stdout.replace(/[\r\n]+$/, '');
        const preceding = result.join('');
        if (/[A-Za-z_][A-Za-z0-9_]*=$/.test(preceding)) {
          subOut = '"' + subOut.replace(/"/g, '\\"') + '"';
        }
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
  private async expandGlobs(args: string[]): Promise<string[]> {
    const result: string[] = [];
    for (const arg of args) {
      // Check for sentinel-marked (quoted) glob chars
      const hasSentinel = arg.includes('\x01');
      // Check for real (unquoted) glob chars
      const hasGlob = !hasSentinel && /[*?[]/.test(arg);

      if (hasGlob) {
        try {
          const matches = await this.fs.glob(arg, this.cwd);
          if (matches.length > 0) {
            result.push(...matches);
          } else {
            // No matches: keep literal (bash behavior)
            result.push(arg);
          }
        } catch {
          result.push(arg);
        }
      } else {
        // Strip sentinel markers and keep literal
        result.push(arg.replace(/\x01/g, ''));
      }
    }
    return result;
  }

  // ─── ARITHMETIC EXPANSION ─────────────────────────────────────────────────

  private expandArithmetic(input: string): string {
    let result = '';
    let i = 0;
    while (i < input.length) {
      if (input[i] === '$' && input[i + 1] === '(' && input[i + 2] === '(') {
        let depth = 1;
        let j = i + 3;
        while (j < input.length - 1 && depth > 0) {
          if (input[j] === '(' && input[j + 1] === '(') { depth++; j += 2; continue; }
          if (input[j] === ')' && input[j + 1] === ')') { depth--; if (depth === 0) break; j += 2; continue; }
          j++;
        }
        const expr = input.slice(i + 3, j);
        result += String(this.evalArithmetic(expr));
        i = j + 2;
      } else {
        result += input[i];
        i++;
      }
    }
    return result;
  }

  private evalArithmetic(expr: string): number {
    const trimmed = expr.trim();

    // Handle comma-separated expressions: (( a=1, b=2 ))
    if (trimmed.includes(',')) {
      const parts = trimmed.split(',');
      let result = 0;
      for (const part of parts) result = this.evalArithmetic(part);
      return result;
    }

    // Handle assignment: var = expr, var += expr, var -= expr, var *= expr, var /= expr, var %= expr
    const assignMatch = trimmed.match(/^([A-Za-z_]\w*)\s*([-+*/%]?)=\s*(.+)$/);
    if (assignMatch && assignMatch[2] !== '=' && assignMatch[2] !== '!') {
      const [, varName, op, rhs] = assignMatch;
      const rhsVal = this.evalArithmetic(rhs);
      let result: number;
      if (op === '') {
        result = rhsVal;
      } else {
        const cur = parseInt(this.env[varName] || '0', 10);
        switch (op) {
          case '+': result = cur + rhsVal; break;
          case '-': result = cur - rhsVal; break;
          case '*': result = cur * rhsVal; break;
          case '/': result = rhsVal !== 0 ? Math.trunc(cur / rhsVal) : 0; break;
          case '%': result = rhsVal !== 0 ? cur % rhsVal : 0; break;
          default: result = rhsVal;
        }
      }
      this.env[varName] = String(result);
      return result;
    }

    // Handle post-increment/decrement: var++, var--
    const postMatch = trimmed.match(/^([A-Za-z_]\w*)\s*(\+\+|--)$/);
    if (postMatch) {
      const cur = parseInt(this.env[postMatch[1]] || '0', 10);
      this.env[postMatch[1]] = String(postMatch[2] === '++' ? cur + 1 : cur - 1);
      return cur; // return old value
    }

    // Handle pre-increment/decrement: ++var, --var
    const preMatch = trimmed.match(/^(\+\+|--)([A-Za-z_]\w*)$/);
    if (preMatch) {
      const newVal = parseInt(this.env[preMatch[2]] || '0', 10) + (preMatch[1] === '++' ? 1 : -1);
      this.env[preMatch[2]] = String(newVal);
      return newVal; // return new value
    }

    // Replace variable references (including positional params $1, $2, etc.)
    let expanded = trimmed.replace(/\$\{?([A-Za-z_]\w*|\d+)\}?/g, (_, name: string) => this.env[name] || '0');
    expanded = expanded.replace(/\b([A-Za-z_]\w*)\b/g, (match) => {
      if (/^\d+$/.test(match)) return match;
      return this.env[match] || '0';
    });
    try {
      return this.safeArithEval(expanded.trim());
    } catch {
      return 0;
    }
  }

  private safeArithEval(expr: string): number {
    type Token = { type: 'num' | 'op' | 'paren'; value: any };
    const tokens: Token[] = [];
    let i = 0;
    while (i < expr.length) {
      if (/\s/.test(expr[i])) { i++; continue; }
      if (/\d/.test(expr[i])) {
        let num = '';
        while (i < expr.length && /\d/.test(expr[i])) { num += expr[i]; i++; }
        tokens.push({ type: 'num', value: parseInt(num) });
        continue;
      }
      if (expr[i] === '-' && (tokens.length === 0 || tokens[tokens.length - 1].type === 'op' || tokens[tokens.length - 1].value === '(')) {
        let num = '-';
        i++;
        while (i < expr.length && /\d/.test(expr[i])) { num += expr[i]; i++; }
        tokens.push({ type: 'num', value: parseInt(num) });
        continue;
      }
      // Multi-char operators (check longest first)
      const ops2 = ['**', '<=', '>=', '==', '!=', '&&', '||', '<<', '>>'];
      let found = false;
      for (const op of ops2) {
        if (expr.slice(i, i + op.length) === op) { tokens.push({ type: 'op', value: op }); i += op.length; found = true; break; }
      }
      if (found) continue;
      // Single-char operators
      if ('+-*/%<>&|^~!?:'.includes(expr[i])) { tokens.push({ type: 'op', value: expr[i] }); i++; continue; }
      if (expr[i] === '(') { tokens.push({ type: 'paren', value: '(' }); i++; continue; }
      if (expr[i] === ')') { tokens.push({ type: 'paren', value: ')' }); i++; continue; }
      i++;
    }

    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    // Precedence (lowest to highest): ternary ?:, ||, &&, |, ^, &, ==/!=, </>/<=/>=, <>/<>>, +/-, */÷/%, **, unary !/~
    const parseAtom = (): number => {
      const t = peek();
      if (!t) return 0;
      if (t.type === 'num') { next(); return t.value; }
      if (t.value === '(') { next(); const v = parseTernary(); if (peek()?.value === ')') next(); return v; }
      // Unary operators: !, ~
      if (t.value === '!') { next(); return parseAtom() === 0 ? 1 : 0; }
      if (t.value === '~') { next(); return ~parseAtom(); }
      return 0;
    };
    const parsePow = (): number => {
      let left = parseAtom();
      while (peek()?.value === '**') { next(); left = Math.pow(left, parseAtom()); }
      return left;
    };
    const parseMul = (): number => {
      let left = parsePow();
      while (peek() && ['*', '/', '%'].includes(peek().value)) {
        const op = next().value;
        const right = parsePow();
        if (op === '*') left *= right;
        else if (op === '/') left = right === 0 ? 0 : Math.trunc(left / right);
        else left = right === 0 ? 0 : left % right;
      }
      return left;
    };
    const parseAdd = (): number => {
      let left = parseMul();
      while (peek() && ['+', '-'].includes(peek().value)) {
        const op = next().value;
        left = op === '+' ? left + parseMul() : left - parseMul();
      }
      return left;
    };
    const parseShift = (): number => {
      let left = parseAdd();
      while (peek() && ['<<', '>>'].includes(peek().value)) {
        const op = next().value;
        const right = parseAdd();
        left = op === '<<' ? left << right : left >> right;
      }
      return left;
    };
    const parseRel = (): number => {
      let left = parseShift();
      while (peek() && ['<', '>', '<=', '>='].includes(peek().value)) {
        const op = next().value;
        const right = parseShift();
        if (op === '<') left = left < right ? 1 : 0;
        else if (op === '>') left = left > right ? 1 : 0;
        else if (op === '<=') left = left <= right ? 1 : 0;
        else left = left >= right ? 1 : 0;
      }
      return left;
    };
    const parseEq = (): number => {
      let left = parseRel();
      while (peek() && ['==', '!='].includes(peek().value)) {
        const op = next().value;
        const right = parseRel();
        left = op === '==' ? (left === right ? 1 : 0) : (left !== right ? 1 : 0);
      }
      return left;
    };
    const parseBitAnd = (): number => {
      let left = parseEq();
      while (peek()?.value === '&') { next(); left = left & parseEq(); }
      return left;
    };
    const parseBitXor = (): number => {
      let left = parseBitAnd();
      while (peek()?.value === '^') { next(); left = left ^ parseBitAnd(); }
      return left;
    };
    const parseBitOr = (): number => {
      let left = parseBitXor();
      while (peek()?.value === '|') { next(); left = left | parseBitXor(); }
      return left;
    };
    const parseLogAnd = (): number => {
      let left = parseBitOr();
      while (peek()?.value === '&&') { next(); const right = parseBitOr(); left = (left !== 0 && right !== 0) ? 1 : 0; }
      return left;
    };
    const parseLogOr = (): number => {
      let left = parseLogAnd();
      while (peek()?.value === '||') { next(); const right = parseLogAnd(); left = (left !== 0 || right !== 0) ? 1 : 0; }
      return left;
    };
    const parseTernary = (): number => {
      const cond = parseLogOr();
      if (peek()?.value === '?') {
        next(); // consume ?
        const trueVal = parseTernary();
        if (peek()?.value === ':') next(); // consume :
        const falseVal = parseTernary();
        return cond !== 0 ? trueVal : falseVal;
      }
      return cond;
    };
    return parseTernary();
  }

  // ─── SHELL FUNCTIONS ──────────────────────────────────────────────────────

  private parseFunctionDef(input: string): { name: string; body: string } | null {
    let match = input.match(/^(\w+)\s*\(\)\s*\{([\s\S]*)\}$/);
    if (!match) match = input.match(/^function\s+(\w+)\s*(?:\(\))?\s*\{([\s\S]*)\}$/);
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
    const saved: Record<string, string | undefined> = {};
    for (let i = 0; i <= args.length; i++) saved[String(i)] = this.env[String(i)];
    saved['#'] = this.env['#'];
    saved['@'] = this.env['@'];

    this.env['0'] = name;
    for (let i = 0; i < args.length; i++) this.env[String(i + 1)] = args[i];
    this.env['#'] = String(args.length);
    this.env['@'] = args.join(' ');

    // Track FUNCNAME stack
    const prevFuncname = this.arrays.get('FUNCNAME') || [];
    this.arrays.set('FUNCNAME', [name, ...prevFuncname]);

    // Push local variable frame for `local` declarations
    this.localVarStack.push(new Map());

    // Execute body — catch ReturnSignal for `return [N]`
    let exitCode = 0;
    try {
      exitCode = await this.execute(func.body, writeStdout, writeStderr);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        exitCode = e.code;
      } else {
        // Restore before re-throwing
        this.restoreLocalVars();
        this.arrays.set('FUNCNAME', prevFuncname);
        for (const key of Object.keys(saved)) {
          if (saved[key] === undefined) delete this.env[key];
          else this.env[key] = saved[key]!;
        }
        throw e;
      }
    }

    // Pop local variable frame — restore saved values
    this.restoreLocalVars();

    // Restore FUNCNAME stack
    this.arrays.set('FUNCNAME', prevFuncname);

    // Restore positional params
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete this.env[key];
      else this.env[key] = saved[key]!;
    }

    return exitCode;
  }

  // ─── CONTROL STRUCTURES ───────────────────────────────────────────────────

  private isControlStructure(input: string): boolean {
    return /^if\s+/.test(input) || /^while\s+/.test(input) || /^until\s+/.test(input) || /^for\s+/.test(input) || /^case\s+/.test(input) || /^select\s+/.test(input);
  }

  private async execControlStructure(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    if (/^if\s+/.test(input)) return this.execIf(input, writeStdout, writeStderr);
    if (/^while\s+/.test(input)) return this.execWhile(input, writeStdout, writeStderr);
    if (/^until\s+/.test(input)) return this.execUntil(input, writeStdout, writeStderr);
    if (/^for\s+/.test(input)) return this.execFor(input, writeStdout, writeStderr);
    if (/^case\s+/.test(input)) return this.execCase(input, writeStdout, writeStderr);
    if (/^select\s+/.test(input)) return this.execSelect(input, writeStdout, writeStderr);
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
    if (/^while\s+/.test(input)) return this.execWhile(input, writeStdout, writeStderr, pipeStdin);
    // For other control structures, set __PIPE_STDIN env and delegate
    const saved = this.env['__PIPE_STDIN'];
    this.env['__PIPE_STDIN'] = pipeStdin;
    const result = await this.execControlStructure(input, writeStdout, writeStderr);
    if (saved === undefined) delete this.env['__PIPE_STDIN'];
    else this.env['__PIPE_STDIN'] = saved;
    return result;
  }

  private async evalCondition(
    condition: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const trimmed = condition.trim();
    // [[ ... ]] syntax (bash double-bracket test)
    if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
      return this.evalTest(trimmed.slice(2, -2).trim());
    }
    // [ ... ] syntax
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return this.evalTest(trimmed.slice(1, -1).trim());
    }
    if (trimmed.startsWith('test ')) {
      return this.evalTest(trimmed.slice(5));
    }
    // Execute as command
    const result = await this.exec(trimmed);
    if (result.stderr) writeStderr(result.stderr);
    if (result.stdout) writeStdout(result.stdout);
    return result.exitCode;
  }

  private async evalTest(args: string): Promise<number> {
    const tokens = args.split(/\s+/);
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
        case '!': return (await this.evalTest(tokens.slice(1).join(' '))) === 0 ? 1 : 0;
      }
    }

    if (tokens.length === 3) {
      const left = strip(tokens[0]);
      const op = tokens[1];
      const right = strip(tokens[2]);
      switch (op) {
        case '=': case '==': return left === right ? 0 : 1;
        case '!=': return left !== right ? 0 : 1;
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
        return branch.body.trim() ? this.execute(branch.body, writeStdout, writeStderr) : 0;
      }
    }

    // No branch matched, try else
    if (elseBody) {
      return this.execute(elseBody, writeStdout, writeStderr);
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
  private shellTokenScan(input: string): { word: string; pos: number }[] {
    const results: { word: string; pos: number }[] = [];
    let inSQ = false, inDQ = false;
    let i = 0;
    const keywords = ['for', 'while', 'until', 'select', 'do', 'done', 'if', 'then', 'elif', 'else', 'fi', 'case', 'esac', 'in'];
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\\' && !inSQ) { i += 2; continue; }
      if (ch === "'" && !inDQ) { inSQ = !inSQ; i++; continue; }
      if (ch === '"' && !inSQ) { inDQ = !inDQ; i++; continue; }
      if (inSQ || inDQ) { i++; continue; }
      // Check word boundary
      const prevCh = i > 0 ? input[i - 1] : ' ';
      if (/[\s;]/.test(prevCh) || i === 0) {
        for (const kw of keywords) {
          if (input.slice(i, i + kw.length) === kw) {
            const after = input[i + kw.length];
            if (after === undefined || /[\s;]/.test(after)) {
              results.push({ word: kw, pos: i });
              i += kw.length;
              break;
            }
          }
        }
      }
      i++;
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
    while (iter++ < 10000) {
      // Expand vars in condition each iteration (loop vars like $X change)
      const expandedCond = this.expandVars(await this.expandCommandSubstitution(this.expandArithmetic(parsed.condition), writeStderr));
      if ((await this.evalCondition(expandedCond, writeStdout, writeStderr)) !== 0) break;
      try {
        if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr);
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
    while (iter++ < 10000) {
      const expandedCond = this.expandVars(await this.expandCommandSubstitution(this.expandArithmetic(parsed.condition), writeStderr));
      if ((await this.evalCondition(expandedCond, writeStdout, writeStderr)) === 0) break;
      try {
        if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr);
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
      while (iter++ < 10000) {
        // Evaluate test — 0 means false (stop)
        if (test && this.evalArithmetic(test) === 0) break;
        // Execute body
        try {
          if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr);
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
    const forMatch = parsed.condition.match(/^(\w+)\s+in\s+(.+)$/);
    if (!forMatch) { writeStderr('for: syntax error\r\n'); return 1; }

    const varName = forMatch[1];
    const itemsStr = await this.expandCommandSubstitution(this.expandArithmetic(forMatch[2]), writeStderr);
    const items = this.expandVars(itemsStr).split(/\s+/).filter(Boolean);
    for (const item of items) {
      this.env[varName] = item;
      try {
        if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr);
      } catch (e) {
        if (e instanceof BreakSignal) { if (e.levels > 1) throw new BreakSignal(e.levels - 1); break; }
        if (e instanceof ContinueSignal) { if (e.levels > 1) throw new ContinueSignal(e.levels - 1); continue; }
        throw e;
      }
    }
    return 0;
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
    const itemsStr = await this.expandCommandSubstitution(this.expandArithmetic(selMatch[2]), writeStderr);
    const items = this.expandVars(itemsStr).split(/\s+/).filter(Boolean);

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
        if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr);
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

  private async execCase(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    // Normalize newlines to semicolons (preserve ;; clause separators)
    const joined = input.replace(/\r?\n/g, '; ');

    // Parse: case WORD in ... esac
    const caseMatch = joined.match(/^case\s+(.+?)\s+in\b/);
    if (!caseMatch) { writeStderr('case: syntax error\r\n'); return 1; }

    const rawWord = caseMatch[1].trim();
    const word = this.expandVars(rawWord).replace(/^["']|["']$/g, '');

    // Get the body between 'in' and 'esac'
    const inPos = joined.indexOf(' in', caseMatch.index! + 4) + 3;
    const tokens = this.shellTokenScan(joined);
    const esacTok = tokens.find(t => t.word === 'esac');
    const body = joined.slice(inPos, esacTok ? esacTok.pos : joined.length).trim();

    // Split body into clauses on ';;'
    const clauses = body.split(';;').map(c => c.trim()).filter(Boolean);

    for (const clause of clauses) {
      // Parse: pattern[|pattern]) commands
      const clauseMatch = clause.match(/^(.+?)\)\s*([\s\S]*)$/);
      if (!clauseMatch) continue;
      const patterns = clauseMatch[1].split('|').map(p => p.trim().replace(/^\(/, ''));
      const commands = clauseMatch[2].trim().replace(/^;\s*/, '').replace(/;\s*$/, '');

      let matched = false;
      for (const p of patterns) {
        if (p === '*') { matched = true; break; }
        if (word === p) { matched = true; break; }
        // Glob match
        const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        if (re.test(word)) { matched = true; break; }
      }
      if (matched) {
        if (commands) return this.execute(commands, writeStdout, writeStderr);
        return 0;
      }
    }
    return 0;
  }

  // ─── PATH EXECUTION ─────────────────────────────────────────────────────────

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
        const { WasiRT } = await loadWasiRuntime();
        const wasmModule = await getCompiledModule(pkgName, (msg) => {
          writeStderr(`  ${msg}\r\n`);
        });
        const config = {
          fs: this.fs,
          cwd: this.cwd,
          args: [pkgName, ...args],
          env: { ...this.env },
          stdin: ctx.stdin || '',
          onStdout: (text: string) => { ctx.stdout += text; },
          onStderr: (text: string) => { ctx.stderr += text; },
          preopens: { '/': '/', '.': this.cwd },
        };
        const wasi = new WasiRT(config);
        await wasi.preloadTree(this.cwd, 3, 100);
        return await wasi.run(wasmModule);
      } catch (e: any) {
        const { WasiExit } = await loadWasiRuntime();
        if (e instanceof WasiExit) return e.code;
        writeStderr(`shiro: ${pkgName}: ${e.message}\r\n`);
        return 1;
      }
    }

    // Reject other binary files (ELF, Mach-O, etc.) that can't be interpreted
    if (content.charCodeAt(0) === 0x7f || content.includes('\0')) {
      writeStderr(`shiro: ${resolvedPath}: cannot execute binary file\n`);
      return 126;
    }

    // Check for shebang
    const firstLine = content.split('\n')[0];
    if (firstLine.startsWith('#!')) {
      const shebang = firstLine.substring(2).trim();
      const [interpreter, ...interpArgs] = shebang.split(/\s+/);

      // Handle common interpreters
      if (interpreter === '/usr/bin/env' || interpreter === '/bin/env') {
        // env node script.js -> node script.js
        const realInterp = interpArgs[0];
        if (realInterp === 'node' || realInterp === 'nodejs') {
          return this.executeNodeScript(resolvedPath, content, args, ctx, writeStdout, writeStderr);
        } else if (realInterp === 'sh' || realInterp === 'bash') {
          return this.executeShellScript(content, args, ctx, writeStdout, writeStderr);
        }
        // Unknown interpreter via env
        writeStderr(`shiro: cannot execute ${realInterp} scripts\r\n`);
        return 126;
      } else if (interpreter.endsWith('/node') || interpreter.endsWith('/nodejs')) {
        return this.executeNodeScript(resolvedPath, content, args, ctx, writeStdout, writeStderr);
      } else if (interpreter.endsWith('/sh') || interpreter.endsWith('/bash')) {
        return this.executeShellScript(content, args, ctx, writeStdout, writeStderr);
      }

      // Unknown shebang interpreter
      writeStderr(`shiro: cannot execute ${interpreter} scripts\r\n`);
      return 126;
    }

    // No shebang - try to detect file type
    // Check if content is just a path to another file (npm bin stubs)
    const trimmedContent = content.trim();
    if (!trimmedContent.includes('\n') && !trimmedContent.includes(' ') &&
        (trimmedContent.endsWith('.js') || trimmedContent.endsWith('.mjs') || trimmedContent.endsWith('.ts'))) {
      console.log(`[executeScript] bin stub detected → following to ${trimmedContent}`);
      try {
        const targetContent = await this.fs.readFile(trimmedContent, 'utf8') as string;
        console.log(`[executeScript] bin stub target loaded (${targetContent.length} bytes), passing args: ${JSON.stringify(args)}`);
        return this.executeNodeScript(trimmedContent, targetContent, args, ctx, writeStdout, writeStderr);
      } catch (e: any) {
        console.log(`[executeScript] bin stub target not found: ${e.message}`);
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
    return this.executeShellScript(content, args, ctx, writeStdout, writeStderr);
  }

  /**
   * Write #!wasi-pkg stubs to /usr/local/bin for a package and its aliases.
   */
  private async writeWasiPkgStubs(pkgName: string, aliases?: string[]): Promise<void> {
    try {
      for (const dir of ['/usr', '/usr/local', '/usr/local/bin']) {
        try { await this.fs.stat(dir); } catch { await this.fs.mkdir(dir); }
      }
      const stubContent = `#!wasi-pkg ${pkgName}\n`;
      const names = [pkgName, ...(aliases || [])];
      for (const name of names) {
        await this.fs.writeFile(`/usr/local/bin/${name}`, stubContent);
      }
    } catch {
      // Non-fatal — auto-install still works without stubs
    }
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
      const { WasiRT } = await loadWasiRuntime();
      const data = await this.fs.readFile(filePath) as Uint8Array;
      const wasmBytes = new Uint8Array(data).buffer;
      const wasmModule = await WebAssembly.compile(wasmBytes);

      const programName = filePath.split('/').pop() || filePath;
      const config = {
        fs: this.fs,
        cwd: this.cwd,
        args: [programName, ...args],
        env: { ...this.env },
        stdin: ctx.stdin || '',
        onStdout: (text: string) => { ctx.stdout += text; },
        onStderr: (text: string) => { ctx.stderr += text; },
        preopens: { '/': '/', '.': this.cwd },
      };

      const wasi = new WasiRT(config);
      await wasi.preloadTree(this.cwd, 3, 100);
      return await wasi.run(wasmModule);
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
  async executeShellScript(
    content: string,
    args: string[],
    ctx: CommandContext,
    writeStdout: (s: string) => void,
    writeStderr: (s: string) => void,
  ): Promise<number> {
    // Set positional parameters
    const savedParams: Record<string, string | undefined> = {};
    for (let i = 0; i <= args.length; i++) {
      savedParams[String(i)] = this.env[String(i)];
    }
    savedParams['#'] = this.env['#'];
    savedParams['@'] = this.env['@'];

    for (let i = 0; i < args.length; i++) {
      this.env[String(i + 1)] = args[i];
    }
    this.env['#'] = String(args.length);
    this.env['@'] = args.join(' ');

    // Execute script with multi-line compound statement accumulation
    const lines = content.split('\n');
    let exitCode = 0;
    let buffer = '';
    let depth = 0; // track nesting: for/while/until/if/case increment, done/fi/esac decrement

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Count opening/closing keywords (quote-aware)
      const keywords = this.shellTokenScan(trimmed);
      for (const kw of keywords) {
        if (['for', 'while', 'until', 'select', 'if', 'case'].includes(kw.word)) depth++;
        if (['done', 'fi', 'esac'].includes(kw.word)) depth--;
      }

      if (buffer) {
        buffer += '; ' + trimmed;
      } else {
        buffer = trimmed;
      }

      // If depth is 0, we have a complete statement — execute it
      if (depth <= 0) {
        depth = 0;
        exitCode = await this.execute(buffer, writeStdout, writeStderr, false, ctx.terminal, true);
        buffer = '';
      }
    }

    // Execute any remaining buffer
    if (buffer.trim()) {
      exitCode = await this.execute(buffer, writeStdout, writeStderr, false, ctx.terminal, true);
    }

    // Restore positional parameters
    for (const key of Object.keys(savedParams)) {
      if (savedParams[key] === undefined) {
        delete this.env[key];
      } else {
        this.env[key] = savedParams[key]!;
      }
    }

    return exitCode;
  }
}

