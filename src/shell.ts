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

  async execute(
    line: string,
    writeStdout: (s: string) => void,
    writeStderr?: (s: string) => void,
  ): Promise<number> {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return 0;

    this.history.push(trimmed);

    const stderrWriter = writeStderr || writeStdout;

    // Split into compound commands: &&, ||, ;
    const compounds = this.parseCompound(trimmed);
    let exitCode = 0;

    for (const compound of compounds) {
      // Check conditional
      if (compound.operator === '&&' && exitCode !== 0) continue;
      if (compound.operator === '||' && exitCode === 0) continue;

      // Expand environment variables (including $?)
      const expanded = this.expandVars(compound.command);

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

        // Handle built-in variable assignment: FOO=bar
        if (cmdName.includes('=') && !cmdName.startsWith('=')) {
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

        const cmd = this.commands.get(cmdName);
        if (!cmd) {
          stderrWriter(`shiro: command not found: ${cmdName}\r\n`);
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
          if (redir.type === '2>') {
            const targetPath = this.fs.resolvePath(redir.target, this.cwd);
            await this.fs.writeFile(targetPath, stderrOutput);
            stderrOutput = '';
          } else if (redir.type === '2>>') {
            const targetPath = this.fs.resolvePath(redir.target, this.cwd);
            await this.fs.appendFile(targetPath, stderrOutput);
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
          if (redir.type === '>') {
            const targetPath = this.fs.resolvePath(redir.target, this.cwd);
            await this.fs.writeFile(targetPath, output);
            output = '';
          } else if (redir.type === '>>') {
            const targetPath = this.fs.resolvePath(redir.target, this.cwd);
            await this.fs.appendFile(targetPath, output);
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
}
