/**
 * ps - list running processes
 * kill - terminate a process by PID
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

export const killCmd: Command = {
  name: 'kill',
  description: 'Kill a process by PID',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stderr = 'Usage: kill <pid>\n';
      return 1;
    }

    const pid = parseInt(ctx.args[0], 10);
    if (isNaN(pid)) {
      ctx.stderr = `kill: invalid PID: ${ctx.args[0]}\n`;
      return 1;
    }

    const proc = processTable.get(pid);
    if (!proc) {
      ctx.stderr = `kill: no such process: ${pid}\n`;
      return 1;
    }

    if (proc.status !== 'running') {
      ctx.stderr = `kill: process ${pid} already ${proc.status}\n`;
      return 1;
    }

    processTable.kill(pid);
    // Close the window too
    if (proc.serverWindow) {
      proc.serverWindow.close();
    }
    ctx.stdout = `Killed [${pid}] ${proc.command}\n`;
    return 0;
  },
};
