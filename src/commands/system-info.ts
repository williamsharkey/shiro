/**
 * System info commands: users, who, w, nice, lsof
 */

import type { Command } from './index';
import { parseArgs } from './flags';
import { processTable } from '../process-table';

export const usersCmd: Command = {
  name: 'users',
  description: 'Print logged-in user names',
  async exec(ctx) {
    ctx.stdout += (ctx.env.USER || 'user') + '\n';
    return 0;
  },
};

export const whoCmd: Command = {
  name: 'who',
  description: 'Show who is logged on',
  async exec(ctx) {
    const { flags } = parseArgs(ctx.args);
    const user = ctx.env.USER || 'user';
    const bootTime = new Date(Date.now() - 86400000); // 1 day ago
    const loginTime = new Date(typeof performance !== 'undefined' ? performance.timeOrigin : Date.now());
    const timeFmt = (d: Date): string => {
      const Y = d.getFullYear();
      const M = String(d.getMonth() + 1).padStart(2, '0');
      const D = String(d.getDate()).padStart(2, '0');
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      return `${Y}-${M}-${D} ${h}:${m}`;
    };

    if (flags.q) {
      ctx.stdout += `${user}\n# users=1\n`;
      return 0;
    }

    if (flags.b) {
      ctx.stdout += `         system boot  ${timeFmt(bootTime)}\n`;
      return 0;
    }

    const lines: string[] = [];
    if (flags.H) {
      lines.push('NAME     LINE         TIME');
    }
    lines.push(`${user.padEnd(8)} pts/0        ${timeFmt(loginTime)}`);
    ctx.stdout += lines.join('\n') + '\n';
    return 0;
  },
};

export const wCmd: Command = {
  name: 'w',
  description: 'Show who is logged on and what they are doing',
  async exec(ctx) {
    const { flags } = parseArgs(ctx.args);
    const user = ctx.env.USER || 'user';
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];

    const uptimeSec = typeof performance !== 'undefined'
      ? Math.floor((Date.now() - performance.timeOrigin) / 1000)
      : 3600;
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const upStr = days > 0
      ? `${days} day${days !== 1 ? 's' : ''}, ${hours}:${String(mins).padStart(2, '0')}`
      : `${hours}:${String(mins).padStart(2, '0')}`;

    const lines: string[] = [];
    if (!flags.h) {
      lines.push(` ${timeStr} up ${upStr},  1 user,  load average: 0.50, 0.40, 0.35`);
      if (!flags.s) {
        lines.push('USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT');
      }
    }

    const loginHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (flags.s) {
      lines.push(`${user.padEnd(8)} pts/0    -                ${loginHM}    0.00s sh`);
    } else {
      lines.push(`${user.padEnd(8)} pts/0    -                ${loginHM}    0.00s  0.01s  0.00s sh`);
    }

    ctx.stdout += lines.join('\n') + '\n';
    return 0;
  },
};

export const niceCmd: Command = {
  name: 'nice',
  description: 'Run a command with modified scheduling priority',
  async exec(ctx) {
    const { values, positional } = parseArgs(ctx.args, ['n']);

    if (positional.length === 0) {
      ctx.stdout += '0\n';
      return 0;
    }

    // Run the command, ignoring the priority adjustment (browser has no scheduling)
    const cmdStr = positional.join(' ');
    let stdout = '';
    let stderr = '';
    const exitCode = await ctx.shell.execute(
      cmdStr,
      (s: string) => { stdout += s; },
      (s: string) => { stderr += s; }
    );
    ctx.stdout += stdout;
    ctx.stderr += stderr;
    return exitCode;
  },
};

export const lsofCmd: Command = {
  name: 'lsof',
  description: 'List open files and network connections',
  async exec(ctx) {
    try {
      const { flags, values } = parseArgs(ctx.args, ['p']);
      const filterPid = values.p ? parseInt(values.p, 10) : 0;
      const networkOnly = flags.i;

      const procs = processTable.list();

      // Try to get servers list
      let servers: Array<{ port: number; dir: string }> = [];
      try {
        const mod = await import('../iframe-server');
        if (mod && typeof (mod as any).getActiveServers === 'function') {
          servers = (mod as any).getActiveServers() || [];
        }
      } catch {}

      const lines: string[] = [];
      lines.push('COMMAND     PID   USER   FD   TYPE   NAME');

      if (!networkOnly) {
        for (const p of procs) {
          if (filterPid && p.pid !== filterPid) continue;
          const user = ctx.env.USER || 'user';
          lines.push(`${p.command.slice(0, 10).padEnd(10)}  ${String(p.pid).padStart(3)}   ${user.padEnd(5)}  cwd    DIR    ${ctx.cwd}`);
        }
      }

      for (const s of servers) {
        if (filterPid) continue;
        const user = ctx.env.USER || 'user';
        lines.push(`serve${' '.repeat(5)}    -   ${user.padEnd(5)}  ${String(s.port).padStart(3)}u   IPv4   *:${s.port} (LISTEN)`);
      }

      if (lines.length === 1 && !networkOnly) {
        // No processes, show shell itself
        const user = ctx.env.USER || 'user';
        lines.push(`sh${' '.repeat(8)}    1   ${user.padEnd(5)}  cwd    DIR    ${ctx.cwd}`);
      }

      ctx.stdout += lines.join('\n') + '\n';
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `lsof: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
