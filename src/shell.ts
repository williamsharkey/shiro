import { FileSystem } from './filesystem';
import { CommandRegistry, CommandContext } from './commands/index';

interface Redirect {
  type: '>' | '>>' | '<' | '2>' | '2>>' | '2>&1';
  target: string;
}

export class Shell {
  fs: FileSystem;
  cwd: string = '/home/user';
  env: Record<string, string> = {};
  history: string[] = [];
  commands: CommandRegistry;
  lastExitCode: number = 0;
  functions: Record<string, { body: string }> = {};

  constructor(fs: FileSystem, commands: CommandRegistry) {
    this.fs = fs;
    this.commands = commands;
    this.env = {
      HOME: '/home/user',
      USER: 'user',
      SHELL: '/bin/sh',
      PATH: '/usr/bin:/bin',
      PWD: '/home/user',
      TERM: 'xterm-256color',
    };
  }

  // Execute a command string and return { stdout, stderr, exitCode }
  async exec(input: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let stdout = '';
    let stderr = '';
    const exitCode = await this.execute(
      input,
      (s) => { stdout += s; },
      (s) => { stderr += s; },
    );
    return { stdout, stderr, exitCode };
  }

  async execute(
    line: string,
    writeStdout: (s: string) => void,
    writeStderr?: (s: string) => void,
  ): Promise<number> {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return 0;

    // Handle heredocs before anything else
    const heredoc = this.parseHeredoc(trimmed);
    const effectiveLine = heredoc ? heredoc.command : trimmed;
    const heredocStdin = heredoc ? heredoc.body : '';

    this.history.push(trimmed);

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

    // Split into compound commands: &&, ||, ;
    const compounds = this.parseCompound(effectiveLine);
    let exitCode = 0;

    for (const compound of compounds) {
      // Check conditional
      if (compound.operator === '&&' && exitCode !== 0) continue;
      if (compound.operator === '||' && exitCode === 0) continue;

      // Expand arithmetic, command substitution, and environment variables
      let expanded = this.expandArithmetic(compound.command);
      expanded = await this.expandCommandSubstitution(expanded, stderrWriter);
      expanded = this.expandVars(expanded);

      // Parse pipeline
      const pipeline = this.parsePipeline(expanded);

      let lastOutput = '';
      exitCode = 0;

      for (let i = 0; i < pipeline.length; i++) {
        const segment = pipeline[i];
        const { args, redirects } = this.parseSegment(segment);

        if (args.length === 0) continue;

        const cmdName = args[0];
        const cmdArgs = args.slice(1);

        // Handle . as alias for source
        const effectiveCmdName = cmdName === '.' ? 'source' : cmdName;

        // Handle built-in variable assignment: FOO=bar
        if (effectiveCmdName.includes('=') && !effectiveCmdName.startsWith('=')) {
          const eqIdx = cmdName.indexOf('=');
          const key = cmdName.substring(0, eqIdx);
          const val = cmdName.substring(eqIdx + 1);
          this.env[key] = val;
          if (key === 'PWD') this.cwd = val;
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

        const ctx: CommandContext = {
          args: cmdArgs,
          fs: this.fs,
          cwd: this.cwd,
          env: this.env,
          stdin,
          stdout: '',
          stderr: '',
          shell: this,
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
        if (!cmd) {
          stderrWriter(`shiro: command not found: ${effectiveCmdName}\r\n`);
          exitCode = 127;
          this.lastExitCode = exitCode;
          this.env['?'] = String(exitCode);
          break;
        }

        try {
          exitCode = await cmd.exec(ctx);
        } catch (e: any) {
          ctx.stderr += e.message + '\n';
          exitCode = 1;
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

      this.lastExitCode = exitCode;
      this.env['?'] = String(exitCode);
    }

    return exitCode;
  }

  private expandVars(line: string): string {
    // Handle $? specially
    let result = line.replace(/\$\?/g, String(this.lastExitCode));
    // Handle $VAR and ${VAR}
    result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      return this.env[name] ?? '';
    });
    result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      return this.env[name] ?? '';
    });
    return result;
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
      // Single | but not ||
      if (ch === '|' && line[i + 1] !== '|' && !inSingle && !inDouble) {
        segments.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    segments.push(current);
    return segments;
  }

  private parseSegment(segment: string): { args: string[], redirects: Redirect[] } {
    const tokens = this.tokenize(segment);
    const args: string[] = [];
    const redirects: Redirect[] = [];

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '2>&1') {
        // 2>&1 doesn't need a target - it redirects stderr to stdout
        redirects.push({ type: '2>&1', target: '' });
      } else if ((tokens[i] === '>' || tokens[i] === '>>' || tokens[i] === '<' || tokens[i] === '2>' || tokens[i] === '2>>') && i + 1 < tokens.length) {
        redirects.push({ type: tokens[i] as Redirect['type'], target: tokens[i + 1] });
        i++;
      } else {
        args.push(tokens[i]);
      }
    }

