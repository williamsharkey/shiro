import { FileSystem } from './filesystem';
import { CommandRegistry, CommandContext } from './commands/index';
import type { ShiroTerminal } from './terminal';
import { recordCommand } from './favicon';

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

export class Shell {
  fs: FileSystem;
  cwd: string = '/home/user';
  env: Record<string, string> = {};
  history: string[] = [];
  commands: CommandRegistry;
  lastExitCode: number = 0;
  functions: Record<string, { body: string }> = {};
  backgroundJobs: Map<number, BackgroundJob> = new Map();
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
  fork(): Shell {
    const child = new Shell(this.fs, this.commands);
    child.cwd = this.cwd;
    child.env = { ...this.env };
    child.functions = { ...this.functions };
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

    // Check for control structures (if/while/for/case)
    if (this.isControlStructure(effectiveLine)) {
      return this.execControlStructure(effectiveLine, writeStdout, stderrWriter);
    }

    // Check for subshell: (commands)
    if (effectiveLine.startsWith('(') && effectiveLine.endsWith(')')) {
      const inner = effectiveLine.slice(1, -1).trim();
      if (inner) {
        // Execute in a forked shell (env changes don't propagate back)
        const child = this.fork();
        const result = await child.exec(inner);
        if (result.stdout) writeStdout(result.stdout.replace(/\n/g, '\r\n'));
        if (result.stderr) stderrWriter(result.stderr.replace(/\n/g, '\r\n'));
        this.lastExitCode = result.exitCode;
        this.env['?'] = String(result.exitCode);
        return result.exitCode;
      }
    }

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

      // Check if compound is a control structure BEFORE variable expansion
      // (control structures handle their own expansion internally to support loop variables)
      if (this.isControlStructure(compound.command.trim())) {
        exitCode = await this.execControlStructure(compound.command.trim(), writeStdout, stderrWriter);
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

      for (let i = 0; i < pipeline.length; i++) {
        const segment = pipeline[i];
        const { args, redirects, hereString } = this.parseSegment(segment);

        if (args.length === 0) continue;

        // Expand glob patterns in args (but not quoted ones marked with \x01)
        const expandedArgs = await this.expandGlobs(args);

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

        // Handle . as alias for source
        const effectiveCmdName = cmdName === '.' ? 'source' : cmdName;

        // Handle built-in variable assignment: FOO=bar
        if (effectiveCmdName.includes('=') && !effectiveCmdName.startsWith('=')) {
          const eqIdx = cmdName.indexOf('=');
          const key = cmdName.substring(0, eqIdx);
          const val = cmdName.substring(eqIdx + 1);
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
          // Basic declare/typeset/local support
          for (const arg of cmdArgs) {
            if (arg === '-x' || arg === '-r' || arg === '-i' || arg === '-a' || arg === '-f' || arg === '-p') continue;
            if (arg.startsWith('-')) continue; // skip other flags
            const eqIdx = arg.indexOf('=');
            if (eqIdx >= 0) {
              this.env[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
            } else {
              // Declare without value — ensure exists
              if (!(arg in this.env)) this.env[arg] = '';
            }
          }
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
            stderrWriter(`shiro: command not found: ${effectiveCmdName}\r\n`);
            exitCode = 127;
            this.lastExitCode = exitCode;
            this.env['?'] = String(exitCode);
            break;
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

        // Update cwd from env
        this.cwd = this.env['PWD'] || this.cwd;
      }

      // Apply ! negation
      if (negateExit) {
        exitCode = exitCode === 0 ? 1 : 0;
      }

      this.lastExitCode = exitCode;
      this.env['?'] = String(exitCode);
    }

    return exitCode;
  }

  /**
   * Expand brace expressions: {a,b,c} → a b c, {1..5} → 1 2 3 4 5
   * Handles prefix/suffix: pre{a,b}suf → preasuf prebsuf
   * Respects quoting: '{a,b}' is literal.
   */
  private expandBraces(input: string): string {
    // Quick check: no unquoted braces
    if (!input.includes('{')) return input;

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
          result += this.env[varName] ?? '';
          i += m[0].length;
          continue;
        }
      }

      // Tilde expansion (only unquoted)
      if (ch === '~' && !inDouble) {
        const before = i === 0 ? '' : line[i - 1];
        const after = line[i + 1] || '';
        if ((i === 0 || /[\s=]/.test(before)) && (/[\/\s;|&>]/.test(after) || i + 1 >= line.length)) {
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
    // ${#VAR} — string length
    const lenMatch = inner.match(/^#([A-Za-z_][A-Za-z0-9_]*)$/);
    if (lenMatch) {
      return String((this.env[lenMatch[1]] ?? '').length);
    }

    // ${VAR^^} — uppercase all
    const ucMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\^\^$/);
    if (ucMatch) return (this.env[ucMatch[1]] ?? '').toUpperCase();

    // ${VAR,,} — lowercase all
    const lcMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*),,$/);
    if (lcMatch) return (this.env[lcMatch[1]] ?? '').toLowerCase();

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
    for (let i = 1; i < lines.length; i++) {
      const line = stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
      if (line.trim() === delimiter) {
        found = true;
        break;
      }
      bodyLines.push(line);
    }

    if (!found) return null;

    let body = bodyLines.join('\n');
    // If delimiter was not quoted, expand variables
    if (!quoted) {
      body = this.expandVars(body);
    }
    // Add trailing newline (standard heredoc behavior)
    body += '\n';

    return { command, body };
  }

