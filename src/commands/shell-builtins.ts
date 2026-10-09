/**
 * Shell builtins — commands that need direct access to ctx.shell.
 *
 * cd, export, help, command, sh, bash, and the POSIX [ bracket alias.
 * Also re-exports grep/sed/diff so they override the unix.ts versions.
 */
import { Command, type CommandContext } from './index';
import { grepCmd, egrepCmd, fgrepCmd } from './grep';
import { sedCmd } from './sed';
import { diffCmd } from './diff';

/** PATH with every symlink resolved (cd -P, pwd -P) */
export async function physicalPath(fs: any, path: string): Promise<string> {
  let cur = '/';
  const parts = path.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cur = fs.resolvePath(parts[i], cur);
    const real = await fs.realpath(cur).catch(() => cur);
    if (real !== cur) cur = real.split('/').length > 2 && i < 40 ? await physicalPath(fs, real) : real;
  }
  return cur;
}

/**
 * cd [-L|-P] [--] [DIR]: no DIR is $HOME, - is $OLDPWD (printed), a relative
 * DIR is looked up in $CDPATH (printed when found there). -L (the default)
 * keeps symlinks in $PWD, -P resolves them. Sets PWD and OLDPWD.
 */
export const cdCmd: Command = {
  name: 'cd',
  description: 'Change directory',
  async exec(ctx) {
    let physical = false;
    const args = [...ctx.args];
    while (args.length && /^-[LPe@]+$/.test(args[0])) {
      for (const c of args.shift()!.slice(1)) if (c === 'P') physical = true; else if (c === 'L') physical = false;
    }
    if (args[0] === '--') args.shift();
    if (args.length > 1) { ctx.stderr = 'cd: too many arguments\n'; return 1; }
    let target = args[0];
    let print = false;
    if (target === undefined) {
      target = ctx.env['HOME'];
      if (target === undefined) { ctx.stderr = 'cd: HOME not set\n'; return 1; }
      if (target === '') return 0;
    } else if (target === '-') {
      target = ctx.env['OLDPWD'];
      if (!target) { ctx.stderr = 'cd: OLDPWD not set\n'; return 1; }
      print = true;
    }
    // (the filesystem follows a symlink only as the last component, so check the physical path)
    const isDir = async (p: string) => (await ctx.fs.stat(await physicalPath(ctx.fs, p)).catch(() => null))?.isDirectory() ?? false;
    const oldPwd = ctx.env['PWD'] || ctx.cwd;
    // Logical: relative to $PWD, with .. taken lexically (each step must exist)
    const logical = async (t: string, base: string): Promise<string | null> => {
      const parts = t.startsWith('/') ? t.split('/') : [...base.split('/'), ...t.split('/')];
      const stack: string[] = [];
      for (const part of parts) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
          if (!(await isDir('/' + stack.join('/')))) return null;
          stack.pop();
        } else stack.push(part);
      }
      const p = '/' + stack.join('/');
      return (await isDir(p)) ? p : null;
    };
    let resolved: string | null = null;
    // $CDPATH for a relative DIR that doesn't start with . or ..
    const cdpath = ctx.env['CDPATH'];
    if (cdpath && !target.startsWith('/') && !/^\.\.?(\/|$)/.test(target)) {
      for (const dir of cdpath.split(':')) {
        const base = dir ? ctx.fs.resolvePath(dir, oldPwd) : oldPwd;
        const r = await logical(target, base);
        if (r) { resolved = r; if (dir) print = true; break; }
      }
    }
    if (!resolved) resolved = await logical(target, oldPwd);
    if (!resolved) {
      const p = ctx.fs.resolvePath(target, oldPwd);
      const st = await ctx.fs.stat(p).catch(() => null);
      ctx.stderr = `cd: ${target}: ${st && !st.isDirectory() ? 'Not a directory' : 'No such file or directory'}\n`;
      return 1;
    }
    const real = await physicalPath(ctx.fs, resolved);
    if (physical) resolved = real;
    // The working directory is the physical path; $PWD keeps the logical one
    ctx.shell.cwd = real;
    ctx.shell.logicalPwd = resolved;
    ctx.shell.env['OLDPWD'] = oldPwd;
    ctx.shell.env['PWD'] = resolved;
    if (print) ctx.stdout += resolved + '\n';
    return 0;
  },
};

// Map of env vars to localStorage keys for persistence across sessions
const PERSIST_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'tabcomputer_anthropic_key',
  OPENAI_API_KEY: 'tabcomputer_openai_key',
  GOOGLE_API_KEY: 'tabcomputer_google_key',
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

