import { Command, CommandContext } from './index';

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

export const pwdCmd: Command = {
  name: 'pwd',
  description: 'Print working directory',
  async exec(ctx) {
    ctx.stdout = ctx.cwd + '\n';
    return 0;
  },
};

export const echoCmd: Command = {
  name: 'echo',
  description: 'Display a line of text',
  async exec(ctx) {
    let newline = true;
    let args = ctx.args;
    if (args[0] === '-n') { newline = false; args = args.slice(1); }
    ctx.stdout = args.join(' ') + (newline ? '\n' : '');
    return 0;
  },
};

export const printfCmd: Command = {
  name: 'printf',
  description: 'Format and print data',
  async exec(ctx) {
    if (ctx.args.length === 0) return 0;
    let fmt = ctx.args[0];
    // Very basic: just handle %s and escape sequences
    let argIdx = 1;
    let out = fmt.replace(/%s/g, () => ctx.args[argIdx++] || '');
    out = out.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    ctx.stdout = out;
    return 0;
  },
};

export const lsCmd: Command = {
  name: 'ls',
  description: 'List directory contents',
  async exec(ctx) {
    let showAll = false;
    let showLong = false;
    const paths: string[] = [];

    for (const arg of ctx.args) {
      if (arg.startsWith('-')) {
        if (arg.includes('a')) showAll = true;
        if (arg.includes('l')) showLong = true;
      } else {
        paths.push(arg);
      }
    }

    if (paths.length === 0) paths.push('.');

    for (const p of paths) {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      let stat;
      try { stat = await ctx.fs.stat(resolved); } catch {
        ctx.stderr += `ls: cannot access '${p}': No such file or directory\n`;
        continue;
      }

      if (stat.isFile()) {
        ctx.stdout += formatEntry(p, stat, showLong) + '\n';
        continue;
      }

      const entries = await ctx.fs.readdir(resolved);
      const filtered = showAll ? entries : entries.filter(e => !e.startsWith('.'));

      if (showLong) {
        for (const name of filtered) {
          const childPath = resolved === '/' ? '/' + name : resolved + '/' + name;
          const childStat = await ctx.fs.stat(childPath);
          ctx.stdout += formatEntry(name, childStat, true) + '\n';
        }
      } else {
        ctx.stdout += filtered.join('  ') + (filtered.length ? '\n' : '');
      }
    }
    return 0;
  },
};

function formatEntry(name: string, stat: any, long: boolean): string {
  if (!long) return name;
  const type = stat.isDirectory() ? 'd' : stat.isSymbolicLink?.() ? 'l' : '-';
  const mode = formatMode(stat.mode);
  const size = String(stat.size).padStart(8);
  const date = new Date(stat.mtime).toISOString().slice(0, 16).replace('T', ' ');
  return `${type}${mode}  1 user  user  ${size} ${date} ${name}`;
}

function formatMode(mode: number): string {
  const chars = 'rwx';
  let s = '';
  for (let i = 2; i >= 0; i--) {
    const bits = (mode >> (i * 3)) & 7;
    for (let j = 2; j >= 0; j--) {
      s += bits & (1 << j) ? chars[2 - j] : '-';
    }
  }
  return s;
}

export const catCmd: Command = {
  name: 'cat',
  description: 'Concatenate files and print on stdout',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      // Read from stdin
      ctx.stdout = ctx.stdin;
      return 0;
    }
    for (const arg of ctx.args) {
      const resolved = ctx.fs.resolvePath(arg, ctx.cwd);
      try {
        const content = await ctx.fs.readFile(resolved, 'utf8') as string;
        ctx.stdout += content;
      } catch (e: any) {
        ctx.stderr += `cat: ${arg}: ${e.message}\n`;
        return 1;
      }
    }
    return 0;
  },
};

export const headCmd: Command = {
  name: 'head',
  description: 'Output the first part of files',
  async exec(ctx) {
    let n = 10;
    const files: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      if (ctx.args[i] === '-n' && ctx.args[i + 1]) { n = parseInt(ctx.args[++i]); }
      else if (ctx.args[i].startsWith('-') && !isNaN(parseInt(ctx.args[i].slice(1)))) { n = parseInt(ctx.args[i].slice(1)); }
      else files.push(ctx.args[i]);
    }
    const input = files.length === 0 ? ctx.stdin : null;
    if (input !== null) {
      ctx.stdout = input.split('\n').slice(0, n).join('\n') + '\n';
      return 0;
    }
    for (const f of files) {
      const resolved = ctx.fs.resolvePath(f, ctx.cwd);
      try {
        const content = await ctx.fs.readFile(resolved, 'utf8') as string;
        ctx.stdout += content.split('\n').slice(0, n).join('\n') + '\n';
      } catch (e: any) { ctx.stderr += `head: ${f}: ${e.message}\n`; return 1; }
    }
    return 0;
  },
};

