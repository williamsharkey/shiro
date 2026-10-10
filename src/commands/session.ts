/**
 * Sessions and terminals: tty, setsid, script (util-linux and coreutils).
 *
 * `setsid CMD` runs CMD off the terminal (it can't take the tty or get the
 * terminal's signals), as agents start long-lived programs. `script -c CMD`
 * runs CMD on a pty of its own, so programs see a terminal (isatty, colours,
 * line editing) even when script's own stdout is a pipe, and copies what they
 * write to the log: `script -qc CMD /dev/null` is the usual way to give a
 * program a tty from a script.
 */
import type { Command, CommandContext, TerminalLike } from './index';
import { quoteArgsForShell } from '../shell';
import { ptyOf } from './tty-of';
import { TtySession } from '../kernel/pty';

/** tty [-s]: the terminal on stdin */
export const ttyCmd: Command = {
  name: 'tty',
  description: 'Print the file name of the terminal on standard input',
  async exec(ctx) {
    const silent = ctx.args.some((a) => a === '-s' || a === '--silent' || a === '--quiet');
    const bad = ctx.args.find((a) => !['-s', '--silent', '--quiet'].includes(a));
    if (bad) {
      ctx.stderr += `tty: ${bad.startsWith('-') ? `invalid option -- '${bad.replace(/^-+/, '')}'` : `extra operand '${bad}'`}\n`;
      return 2;
    }
    const pty = ctx.stdinIsTTY ? ptyOf(ctx, [0]) : undefined;
    if (!ctx.stdinIsTTY) {
      if (!silent) ctx.stdout += 'not a tty\n';
      return 1;
    }
    if (!silent) ctx.stdout += `${pty?.name ?? '/dev/pts/0'}\n`;
    return 0;
  },
};

/** Run `argv` in a child shell; resolves to its status */
function runChild(ctx: CommandContext, argv: string[], terminal: TerminalLike | undefined,
  out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const child = ctx.shell.fork();
  child.cwd = ctx.cwd;
  (child as unknown as { terminal?: TerminalLike }).terminal = terminal;
  return ctx.stdin
    ? child.executeWithStdin(quoteArgsForShell(argv), ctx.stdin, out, err)
    : child.execute(quoteArgsForShell(argv), out, err, false, terminal, true);
}

/** setsid [-f] [-w] [-c] COMMAND [ARG]...: COMMAND in a new session, without the terminal */
export const setsidCmd: Command = {
  name: 'setsid',
  description: 'Run a program in a new session',
  async exec(ctx) {
    let fork = false;
    let i = 0;
    for (; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--') { i++; break; }
      if (!a.startsWith('-') || a === '-') break;
      if (a === '-f' || a === '--fork') fork = true;
      else if (a === '-w' || a === '--wait' || a === '-c' || a === '--ctty') { /* waiting is the default here */ }
      else {
        ctx.stderr += `setsid: invalid option -- '${a.replace(/^-+/, '')}'\n`;
        return 1;
      }
    }
    const argv = ctx.args.slice(i);
    if (!argv.length) {
      ctx.stderr += 'setsid: no command specified\n';
      return 1;
    }
    // No terminal: the program can't become the foreground job, read the
    // terminal or get its signals (its output comes back through setsid)
    const term = undefined;
    const out = ctx.streamStdout ?? ((s: string) => { ctx.stdout += s.replace(/\r\n/g, '\n'); });
    const err = ctx.streamStderr ?? ((s: string) => { ctx.stderr += s.replace(/\r\n/g, '\n'); });
    const run = runChild(ctx, argv, term, out, err);
    if (fork) {
      // (like setsid -f: the program goes on; its output still reaches the terminal, if any)
      run.catch(() => {});
      return 0;
    }
    return run;
  },
};

