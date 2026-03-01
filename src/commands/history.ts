import { Command, CommandContext } from './index';

/**
 * history - Display command history
 *
 * Usage:
 *   history              Show all history
 *   history N            Show last N commands
 *   history -n 20        Show last 20 commands
 *   history -c           Clear history
 *   history -d N         Delete history entry at position N
 *   history -s "cmd"     Append cmd to history without executing
 *   history | grep npm   Filter history (pipeable)
 *
 * Output is to stdout, so it composes with grep, head, tail, etc.
 */
export const historyCmd: Command = {
  name: 'history',
  description: 'Display command history',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;
    let count: number | null = null;
    let clear = false;
    let deletePos: number | null = null;
    let appendCmd: string | null = null;

    // Parse args
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n' || args[i] === '--last') {
        count = parseInt(args[++i]) || 10;
      } else if (args[i] === '-c' || args[i] === '--clear') {
        clear = true;
      } else if (args[i] === '-d') {
        deletePos = parseInt(args[++i]);
        if (isNaN(deletePos)) {
          ctx.stdout = `history: -d: ${args[i]}: numeric argument required\n`;
          return 1;
        }
      } else if (args[i] === '-s') {
        appendCmd = args.slice(i + 1).join(' ');
        break;
      } else if (args[i] === '-h' || args[i] === '--help') {
        ctx.stdout = `history [options]
  -n, --last N    Show only last N entries
  -c, --clear     Clear history
  -d N            Delete history entry at position N
  -s cmd          Append cmd to history without executing
  -h, --help      Show this help

Examples:
  history              Show all history
  history 20           Show last 20 commands
  history -n 20        Show last 20 commands
  history -d 3         Delete 3rd history entry
  history -s "fake"    Add "fake" to history
  history | grep git   Filter to git commands
`;
        return 0;
      } else if (/^\d+$/.test(args[i])) {
        // Bare numeric arg: history N → show last N entries
        count = parseInt(args[i]);
      }
    }

    // Get history from shell
    const history: string[] = ctx.shell.history || [];

    if (clear) {
      ctx.shell.history.length = 0;
      ctx.stdout = 'History cleared.\n';
      return 0;
    }

    if (deletePos !== null) {
      if (deletePos < 1 || deletePos > history.length) {
        ctx.stdout = `history: -d: ${deletePos}: history position out of range\n`;
        return 1;
      }
      history.splice(deletePos - 1, 1);
      return 0;
    }

    if (appendCmd !== null) {
      history.push(appendCmd);
      return 0;
    }

    // Slice if count specified
    const entries = count !== null ? history.slice(-count) : history;
    const startIndex = count !== null ? Math.max(0, history.length - count) : 0;

    // Output with line numbers (like bash history)
    for (let i = 0; i < entries.length; i++) {
      const lineNum = startIndex + i + 1;
      ctx.stdout += `${String(lineNum).padStart(5)}  ${entries[i]}\n`;
    }

    return 0;
  },
};
