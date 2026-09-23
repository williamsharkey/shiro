/**
 * setup - Sign in to Claude and launch Claude Code.
 *
 * Opens the sign-in panel (a link to the sign-in page plus a box for the code
 * it returns), saves the credentials, then starts Claude Code in a new window.
 * `claude` shows the same panel on its own when you aren't signed in.
 *
 *   setup          # Sign in (again) and launch
 */

import { Command } from './index';
import { openClaudeSignIn } from '../claude-signin';

export const setupCmd: Command = {
  name: 'setup',
  description: 'Sign in to Claude and launch Claude Code',
  async exec(ctx) {
    const signedIn = await openClaudeSignIn({ fs: ctx.fs, cwd: ctx.cwd });
    if (!signedIn) {
      ctx.stdout += 'Sign-in skipped.\n';
      return 1;
    }
    ctx.stdout += 'Signed in. Starting Claude Code in a new window...\n';
    const launch = ctx.shell.commands.get('claude-window');
    return launch ? launch.exec({ ...ctx, args: [], stdout: '', stderr: '' }) : 0;
  },
};
