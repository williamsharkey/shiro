/**
 * ps - list running processes
 * kill - re-exported from ./trap
 */

import { Command } from './index';
import { processTable } from '../process-table';

export const psCmd: Command = {
  name: 'ps',
  description: 'List running processes',
  async exec(ctx) {
    const procs = processTable.list();
    if (procs.length === 0) {
      ctx.stdout = 'No processes\n';
      return 0;
    }

    // Header
    const lines: string[] = [];
    lines.push('  PID  STATUS     TIME  COMMAND');

    for (const p of procs) {
      const elapsed = Math.floor((Date.now() - p.startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const time = `${mins}:${String(secs).padStart(2, '0')}`;
      const status = p.status.padEnd(8);
      lines.push(`  ${String(p.pid).padStart(3)}  ${status}  ${time.padStart(5)}  ${p.command}`);
    }

    ctx.stdout = lines.join('\n') + '\n';
    return 0;
  },
};

/** The real `kill` lives with `trap` (bash builtin semantics, kernel signals) */
export { kill as killCmd } from './trap';