export const tailCmd: Command = {
  name: 'tail',
  description: 'Output the last part of files',
  async exec(ctx) {
    let n = 10;
    const files: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      if (ctx.args[i] === '-n' && ctx.args[i + 1]) { n = parseInt(ctx.args[++i]); }
      else if (ctx.args[i].startsWith('-') && !isNaN(parseInt(ctx.args[i].slice(1)))) { n = parseInt(ctx.args[i].slice(1)); }
      else files.push(ctx.args[i]);
    }
    const input = files.length === 0 ? ctx.stdin : null;
    if (input !== null) {
      const lines = input.split('\n');
      ctx.stdout = lines.slice(-n).join('\n') + '\n';
      return 0;
    }
    for (const f of files) {
      const resolved = ctx.fs.resolvePath(f, ctx.cwd);
      try {
        const content = await ctx.fs.readFile(resolved, 'utf8') as string;
        const lines = content.split('\n');
        ctx.stdout += lines.slice(-n).join('\n') + '\n';
      } catch (e: any) { ctx.stderr += `tail: ${f}: ${e.message}\n`; return 1; }
    }
    return 0;
  },
};

export const mkdirCmd: Command = {
  name: 'mkdir',
  description: 'Make directories',
  async exec(ctx) {
    let recursive = false;
    const dirs: string[] = [];
    for (const arg of ctx.args) {
      if (arg === '-p' || arg === '--parents') recursive = true;
      else dirs.push(arg);
    }
    for (const d of dirs) {
      const resolved = ctx.fs.resolvePath(d, ctx.cwd);
      try { await ctx.fs.mkdir(resolved, { recursive }); }
      catch (e: any) { ctx.stderr += `mkdir: ${e.message}\n`; return 1; }
    }
    return 0;
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

export const cpCmd: Command = {
  name: 'cp',
  description: 'Copy files and directories',
  async exec(ctx) {
    let recursive = false;
    const paths: string[] = [];
    for (const arg of ctx.args) {
      if (arg === '-r' || arg === '-R' || arg === '--recursive') recursive = true;
      else paths.push(arg);
    }
    if (paths.length < 2) { ctx.stderr = 'cp: missing destination\n'; return 1; }
    const dest = paths.pop()!;
    const destResolved = ctx.fs.resolvePath(dest, ctx.cwd);

    for (const src of paths) {
      const srcResolved = ctx.fs.resolvePath(src, ctx.cwd);
      try {
        const stat = await ctx.fs.stat(srcResolved);
        if (stat.isDirectory()) {
          if (!recursive) { ctx.stderr += `cp: -r not specified; omitting directory '${src}'\n`; return 1; }
          await copyDir(ctx.fs, srcResolved, destResolved, ctx.cwd);
        } else {
          const content = await ctx.fs.readFile(srcResolved);
          let finalDest = destResolved;
          const destStat = await ctx.fs.stat(destResolved).catch(() => null);
          if (destStat?.isDirectory()) {
            const basename = src.split('/').pop()!;
            finalDest = destResolved + '/' + basename;
          }
          await ctx.fs.writeFile(finalDest, content as Uint8Array);
        }
      } catch (e: any) { ctx.stderr += `cp: ${e.message}\n`; return 1; }
    }
    return 0;
  },
};

async function copyDir(fs: any, src: string, dest: string, _cwd: string) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src);
  for (const entry of entries) {
    const srcChild = src + '/' + entry;
    const destChild = dest + '/' + entry;
    const stat = await fs.stat(srcChild);
    if (stat.isDirectory()) {
      await copyDir(fs, srcChild, destChild, _cwd);
    } else {
      const content = await fs.readFile(srcChild);
      await fs.writeFile(destChild, content);
    }
  }
}

export const mvCmd: Command = {
  name: 'mv',
  description: 'Move (rename) files',
  async exec(ctx) {
    if (ctx.args.length < 2) { ctx.stderr = 'mv: missing destination\n'; return 1; }
    const dest = ctx.args[ctx.args.length - 1];
    const sources = ctx.args.slice(0, -1);
    const destResolved = ctx.fs.resolvePath(dest, ctx.cwd);

    for (const src of sources) {
      const srcResolved = ctx.fs.resolvePath(src, ctx.cwd);
      try {
        const destStat = await ctx.fs.stat(destResolved).catch(() => null);
        let finalDest = destResolved;
        if (destStat?.isDirectory()) {
          const basename = src.split('/').pop()!;
          finalDest = destResolved + '/' + basename;
        }
        await ctx.fs.rename(srcResolved, finalDest);
      } catch (e: any) { ctx.stderr += `mv: ${e.message}\n`; return 1; }
    }
    return 0;
  },
};

export const touchCmd: Command = {
  name: 'touch',
  description: 'Change file timestamps or create empty files',
  async exec(ctx) {
    for (const arg of ctx.args) {
      const resolved = ctx.fs.resolvePath(arg, ctx.cwd);
      const exists = await ctx.fs.exists(resolved);
      if (!exists) {
        await ctx.fs.writeFile(resolved, '');
      }
      // If exists, we could update mtime but keeping simple
    }
    return 0;
  },
};

