/**
 * Shiro-specific command implementations.
 *
 * These override unix.ts versions with Shiro FS-aware behavior,
 * or provide browser-specific functionality.
 */
import { Command } from './index';
import { getAssociation } from '../file-associations';

export const rmCmd: Command = {
  name: 'rm',
  description: 'Remove files or directories',
  async exec(ctx) {
    let recursive = false;
    let force = false;
    const files: string[] = [];
    for (const arg of ctx.args) {
      if (arg.startsWith('-')) {
        if (arg.includes('r') || arg.includes('R')) recursive = true;
        if (arg.includes('f')) force = true;
      } else {
        files.push(arg);
      }
    }
    for (const f of files) {
      const resolved = ctx.fs.resolvePath(f, ctx.cwd);
      try { await ctx.fs.rm(resolved, { recursive }); }
      catch (e: any) {
        if (!force) { ctx.stderr += `rm: ${e.message}\n`; return 1; }
      }
    }
    return 0;
  },
};

export const lnCmd: Command = {
  name: 'ln',
  description: 'Create links between files',
  async exec(ctx) {
    let symbolic = false;
    let force = false;
    const args: string[] = [];
    for (const arg of ctx.args) {
      if (arg.startsWith('-') && arg !== '--') {
        for (const ch of arg.slice(1)) {
          if (ch === 's') symbolic = true;
          else if (ch === 'f') force = true;
        }
      } else {
        args.push(arg);
      }
    }
    if (args.length < 2) {
      ctx.stderr = 'ln: missing file operand\n';
      return 1;
    }
    if (!symbolic) {
      ctx.stderr = 'ln: hard links not supported, use -s for symbolic\n';
      return 1;
    }
    const target = args[0];
    const linkPath = ctx.fs.resolvePath(args[1], ctx.cwd);
    try {
      if (force) {
        try { await ctx.fs.unlink(linkPath); } catch {}
      }
      await ctx.fs.symlink(target, linkPath);
      return 0;
    } catch (e: any) {
      ctx.stderr = `ln: ${e.message}\n`;
      return 1;
    }
  },
};

export const hostnameCmd: Command = {
  name: 'hostname',
  description: 'Show system hostname',
  async exec(ctx) {
    ctx.stdout = 'shiro\n';
    return 0;
  },
};

export const unameCmd: Command = {
  name: 'uname',
  description: 'Print system information',
  async exec(ctx) {
    const flags = ctx.args.filter(a => a.startsWith('-')).join('');
    const hasAll = flags.includes('a');
    const hasS = flags.includes('s') || (!flags && ctx.args.length === 0);
    const hasM = flags.includes('m');
    const hasN = flags.includes('n');
    const hasR = flags.includes('r');
    const hasV = flags.includes('v');

    if (hasAll) {
      ctx.stdout = 'Shiro shiro 0.1.0 Shiro/WASM browser wasm\n';
      return 0;
    }

    const parts: string[] = [];
    if (hasS) parts.push('Shiro');
    if (hasN) parts.push('shiro');
    if (hasR) parts.push('0.1.0');
    if (hasV) parts.push('Shiro/WASM');
    if (hasM) parts.push('wasm');

    ctx.stdout = (parts.length > 0 ? parts.join(' ') : 'Shiro') + '\n';
    return 0;
  },
};

export const whichCmd: Command = {
  name: 'which',
  description: 'Locate a command',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stderr = 'which: missing argument\n';
      return 1;
    }
    const name = ctx.args[0];
    const execPath = await ctx.shell.findExecutableInPath(name);
    if (execPath) {
      ctx.stdout = `${execPath}\n`;
      return 0;
    }
    const cmd = ctx.shell.commands.get(name);
    if (cmd) {
      ctx.stdout = `${name}\n`;
      return 0;
    }
    if (ctx.shell.functions?.[name]) {
      ctx.stdout = `${name}: shell function\n`;
      return 0;
    }
    ctx.stderr = `${name} not found\n`;
    return 1;
  },
};

