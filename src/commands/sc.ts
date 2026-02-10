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

export const scCmd: Command = {
  name: 'sc',
  description: 'Spawn Claude Code in a new terminal window',
  async exec(ctx) {
    const spawnCmd = ctx.shell.commands.get('spawn');
    if (!spawnCmd) {
      ctx.stderr = 'sc: spawn command not available\n';
      return 1;
    }

    // Build the inner command for the spawned shell
    const claudeArgs = ctx.args.length > 0
      ? ' ' + ctx.args.map(a =>
          /^[A-Za-z0-9_\-.,/:=@]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'"
        ).join(' ')
      : '';

    const installAndRun = [
      'which claude > /dev/null 2>&1 || echo "Claude not found. Installing..."',
      'which claude > /dev/null 2>&1 || npm install -g @anthropic-ai/claude-code',
      `claude --dangerously-skip-permissions${claudeArgs}`,
    ];

    return spawnCmd.exec({
      ...ctx,
      args: ['/bin/sh', '-c', installAndRun.join(' && ')],
      stdout: '',
      stderr: '',
    });
  },
};
