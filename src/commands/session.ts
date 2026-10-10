/**
 * tty, setsid, script: what a command's terminal is, running a command
 * without one, and running one on a fresh one (williamsharkey/tabcomputer#14).
 */
import type { Command, TerminalLike } from './index';
import { quoteArgsForShell, withoutTty } from '../shell';
import { TtySession } from '../kernel/pty';
import { ptyOf } from './tty-of';

/** tty [-s]: the terminal on stdin, or "not a tty" (exit 1) */
export const ttyCmd: Command = {
  name: 'tty',
  description: 'Print the file name of the terminal connected to standard input',
  async exec(ctx) {
    const silent = ctx.args.includes('-s') || ctx.args.includes('--silent') || ctx.args.includes('--quiet');
    const pty = ctx.stdinIsTTY === false ? undefined : ptyOf(ctx, [0]);
    if (!silent) ctx.stdout += pty ? `${pty.name}\n` : 'not a tty\n';
    return pty ? 0 : 1;
  },
};

/** Options before the command; `withValue` options take the next word */
function splitOptions(args: string[], withValue: string[] = []): { opts: Set<string>; values: Record<string, string>; rest: string[] } {
  const opts = new Set<string>();
  const values: Record<string, string> = {};
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (!a.startsWith('-') || a === '-') break;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { values[a.slice(0, eq)] = a.slice(eq + 1); continue; }
    if (withValue.includes(a)) { values[a] = args[++i] ?? ''; continue; }
    if (!a.startsWith('--') && a.length > 2) {
      // bundled short flags; one taking a value ends the bundle (-qc CMD)
      for (let j = 1; j < a.length; j++) {
        const f = `-${a[j]}`;
        if (withValue.includes(f)) { values[f] = a.slice(j + 1) || args[++i] || ''; break; }
        opts.add(f);
      }
      continue;
    }
    opts.add(a);
  }
  return { opts, values, rest: args.slice(i) };
}

/**
 * setsid [-f] [-w] COMMAND [ARG]...: COMMAND in a session of its own, with no
 * controlling terminal, so the terminal's Ctrl-C and its caller's kill don't
 * reach it. -f returns at once and leaves it running; otherwise setsid waits
 * and returns its status.
 */
export const setsidCmd: Command = {
  name: 'setsid',
  description: 'Run a program in a new session',
  async exec(ctx) {
    const { opts, rest } = splitOptions(ctx.args);
    if (opts.has('-h') || opts.has('--help')) {
      ctx.stdout += 'Usage: setsid [-f] [-w] <program> [arguments ...]\n';
      return 0;
    }
    if (rest.length === 0) {
      ctx.stderr += 'setsid: no command specified\n';
      return 1;
    }
    const fork = opts.has('-f') || opts.has('--fork');
    const child = ctx.shell.fork();
    // A new session: none of the caller's aborts (Ctrl-C, timeout, the caller ending) reach it
    child.inheritedAbort = new AbortController();
    child.cwd = ctx.cwd;
    if (ctx.terminal) child.setTerminal(withoutTty(ctx.terminal) as any);
    const command = quoteArgsForShell(rest);

    if (fork) {
      // Output goes where the caller's went while it is there: the screen, or nowhere
      const toScreen = ctx.terminal && ctx.stdoutIsTTY !== false ? (s: string) => ctx.terminal!.writeOutput(s.replace(/\r?\n/g, '\r\n')) : () => {};
      void child.executeWithStdin(command, '', toScreen, toScreen).catch(() => {});
      return 0;
    }

    let out = '';
    let err = '';
    const run = child.executeWithStdin(command, ctx.stdin || '', ctx.streamStdout ?? ((s) => { out += s; }), ctx.streamStderr ?? ((s) => { err += s; }));
    // The caller interrupted: stop waiting; COMMAND goes on in its session
    const outer = ctx.shell.abortController?.signal;
    const interrupted = outer && new Promise<number>((resolve) => {
      if (outer.aborted) resolve(130);
      else outer.addEventListener('abort', () => resolve(130), { once: true });
    });
    const status = await (interrupted ? Promise.race([run, interrupted]) : run);
    ctx.stdout += out.replace(/\r\n/g, '\n');
    ctx.stderr += err.replace(/\r\n/g, '\n');
    return status;
  },
};

