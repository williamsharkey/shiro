import { Command, CommandContext } from './index';

/**
 * console - Display and copy captured console messages
 *
 * Usage:
 *   console                Show all captured messages
 *   console -n 20          Show last 20 messages
 *   console -e             Show only errors
 *   console -w             Show only warnings
 *   console -l             Show only logs
 *   console -c             Clear captured messages
 *   console --copy         Dedupe and copy all messages to clipboard
 *   console -e --copy      Dedupe errors only, copy to clipboard
 *   console | grep error   Filter messages (pipeable)
 *
 * All console methods (log, info, warn, error, debug) are captured from boot.
 *
 * Browser console shortcut:
 *   copy(__shiroCapturedMessages.map(m=>m.type+': '+m.message).filter((v,i,a)=>a.indexOf(v)===i).join('\n'))
 */

interface CapturedMessage {
  type: 'error' | 'warn' | 'log' | 'info' | 'debug';
  message: string;
  timestamp: number;
}

declare global {
  interface Window {
    __shiroCapturedMessages?: CapturedMessage[];
    __shiroClearMessages?: () => void;
  }
}

export const consoleCmd: Command = {
  name: 'console',
  description: 'Display captured console messages (all methods captured from boot)',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;
    let count: number | null = null;
    let typeFilter: string | null = null;
    let clear = false;
    let copy = false;
    let showStatus = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-n' || arg === '--last') {
        count = parseInt(args[++i]) || 10;
      } else if (arg === '-e' || arg === '--errors') {
        typeFilter = 'error';
      } else if (arg === '-w' || arg === '--warnings') {
        typeFilter = 'warn';
      } else if (arg === '-l' || arg === '--logs') {
        typeFilter = 'log';
      } else if (arg === '-i' || arg === '--info') {
        typeFilter = 'info';
      } else if (arg === '-d' || arg === '--debug') {
        typeFilter = 'debug';
      } else if (arg === '-c' || arg === '--clear') {
        clear = true;
      } else if (arg === '--copy' || arg === '-C') {
        copy = true;
      } else if (arg === '--status') {
        showStatus = true;
      } else if (arg === '-h' || arg === '--help') {
        ctx.stdout = `console [options]
  -n, --last N      Show only last N entries
  -e, --errors      Show only errors
  -w, --warnings    Show only warnings
  -l, --logs        Show only logs
  -i, --info        Show only info
  -d, --debug       Show only debug
  -c, --clear       Clear captured messages
  -C, --copy        Dedupe and copy to clipboard
  --status          Show capture stats
  -h, --help        Show this help

All console methods are captured from boot (no --live needed).

Examples:
  console                  Show all captured messages
  console -n 20            Show last 20
  console -e               Show only errors
  console -e --copy        Copy deduped errors to clipboard
  console --copy           Copy all deduped messages to clipboard
  console | grep fetch     Filter with grep
  console -c               Clear all
`;
        return 0;
      }
    }

    if (showStatus) {
      const messages = window.__shiroCapturedMessages || [];
      const errors = messages.filter(m => m.type === 'error').length;
      const warns = messages.filter(m => m.type === 'warn').length;
      const logs = messages.filter(m => m.type === 'log').length;
      const infos = messages.filter(m => m.type === 'info').length;
      const debugs = messages.filter(m => m.type === 'debug').length;
      ctx.stdout = `Console capture: ${messages.length} total (${errors} errors, ${warns} warns, ${logs} logs, ${infos} info, ${debugs} debug)\n`;
      return 0;
    }

    const messages: CapturedMessage[] = window.__shiroCapturedMessages || [];

    if (clear) {
      if (window.__shiroClearMessages) {
        window.__shiroClearMessages();
      }
      ctx.stdout = 'Console messages cleared.\n';
      return 0;
    }

    let filtered = typeFilter
      ? messages.filter(m => m.type === typeFilter)
      : messages;

    if (count !== null) {
      filtered = filtered.slice(-count);
    }

    if (filtered.length === 0) {
      ctx.stdout = 'No console messages captured.\n';
      return 0;
    }

    // Build output lines
    const lines: string[] = [];
    for (const msg of filtered) {
      const time = new Date(msg.timestamp).toISOString().slice(11, 23);
      const typeLabel = msg.type.toUpperCase().padEnd(5);
      lines.push(`[${typeLabel}] ${time} ${msg.message}`);
    }

    if (copy) {
      // Dedupe the message content (ignore timestamps for dedup)
      const deduped = [...new Set(filtered.map(m => m.type.toUpperCase() + ': ' + m.message))];
      const text = deduped.join('\n');
      try {
        await navigator.clipboard.writeText(text);
        ctx.stdout = `${filtered.length} messages → ${deduped.length} unique, copied to clipboard\n`;
      } catch {
        // Clipboard may fail without user gesture — output to stdout instead
        ctx.stdout = text + '\n';
        ctx.stderr = 'Clipboard unavailable, output printed instead\n';
      }
      return 0;
    }

    ctx.stdout = lines.join('\n') + '\n';
    return 0;
  },
};
