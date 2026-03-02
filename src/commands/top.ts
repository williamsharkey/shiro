import type { Command } from './index';
import { parseArgs } from './flags';
import { processTable } from '../process-table';

export const topCmd: Command = {
  name: 'top',
  description: 'Real-time process monitor',
  async exec(ctx) {
    const { flags, values } = parseArgs(ctx.args, ['d', 'delay', 'n']);

    const delay = parseFloat(values.d || values.delay || '2') * 1000;
    const maxIter = parseInt(values.n || '0', 10);
    const batchMode = !!flags.b;

    const startTime = Date.now();

    const formatUptime = () => {
      const sec = Math.floor((Date.now() - (performance.timeOrigin || startTime)) / 1000);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return `${h}:${String(m).padStart(2, '0')}`;
    };

    const formatTime = (ms: number) => {
      const sec = Math.floor((Date.now() - ms) / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    };

    const renderSnapshot = (cols: number, maxRows?: number): string => {
      const procs = processTable.list();
      const running = procs.filter(p => p.status === 'running').length;
      const exited = procs.filter(p => p.status !== 'running').length;

      const now = new Date();
      const timeStr = now.toTimeString().slice(0, 8);

      const lines: string[] = [];

      // Header
      lines.push(`\x1b[1mtop\x1b[0m - ${timeStr} up ${formatUptime()}, 1 user`);
      lines.push(`Tasks: \x1b[1m${procs.length}\x1b[0m total, \x1b[32m${running} running\x1b[0m, ${exited} exited`);

      // Memory (use performance.memory if available, else estimate)
      const mem = (performance as any).memory;
      if (mem) {
        const used = (mem.usedJSHeapSize / 1048576).toFixed(1);
        const total = (mem.jsHeapSizeLimit / 1048576).toFixed(1);
        lines.push(`MiB Mem: \x1b[1m${used}\x1b[0m used / ${total} total`);
      } else {
        lines.push(`CPUs: \x1b[1m${navigator.hardwareConcurrency || '?'}\x1b[0m`);
      }

      lines.push('');

      // Process table header
      const header = '  PID  STATUS     TIME  COMMAND';
      lines.push(`\x1b[7m${header.padEnd(cols)}\x1b[27m`);

      // Sort: running first, then by PID
      const sorted = [...procs].sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        return a.pid - b.pid;
      });

      const limit = maxRows !== undefined ? maxRows : sorted.length;
      for (let i = 0; i < Math.min(sorted.length, limit); i++) {
        const p = sorted[i];
        const time = formatTime(p.startTime);
        const statusColor = p.status === 'running' ? '\x1b[32m' : '\x1b[90m';
        const status = `${statusColor}${p.status.padEnd(8)}\x1b[0m`;
        const cmd = p.command.length > cols - 28 ? p.command.slice(0, cols - 31) + '...' : p.command;
        lines.push(`  ${String(p.pid).padStart(3)}  ${status}  ${time.padStart(5)}  ${cmd}`);
      }

      return lines.join('\n') + '\n';
    };

    // Batch mode: print and exit
    if (batchMode) {
      let iter = 0;
      do {
        ctx.stdout += renderSnapshot(80);
        iter++;
        if (maxIter > 0 && iter >= maxIter) break;
        if (iter < (maxIter || 1)) {
          await new Promise(r => setTimeout(r, delay));
        }
      } while (maxIter === 0 || iter < maxIter);
      return 0;
    }

    // Interactive TUI mode
    if (!ctx.terminal) {
      // No terminal — fall back to single batch snapshot
      ctx.stdout += renderSnapshot(80);
      return 0;
    }

    const terminal = ctx.terminal!;
    let { rows, cols } = terminal.getSize();

    return new Promise<number>((resolve) => {
      let running = true;
      let interval: ReturnType<typeof setInterval> | null = null;
      let iterations = 0;

      const render = () => {
        if (!running) return;
        const write = (s: string) => terminal.writeOutput(s);
        write('\x1b[?25l');     // hide cursor
        write('\x1b[H');       // cursor home

        const contentRows = rows - 1;
        const snapshot = renderSnapshot(cols, contentRows - 5);
        const snapshotLines = snapshot.split('\n');

        for (let i = 0; i < contentRows; i++) {
          write('\x1b[2K');
          if (i < snapshotLines.length) {
            write(snapshotLines[i]);
          }
          if (i < contentRows - 1) write('\r\n');
        }

        // Status bar
        write('\r\n\x1b[2K');
        const status = ` Press q to quit, k to kill, Space to refresh `;
        write(`\x1b[7m${status.padEnd(cols)}\x1b[27m`);

        iterations++;
        if (maxIter > 0 && iterations >= maxIter) {
          cleanup();
          resolve(0);
        }
      };

      const cleanup = () => {
        running = false;
        if (interval) clearInterval(interval);
        if (unsubResize) unsubResize();
        terminal.exitRawMode();
        terminal.writeOutput('\x1b[?25h');  // show cursor
        terminal.writeOutput('\x1b[2J\x1b[H'); // clear
      };

      let killMode = false;
      let killInput = '';

      const onKey = (key: string) => {
        if (!running) return;

        if (killMode) {
          if (key === '\r' || key === 'Enter') {
            killMode = false;
            const pid = parseInt(killInput, 10);
            if (!isNaN(pid)) {
              processTable.kill(pid);
            }
            killInput = '';
            render();
          } else if (key === '\x1b' || key === 'Escape') {
            killMode = false;
            killInput = '';
            render();
          } else if (key === '\x7f' || key === 'Backspace') {
            killInput = killInput.slice(0, -1);
            // Re-render status with input
            terminal.writeOutput(`\r\x1b[2K\x1b[7m Kill PID: ${killInput}\x1b[27m`);
          } else if (key >= '0' && key <= '9') {
            killInput += key;
            terminal.writeOutput(`\r\x1b[2K\x1b[7m Kill PID: ${killInput}\x1b[27m`);
          }
          return;
        }

        switch (key) {
          case 'q':
          case 'Q':
          case 'Ctrl+C':
            cleanup();
            resolve(key === 'Ctrl+C' ? 130 : 0);
            return;
          case 'k':
            killMode = true;
            killInput = '';
            terminal.writeOutput(`\r\x1b[2K\x1b[7m Kill PID: \x1b[27m`);
            return;
          case ' ':
            render();
            return;
        }
      };

      const unsubResize = terminal.onResize((newCols, newRows) => {
        cols = newCols;
        rows = newRows;
        render();
      });

      // Ctrl+C abort
      const signal = ctx.shell?.abortController?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          cleanup();
          resolve(130);
        }, { once: true });
      }

      terminal.writeOutput('\x1b[?1049h'); // alternate screen
      terminal.enterRawMode(onKey);
      render();

      interval = setInterval(render, delay);
    });
  },
};
