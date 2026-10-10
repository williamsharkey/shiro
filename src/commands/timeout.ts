import type { Command } from './index';
import { quoteArgsForShell, terminalForCommand } from '../shell';
import { signalNumber, signalName } from '../kernel/signals';

/** Seconds after the signal before SIGKILL when there is no -k (GNU timeout waits forever) */
const DEFAULT_KILL_AFTER = 5;

/**
 * timeout [OPTION] DURATION COMMAND [ARG]...
 * Runs COMMAND in a forked shell; if it is still running after DURATION it is
 * aborted (loops and pipelines stop at their next check) and timeout exits 124.
 */
export const timeout: Command = {
  name: "timeout",
  description: "Run a command with a time limit",
  async exec(ctx) {
    // Options come before DURATION; everything after it belongs to COMMAND
    let preserveStatus = false;
    let verbose = false;
    let signal = 'TERM';
    let killAfter: string | undefined;
    let i = 0;
    for (; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--') { i++; break; }
      if (!a.startsWith('-') || a === '-') break;
      if (a === '--preserve-status') preserveStatus = true;
      else if (a === '-v' || a === '--verbose') verbose = true;
      else if (a === '--foreground') { /* (COMMAND keeps the tty; the signal still goes to its group) */ }
      else if (a === '-s' || a === '--signal' || a === '-k' || a === '--kill-after') {
        if (a === '-s' || a === '--signal') signal = ctx.args[i + 1] ?? signal;
        else killAfter = ctx.args[i + 1];
        i++;
      } else if (/^--(signal|kill-after)=/.test(a) || /^-[sk]./.test(a)) {
        if (/^(-s|--signal=)/.test(a)) signal = a.replace(/^(-s|--signal=)/, '');
        else killAfter = a.replace(/^(-k|--kill-after=)/, '');
      } else {
        ctx.stderr += `timeout: invalid option -- '${a}'\n`;
        return 125;
      }
    }

    const durationStr = ctx.args[i];
    const command = ctx.args.slice(i + 1);
    if (durationStr === undefined) {
      ctx.stderr += "timeout: missing operand\n";
      return 125;
    }
    const duration = parseDuration(durationStr);
    if (duration === null) {
      ctx.stderr += `timeout: invalid time interval '${durationStr}'\n`;
      return 125;
    }
    if (command.length === 0) {
      ctx.stderr += "timeout: missing operand\n";
      return 125;
    }
    const sig = signalNumber(signal);
    if (sig === undefined || sig === 0) {
      ctx.stderr += `timeout: ${signal}: invalid signal\n`;
      return 125;
    }
    const kill = killAfter === undefined ? null : parseDuration(killAfter);
    if (kill === null && killAfter !== undefined) {
      ctx.stderr += `timeout: invalid time interval '${killAfter}'\n`;
      return 125;
    }

    const child = ctx.shell.fork();
    // The child's own abort (the timeout's), chained to the shell's (Ctrl-C):
    // aborting it must not abort the shell that runs timeout
    // COMMAND's kernel programs get a process group of their own (shell-kernel.ts), as GNU
    // timeout's do: its signal goes to that group, not to a group shared with whoever runs timeout
    const own = Object.assign(new AbortController(), { ownProcessGroup: true });
    const outer = ctx.shell.abortController ?? child.inheritedAbort;
    if (outer?.signal.aborted) own.abort();
    else outer?.signal.addEventListener('abort', () => own.abort(), { once: true });
    child.inheritedAbort = own;
    // Piped or redirected: programs keep the tty for input, their stdout comes back here
    if (ctx.terminal) child.setTerminal(terminalForCommand(ctx.terminal, ctx) as any);
    child.cwd = ctx.cwd;
    let out = '';
    let err = '';
    // A shell running as a kernel process (an agent's `sh -c`) gives COMMAND its
    // live fd 0: reading ctx.stdin would wait for that pipe to close first
    const live = !!ctx.liveStdin && !!ctx.shell.kernelStdio;
    const sink = (s: string) => { out += s; };
    const errSink = (s: string) => { err += s; };
    const run = live
      ? child.execute(quoteArgsForShell(command), ctx.streamStdout ?? sink, ctx.streamStderr ?? errSink, false, undefined, true)
      : child.executeWithStdin(quoteArgsForShell(command), ctx.stdin || '', sink, errSink);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = duration === 0 ? null : new Promise<'timeout'>((resolve) => {
      timer = (globalThis as any).setTimeout(() => resolve('timeout'), duration * 1000);
    });
    const result = await (expired ? Promise.race([run, expired]) : run);
    (globalThis as any).clearTimeout(timer);

    const flush = () => {
      ctx.stdout += out.replace(/\r\n/g, '\n');
      ctx.stderr += err.replace(/\r\n/g, '\n');
    };
    if (result === 'timeout') {
      // The signal goes to COMMAND's programs (a TUI in raw mode ignores the
      // SIGINT a plain abort sends), and timeout waits for COMMAND to end, so
      // the terminal is the shell's again when it returns. -k sends SIGKILL
      // after its delay; without it, one a program ignores still gets
      // SIGKILL after DEFAULT_KILL_AFTER rather than holding the tty forever.
      if (verbose) ctx.stderr += `timeout: sending signal ${signalName(sig)} to command '${command[0]}'\n`;
      // (an AbortError still, for fetch and the like; shell-kernel.ts reads signal and killAfter)
      own.abort(Object.assign(new DOMException('The operation was aborted.', 'AbortError'), { signal: sig, killAfter: (kill ?? DEFAULT_KILL_AFTER) * 1000 }));
      const status = await run;
      flush();
      if (preserveStatus) return status === 130 ? 128 + sig : status; // (130: an in-page command the abort stopped)
      return 124;
    }
    flush();
    return result;
  },
};

function parseDuration(str: string): number | null {
  const match = str.match(/^(\d+(?:\.\d+)?|\.\d+)(s|m|h|d)?$/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] || 's']!;
  return value * mult;
}