/** script [-q] [-a] [-c COMMAND] [-e] [FILE]: COMMAND on a pty of its own, its output logged to FILE */
export const scriptCmd: Command = {
  name: 'script',
  description: 'Run a command on a terminal, logging its output',
  async exec(ctx) {
    let quiet = false;
    let append = false;
    let command: string | undefined;
    let file: string | undefined;
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '-q' || a === '--quiet') quiet = true;
      else if (a === '-a' || a === '--append') append = true;
      else if (a === '-c' || a === '--command') command = ctx.args[++i];
      else if (a.startsWith('--command=')) command = a.slice(10);
      else if (a === '-O' || a === '--log-out') file = ctx.args[++i];
      else if (a === '-e' || a === '--return' || a === '-f' || a === '--flush') { /* always so here */ }
      else if (a === '-E' || a === '--echo' || a === '-T' || a === '--log-timing' || a === '-I' || a === '--log-in' || a === '-B' || a === '--log-io') i++;
      else if (/^-[qaef]+$/.test(a) && a.length > 2) {
        for (const c of a.slice(1)) { if (c === 'q') quiet = true; else if (c === 'a') append = true; }
      } else if (/^-[qaef]*c$/.test(a)) {
        if (a.includes('q')) quiet = true;
        if (a.includes('a')) append = true;
        command = ctx.args[++i];
      } else if (a.startsWith('-') && a !== '-') {
        ctx.stderr += `script: invalid option -- '${a.replace(/^-+/, '')}'\n`;
        return 1;
      } else file = a;
    }
    if (command === undefined && ctx.stdinIsTTY) {
      ctx.stderr += 'script: an interactive session is not supported here; use script -c COMMAND\n';
      return 1;
    }
    file ??= 'typescript';
    const path = ctx.fs.resolvePath(file, ctx.cwd);
    const toLog = path !== '/dev/null';
    const size = ctx.terminal?.getSize() ?? { rows: Number(ctx.env.LINES) || 24, cols: Number(ctx.env.COLUMNS) || 80 };

    let log = '';
    // (ctx.stdout holds \n lines: the shell writes them to a terminal as \r\n)
    const out = ctx.streamStdout ?? ((s: string) => { ctx.stdout += s.replace(/\r\n/g, '\n'); });
    const show = (s: string) => { out(s); if (toLog) log += s; };
    const dec = new TextDecoder();
    // \n as \r\n (a terminal's ONLCR), also when a \r\n comes in two writes
    let lastCR = false;
    const crlf = (t: string) => {
      const r = t.replace(/\r?\n/g, (m, i: number) => (m === '\n' && i === 0 && lastCR ? '\n' : '\r\n'));
      if (t) lastCR = t.endsWith('\r');
      return r;
    };
    const session = new TtySession({ winsize: { rows: size.rows, cols: size.cols }, onOutput: (b) => show(dec.decode(b, { stream: true })) });
    const term: TerminalLike = {
      tty: session,
      writeOutput: (s) => show(crlf(s)),
      enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {},
      isRawMode: () => false, onResize: () => () => {},
      getSize: () => ({ rows: session.pty.winsize.rows, cols: session.pty.winsize.cols }),
      term: null,
    };
    // What script's stdin has goes to the program through the pty, as typed
    if (ctx.stdin) session.onJobForeground = () => { const s = ctx.stdin; ctx.stdin = ''; if (s) session.pty.input(s); };

    const when = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00:00');
    const header = `Script started on ${when} [${command !== undefined ? `COMMAND="${command}" ` : ''}TERM="${ctx.env.TERM ?? 'xterm-256color'}" TTY="${session.pty.name}" COLUMNS="${size.cols}" LINES="${size.rows}"]\n`;
    if (toLog) log += header;
    if (!quiet) out(`Script started, output log file is '${file}'.\n`);

    let code: number;
    try {
      const child = ctx.shell.fork();
      child.cwd = ctx.cwd;
      child.setTerminal(term as any);
      const line = command ?? ctx.stdin;
      if (command === undefined) ctx.stdin = '';
      code = await child.execute(line, (s) => term.writeOutput(s), (s) => term.writeOutput(s), false, term, true);
    } finally {
      session.dispose();
    }
    if (toLog) {
      log += `\nScript done on ${new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00:00')} [COMMAND_EXIT_CODE="${code}"]\n`;
      try {
        if (append) await ctx.fs.appendFile(path, log);
        else await ctx.fs.writeFile(path, log);
      } catch (e: any) {
        ctx.stderr += `script: cannot open ${file}: ${e?.message ?? e}\n`;
        return 1;
      }
    }
    if (!quiet) out(`Script done, output log file is '${file}'.\n`);
    return code;
  },
};
