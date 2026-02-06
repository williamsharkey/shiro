/**
 * Shiro-only commands that require shell state access or aren't in fluffycoreutils.
 *
 * Most coreutils (cat, ls, grep, sed, etc.) are now provided by the shared
 * fluffycoreutils library. These commands remain here because they need
 * direct access to ctx.shell (cd, export, help, which, xargs) or aren't
 * in the shared library (sleep, seq, rmdir).
 */
import { Command } from './index';
import { grepCmd } from './grep';
import { sedCmd } from './sed';
import { diffCmd } from './diff';

export const cdCmd: Command = {
  name: 'cd',
  description: 'Change directory',
  async exec(ctx) {
    const target = ctx.args[0] || ctx.env['HOME'] || '/';
    const resolved = ctx.fs.resolvePath(target === '~' ? (ctx.env['HOME'] || '/') : target, ctx.cwd);
    const stat = await ctx.fs.stat(resolved).catch(() => null);
    if (!stat) { ctx.stderr = `cd: no such file or directory: ${target}\n`; return 1; }
    if (!stat.isDirectory()) { ctx.stderr = `cd: not a directory: ${target}\n`; return 1; }
    ctx.shell.cwd = resolved;
    ctx.shell.env['PWD'] = resolved;
    return 0;
  },
};

// Map of env vars to localStorage keys for persistence across sessions
const PERSIST_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'shiro_anthropic_key',
  OPENAI_API_KEY: 'shiro_openai_key',
  GOOGLE_API_KEY: 'shiro_google_key',
};

export const exportCmd: Command = {
  name: 'export',
  description: 'Set environment variables',
  async exec(ctx) {
    for (const arg of ctx.args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx === -1) continue;
      const key = arg.substring(0, eqIdx);
      const val = arg.substring(eqIdx + 1);
      ctx.shell.env[key] = val;
      // Persist API keys to localStorage so they survive page refreshes
      if (PERSIST_ENV[key] && typeof localStorage !== 'undefined') {
        localStorage.setItem(PERSIST_ENV[key], val);
      }
    }
    return 0;
  },
};

export const helpCmd: Command = {
  name: 'help',
  description: 'Show available commands',
  async exec(ctx) {
    ctx.stdout = 'shiro - available commands:\n\n';
    const cmds = ctx.shell.commands.list();
    const nameCol = 10; // max name length before wrapping description to next line
    for (const cmd of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
      if (cmd.name.length > nameCol) {
        // Long command name: description on next line
        ctx.stdout += ` ${cmd.name}\n`;
        ctx.stdout += `${''.padEnd(nameCol + 5)}${cmd.description}\n`;
      } else {
        ctx.stdout += ` ${cmd.name.padEnd(nameCol + 4)}${cmd.description}\n`;
      }
    }
    ctx.stdout += '\n';
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
    const cmd = ctx.shell.commands.get(ctx.args[0]);
    if (cmd) {
      ctx.stdout = `${ctx.args[0]}: shell built-in\n`;
      return 0;
    }
    ctx.stderr = `which: no ${ctx.args[0]} in (built-in commands)\n`;
    return 1;
  },
};

