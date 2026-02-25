/**
 * spawn - run a command in a new windowed terminal.
 *
 *   spawn                              # open a blank interactive window
 *   spawn claude --dangerously-skip-permissions
 *   spawn node server.js
 *   spawn sh
 */

import { Command } from './index';
import { processTable } from '../process-table';
import { createServerWindow } from '../server-window';
import { WindowTerminal } from '../window-terminal';
import { iframeServer } from '../iframe-server';
import { injectIframeScripts } from './serve';
import type { Shell } from '../shell';

/**
 * Spawn a new windowed terminal, optionally running a command first.
 * After the command finishes (or immediately if no command), starts an
 * interactive REPL so the user can type more commands.
 *
 * @param splitPort — if set, show the served page in a split iframe inside the window after the command finishes
 *
 * Exported for use by template palette and other callers.
 */
export function spawnInWindow(
  shell: Shell,
  command?: string,
  title?: string,
  splitPort?: number,
): { pid: number; promise: Promise<number> } {
  const childShell = shell.fork();
  const label = command || 'terminal';
  const proc = processTable.allocate(label);

  // Guard against reentrant close (forceKill → forceExitCb → win.close → onClose)
  let closing = false;
  let replResolve: (() => void) | null = null;

  const doClose = () => {
    if (closing) return;
    closing = true;
    if (proc.status === 'running') {
      winTerm.forceKill();
      processTable.kill(proc.pid);
    }
    winTerm.dispose();
    replResolve?.();
  };

  const win = createServerWindow({
    mode: 'terminal',
    title: title || (command ? `[${proc.pid}] ${command.split(/\s/)[0]}` : `[${proc.pid}] terminal`),
    width: splitPort ? '64em' : '48em',
    height: '28em',
    onClose: doClose,
  });

  const winTerm = new WindowTerminal(win.contentDiv!);
  winTerm.secretMasker = (text: string) => childShell.maskSecrets(text);
  win.setTerminal?.(winTerm);

  proc.windowTerminal = winTerm;
  proc.serverWindow = win;
  proc.kill = () => {
    winTerm.forceKill();
    proc.status = 'killed';
    proc.exitCode = 130;
    winTerm.writeOutput('\r\n\x1b[31m[Process killed]\x1b[0m\r\n');
    replResolve?.();
  };

  requestAnimationFrame(() => winTerm.term.focus());

  /** Try to show the split iframe for the served port */
  const tryShowSplit = async (port: number) => {
    if (!iframeServer.isPortInUse(port) || !win.showSplit) return;
    try {
      const response = await iframeServer.fetch(port, '/');
      let html: string;
      if (typeof response.body === 'string') {
        html = response.body;
      } else if (response.body instanceof Uint8Array) {
        html = new TextDecoder().decode(response.body);
      } else {
        html = '<!DOCTYPE html><html><body></body></html>';
      }
      html = injectIframeScripts(html, port);
      iframeServer.ensureResourceProxy();
      win.showSplit(html, port);
    } catch {}
  };

  /** Start an interactive REPL in the window */
  const startRepl = () => {
    let lineBuffer = '';
    let cursorPos = 0;

    const showPrompt = () => {
      const cwd = childShell.cwd.replace(/^\/home\/user/, '~');
      winTerm.writeOutput(`\x1b[36m${cwd}\x1b[0m $ `);
    };

    showPrompt();

    winTerm.enterStdinPassthrough((data: string) => {
      // Ctrl+D — close window
      if (data === '\x04') {
        doClose();
        win.close();
        return;
      }
      // Ctrl+C — clear line
      if (data === '\x03') {
        lineBuffer = '';
        cursorPos = 0;
        winTerm.writeOutput('^C\r\n');
        showPrompt();
        return;
      }
      // Enter — execute line
      if (data === '\r' || data === '\n') {
        winTerm.writeOutput('\r\n');
        const cmd = lineBuffer.trim();
        lineBuffer = '';
        cursorPos = 0;
        if (!cmd) {
          showPrompt();
          return;
        }
        winTerm.exitStdinPassthrough();
        childShell.execute(
          cmd,
          (s: string) => winTerm.writeOutput(s),
          (s: string) => winTerm.writeOutput(`\x1b[31m${s}\x1b[0m`),
          false,
          winTerm,
          true,
        ).then(() => {
          if (proc.status === 'running') {
            startRepl();
          }
        }).catch(() => {
          if (proc.status === 'running') {
            startRepl();
          }
        });
        return;
      }
      // Backspace
      if (data === '\x7f' || data === '\b') {
        if (cursorPos > 0) {
          lineBuffer = lineBuffer.slice(0, cursorPos - 1) + lineBuffer.slice(cursorPos);
          cursorPos--;
          const tail = lineBuffer.slice(cursorPos);
          winTerm.writeOutput(`\b${tail} \x1b[${tail.length + 1}D`);
        }
        return;
      }
      // Regular character(s)
      if (data >= ' ' || data.length > 1) {
        lineBuffer = lineBuffer.slice(0, cursorPos) + data + lineBuffer.slice(cursorPos);
        cursorPos += data.length;
        const tail = lineBuffer.slice(cursorPos);
        winTerm.writeOutput(data + tail);
        if (tail.length > 0) winTerm.writeOutput(`\x1b[${tail.length}D`);
      }
    }, () => {
      // Force exit callback (double Ctrl+C)
      doClose();
      win.close();
    });
  };

  proc.promise = (async () => {
    try {
      if (command) {
        const exitCode = await childShell.execute(
          command,
          (s: string) => winTerm.writeOutput(s),
          (s: string) => winTerm.writeOutput(`\x1b[31m${s}\x1b[0m`),
          false,
          winTerm,
          true,
        );
        if (proc.status !== 'running') return exitCode;
        winTerm.writeOutput(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      }
      // Show split iframe if requested
      if (splitPort && proc.status === 'running') {
        await tryShowSplit(splitPort);
      }
      // Drop into interactive REPL
      if (proc.status === 'running') {
        startRepl();
        // Keep the process alive until window is closed
        await new Promise<void>((resolve) => {
          replResolve = resolve;
        });
      }
      return 0;
    } catch (err: any) {
      if (proc.status === 'running') {
        processTable.markExited(proc.pid, 1);
        winTerm.writeOutput(`\r\n\x1b[31m[Process error: ${err.message}]\x1b[0m\r\n`);
      }
      return 1;
    }
  })();

  return { pid: proc.pid, promise: proc.promise };
}

export const spawnCmd: Command = {
  name: 'spawn',
  description: 'Run a command in a new windowed terminal',
  async exec(ctx) {
    const command = ctx.args.length > 0 ? ctx.args.join(' ') : undefined;
    const { pid } = spawnInWindow(ctx.shell, command);
    ctx.stdout = command ? `[${pid}] ${command}\n` : `[${pid}] terminal\n`;
    return 0;
  },
};