export const typeCmd: Command = {
  name: 'type',
  description: 'Describe a command',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stderr = 'type: missing argument\n';
      return 1;
    }
    const name = ctx.args[0];
    const cmd = ctx.shell.commands.get(name);
    if (cmd) {
      ctx.stdout = `${name} is a shell builtin\n`;
      return 0;
    }
    if (ctx.shell.functions?.[name]) {
      ctx.stdout = `${name} is a shell function\n`;
      return 0;
    }
    const execPath = await ctx.shell.findExecutableInPath(name);
    if (execPath) {
      ctx.stdout = `${name} is ${execPath}\n`;
      return 0;
    }
    ctx.stderr = `type: ${name}: not found\n`;
    return 1;
  },
};

export const rmdirCmd: Command = {
  name: 'rmdir',
  description: 'Remove empty directories',
  async exec(ctx) {
    for (const arg of ctx.args) {
      const resolved = ctx.fs.resolvePath(arg, ctx.cwd);
      try { await ctx.fs.rmdir(resolved); }
      catch (e: any) { ctx.stderr += `rmdir: ${e.message}\n`; return 1; }
    }
    return 0;
  },
};

export const revCmd: Command = {
  name: 'rev',
  description: 'Reverse lines character-wise',
  async exec(ctx) {
    const input = ctx.stdin || (ctx.args.length ? await ctx.fs.readFile(
      ctx.fs.resolvePath(ctx.args[0], ctx.cwd), 'utf8') as string : '');
    ctx.stdout = input.split('\n').map(l => l.split('').reverse().join('')).join('\n');
    return 0;
  },
};

export const cutCmd: Command = {
  name: 'cut',
  description: 'Remove sections from each line',
  async exec(ctx) {
    let delimiter = '\t';
    let fields: number[] = [];
    let bytes: number[] = [];
    let chars: number[] = [];
    const files: string[] = [];

    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '-d' && ctx.args[i + 1]) {
        delimiter = ctx.args[++i];
        if (delimiter.length === 0) delimiter = ' ';
      } else if (arg.startsWith('-d')) {
        delimiter = arg.slice(2) || ' ';
      } else if (arg === '-f' && ctx.args[i + 1]) {
        fields = parseRange(ctx.args[++i]);
      } else if (arg.startsWith('-f')) {
        fields = parseRange(arg.slice(2));
      } else if (arg === '-b' && ctx.args[i + 1]) {
        bytes = parseRange(ctx.args[++i]);
      } else if (arg.startsWith('-b')) {
        bytes = parseRange(arg.slice(2));
      } else if (arg === '-c' && ctx.args[i + 1]) {
        chars = parseRange(ctx.args[++i]);
      } else if (arg.startsWith('-c')) {
        chars = parseRange(arg.slice(2));
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    let input = ctx.stdin;
    if (files.length > 0) {
      const parts: string[] = [];
      for (const f of files) {
        const path = ctx.fs.resolvePath(f, ctx.cwd);
        try {
          parts.push(await ctx.fs.readFile(path, 'utf8') as string);
        } catch (e: any) {
          ctx.stderr += `cut: ${f}: ${e.message}\n`;
          return 1;
        }
      }
      input = parts.join('');
    }

    input = input.replace(/\r\n/g, '\n');

    const lines = input.split('\n');
    const output: string[] = [];

    for (const line of lines) {
      if (!line && lines.indexOf(line) === lines.length - 1) continue;

      if (fields.length > 0) {
        const parts = line.split(delimiter);
        const selected = fields.map(f => parts[f - 1] || '').filter(Boolean);
        output.push(selected.join(delimiter));
      } else if (bytes.length > 0 || chars.length > 0) {
        const indices = bytes.length > 0 ? bytes : chars;
        const selected = indices.map(i => line[i - 1] || '').join('');
        output.push(selected);
      } else {
        output.push(line);
      }
    }

    ctx.stdout = output.join('\n') + '\n';
    return 0;
  },
};