    return { args, redirects };
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
        current += input[i + 1];
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

      // Handle >> and > redirects
      if (ch === '>' && !inSingle && !inDouble) {
        if (current) { tokens.push(current); current = ''; }
        if (input[i + 1] === '>') {
          tokens.push('>>');
          i += 2;
        } else {
          tokens.push('>');
          i++;
        }
        continue;
      }

      // Handle < stdin redirect
      if (ch === '<' && !inSingle && !inDouble) {
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
        while (j < input.length && depth > 0) {
          if (input[j] === '(') depth++;
          if (input[j] === ')') depth--;
          j++;
        }
        const subCmd = input.slice(i + 2, j - 1);
        const subResult = await this.exec(subCmd);
        if (subResult.stderr) stderrWriter(subResult.stderr);
        result.push(subResult.stdout.replace(/[\r\n]+$/, ''));
        i = j;
      } else if (input[i] === '`') {
        let j = input.indexOf('`', i + 1);
        if (j === -1) { result.push(input.slice(i)); break; }
        const subCmd = input.slice(i + 1, j);
        const subResult = await this.exec(subCmd);
        if (subResult.stderr) stderrWriter(subResult.stderr);
        result.push(subResult.stdout.replace(/[\r\n]+$/, ''));
        i = j + 1;
      } else {
        result.push(input[i]);
        i++;
      }
    }
    return result.join('');
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
    // Replace variable references
    let expanded = expr.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_, name: string) => this.env[name] || '0');
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
    return /^if\s+/.test(input) || /^while\s+/.test(input) || /^for\s+/.test(input) || /^case\s+/.test(input);
  }

  private async execControlStructure(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    if (/^if\s+/.test(input)) return this.execIf(input, writeStdout, writeStderr);
    if (/^while\s+/.test(input)) return this.execWhile(input, writeStdout, writeStderr);
    if (/^for\s+/.test(input)) return this.execFor(input, writeStdout, writeStderr);
    if (/^case\s+/.test(input)) return this.execCase(input, writeStdout, writeStderr);
    return 0;
  }

  private async evalCondition(
    condition: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const trimmed = condition.trim();
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
    const lines = input.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    // Single-line: if <cond>; then <cmd>; fi
    if (lines.length === 1) {
      const m = lines[0].match(/^if\s+(.+?);\s*then\s+(.+?)(?:;\s*else\s+(.+?))?;\s*fi$/);
      if (m) {
        const cond = await this.evalCondition(m[1], writeStdout, writeStderr);
        if (cond === 0) return this.execute(m[2], writeStdout, writeStderr);
        if (m[3]) return this.execute(m[3], writeStdout, writeStderr);
        return 0;
      }
    }

    // Multi-line
    const condMatch = lines[0].match(/^if\s+(.+?)(?:;\s*then)?$/);
    if (!condMatch) { writeStderr('if: syntax error\r\n'); return 1; }

    let thenIdx = -1, elseIdx = -1, fiIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l === 'then' || l.endsWith('; then')) thenIdx = i;
      else if (l === 'else') elseIdx = i;
      else if (l === 'fi') fiIdx = i;
    }

    const cond = await this.evalCondition(condMatch[1], writeStdout, writeStderr);

    if (cond === 0) {
      const start = thenIdx + 1;
      const end = elseIdx >= 0 ? elseIdx : fiIdx;
      const block = lines.slice(start, end).join('\n');
      return block.trim() ? this.execute(block, writeStdout, writeStderr) : 0;
    } else if (elseIdx >= 0) {
      const block = lines.slice(elseIdx + 1, fiIdx).join('\n');
      return block.trim() ? this.execute(block, writeStdout, writeStderr) : 0;
    }
    return 0;
  }

  private async execWhile(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const lines = input.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    // Single-line: while <cond>; do <cmd>; done
    if (lines.length === 1) {
      const m = lines[0].match(/^while\s+(.+?);\s*do\s+(.+?);\s*done$/);
      if (m) {
        let iter = 0;
        while (iter++ < 10000) {
          if ((await this.evalCondition(m[1], writeStdout, writeStderr)) !== 0) break;
          await this.execute(m[2], writeStdout, writeStderr);
        }
        return 0;
      }
    }

    const condMatch = lines[0].match(/^while\s+(.+?)(?:;\s*do)?$/);
    if (!condMatch) { writeStderr('while: syntax error\r\n'); return 1; }

    let doIdx = -1, doneIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === 'do' || lines[i].endsWith('; do')) doIdx = i;
      if (lines[i] === 'done') doneIdx = i;
    }

    const body = lines.slice((doIdx >= 0 ? doIdx : 0) + 1, doneIdx >= 0 ? doneIdx : lines.length).join('\n');
    let iter = 0;
    while (iter++ < 10000) {
      if ((await this.evalCondition(condMatch[1], writeStdout, writeStderr)) !== 0) break;
      if (body.trim()) await this.execute(body, writeStdout, writeStderr);
    }
    return 0;
  }

  private async execFor(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const lines = input.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    // Single-line: for i in 1 2 3; do echo $i; done
    if (lines.length === 1) {
      const m = lines[0].match(/^for\s+(\w+)\s+in\s+(.+?);\s*do\s+(.+?);\s*done$/);
      if (m) {
        const items = this.expandVars(m[2]).split(/\s+/).filter(Boolean);
        for (const item of items) {
          this.env[m[1]] = item;
          await this.execute(m[3], writeStdout, writeStderr);
        }
        return 0;
      }
    }

    const forMatch = lines[0].match(/^for\s+(\w+)\s+in\s+(.+?)(?:;\s*do)?$/);
    if (!forMatch) { writeStderr('for: syntax error\r\n'); return 1; }

    let doIdx = -1, doneIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === 'do' || lines[i].endsWith('; do')) doIdx = i;
      if (lines[i] === 'done') doneIdx = i;
    }

    const body = lines.slice((doIdx >= 0 ? doIdx : 0) + 1, doneIdx >= 0 ? doneIdx : lines.length).join('\n');
    const items = this.expandVars(forMatch[2]).split(/\s+/).filter(Boolean);
    for (const item of items) {
      this.env[forMatch[1]] = item;
      if (body.trim()) await this.execute(body, writeStdout, writeStderr);
    }
    return 0;
  }

  private async execCase(
    input: string, writeStdout: (s: string) => void, writeStderr: (s: string) => void
  ): Promise<number> {
    const lines = input.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    const caseMatch = lines[0].match(/^case\s+(.+?)\s+in$/);
    if (!caseMatch) { writeStderr('case: syntax error\r\n'); return 1; }

    const word = this.expandVars(caseMatch[1]);
    let esacIdx = lines.findIndex(l => l === 'esac');
    if (esacIdx < 0) esacIdx = lines.length;

    for (let i = 1; i < esacIdx; i++) {
      const patternMatch = lines[i].match(/^(.+?)\s*\)/);
      if (patternMatch) {
        const patterns = patternMatch[1].split('|').map(p => p.trim());
        let matched = false;
        for (const p of patterns) {
          if (p === '*' || word === p) { matched = true; break; }
          const re = new RegExp('^' + p.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          if (re.test(word)) { matched = true; break; }
        }
        if (matched) {
          const cmdLines: string[] = [];
          i++;
          while (i < esacIdx && !lines[i].endsWith(';;')) { cmdLines.push(lines[i]); i++; }
          if (i < esacIdx && lines[i].endsWith(';;')) {
            const last = lines[i].replace(/;;\s*$/, '').trim();
            if (last) cmdLines.push(last);
          }
          if (cmdLines.length > 0) return this.execute(cmdLines.join('\n'), writeStdout, writeStderr);
          return 0;
        }
      }
    }
    return 0;
  }
}
