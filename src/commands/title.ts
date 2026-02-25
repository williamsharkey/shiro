/**
 * title - set window or document title.
 *
 *   title My App        # Set the spawned window title (or document.title)
 *   title               # Print current title
 */

import { Command } from './index';
import { processTable } from '../process-table';

export const titleCmd: Command = {
  name: 'title',
  description: 'Set window or document title',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stdout = document.title + '\n';
      return 0;
    }
    const newTitle = ctx.args.join(' ');
    // If we're in a spawned window, find it via processTable
    const procs = processTable.list();
    for (const proc of procs) {
      if (proc.windowTerminal === ctx.terminal && proc.serverWindow) {
        proc.serverWindow.setTitle(newTitle);
        return 0;
      }
    }
    // Fallback: set document title
    document.title = newTitle;
    return 0;
  },
};