export const wcCmd: Command = {
  name: 'wc',
  description: 'Word, line, character, and byte count',
  async exec(ctx) {
    const getContent = async (): Promise<string> => {
      if (ctx.args.length === 0) return ctx.stdin;
      let all = '';
      for (const f of ctx.args) {
        const resolved = ctx.fs.resolvePath(f, ctx.cwd);
        all += await ctx.fs.readFile(resolved, 'utf8') as string;
      }
      return all;
    };
    const content = await getContent();
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    const words = content.split(/\s+/).filter(Boolean).length;
    const chars = content.length;
    ctx.stdout = `  ${lines}  ${words}  ${chars}\n`;
    return 0;
  },
};

export const sortCmd: Command = {
  name: 'sort',
  description: 'Sort lines of text',
  async exec(ctx) {
    let reverse = false;
    let numeric = false;
    let unique = false;
    const files: string[] = [];
    for (const arg of ctx.args) {
      if (arg === '-r') reverse = true;
      else if (arg === '-n') numeric = true;
      else if (arg === '-u') unique = true;
      else files.push(arg);
    }
    let content = ctx.stdin;
    if (files.length > 0) {
      content = '';
      for (const f of files) {
        const resolved = ctx.fs.resolvePath(f, ctx.cwd);
        content += await ctx.fs.readFile(resolved, 'utf8') as string;
      }
    }
    let lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (numeric) {
      lines.sort((a, b) => parseFloat(a) - parseFloat(b));
    } else {
      lines.sort();
    }
    if (reverse) lines.reverse();
    if (unique) lines = [...new Set(lines)];
    ctx.stdout = lines.join('\n') + '\n';
    return 0;
  },
};

export const uniqCmd: Command = {
  name: 'uniq',
  description: 'Report or omit repeated lines',
  async exec(ctx) {
    let countMode = false;
    let dupOnly = false;
    const files: string[] = [];
    for (const arg of ctx.args) {
      if (arg === '-c') countMode = true;
      else if (arg === '-d') dupOnly = true;
      else files.push(arg);
    }
    let content = ctx.stdin;
    if (files.length > 0) {
      const resolved = ctx.fs.resolvePath(files[0], ctx.cwd);
      content = await ctx.fs.readFile(resolved, 'utf8') as string;
    }
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const result: { line: string; count: number }[] = [];
    for (const line of lines) {
      if (result.length > 0 && result[result.length - 1].line === line) {
        result[result.length - 1].count++;
      } else {
        result.push({ line, count: 1 });
      }
    }
    for (const r of result) {
      if (dupOnly && r.count < 2) continue;
      if (countMode) {
        ctx.stdout += `${String(r.count).padStart(7)} ${r.line}\n`;
      } else {
        ctx.stdout += r.line + '\n';
      }
    }
    return 0;
  },
};

export const clearCmd: Command = {
  name: 'clear',
  description: 'Clear the terminal screen',
  async exec(ctx) {
    ctx.stdout = '\x1b[2J\x1b[H';
    return 0;
  },
};

export const envCmd: Command = {
  name: 'env',
  description: 'Display environment variables',
  async exec(ctx) {
    for (const [k, v] of Object.entries(ctx.env)) {
      ctx.stdout += `${k}=${v}\n`;
    }
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

export const trueCmd: Command = {
  name: 'true',
  description: 'Do nothing, successfully',
  async exec() { return 0; },
};

export const falseCmd: Command = {
  name: 'false',
  description: 'Do nothing, unsuccessfully',
  async exec() { return 1; },
};

export const dateCmd: Command = {
  name: 'date',
  description: 'Display the current date and time',
  async exec(ctx) {
    ctx.stdout = new Date().toString() + '\n';
    return 0;
  },
};

export const whoamiCmd: Command = {
  name: 'whoami',
  description: 'Print effective user name',
  async exec(ctx) {
    ctx.stdout = (ctx.env['USER'] || 'user') + '\n';
    return 0;
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

export const teeCmd: Command = {
  name: 'tee',
  description: 'Read from stdin and write to stdout and files',
  async exec(ctx) {
    const append = ctx.args.includes('-a');
    const files = ctx.args.filter(a => a !== '-a');
    ctx.stdout = ctx.stdin;
    for (const f of files) {
      const resolved = ctx.fs.resolvePath(f, ctx.cwd);
      if (append) {
        await ctx.fs.appendFile(resolved, ctx.stdin);
      } else {
        await ctx.fs.writeFile(resolved, ctx.stdin);
      }
    }
    return 0;
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

export const allCoreutils: Command[] = [
  cdCmd, pwdCmd, echoCmd, printfCmd, lsCmd, catCmd, headCmd, tailCmd,
  mkdirCmd, rmdirCmd, rmCmd, cpCmd, mvCmd, touchCmd,
  wcCmd, sortCmd, uniqCmd,
  clearCmd, envCmd, exportCmd, helpCmd,
  trueCmd, falseCmd, dateCmd, whoamiCmd, hostnameCmd, unameCmd,
  teeCmd, xargsCmd,
];
