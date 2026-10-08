/**
 * Shell builtins — commands that need direct access to ctx.shell.
 *
 * cd, export, help, command, sh, bash, and the POSIX [ bracket alias.
 * Also re-exports grep/sed/diff so they override the unix.ts versions.
 */
import { Command } from './index';
import { grepCmd, egrepCmd, fgrepCmd } from './grep';
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

const GETTING_STARTED = `Shiro: a Unix-like environment in your browser tab. Files persist in this
site's storage; use a subdomain (e.g. music.shiro.computer) for a separate workspace.

Claude Code
  claude                 run Claude Code here (installs itself; sign-in panel if needed)
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
  node, npm, npx         Node.js (shimmed) and real npm packages
  serve DIR              serve a folder in a preview window
  finder                 file manager

Try: claude "make a small page that plays a drum loop, then serve it"

help --all lists every command; help NAME describes one.
Source and docs: https://github.com/williamsharkey/shiro
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
    ctx.stdout = 'shiro - available commands:\n\n';
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
    // Options before the command string / script: -c, -e, -u, -x, -v, -f, -o NAME, and combined (-ec, -lc)
    const shortOpts: Record<string, string> = { e: 'errexit', u: 'nounset', x: 'xtrace', v: 'verbose', n: 'noexec', f: 'noglob' };
    const options: string[] = [];
    let commandMode = false;
    let i = 0;
    for (; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--' || a === '-') { i++; break; }
      if (a === '-o' || a === '+o') { if (a === '-o' && ctx.args[i + 1]) options.push(ctx.args[i + 1]); i++; continue; }
      if (!/^[-+][a-zA-Z]+$/.test(a)) break;
      for (const ch of a.slice(1)) {
        if (ch === 'c') commandMode = true;
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
    child.setPositional(positional, argv0);
    for (const o of options) child.options.add(o);
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
  },
};

export const bashCmd: Command = {
  name: 'bash',
  description: 'Execute shell commands',
  async exec(ctx) {
    return shCmd.exec(ctx);
  },
};

/**
 * Shell builtins that need ctx.shell access, plus re-exports that
 * override unix.ts versions. Registered AFTER unix commands.
 */
export const shellBuiltins: Command[] = [
  cdCmd, exportCmd, helpCmd, commandCmd,
  shCmd, bashCmd,
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
