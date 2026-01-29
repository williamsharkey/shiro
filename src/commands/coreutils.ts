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
    }
    return 0;
  },
};

export const helpCmd: Command = {
  name: 'help',
  description: 'Show available commands',
  async exec(ctx) {
    ctx.stdout = 'Shiro OS - Available commands:\n\n';
    const cmds = ctx.shell.commands.list();
    const maxLen = Math.max(...cmds.map(c => c.name.length));
    for (const cmd of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
      ctx.stdout += `  ${cmd.name.padEnd(maxLen + 2)} ${cmd.description}\n`;
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
    if (ctx.args.includes('-a')) {
      ctx.stdout = 'ShiroOS shiro 0.1.0 WebAssembly browser wasm\n';
    } else {
      ctx.stdout = 'ShiroOS\n';
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
];