const GETTING_STARTED = `tabcomputer: a computer that lives in your browser tab. Files persist in this
site's storage, in this browser.

Install software
  apt install NAME       tabcomputer's prebuilt programs: vim, htop, git, python3, ...
                         (also pkg; pkg available lists them all)
  debian install         stream in Debian 13; then sudo apt install is Debian's apt
  gui                    Linux desktop apps (X11) that open in windows

Claude Code
  claude                 run Claude Code (the profile picks the native or npm build;
                         a missing native build says how to install it)
  claude install --native
                         download the native build (about 240 MB; slow in the emulator)
  claude --npm           the pinned JavaScript build: installed at boot, starts fast
  claude --continue      resume the last conversation in this directory
  claude-window          run it in a new window
  claude login           sign in again / switch accounts

GitHub
  gh auth login          sign in with a one-time code; sets git user.name/email
  gh repo clone o/r      clone (private repos too)
  gh repo create NAME --private --source . --push
  git status | add | commit | push | pull | log | diff

Connect an outside agent
  remote start           get a code; an MCP client (shiro-mcp) can then drive this tab
  console -g PATTERN     search this page's console log (--prev: before the last reload)

Everyday
  ls, cat, grep, sed, rg, find, jq, vi, nano    the usual tools
  node, npm, npx         Node.js (tabcomputer's runtime) and real npm packages
  serve DIR              serve a folder in a preview window
  page :PORT text        read or drive that page (click, input, eval)
  finder                 file manager

Something wrong?
  doctor                 check this tab (deploy, browser, network, sign-ins, storage):
                         paste its output into a bug report (also: tabinfo)
  Issues: https://github.com/williamsharkey/tabcomputer/issues

help --all lists every command; help NAME describes one.
Source and docs: https://github.com/williamsharkey/tabcomputer
`;