  private parseCompound(line: string): { operator: '' | '&&' | '||' | ';'; command: string }[] {
    const result: { operator: '' | '&&' | '||' | ';'; command: string }[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let currentOp: '' | '&&' | '||' | ';' = '';
    let depth = 0; // track control structure nesting (do/done, then/fi, {/})
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
        // Track {/} brace groups and function bodies
        if (ch === '{') {
          // Only count as depth if preceded by whitespace/; (not in ${VAR})
          const prevBrace = i > 0 ? line[i - 1] : ' ';
          if (/[\s;)]/.test(prevBrace) || i === 0) depth++;
          current += ch; i++; continue;
        }
        if (ch === '}') {
          if (depth > 0) depth--;
          current += ch; i++; continue;
        }

        // Track control structure keywords to avoid splitting inside them
        // Only match at word boundary: beginning of string or after whitespace/;
        const prevCh = i > 0 ? line[i - 1] : ' ';
        if (/[\s;]/.test(prevCh) || i === 0) {
          const rest = line.slice(i);
          const wordMatch = rest.match(/^(for|while|until|if|case|do|then|done|fi|esac)\b/);
          if (wordMatch) {
            const word = wordMatch[1];
            if (word === 'for' || word === 'while' || word === 'until' || word === 'if' || word === 'case') depth++;
            else if (word === 'done' || word === 'fi' || word === 'esac') depth--;
          }
        }

        if (depth <= 0) {
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
      if (ch === '<' && !inSingle && !inDouble) {
        if (input[i + 1] === '<' && input[i + 2] === '<') {
          if (current) { tokens.push(current); current = ''; }
          tokens.push('<<<');
          i += 3;
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
    // Replace variable references (including positional params $1, $2, etc.)
    let expanded = expr.replace(/\$\{?([A-Za-z_]\w*|\d+)\}?/g, (_, name: string) => this.env[name] || '0');
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
      const ops2 = ['**', '<=', '>=', '==', '!='];
      let found = false;
      for (const op of ops2) {
        if (expr.slice(i, i + op.length) === op) { tokens.push({ type: 'op', value: op }); i += op.length; found = true; break; }
      }
      if (found) continue;
      if ('+-*/%<>'.includes(expr[i])) { tokens.push({ type: 'op', value: expr[i] }); i++; continue; }
      if (expr[i] === '(') { tokens.push({ type: 'paren', value: '(' }); i++; continue; }
      if (expr[i] === ')') { tokens.push({ type: 'paren', value: ')' }); i++; continue; }
      i++;
    }

    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    const parseAtom = (): number => {
      const t = peek();
      if (!t) return 0;
      if (t.type === 'num') { next(); return t.value; }
      if (t.value === '(') { next(); const v = parseExpr(); next(); return v; }
      return 0;
    };
    const parsePow = (): number => {
      let left = parseAtom();
      while (peek() && peek().value === '**') { next(); left = Math.pow(left, parseAtom()); }
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
    const parseExpr = (): number => {
      let left = parseAdd();
      while (peek() && ['<', '>', '<=', '>=', '==', '!='].includes(peek().value)) {
        const op = next().value;
        const right = parseAdd();
        if (op === '<') left = left < right ? 1 : 0;
        else if (op === '>') left = left > right ? 1 : 0;
        else if (op === '<=') left = left <= right ? 1 : 0;
        else if (op === '>=') left = left >= right ? 1 : 0;
        else if (op === '==') left = left === right ? 1 : 0;
        else if (op === '!=') left = left !== right ? 1 : 0;
      }
      return left;
    };
    return parseExpr();
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

    // Execute body
    let exitCode = 0;
    const bodyLines = func.body.split(/\n|;/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    for (const line of bodyLines) {
      if (line === 'return' || line.startsWith('return ')) {
        const retMatch = line.match(/^return\s+(\d+)?/);
        exitCode = retMatch?.[1] ? parseInt(retMatch[1]) : this.lastExitCode;
        break;
      }
      exitCode = await this.execute(line, writeStdout, writeStderr);
    }

    // Restore
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete this.env[key];
      else this.env[key] = saved[key]!;
    }

    return exitCode;
  }

  // ─── CONTROL STRUCTURES ───────────────────────────────────────────────────

  private isControlStructure(input: string): boolean {
    return /^if\s+/.test(input) || /^while\s+/.test(input) || /^until\s+/.test(input) || /^for\s+/.test(input) || /^case\s+/.test(input);
  }

  private async execControlStructure(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    if (/^if\s+/.test(input)) return this.execIf(input, writeStdout, writeStderr);
    if (/^while\s+/.test(input)) return this.execWhile(input, writeStdout, writeStderr);
    if (/^until\s+/.test(input)) return this.execUntil(input, writeStdout, writeStderr);
    if (/^for\s+/.test(input)) return this.execFor(input, writeStdout, writeStderr);
    if (/^case\s+/.test(input)) return this.execCase(input, writeStdout, writeStderr);
    return 0;
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

    if (tokens.length === 2) {
      const [op, arg] = tokens;
      const expanded = this.expandVars(arg);
      switch (op) {
        case '-z': return expanded === '' ? 0 : 1;
        case '-n': return expanded !== '' ? 0 : 1;
        case '-e': case '-r': case '-w': case '-x':
          try { await this.fs.stat(this.fs.resolvePath(expanded, this.cwd)); return 0; } catch { return 1; }
        case '-f':
          try { const s = await this.fs.stat(this.fs.resolvePath(expanded, this.cwd)); return s.type === 'file' ? 0 : 1; } catch { return 1; }
        case '-d':
          try { const s = await this.fs.stat(this.fs.resolvePath(expanded, this.cwd)); return s.type === 'dir' ? 0 : 1; } catch { return 1; }
        case '!': return (await this.evalTest(tokens.slice(1).join(' '))) === 0 ? 1 : 0;
      }
    }

    if (tokens.length === 3) {
      const left = this.expandVars(tokens[0]);
      const op = tokens[1];
      const right = this.expandVars(tokens[2]);
      switch (op) {
        case '=': case '==': return left === right ? 0 : 1;
        case '!=': return left !== right ? 0 : 1;
        case '-eq': return parseInt(left) === parseInt(right) ? 0 : 1;
        case '-ne': return parseInt(left) !== parseInt(right) ? 0 : 1;
        case '-lt': return parseInt(left) < parseInt(right) ? 0 : 1;
        case '-le': return parseInt(left) <= parseInt(right) ? 0 : 1;
        case '-gt': return parseInt(left) > parseInt(right) ? 0 : 1;
        case '-ge': return parseInt(left) >= parseInt(right) ? 0 : 1;
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
      if (tok.word === 'for' || tok.word === 'while' || tok.word === 'until') {
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
    const keywords = ['for', 'while', 'until', 'do', 'done', 'if', 'then', 'elif', 'else', 'fi', 'case', 'esac', 'in'];
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
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const parsed = this.parseLoopConstruct(input, 'while');
    if (!parsed) { writeStderr('while: syntax error\r\n'); return 1; }

    let iter = 0;
    while (iter++ < 10000) {
      // Expand vars in condition each iteration (loop vars like $X change)
      const expandedCond = this.expandVars(await this.expandCommandSubstitution(this.expandArithmetic(parsed.condition), writeStderr));
      if ((await this.evalCondition(expandedCond, writeStdout, writeStderr)) !== 0) break;
      if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr);
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
      if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr);
    }
    return 0;
  }

  private async execFor(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const parsed = this.parseLoopConstruct(input, 'for');
    if (!parsed) { writeStderr('for: syntax error\r\n'); return 1; }

    // Parse "VAR in item1 item2 item3" from condition
    const forMatch = parsed.condition.match(/^(\w+)\s+in\s+(.+)$/);
    if (!forMatch) { writeStderr('for: syntax error\r\n'); return 1; }

    const varName = forMatch[1];
    const itemsStr = await this.expandCommandSubstitution(this.expandArithmetic(forMatch[2]), writeStderr);
    const items = this.expandVars(itemsStr).split(/\s+/).filter(Boolean);
    for (const item of items) {
      this.env[varName] = item;
      if (parsed.body.trim()) await this.execute(parsed.body, writeStdout, writeStderr);
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

    // Search each directory
    for (const pathDir of pathDirs) {
      const candidate = `${pathDir}/${name}`;
      try {
        const stat = await this.fs.stat(candidate);
        if (stat.type === 'file' || stat.type === 'symlink') {
          return candidate;
        }
      } catch {
        // Not found in this directory, continue
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

    // Reject binary files (ELF, Mach-O, etc.) that can't be interpreted
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
  private async executeShellScript(
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

    // Execute script line by line
    const lines = content.split('\n');
    let exitCode = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      exitCode = await this.execute(trimmed, writeStdout, writeStderr, false, ctx.terminal, true);
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
