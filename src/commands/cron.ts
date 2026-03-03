/**
 * cron.ts — crontab and journalctl commands
 *
 * crontab -l/-e/-r   Manage cron schedules
 * journalctl -u/-n/-f View service logs
 */

import type { Command, CommandContext } from './index';
import { serviceManager } from '../service-manager';

// ── crontab ─────────────────────────────────────────────────────────

export const crontabCmd: Command = {
  name: 'crontab',
  description: 'Maintain crontab files',

  async exec(ctx: CommandContext): Promise<number> {
    serviceManager.bind(ctx.fs, ctx.shell);

    const args = ctx.args;

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      ctx.stdout += 'Usage: crontab [-l | -e | -r] [file]\n';
      ctx.stdout += '\nOptions:\n';
      ctx.stdout += '  -l    List current crontab\n';
      ctx.stdout += '  -e    Edit crontab (loads from file or stdin)\n';
      ctx.stdout += '  -r    Remove crontab\n';
      ctx.stdout += '  file  Install crontab from file\n';
      return args[0] === '--help' || args[0] === '-h' ? 0 : 1;
    }

    if (args[0] === '-l') {
      const entries = await serviceManager.loadCrontab();
      if (entries.length === 0) {
        ctx.stderr += 'no crontab for user\n';
        return 1;
      }
      for (const entry of entries) {
        ctx.stdout += entry.raw + '\n';
      }
      return 0;
    }

    if (args[0] === '-r') {
      try {
        await ctx.fs.unlink('/var/spool/cron/crontabs/user');
      } catch {}
      serviceManager.stopCronDaemon();
      ctx.stdout += 'crontab removed\n';
      return 0;
    }

    if (args[0] === '-e') {
      // In a real system this opens $EDITOR — here just show instructions
      ctx.stderr += 'crontab: interactive editing not supported\n';
      ctx.stderr += 'Use: crontab <file> to install from file\n';
      ctx.stderr += 'Or:  echo "* * * * * command" | crontab -\n';
      return 1;
    }

    // Install from file or stdin
    let content: string;

    if (args[0] === '-') {
      // Read from stdin
      content = ctx.stdin || '';
    } else {
      // Read from file
      const path = args[0].startsWith('/') ? args[0] : ctx.shell.cwd + '/' + args[0];
      try {
        const data = await ctx.fs.readFile(path, 'utf8');
        content = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
      } catch {
        ctx.stderr += `crontab: cannot open '${args[0]}': No such file\n`;
        return 1;
      }
    }

    await serviceManager.saveCrontab(content);
    const entries = serviceManager.getCrontab();
    ctx.stdout += `crontab: installing new crontab (${entries.length} entries)\n`;

    // Auto-start cron daemon
    if (entries.length > 0 && !serviceManager.isCronRunning()) {
      serviceManager.startCronDaemon();
    }
    return 0;
  },
};

// ── journalctl ──────────────────────────────────────────────────────

export const journalctlCmd: Command = {
  name: 'journalctl',
  description: 'Query the journal',

  async exec(ctx: CommandContext): Promise<number> {
    serviceManager.bind(ctx.fs, ctx.shell);

    const args = ctx.args;

    if (args[0] === '--help' || args[0] === '-h') {
      ctx.stdout += 'Usage: journalctl [-u unit] [-n lines] [-f] [--no-pager]\n';
      ctx.stdout += '\nOptions:\n';
      ctx.stdout += '  -u <unit>   Show logs for a specific unit\n';
      ctx.stdout += '  -n <lines>  Number of recent entries to show (default: 10)\n';
      ctx.stdout += '  -f          Follow log output (poll every 2s)\n';
      ctx.stdout += '  --no-pager  Do not pipe through pager\n';
      return 0;
    }

    let unit: string | undefined;
    let count = 10;
    let follow = false;

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '-u':
          unit = args[++i]?.replace(/\.service$/, '');
          break;
        case '-n':
          count = parseInt(args[++i], 10) || 10;
          break;
        case '-f':
          follow = true;
          break;
        case '--no-pager':
          break;
        default:
          if (!args[i].startsWith('-')) {
            unit = args[i].replace(/\.service$/, '');
          }
          break;
      }
    }

    if (follow) {
      return followLogs(ctx, unit, count);
    }

    const entries = serviceManager.getLogs(unit, count);
    if (entries.length === 0) {
      ctx.stdout += '-- No entries --\n';
      return 0;
    }

    for (const entry of entries) {
      ctx.stdout += formatLogEntry(entry) + '\n';
    }
    return 0;
  },
};

function formatLogEntry(entry: import('../service-manager').LogEntry): string {
  const d = new Date(entry.timestamp);
  const month = d.toLocaleString('en', { month: 'short' });
  const day = String(d.getDate()).padStart(2, '0');
  const time = d.toLocaleTimeString('en', { hour12: false });
  const priority = entry.priority === 'error' ? '[ERROR]' : entry.priority === 'warn' ? '[WARN]' : '';
  return `${month} ${day} ${time} shiro ${entry.unit}: ${priority}${priority ? ' ' : ''}${entry.message}`;
}

async function followLogs(
  ctx: CommandContext,
  unit: string | undefined,
  initialCount: number,
): Promise<number> {
  const terminal = ctx.terminal;
  if (!terminal) {
    // Non-interactive: just print what we have
    const entries = serviceManager.getLogs(unit, initialCount);
    for (const entry of entries) {
      ctx.stdout += formatLogEntry(entry) + '\n';
    }
    ctx.stdout += '-- follow mode requires a terminal --\n';
    return 0;
  }

  const write = (s: string) => terminal.writeOutput(s);

  // Print initial entries
  const entries = serviceManager.getLogs(unit, initialCount);
  for (const entry of entries) {
    write(formatLogEntry(entry) + '\r\n');
  }

  let lastCount = serviceManager.getLogs(unit).length;

  return new Promise<number>((resolve) => {
    const interval = setInterval(() => {
      const allEntries = serviceManager.getLogs(unit);
      if (allEntries.length > lastCount) {
        const newEntries = allEntries.slice(lastCount);
        for (const entry of newEntries) {
          write(formatLogEntry(entry) + '\r\n');
        }
        lastCount = allEntries.length;
      }
    }, 2000);

    // Handle Ctrl+C to stop following
    const signal = ctx.shell?.abortController?.signal;
    const cleanup = () => {
      clearInterval(interval);
      resolve(0);
    };

    if (signal) {
      signal.addEventListener('abort', cleanup, { once: true });
    }

    // Also allow terminal raw mode Ctrl+C
    terminal.enterRawMode((key: string) => {
      if (key === '\x03' || key === 'Ctrl+C' || key === 'q') {
        terminal.exitRawMode();
        cleanup();
      }
    });
  });
}
