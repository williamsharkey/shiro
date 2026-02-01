import { Command, CommandContext } from './index';

/**
 * clip-report: Copy terminal session and unique errors/warnings to clipboard.
 * Useful for sharing debug info.
 *
 * Usage:
 *   clip-report              Copy terminal output + errors (100 char limit)
 *   clip-report -l 200       Custom character limit for errors
 *   clip-report --clear      Clear captured errors after copying
 *   clip-report --errors     Only show errors section
 */
export const clipReportCmd: Command = {
  name: 'clip-report',
  description: 'Copy terminal session and errors to clipboard',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args.slice(1);
    let charLimit = 100;
    let clearAfter = false;
    let errorsOnly = false;

    // Parse args
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-l' || args[i] === '--limit') {
        charLimit = parseInt(args[++i]) || 100;
      } else if (args[i] === '--clear' || args[i] === '-c') {
        clearAfter = true;
      } else if (args[i] === '--errors' || args[i] === '-e') {
        errorsOnly = true;
      } else if (args[i] === '--help' || args[i] === '-h') {
        ctx.stdout = `clip-report [options]
  -l, --limit N    Character limit per message (default: 100)
  -c, --clear      Clear captured messages after copying
  -e, --errors     Only copy errors section, not terminal output
  -h, --help       Show this help
`;
        return 0;
      }
    }

    const captured = (window as any).__shiroCapturedMessages || [];
    const clearFn = (window as any).__shiroClearMessages;

    // Get terminal content if available
    let terminalContent = '';
    if (!errorsOnly) {
      const terminal = (ctx.shell as any)._terminal;
      if (terminal && typeof terminal.getBufferContent === 'function') {
        terminalContent = terminal.getBufferContent();
      }
    }

    // Build errors/warnings section
    let errorsSection = '';
    if (captured.length > 0) {
      const errors = captured.filter((m: any) => m.type === 'error');
      const warns = captured.filter((m: any) => m.type === 'warn');

      if (errors.length > 0) {
        errorsSection += `\n--- Errors (${errors.length}) ---\n`;
        errors.forEach((e: any) => {
          errorsSection += `E: ${e.message.slice(0, charLimit)}\n`;
        });
      }

      if (warns.length > 0) {
        errorsSection += `\n--- Warnings (${warns.length}) ---\n`;
        warns.forEach((w: any) => {
          errorsSection += `W: ${w.message.slice(0, charLimit)}\n`;
        });
      }
    }

    // Combine report
    let report = '';
    if (!errorsOnly && terminalContent) {
      report = terminalContent;
    }
    if (errorsSection) {
      report += errorsSection;
    }

    if (!report.trim()) {
      ctx.stdout = 'Nothing to copy (no terminal content or captured messages)\n';
      return 0;
    }

    // Copy to clipboard
    try {
      await navigator.clipboard.writeText(report);
      const stats = [];
      if (!errorsOnly && terminalContent) {
        stats.push(`${terminalContent.split('\n').length} lines`);
      }
      const errors = captured.filter((m: any) => m.type === 'error').length;
      const warns = captured.filter((m: any) => m.type === 'warn').length;
      if (errors > 0) stats.push(`${errors} errors`);
      if (warns > 0) stats.push(`${warns} warnings`);

      ctx.stdout = `Copied to clipboard: ${stats.join(', ')}\n`;

      if (clearAfter && clearFn) {
        clearFn();
        ctx.stdout += 'Captured messages cleared.\n';
      }

      return 0;
    } catch (err) {
      ctx.stderr = `Failed to copy to clipboard: ${err instanceof Error ? err.message : 'unknown error'}\n`;
      return 1;
    }
  },
};