function parseRange(spec: string): number[] {
  const result: number[] = [];
  for (const part of spec.split(',')) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= (end || start); i++) result.push(i);
    } else {
      result.push(Number(part));
    }
  }
  return result.filter(n => !isNaN(n) && n > 0);
}

export const shasumCmd: Command = {
  name: 'shasum',
  description: 'Compute SHA checksums',
  async exec(ctx) {
    let algorithm = '1';
    const files: string[] = [];

    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '-a' && ctx.args[i + 1]) {
        algorithm = ctx.args[++i];
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    const algoMap: Record<string, string> = {
      '1': 'SHA-1',
      '256': 'SHA-256',
      '384': 'SHA-384',
      '512': 'SHA-512',
    };

    const cryptoAlgo = algoMap[algorithm];
    if (!cryptoAlgo) {
      ctx.stderr = `shasum: unrecognized algorithm: ${algorithm}\n`;
      return 1;
    }

    const processData = async (data: Uint8Array, name: string) => {
      const hashBuffer = await crypto.subtle.digest(cryptoAlgo, data as BufferSource);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      ctx.stdout += `${hashHex}  ${name}\n`;
    };

    if (files.length === 0 || files.includes('-')) {
      const data = new TextEncoder().encode(ctx.stdin);
      await processData(data, '-');
    }

    for (const file of files) {
      if (file === '-') continue;
      const resolved = ctx.fs.resolvePath(file, ctx.cwd);
      try {
        const content = await ctx.fs.readFile(resolved);
        const data = typeof content === 'string'
          ? new TextEncoder().encode(content)
          : (content instanceof Uint8Array ? content : new Uint8Array(content));
        await processData(data, file);
      } catch (e: any) {
        ctx.stderr += `shasum: ${file}: ${e.message}\n`;
        return 1;
      }
    }

    return 0;
  },
};

export const sha256sumCmd: Command = {
  name: 'sha256sum',
  description: 'Compute SHA-256 checksums',
  async exec(ctx) {
    const newCtx = { ...ctx, args: ['-a', '256', ...ctx.args] };
    return shasumCmd.exec(newCtx);
  },
};

export const openCmd: Command = {
  name: 'open',
  description: 'Open files, directories, or URLs',
  async exec(ctx) {
    let app: string | null = null;
    const targets: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      if (ctx.args[i] === '-a' && ctx.args[i + 1]) { app = ctx.args[++i]; continue; }
      targets.push(ctx.args[i]);
    }
    if (targets.length === 0) {
      ctx.stderr = 'Usage: open [-a app] <file|url>\n';
      return 1;
    }

    for (const target of targets) {
      // URL?
      if (/^https?:\/\//.test(target)) {
        if (typeof window !== 'undefined') window.open(target, '_blank');
        continue;
      }
      // File or directory
      const resolved = ctx.fs.resolvePath(target, ctx.cwd);
      const stat = await ctx.fs.stat(resolved).catch(() => null);
      if (!stat) {
        ctx.stderr += `open: ${target}: No such file or directory\n`;
        return 1;
      }

      const cmd = app || (stat.type === 'dir' ? 'code' : getAssociation(target)) || 'code';
      const escaped = resolved.replace(/"/g, '\\"');
      await ctx.shell.execute(
        `${cmd} "${escaped}"`,
        (d: string) => { ctx.stdout += d; },
        (d: string) => { ctx.stderr += d; },
      );
    }
    return 0;
  },
};

/**
 * Shiro-specific commands. Registered AFTER unix commands so they
 * take precedence where needed (rm, find, ln, etc.).
 */
export const shiroCmds: Command[] = [
  rmCmd, lnCmd,
  hostnameCmd, unameCmd,
  whichCmd, typeCmd,
  rmdirCmd, revCmd,
  cutCmd, shasumCmd, sha256sumCmd,
  openCmd, { name: 'xdg-open', description: 'Open a URL in the browser', exec: (ctx) => openCmd.exec(ctx) },
];
