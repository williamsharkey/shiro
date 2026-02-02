import { Command, CommandContext } from './index';

/**
 * console - Display captured console messages
 *
 * Usage:
 *   console                Show all captured messages
 *   console -n 20          Show last 20 messages
 *   console -e             Show only errors
 *   console -w             Show only warnings
 *   console -l             Show only logs (if capturing enabled)
 *   console -c             Clear captured messages
 *   console --live         Enable live console capture (logs + info)
 *   console | grep error   Filter messages (pipeable)
 *
 * By default, only console.error and console.warn are captured.
 * Use --live to also capture console.log and console.info.
 *
 * Output is to stdout, so it composes with grep, head, tail, etc.
 */

interface CapturedMessage {
  type: 'error' | 'warn' | 'log' | 'info';
  message: string;
  timestamp: number;
}

declare global {
  interface Window {
    __shiroCapturedMessages?: CapturedMessage[];
    __shiroClearMessages?: () => void;
    __shiroConsoleLiveCapture?: boolean;
    __shiroOriginalLog?: typeof console.log;
    __shiroOriginalInfo?: typeof console.info;
  }
}

export const consoleCmd: Command = {
  name: 'console',
  description: 'Display captured console messages (errors, warnings, logs)',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;
    let count: number | null = null;
    let typeFilter: string | null = null;
    let clear = false;
    let enableLive = false;
    let disableLive = false;
    let showStatus = false;

    // Parse args
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
      } else if (arg === '-c' || arg === '--clear') {
        clear = true;
      } else if (arg === '--live') {
        enableLive = true;
      } else if (arg === '--no-live') {
        disableLive = true;
      } else if (arg === '--status') {
        showStatus = true;
      } else if (arg === '-h' || arg === '--help') {
        ctx.stdout = `console [options]
  -n, --last N      Show only last N entries
  -e, --errors      Show only errors
  -w, --warnings    Show only warnings
  -l, --logs        Show only logs
  -i, --info        Show only info
  -c, --clear       Clear captured messages
  --live            Enable live capture (also capture console.log/info)
  --no-live         Disable live capture (only errors/warnings)
  --status          Show capture status
  -h, --help        Show this help

Output format: [TYPE] TIMESTAMP MESSAGE

Examples:
  console                  Show all captured messages
  console -n 20            Show last 20 messages
  console -e               Show only errors
  console | grep fetch     Filter to fetch-related messages
  console --live           Enable log/info capture
  console -c               Clear all captured messages
`;
        return 0;
      }
    }

    // Handle live capture toggle
    if (enableLive) {
      enableLiveCapture();
      ctx.stdout = 'Live capture enabled (now capturing console.log and console.info)\n';
      return 0;
    }

    if (disableLive) {
      disableLiveCapture();
      ctx.stdout = 'Live capture disabled (only capturing console.error and console.warn)\n';
      return 0;
    }

    if (showStatus) {
      const isLive = window.__shiroConsoleLiveCapture || false;
      const messages = window.__shiroCapturedMessages || [];
      const errors = messages.filter(m => m.type === 'error').length;
      const warns = messages.filter(m => m.type === 'warn').length;
      const logs = messages.filter(m => m.type === 'log').length;
      const infos = messages.filter(m => m.type === 'info').length;
      ctx.stdout = `Console capture status:
  Live capture: ${isLive ? 'enabled' : 'disabled'}
  Total messages: ${messages.length}
    Errors: ${errors}
    Warnings: ${warns}
    Logs: ${logs}
    Info: ${infos}
`;
      return 0;
    }

    // Get captured messages
    const messages: CapturedMessage[] = window.__shiroCapturedMessages || [];

    if (clear) {
      if (window.__shiroClearMessages) {
        window.__shiroClearMessages();
      }
      ctx.stdout = 'Console messages cleared.\n';
      return 0;
    }

    // Filter by type
    let filtered = typeFilter
      ? messages.filter(m => m.type === typeFilter)
      : messages;

    // Slice if count specified
    if (count !== null) {
      filtered = filtered.slice(-count);
    }

    if (filtered.length === 0) {
      ctx.stdout = 'No console messages captured.\n';
      if (!window.__shiroConsoleLiveCapture) {
        ctx.stdout += 'Tip: Use "console --live" to also capture console.log/info\n';
      }
      return 0;
    }

    // Output messages
    for (const msg of filtered) {
      const time = new Date(msg.timestamp).toISOString().slice(11, 23);
      const typeLabel = msg.type.toUpperCase().padEnd(5);
      ctx.stdout += `[${typeLabel}] ${time} ${msg.message}\n`;
    }

    return 0;
  },
};

/**
 * Enable live capture of console.log and console.info
 */
function enableLiveCapture(): void {
  if (window.__shiroConsoleLiveCapture) return;

  const messages = window.__shiroCapturedMessages || [];
  const seenMessages = new Set<string>();

  // Populate seen set from existing messages to avoid duplicates
  for (const m of messages) {
    seenMessages.add(m.message);
  }

  // Save original methods
  window.__shiroOriginalLog = console.log;
  window.__shiroOriginalInfo = console.info;

  // Override console.log
  const origLog = console.log;
  console.log = (...args: any[]) => {
    const msg = args.map(a => typeof a === 'string' ? a : (a?.message || String(a))).join(' ').slice(0, 200);
    if (!seenMessages.has(msg)) {
      seenMessages.add(msg);
      messages.push({ type: 'log', message: msg, timestamp: Date.now() });
    }
    origLog.apply(console, args);
  };

  // Override console.info
  const origInfo = console.info;
  console.info = (...args: any[]) => {
    const msg = args.map(a => typeof a === 'string' ? a : (a?.message || String(a))).join(' ').slice(0, 200);
    if (!seenMessages.has(msg)) {
      seenMessages.add(msg);
      messages.push({ type: 'info', message: msg, timestamp: Date.now() });
    }
    origInfo.apply(console, args);
  };

  window.__shiroConsoleLiveCapture = true;
}

/**
 * Disable live capture (restore original console.log/info)
 */
function disableLiveCapture(): void {
  if (!window.__shiroConsoleLiveCapture) return;

  if (window.__shiroOriginalLog) {
    console.log = window.__shiroOriginalLog;
  }
  if (window.__shiroOriginalInfo) {
    console.info = window.__shiroOriginalInfo;
  }

  window.__shiroConsoleLiveCapture = false;
}