export const xargsCmd: Command = {
  name: 'xargs',
  description: 'Build and execute command lines from stdin',
  async exec(ctx) {
    const cmdName = ctx.args[0] || 'echo';
    const cmdArgs = ctx.args.slice(1);
    const items = ctx.stdin.split(/\s+/).filter(Boolean);
    const cmd = ctx.shell.commands.get(cmdName);
    if (!cmd) { ctx.stderr = `xargs: ${cmdName}: command not found\n`; return 127; }
    const newCtx = { ...ctx, args: [...cmdArgs, ...items], stdin: '', stdout: '', stderr: '' };
    const code = await cmd.exec(newCtx);
    ctx.stdout = newCtx.stdout;
    ctx.stderr = newCtx.stderr;
    return code;
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

export const sleepCmd: Command = {
  name: 'sleep',
  description: 'Delay for a specified time',
  async exec(ctx) {
    const secs = parseFloat(ctx.args[0] || '0');
    if (isNaN(secs) || secs < 0) {
      ctx.stderr = `sleep: invalid time interval '${ctx.args[0]}'\n`;
      return 1;
    }
    await new Promise(resolve => setTimeout(resolve, secs * 1000));
    return 0;
  },
};

export const seqCmd: Command = {
  name: 'seq',
  description: 'Print a sequence of numbers',
  async exec(ctx) {
    let first = 1, increment = 1, last = 1;
    if (ctx.args.length === 1) {
      last = parseInt(ctx.args[0]);
    } else if (ctx.args.length === 2) {
      first = parseInt(ctx.args[0]);
      last = parseInt(ctx.args[1]);
    } else if (ctx.args.length >= 3) {
      first = parseInt(ctx.args[0]);
      increment = parseInt(ctx.args[1]);
      last = parseInt(ctx.args[2]);
    }
    if (increment === 0) { ctx.stderr = 'seq: zero increment\n'; return 1; }
    const lines: string[] = [];
    if (increment > 0) {
      for (let i = first; i <= last; i += increment) lines.push(String(i));
    } else {
      for (let i = first; i >= last; i += increment) lines.push(String(i));
    }
    ctx.stdout = lines.join('\n') + '\n';
    return 0;
  },
};

// --- Override commands where fluffy has bugs or Shiro needs custom behavior ---

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

export const findCmd: Command = {
  name: 'find',
  description: 'Search for files in a directory hierarchy',
  async exec(ctx) {
    let namePattern = '';
    let typeFilter = '';
    let maxDepth = Infinity;
    const paths: string[] = [];

    for (let i = 0; i < ctx.args.length; i++) {
      if (ctx.args[i] === '-name' && ctx.args[i + 1]) {
        namePattern = ctx.args[++i];
      } else if (ctx.args[i] === '-type' && ctx.args[i + 1]) {
        typeFilter = ctx.args[++i];
      } else if (ctx.args[i] === '-maxdepth' && ctx.args[i + 1]) {
        maxDepth = parseInt(ctx.args[++i]);
      } else if (!ctx.args[i].startsWith('-')) {
        paths.push(ctx.args[i]);
      }
    }

    if (paths.length === 0) paths.push('.');

    const nameRegex = namePattern ? globToRegex(namePattern) : null;

    for (const p of paths) {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      await walkFind(ctx, resolved, p, nameRegex, typeFilter, 0, maxDepth);
    }
    return 0;
  },
};

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

async function walkFind(
  ctx: any, dir: string, displayBase: string,
  nameRegex: RegExp | null, typeFilter: string,
  depth: number, maxDepth: number,
): Promise<void> {
  if (depth > maxDepth) return;
  let entries: string[];
  try { entries = await ctx.fs.readdir(dir); } catch { return; }

  for (const name of entries) {
    const fullPath = dir === '/' ? '/' + name : dir + '/' + name;
    const displayPath = displayBase + '/' + name;
    const stat = await ctx.fs.stat(fullPath).catch(() => null);
    if (!stat) continue;

    const isDir = stat.isDirectory();
    let include = true;
    if (nameRegex && !nameRegex.test(name)) include = false;
    if (typeFilter === 'f' && isDir) include = false;
    if (typeFilter === 'd' && !isDir) include = false;

    if (include) ctx.stdout += displayPath + '\n';
    if (isDir) await walkFind(ctx, fullPath, displayPath, nameRegex, typeFilter, depth + 1, maxDepth);
  }
}

export const lnCmd: Command = {
  name: 'ln',
  description: 'Create links between files',
  async exec(ctx) {
    let symbolic = false;
    const args: string[] = [];
    for (const arg of ctx.args) {
      if (arg === '-s') symbolic = true;
      else args.push(arg);
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
    // Support individual flags like real uname
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

export const commandCmd: Command = {
  name: 'command',
  description: 'Run command or check if command exists',
  async exec(ctx) {
    // Handle -v flag (check if command exists)
    if (ctx.args[0] === '-v' && ctx.args[1]) {
      const cmdName = ctx.args[1];
      const cmd = ctx.shell.commands.get(cmdName);
      if (cmd) {
        ctx.stdout = cmdName + '\n';
        return 0;
      }
      // Check PATH for executable
      const executable = await ctx.shell.findExecutableInPath?.(cmdName);
      if (executable) {
        ctx.stdout = executable + '\n';
        return 0;
      }
      return 1;
    }
    // Handle -V flag (verbose version info)
    if (ctx.args[0] === '-V' && ctx.args[1]) {
      const cmdName = ctx.args[1];
      const cmd = ctx.shell.commands.get(cmdName);
      if (cmd) {
        ctx.stdout = `${cmdName} is a shell builtin\n`;
        return 0;
      }
      ctx.stderr = `command: ${cmdName}: not found\n`;
      return 1;
    }
    // Without flags, execute the command (bypassing shell functions)
    if (ctx.args.length > 0) {
      const cmdName = ctx.args[0];
      const cmd = ctx.shell.commands.get(cmdName);
      if (cmd) {
        const newCtx = { ...ctx, args: ctx.args.slice(1) };
        return await cmd.exec(newCtx);
      }
      ctx.stderr = `command: ${cmdName}: not found\n`;
      return 127;
    }
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

    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '-d' && ctx.args[i + 1]) {
        delimiter = ctx.args[++i];
        // Handle space delimiter specified as -d' ' or -d" "
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
      }
    }

    const lines = ctx.stdin.split('\n');
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
    let algorithm = '1'; // default SHA-1
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
      // Read from stdin
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

// Alias sha256sum -> shasum -a 256
export const sha256sumCmd: Command = {
  name: 'sha256sum',
  description: 'Compute SHA-256 checksums',
  async exec(ctx) {
    // Prepend -a 256 to args
    const newCtx = { ...ctx, args: ['-a', '256', ...ctx.args] };
    return shasumCmd.exec(newCtx);
  },
};

// sh/bash: execute shell commands from stdin or -c flag
export const shCmd: Command = {
  name: 'sh',
  description: 'Execute shell commands',
  async exec(ctx) {
    // sh -c "command" — execute inline command
    const cIdx = ctx.args.indexOf('-c');
    if (cIdx !== -1 && ctx.args[cIdx + 1]) {
      const cmd = ctx.args[cIdx + 1];
      let stdout = '';
      let stderr = '';
      const code = await ctx.shell.execute(cmd, (s) => { stdout += s; }, (s) => { stderr += s; });
      ctx.stdout += stdout;
      ctx.stderr += stderr;
      return code;
    }

    // sh script.sh — execute a script file
    if (ctx.args.length > 0 && !ctx.args[0].startsWith('-')) {
      const scriptPath = ctx.fs.resolvePath(ctx.args[0], ctx.cwd);
      try {
        const content = await ctx.fs.readFile(scriptPath, 'utf8');
        const script = typeof content === 'string' ? content : new TextDecoder().decode(content as any);
        let stdout = '';
        let stderr = '';
        // Execute each line of the script
        for (const line of script.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const code = await ctx.shell.execute(trimmed, (s) => { stdout += s; }, (s) => { stderr += s; });
          if (code !== 0) {
            ctx.stdout += stdout;
            ctx.stderr += stderr;
            return code;
          }
        }
        ctx.stdout += stdout;
        ctx.stderr += stderr;
        return 0;
      } catch (e: any) {
        ctx.stderr += `sh: ${ctx.args[0]}: ${e.message}\n`;
        return 1;
      }
    }

    // Piped input: echo "command" | sh
    if (ctx.stdin) {
      let stdout = '';
      let stderr = '';
      for (const line of ctx.stdin.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const code = await ctx.shell.execute(trimmed, (s) => { stdout += s; }, (s) => { stderr += s; });
        if (code !== 0) {
          ctx.stdout += stdout;
          ctx.stderr += stderr;
          return code;
        }
      }
      ctx.stdout += stdout;
      ctx.stderr += stderr;
      return 0;
    }

    // No input — nothing to do
    return 0;
  },
};

export const bashCmd: Command = {
  name: 'bash',
  description: 'Execute shell commands',
  async exec(ctx) {
    return shCmd.exec(ctx);
  },
};

export const openCmd: Command = {
  name: 'open',
  description: 'Open a URL in the browser',
  async exec(ctx) {
    const url = ctx.args[0];
    if (!url) {
      ctx.stderr = 'Usage: open <url>\n';
      return 1;
    }
    if (typeof window !== 'undefined') {
      try {
        const parsed = new URL(url);
        // OAuth interception: rewrite redirect_uri from localhost to shiro.computer
        if (parsed.searchParams.has('redirect_uri')) {
          const redirectUri = parsed.searchParams.get('redirect_uri')!;
          try {
            const redir = new URL(redirectUri);
            if (redir.hostname === 'localhost' || redir.hostname === '127.0.0.1') {
              const port = redir.port;
              const newRedirectUri = `${window.location.origin}/oauth/callback?port=${port}`;
              parsed.searchParams.set('redirect_uri', newRedirectUri);
              window.open(parsed.toString(), '_blank', 'width=600,height=700');
              return 0;
            }
          } catch {}
        }
        window.open(url, '_blank');
      } catch {
        window.open(url, '_blank');
      }
    }
    return 0;
  },
};

/**
 * Commands that need shell access or override fluffycoreutils bugs.
 * Registered AFTER fluffy commands so they take precedence.
 */
export const shiroOnlyCommands: Command[] = [
  cdCmd, exportCmd, helpCmd, whichCmd, xargsCmd, rmdirCmd, sleepCmd, seqCmd,
  // Overrides for fluffy bugs or Shiro-specific behavior:
  rmCmd, findCmd, lnCmd, hostnameCmd, unameCmd,
  grepCmd, sedCmd, diffCmd,
  // Install script support:
  commandCmd, cutCmd, shasumCmd, sha256sumCmd,
  // Shell interpreters:
  shCmd, bashCmd,
  // Browser helpers:
  openCmd, { name: 'xdg-open', description: 'Open a URL in the browser', exec: (ctx) => openCmd.exec(ctx) },
];
