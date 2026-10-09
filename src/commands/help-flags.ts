/**
 * `CMD --help` and `CMD --version` for every built-in command: agents and
 * scripts probe tools that way, and most built-ins took the flag for an
 * unknown option or a file name. CommandRegistry.register() wraps each
 * command: with one of the two alone on the command line, the command runs
 * as usual, and if it fails (an error status, nothing printed, or an
 * "unrecognized option"-style complaint) its output is replaced by a
 * generic answer with status 0. Commands that would do something instead
 * of failing (nohup writes nohup.out, mktemp makes a file) always get the
 * generic answer; shell syntax and the shell's own builtins, where the flag
 * is an argument (`echo --help` prints it), are left alone.
 */
import type { Command, CommandContext } from './index';
import { NeedStdin } from '../shell-stdio';

/** tabcomputer's own version, as uname -r reports it */
export const TABCOMPUTER_VERSION = '0.1.0';

/** Shell syntax and the shell's own builtins (`--help` is an argument there: `echo --help` prints it), and launchers */
export const FLAG_IS_ARGUMENT = new Set([
  ':', '[', 'test', 'echo', 'printf', 'true', 'false',
  'case', 'esac', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'in', 'function', 'select',
  'break', 'continue', 'return', 'exit', 'shift', 'exec', 'eval', 'source', '.', 'builtin', 'command', 'time',
  'heredoc', 'process-substitution', 'array', 'glob',
  // builtins the shell runs itself, with their own option rules (set --x sets positional parameters)
  'alias', 'unalias', 'declare', 'typeset', 'export', 'readonly', 'local', 'let', 'set', 'unset', 'read', 'getopts',
  'trap', 'type', 'ulimit', 'umask', 'shopt',
  // launchers of a real program, which answers (or says why it can't start)
  'claude', 'claude-window', 'sc',
]);

/** Commands that ignore the flag and act (or never end): answered without running them */
const ACTS_INSTEAD = new Set([
  'nohup', 'mktemp', 'mkfifo', 'yes', 'watch', 'clear', 'top', 'open', 'xdg-open', 'sensible-browser', 'shrine', 'speak',
  'notify', 'camera', 'listen', 'cv',
]);

/** What a command says when it didn't understand the flag */
const COMPLAINT = /unrecognized|unknown (option|command|predicate)|invalid option|illegal option|not found|No such file|missing (operand|URL|file)|no input/i;

/** The generic answer to `--help`/`--version`, or null if `args` isn't one of them alone. */
export function helpFlagAnswer(cmd: Command, args: string[]): string | null {
  if (args.length !== 1 || FLAG_IS_ARGUMENT.has(cmd.name)) return null;
  if (args[0] === '--version') return `${cmd.name} (tabcomputer) ${TABCOMPUTER_VERSION}\n`;
  if (args[0] === '--help') {
    const what = cmd.description ? `${cmd.description.replace(/\.?$/, '.')}\n` : '';
    return `Usage: ${cmd.name} [OPTION]... [ARG]...\n${what}\ntabcomputer's built-in ${cmd.name}.\n`;
  }
  return null;
}

const WRAPPED = Symbol('help-flags');

/** `cmd` with --help/--version answered when it can't (CommandRegistry.register). */
export function withHelpFlags(cmd: Command): Command {
  if (FLAG_IS_ARGUMENT.has(cmd.name) || (cmd as any)[WRAPPED]) return cmd;
  const exec = cmd.exec;
  return {
    ...cmd,
    [WRAPPED]: true,
    async exec(ctx: CommandContext): Promise<number> {
      const answer = helpFlagAnswer(cmd, ctx.args);
      if (answer === null) return exec.call(cmd, ctx);
      if (ACTS_INSTEAD.has(cmd.name)) {
        ctx.stdout += answer;
        return 0;
      }
      // Its own answer when it has one (git --version, cc --help, ...)
      const out0 = ctx.stdout.length, err0 = ctx.stderr.length;
      let code: number;
      try {
        code = await exec.call(cmd, ctx);
      } catch (e) {
        if (e instanceof NeedStdin) throw e; // execLazyStdin's signal: it runs the command again with stdin
        code = 1; // the flag taken for a file that isn't there, ...
      }
      const said = ctx.stdout.slice(out0) + ctx.stderr.slice(err0);
      if (code === 0 && said.trim() && !COMPLAINT.test(said)) return 0;
      ctx.stdout = ctx.stdout.slice(0, out0) + answer;
      ctx.stderr = ctx.stderr.slice(0, err0);
      return 0;
    },
  } as Command;
}
