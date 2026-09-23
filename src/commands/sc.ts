/**
 * claude-window (alias: sc) - Run Claude Code in a new terminal window.
 *
 * The current terminal is free again immediately. The `claude` command does
 * the install / sign-in work, so this only opens the window.
 *
 *   claude-window                    # Interactive session in a new window
 *   claude-window -p "fix the bug"   # Print mode
 */

import { Command, CommandContext } from './index';

function quoteArgs(args: string[]): string {
  return args.map(a =>
    /^[A-Za-z0-9_\-.,/:=@]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'"
  ).join(' ');
}

async function spawnClaudeWindow(ctx: CommandContext, name: string): Promise<number> {
  const spawnCmd = ctx.shell.commands.get('spawn');
  if (!spawnCmd) {
    ctx.stderr = `${name}: spawn command not available\n`;
    return 1;
  }
  // spawn joins args with spaces and passes to shell.execute(), so use a single string
  const cmd = ctx.args.length > 0 ? `claude ${quoteArgs(ctx.args)}` : 'claude';
  return spawnCmd.exec({ ...ctx, args: [cmd], stdout: '', stderr: '' });
}

export const claudeWindowCmd: Command = {
  name: 'claude-window',
  description: 'Run Claude Code in a new terminal window',
  exec: (ctx) => spawnClaudeWindow(ctx, 'claude-window'),
};

/** Old name, kept so existing muscle memory and docs keep working. */
export const scCmd: Command = {
  name: 'sc',
  description: 'Alias for claude-window',
  exec: (ctx) => spawnClaudeWindow(ctx, 'sc'),
};
