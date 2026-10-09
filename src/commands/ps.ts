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
    // Live processes, and zombies until their parent reaps them; not the exited windows the table keeps a while
    const procs = processTable.list().filter(p => p.zombie || p.status === 'running' || p.status === 'stopped');
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
      const status = (p.zombie ? 'zombie' : p.status).padEnd(8);
      // one line per process: control characters in a command line show escaped
      const command = p.command.replace(/[\x00-\x1f\x7f]/g, (c) => c === '\n' ? '\\n' : c === '\t' ? '\\t' : '?');
      lines.push(`  ${String(p.pid).padStart(3)}  ${status}  ${time.padStart(5)}  ${command}`);
    }

    ctx.stdout = lines.join('\n') + '\n';
    return 0;
  },
};

/** The real `kill` lives with `trap` (bash builtin semantics, kernel signals) */
export { kill as killCmd } from './trap';
