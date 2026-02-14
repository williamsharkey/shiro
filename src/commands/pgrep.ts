import { Command } from './index';
import { processTable } from '../process-table';

export const pgrepCmd: Command = {
  name: 'pgrep',
  description: 'Find processes by name',
  async exec(ctx) {
    let showName = false;
    let exact = false;
    let pattern = '';

    for (const arg of ctx.args) {
      if (arg === '-l' || arg === '--list-name') showName = true;
      else if (arg === '-x' || arg === '--exact') exact = true;
      else if (!arg.startsWith('-')) pattern = arg;
    }

    if (!pattern) {
      ctx.stderr = 'pgrep: missing pattern\n';
      return 1;
    }

    const procs = processTable.list().filter(p => {
      if (p.status !== 'running') return false;
      if (exact) return p.command === pattern;
      return p.command.includes(pattern);
    });

    if (procs.length === 0) return 1;

    for (const p of procs) {
      ctx.stdout += showName ? `${p.pid} ${p.command}\n` : `${p.pid}\n`;
    }
    return 0;
  },
};

export const pkillCmd: Command = {
  name: 'pkill',
  description: 'Kill processes by name',
  async exec(ctx) {
    let exact = false;
    let pattern = '';

    for (const arg of ctx.args) {
      if (arg === '-x' || arg === '--exact') exact = true;
      else if (!arg.startsWith('-')) pattern = arg;
    }

    if (!pattern) {
      ctx.stderr = 'pkill: missing pattern\n';
      return 1;
    }

    const procs = processTable.list().filter(p => {
      if (p.status !== 'running') return false;
      if (exact) return p.command === pattern;
      return p.command.includes(pattern);
    });

    if (procs.length === 0) return 1;

    for (const p of procs) {
      processTable.kill(p.pid);
      if (p.serverWindow) p.serverWindow.close();
    }
    return 0;
  },
};
