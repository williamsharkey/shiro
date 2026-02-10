/**
 * spawn - run a command in a new windowed terminal.
 *
 *   spawn claude --dangerously-skip-permissions
 *   spawn node server.js
 *   spawn sh
 */

import { Command } from './index';
import { processTable } from '../process-table';
import { createServerWindow } from '../server-window';
import { WindowTerminal } from '../window-terminal';

export const spawnCmd: Command = {
  name: 'spawn',
  description: 'Run a command in a new windowed terminal',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stderr = 'Usage: spawn <command> [args...]\n';
      return 1;
    }

    const fullCommand = ctx.args.join(' ');
    const shortName = ctx.args[0];

    // Fork the shell so spawned process gets its own cwd/env (no leaking to parent)
    const childShell = ctx.shell.fork();

    // Allocate PID
    const proc = processTable.allocate(fullCommand);

    // Create window
    const win = createServerWindow({
      mode: 'terminal',
      title: `[${proc.pid}] ${shortName}`,
      width: '48em',
      height: '28em',
      onClose: () => {
        if (proc.status === 'running') {
          winTerm.forceKill();
          processTable.kill(proc.pid);
        }
        winTerm.dispose();
      },
    });

    // Create terminal inside the window
    const winTerm = new WindowTerminal(win.contentDiv!);
    // Wire up secret masking so tokens never appear on screen
    winTerm.secretMasker = (text: string) => childShell.maskSecrets(text);
    // Wire copy/paste buttons to this terminal
    win.setTerminal?.(winTerm);

    // Wire up process
    proc.windowTerminal = winTerm;
    proc.serverWindow = win;
    proc.kill = () => {
      winTerm.forceKill();
      proc.status = 'killed';
      proc.exitCode = 130;
      winTerm.writeOutput('\r\n\x1b[31m[Process killed]\x1b[0m\r\n');
    };

    // Run command async on the CHILD shell — don't await
    proc.promise = (async () => {
      try {
        const exitCode = await childShell.execute(
          fullCommand,
          (s: string) => winTerm.writeOutput(s),
          (s: string) => winTerm.writeOutput(`\x1b[31m${s}\x1b[0m`),
          false,
          winTerm,
          true, // skipHistory — spawn already records the parent command
        );
        if (proc.status === 'running') {
          processTable.markExited(proc.pid, exitCode);
          winTerm.writeOutput(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
        }
        return exitCode;
      } catch (err: any) {
        if (proc.status === 'running') {
          processTable.markExited(proc.pid, 1);
          winTerm.writeOutput(`\r\n\x1b[31m[Process error: ${err.message}]\x1b[0m\r\n`);
        }
        return 1;
      }
    })();

    ctx.stdout = `[${proc.pid}] ${fullCommand}\n`;
    return 0;
  },
};
