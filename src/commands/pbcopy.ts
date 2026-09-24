/**
 * pbcopy / xclip / wl-copy - copy stdin to the browser clipboard.
 *
 * Programs like Claude Code shell out to these to copy text.
 *
 *   echo hi | pbcopy
 */

import { Command, CommandContext } from './index';
import { copyText } from '../utils/osc52';

async function copyStdin(ctx: CommandContext, name: string): Promise<number> {
  if (ctx.args.includes('-o') || ctx.args.includes('--paste')) {
    ctx.stderr += `${name}: reading the clipboard is not supported\n`;
    return 1;
  }
  copyText(ctx.stdin || '');
  return 0;
}

const make = (name: string): Command => ({
  name,
  description: 'Copy stdin to the clipboard',
  exec: (ctx) => copyStdin(ctx, name),
});

export const pbcopyCmd = make('pbcopy');
export const xclipCmd = make('xclip');
export const wlCopyCmd = make('wl-copy');
