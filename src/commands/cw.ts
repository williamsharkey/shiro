/**
 * cw - Spawn Claude Code in a web-rendered window.
 *
 * Like `sc` but uses native HTML rendering (WebTerminal) instead of xterm.js.
 * Text selection, clickable links, and word wrap all work natively.
 *
 *   cw                    # Launch Claude interactively
 *   cw -p "fix the bug"   # Print mode
 */

import { Command } from './index';
import { processTable } from '../process-table';
import { createServerWindow } from '../server-window';
import { WebTerminal } from '../web-terminal';
import { smartCopyProcess } from '../utils/copy-utils';

export const cwCmd: Command = {
  name: 'cw',
  description: 'Spawn Claude Code in a web-rendered window',
  async exec(ctx) {
    // On mobile, hint about the setup command if not yet authenticated
    const isMobile = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches;
    if (isMobile) {
      try {
        const creds = await ctx.fs.readFile('/home/user/.claude/.credentials.json', 'utf8');
        const parsed = JSON.parse(creds as string);
        if (!parsed.claudeAiOauth?.accessToken) throw new Error('no token');
      } catch {
        if (ctx.terminal) {
          ctx.terminal.writeOutput('\r\n  Tip: Run \x1b[1;33msetup\x1b[0m for a mobile-friendly sign-in experience.\r\n\r\n');
        }
      }
    }

    // Build the command string
    const claudeArgs = ctx.args.length > 0
      ? ' ' + ctx.args.map(a =>
          /^[A-Za-z0-9_\-.,/:=@]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'"
        ).join(' ')
      : '';

    const cmd = `which claude > /dev/null 2>&1 || npm install -g @anthropic-ai/claude-code && claude --dangerously-skip-permissions${claudeArgs}`;

    // Fork shell so spawned process gets its own cwd/env
    const childShell = ctx.shell.fork();

    // Allocate PID
    const proc = processTable.allocate(cmd);

    // Create window
    const win = createServerWindow({
      mode: 'terminal',
      title: `[${proc.pid}] claude (web)`,
      width: '48em',
      height: '28em',
      onClose: () => {
        if (proc.status === 'running') {
          webTerm.forceKill();
          processTable.kill(proc.pid);
        }
        webTerm.dispose();
      },
    });

    // Create WebTerminal inside the window's content div
    const webTerm = new WebTerminal(win.contentDiv!);
    webTerm.secretMasker = (text: string) => childShell.maskSecrets(text);

    // Wire copy/paste buttons — use WebTerminal's getBufferContent
    if (win.setTerminal) {
      // setTerminal expects a WindowTerminal but we satisfy the shape it needs
      const shim = {
        term: webTerm.term,
        getBufferContent: () => webTerm.getBufferContent(),
        get 'getSelection'() { return undefined; },
      };
      win.setTerminal(shim as any);
    }

    // Wire up process table
    proc.windowTerminal = webTerm as any;
    proc.serverWindow = win;
    proc.kill = () => {
      webTerm.forceKill();
      proc.status = 'killed';
      proc.exitCode = 130;
      webTerm.writeOutput('\r\n\x1b[31m[Process killed]\x1b[0m\r\n');
    };

    // Focus
    requestAnimationFrame(() => webTerm.term.focus());

    // Run command async — don't await
    proc.promise = (async () => {
      try {
        const exitCode = await childShell.execute(
          cmd,
          (s: string) => webTerm.writeOutput(s),
          (s: string) => webTerm.writeOutput(`\x1b[31m${s}\x1b[0m`),
          false,
          webTerm as any,
          true,
        );
        if (proc.status === 'running') {
          processTable.markExited(proc.pid, exitCode);
          webTerm.writeOutput(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
        }
        return exitCode;
      } catch (err: any) {
        if (proc.status === 'running') {
          processTable.markExited(proc.pid, 1);
          webTerm.writeOutput(`\r\n\x1b[31m[Process error: ${err.message}]\x1b[0m\r\n`);
        }
        return 1;
      }
    })();

    ctx.stdout = `[${proc.pid}] claude (web)\n`;
    return 0;
  },
};