/**
 * A terminal with no screen: a pty session whose output goes to `sink`.
 * Programs on it see a tty (isatty, TIOCGWINSZ, /dev/pts/N); nothing types.
 */
class HeadlessTerminal implements TerminalLike {
  readonly tty: TtySession;
  term = null;
  private raw = false;

  constructor(private sink: (s: string) => void, private size: { rows: number; cols: number }) {
    const decoder = new TextDecoder();
    this.tty = new TtySession({ winsize: size, onOutput: (b) => sink(decoder.decode(b, { stream: true })) });
  }

  writeOutput(text: string): void { this.sink(text.replace(/\r?\n/g, '\r\n')); }
  enterStdinPassthrough(): void {}
  exitStdinPassthrough(): void {}
  enterRawMode(): void { this.raw = true; }
  exitRawMode(): void { this.raw = false; }
  isRawMode(): boolean { return this.raw; }
  onResize(): () => void { return () => {}; }
  getSize(): { rows: number; cols: number } { return this.size; }
  dispose(): void { this.tty.dispose(); }
}

/**
 * script [-q] [-a] [-e] [-c COMMAND] [FILE]: COMMAND on a new pty, its output
 * copied to FILE (default ./typescript; /dev/null for none). What scripts use
 * to make a program believe it is on a terminal: `script -qc 'cmd' /dev/null`.
 * Returns COMMAND's status.
 */
export const scriptCmd: Command = {
  name: 'script',
  description: 'Run a command on a new terminal and record its output',
  async exec(ctx) {
    const { opts, values, rest } = splitOptions(ctx.args, ['-c', '--command', '-O', '--log-out', '-E', '--echo']);
    if (opts.has('-h') || opts.has('--help')) {
      ctx.stdout += 'Usage: script [-a] [-q] [-e] [-c command] [file]\n';
      return 0;
    }
    const quiet = opts.has('-q') || opts.has('--quiet');
    const append = opts.has('-a') || opts.has('--append');
    const command = values['-c'] ?? values['--command'];
    if (command === undefined) {
      ctx.stderr += 'script: an interactive session needs a terminal here; use script -c COMMAND\n';
      return 1;
    }
    const file = values['-O'] ?? values['--log-out'] ?? rest[0] ?? 'typescript';
    const path = file === '/dev/null' ? null : ctx.fs.resolvePath(file, ctx.cwd);

    let log = '';
    const toCaller = ctx.terminal && ctx.stdoutIsTTY !== false
      ? (s: string) => ctx.terminal!.writeOutput(s)
      : ctx.streamStdout ?? ((s: string) => { ctx.stdout += s; });
    const sink = (s: string) => { log += s; toCaller(s); };
    const size = ctx.terminal?.getSize() ?? { rows: 24, cols: 80 };
    const term = new HeadlessTerminal(sink, size);

    const started = new Date();
    const header = `Script started on ${stamp(started)} [COMMAND="${command}" TERM="${ctx.env.TERM ?? 'xterm-256color'}" COLUMNS="${size.cols}" LINES="${size.rows}"]\n`;
    if (!quiet) ctx.stderr += `Script started, output log file is '${file}'.\n`;

    const child = ctx.shell.fork();
    child.cwd = ctx.cwd;
    child.setTerminal(term as any);
    const own = new AbortController();
    const outer = ctx.shell.abortController ?? child.inheritedAbort;
    if (outer?.signal.aborted) own.abort();
    else outer?.signal.addEventListener('abort', () => own.abort(), { once: true });
    child.inheritedAbort = own;
    let status: number;
    try {
      status = await child.execute(command, (s) => term.writeOutput(s), (s) => term.writeOutput(s), false, term);
    } finally {
      term.dispose();
    }

    if (!quiet) ctx.stderr += `Script done, output log file is '${file}'.\n`;
    if (path) {
      const footer = `\nScript done on ${stamp(new Date())} [COMMAND_EXIT_CODE="${status}"]\n`;
      let before = '';
      if (append) {
        try {
          const old = await ctx.fs.readFile(path);
          before = typeof old === 'string' ? old : new TextDecoder().decode(old);
        } catch { /* a new file */ }
      }
      try {
        await ctx.fs.writeFile(path, before + header + log + footer);
      } catch (e: any) {
        ctx.stderr += `script: cannot open ${file}: ${e.message}\n`;
        return 1;
      }
    }
    return status;
  },
};

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`;
}
