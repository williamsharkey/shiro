/**
 * sc - Spawn Claude in a new terminal window.
 *
 * The main terminal is immediately free after running this.
 * Installs Claude Code automatically if not already installed.
 *
 *   sc                    # Launch Claude interactively
 *   sc -p "fix the bug"   # Print mode
 */

import { Command } from './index';
import { claudeLaunchCmd } from '../claude-code-version';

export const scCmd: Command = {
  name: 'sc',
  description: 'Spawn Claude Code in a new terminal window',
  async exec(ctx) {
    const spawnCmd = ctx.shell.commands.get('spawn');
    if (!spawnCmd) {
      ctx.stderr = 'sc: spawn command not available\n';
      return 1;
    }

    // On mobile, hint about the setup command if not yet authenticated
    const isMobile = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches;
    if (isMobile) {
      try {
        const creds = await ctx.fs.readFile('/home/user/.claude/.credentials.json', 'utf8');
        const parsed = JSON.parse(creds as string);
        if (!parsed.claudeAiOauth?.accessToken) throw new Error('no token');
      } catch {
        if (ctx.terminal) {
          ctx.terminal.writeOutput('\r\n  Tip: Run \x1b[1;33msetup\x1b[0m for a mobile-friendly sign-in experience.\r\n\r\n');
        }
      }
    }
    // Build the command string for the spawned shell
    const claudeArgs = ctx.args.length > 0
      ? ' ' + ctx.args.map(a =>
          /^[A-Za-z0-9_\-.,/:=@]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'"
        ).join(' ')
      : '';

    // spawn joins args with spaces and passes to shell.execute(), so use a single string
    const cmd = await claudeLaunchCmd(ctx.fs, claudeArgs);

    return spawnCmd.exec({
      ...ctx,
      args: [cmd],
      stdout: '',
      stderr: '',
    });
  },
};
