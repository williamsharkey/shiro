import { FileSystem } from './filesystem';
import { CommandRegistry, CommandContext } from './commands/index';

export class Shell {
  fs: FileSystem;
  cwd: string = '/home/user';
  env: Record<string, string> = {};
  history: string[] = [];
  commands: CommandRegistry;

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

  async execute(line: string, write: (s: string) => void): Promise<number> {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return 0;

    this.history.push(trimmed);

    // Expand environment variables
    const expanded = this.expandVars(trimmed);

    // Parse pipeline
    const pipeline = this.parsePipeline(expanded);

    let lastOutput = '';
    let exitCode = 0;

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

      const stdin = i > 0 ? lastOutput : '';

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
        write(`shiro: command not found: ${cmdName}\r\n`);
        return 127;
      }

      try {
        exitCode = await cmd.exec(ctx);
      } catch (e: any) {
        ctx.stderr += e.message + '\n';
        exitCode = 1;
      }

      if (ctx.stderr) {
        write(ctx.stderr.replace(/\n/g, '\r\n'));
      }

      // Handle redirects
      let output = ctx.stdout;
      for (const redir of redirects) {
        const targetPath = this.fs.resolvePath(redir.target, this.cwd);
        if (redir.type === '>') {
          await this.fs.writeFile(targetPath, output);
          output = '';
        } else if (redir.type === '>>') {
          await this.fs.appendFile(targetPath, output);
          output = '';
        }
      }

      if (i === pipeline.length - 1 && output) {
        write(output.replace(/\n/g, '\r\n'));
      }

      lastOutput = output;

      // Update cwd from env
      this.cwd = this.env['PWD'] || this.cwd;
    }

    return exitCode;
  }

  private expandVars(line: string): string {
    return line.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      return this.env[name] ?? '';
    });
  }

  private parsePipeline(line: string): string[] {
    // Simple pipe splitting (doesn't handle pipes inside quotes)
    const segments: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
      if (ch === '|' && !inSingle && !inDouble) {
        segments.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    segments.push(current);
    return segments;
  }

  private parseSegment(segment: string): { args: string[], redirects: { type: string, target: string }[] } {
    const tokens = this.tokenize(segment);
    const args: string[] = [];
    const redirects: { type: string, target: string }[] = [];

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '>' || tokens[i] === '>>') {
        if (i + 1 < tokens.length) {
          redirects.push({ type: tokens[i], target: tokens[i + 1] });
          i++;
        }
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

      // Handle >> redirect
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

      current += ch;
      i++;
    }

    if (current) tokens.push(current);
    return tokens;
  }
}