export const helpCmd: Command = {
  name: 'help',
  description: 'Getting started (help --all: every command)',
  async exec(ctx) {
    const arg = ctx.args[0];
    if (arg && arg !== '--all' && arg !== '-a') {
      const cmd = ctx.shell.commands.get(arg);
      if (!cmd) { ctx.stderr = `help: no command named '${arg}'\n`; return 1; }
      ctx.stdout = `${cmd.name} - ${cmd.description}\nMore: ${cmd.name} --help\n`;
      return 0;
    }
    if (!arg) {
      ctx.stdout = GETTING_STARTED;
      return 0;
    }
    ctx.stdout = 'tabcomputer - available commands:\n\n';
    const cmds = ctx.shell.commands.list();
    const nameCol = 10;
    for (const cmd of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
      if (cmd.name.length > nameCol) {
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

export const commandCmd: Command = {
  name: 'command',
  description: 'Run command or check if command exists',
  async exec(ctx) {
    if (ctx.args[0] === '-v' && ctx.args[1]) {
      const cmdName = ctx.args[1];
      const cmd = ctx.shell.commands.get(cmdName);
      if (cmd) {
        ctx.stdout = cmdName + '\n';
        return 0;
      }
      const executable = await ctx.shell.findExecutableInPath?.(cmdName);
      if (executable) {
        ctx.stdout = executable + '\n';
        return 0;
      }
      return 1;
    }
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

// sh/bash: execute shell commands from stdin or -c flag
export const shCmd: Command = {
  name: 'sh',
  description: 'Execute shell commands',
  async exec(ctx) {
    return runShell(ctx, 'sh');
  },
};

async function runShell(ctx: CommandContext, invokedAs: 'sh' | 'bash'): Promise<number> {
  {
    // Options before the command string / script: -c, -e, -u, -x, -v, -f, -o NAME, and combined (-ec, -lc)
    const shortOpts: Record<string, string> = { e: 'errexit', u: 'nounset', x: 'xtrace', v: 'verbose', n: 'noexec', f: 'noglob' };
    const options: string[] = [];
    const shopts: [string, boolean][] = [];
    let commandMode = false;
    let interactive = false;
    let i = 0;
    for (; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--' || a === '-') { i++; break; }
      if (a === '-o' || a === '+o') { if (a === '-o' && ctx.args[i + 1]) options.push(ctx.args[i + 1]); i++; continue; }
      // -O NAME / +O NAME: shopt options
      if (a === '-O' || a === '+O') { if (ctx.args[i + 1]) shopts.push([ctx.args[i + 1], a === '-O']); i++; continue; }
      if (a === '--rcfile' || a === '--init-file') { i++; continue; }
      if (/^--(norc|noprofile|posix)$/.test(a)) continue;
      if (!/^[-+][a-zA-Z]+$/.test(a)) break;
      for (const ch of a.slice(1)) {
        if (ch === 'c') commandMode = true;
        else if (ch === 'i' && a[0] === '-') interactive = true;
        else if (a[0] === '-' && shortOpts[ch]) options.push(shortOpts[ch]);
      }
    }
    const rest = ctx.args.slice(i);
    const out = (code: number, stdout: string, stderr: string) => {
      ctx.stdout += stdout.replace(/\r\n/g, '\n');
      ctx.stderr += stderr.replace(/\r\n/g, '\n');
      return code;
    };

    let script: string;
    let argv0: string;
    let positional: string[];
    if (commandMode) {
      if (rest.length === 0) { ctx.stderr += 'sh: -c: option requires an argument\n'; return 2; }
      script = rest[0];
      argv0 = rest[1] ?? 'sh';
      positional = rest.slice(2);
    } else if (rest.length > 0) {
      const scriptPath = ctx.fs.resolvePath(rest[0], ctx.cwd);
      try {
        const content = await ctx.fs.readFile(scriptPath, 'utf8');
        script = typeof content === 'string' ? content : new TextDecoder().decode(content as any);
      } catch (e: any) {
        ctx.stderr += `sh: ${rest[0]}: ${e.message}\n`;
        return 127;
      }
      argv0 = rest[0];
      positional = rest.slice(1);
    } else if (ctx.liveStdin && ctx.shell.kernelStdio) {
      // The script is fd 0 (a shell running as a kernel process, shell-stdio.ts)
      script = await ctx.shell.kernelStdio.readAll();
      argv0 = 'sh';
      positional = [];
    } else if (ctx.stdin) {
      script = ctx.stdin;
      argv0 = 'sh';
      positional = [];
    } else {
      return 0;
    }

    const child = ctx.shell.fork();
    child.startProcess(ctx.shell.execPid, ctx.shell.execPpid);
    child.invokedAsSh = invokedAs === 'sh';
    ctx.shell.execPid = ctx.shell.execPpid = undefined;
    child.setPositional(positional, argv0);
    for (const o of options) child.options.add(o);
    for (const [o, on] of shopts) { if (on) child.shoptopts.add(o); else child.shoptopts.delete(o); }
    child.commandStringFlag = commandMode;
    // An interactive shell starts in emacs editing mode
    if (interactive) { child.interactiveFlag = true; child.options.add('emacs'); }
    // `sh -c` reads the caller's stdin; a script read from stdin has none left.
    // When stdin is the shell's fd 0 the child reads it as it goes.
    if (!ctx.liveStdin && (commandMode || rest.length > 0)) child.setInjectedStdin(ctx.stdin || '');
    else if (ctx.liveStdin && !(commandMode || rest.length > 0)) child.kernelStdinLive = false;
    // Output goes out as each command finishes where nothing captures it
    if (ctx.streamStdout && ctx.streamStderr) {
      return child.runScriptText(script, ctx.terminal, ctx.streamStdout, ctx.streamStderr);
    }
    let stdout = '';
    let stderr = '';
    const code = await child.runScriptText(script, ctx.terminal, (s) => { stdout += s; }, (s) => { stderr += s; });
    return out(code, stdout, stderr);
  }
}

/**
 * times: user and system time of the shell, then of its children. The page
 * has no CPU-time accounting: the shell's elapsed time stands in for its user
 * time, the rest are 0.
 */
export const timesCmd: Command = {
  name: 'times',
  description: 'Print the accumulated times of the shell and its children',
  async exec(ctx) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const t = (ms: number) => `${Math.floor(ms / 60000)}m${((ms % 60000) / 1000).toFixed(3)}s`;
    ctx.stdout += `${t(Math.max(0, now - (ctx.shell.startTime ?? now)))} ${t(0)}\n${t(0)} ${t(0)}\n`;
    return 0;
  },
};

export const bashCmd: Command = {
  name: 'bash',
  description: 'Execute shell commands',
  async exec(ctx) {
    return runShell(ctx, 'bash');
  },
};

/**
 * Shell builtins that need ctx.shell access, plus re-exports that
 * override unix.ts versions. Registered AFTER unix commands.
 */
export const shellBuiltins: Command[] = [
  cdCmd, exportCmd, helpCmd, commandCmd,
  shCmd, bashCmd, timesCmd,
  // Re-exports that override unix.ts versions:
  grepCmd, egrepCmd, fgrepCmd, sedCmd, diffCmd,
  // POSIX test bracket alias (delegates to test command)
  { name: '[', description: 'Evaluate conditional expression', async exec(ctx) {
    const testCmd = ctx.shell.commands.get('test');
    if (ctx.args[ctx.args.length - 1] !== ']') { ctx.stderr += "[: missing ']'\n"; return 2; }
    ctx.args = ctx.args.slice(0, -1);
    if (testCmd) return testCmd.exec(ctx);
    ctx.stderr = '[: test command not found\n';
    return 2;
  }},
];
