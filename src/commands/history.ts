import { Command, CommandContext } from './index';

/**
 * history - Display command history
 *
 * Usage:
 *   history              Show all history
 *   history -n 20        Show last 20 commands
 *   history -c           Clear history
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

    // Parse args
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n' || args[i] === '--last') {
        count = parseInt(args[++i]) || 10;
      } else if (args[i] === '-c' || args[i] === '--clear') {
        clear = true;
      } else if (args[i] === '-h' || args[i] === '--help') {
        ctx.stdout = `history [options]
  -n, --last N    Show only last N entries
  -c, --clear     Clear history
  -h, --help      Show this help

Examples:
  history              Show all history
  history -n 20        Show last 20 commands
  history | grep git   Filter to git commands
  history | tail -5    Show last 5 commands
`;
        return 0;
      }
    }

    // Get history from shell
    const history: string[] = ctx.shell.history || [];

    if (clear) {
      ctx.shell.history.length = 0;
      ctx.stdout = 'History cleared.\n';
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
