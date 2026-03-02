
import type { Command } from './index';

export const watch: Command = {
  name: "watch",
  description: "Execute a program periodically, showing output",
  async exec(ctx) {
    // Parse arguments manually for -n, -d, -t, -e, -g
    let interval = 2;
    let showDiffs = false;
    let noTitle = false;
    let errexit = false;
    let chgexit = false;
    const cmdParts: string[] = [];
    let parsingFlags = true;

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (parsingFlags && (arg === '-n' || arg === '--interval') && i + 1 < ctx.args.length) {
        interval = parseFloat(ctx.args[++i]) || 2;
      } else if (parsingFlags && (arg === '-d' || arg === '--differences')) {
        showDiffs = true;
      } else if (parsingFlags && (arg === '-t' || arg === '--no-title')) {
        noTitle = true;
      } else if (parsingFlags && (arg === '-e' || arg === '--errexit')) {
        errexit = true;
      } else if (parsingFlags && (arg === '-g' || arg === '--chgexit')) {
        chgexit = true;
      } else if (parsingFlags && arg === '--help') {
        ctx.stdout += 'Usage: watch [options] command\n\nOptions:\n  -n, --interval <secs>  Seconds between updates (default: 2)\n  -d, --differences      Highlight changes\n  -t, --no-title         Hide header\n  -e, --errexit          Exit on command error\n  -g, --chgexit          Exit when output changes\n';
        return 0;
      } else {
        parsingFlags = false;
        cmdParts.push(arg);
      }
      i++;
    }

    if (cmdParts.length === 0) {
      ctx.stderr += "watch: missing command\nTry 'watch --help' for more information.\n";
      return 1;
    }

    const command = cmdParts.join(' ');

    // Batch mode (no terminal) — run once and return
    if (!ctx.terminal) {
      let header = '';
      if (!noTitle) {
        const now = new Date();
        const timeStr = now.toTimeString().slice(0, 8);
        header = `Every ${interval}.0s: ${command}    ${timeStr}\n\n`;
      }
      let out = '';
      const exitCode = await ctx.shell.execute(command, (s: string) => { out += s; });
      ctx.stdout += header + out;
      if (errexit && exitCode !== 0) return exitCode;
      return 0;
    }

    // TUI mode — alternate screen, periodic execution
    const terminal = ctx.terminal;
    const write = (s: string) => terminal.writeOutput(s);
    const { cols } = terminal.getSize();

    // Enter alternate screen
    write('\x1b[?1049h');
    write('\x1b[?25l'); // hide cursor

    let prevOutput = '';
    let running = true;
    let iteration = 0;

    const render = async (): Promise<number> => {
      let out = '';
      const exitCode = await ctx.shell.execute(command, (s: string) => { out += s; });

      if (chgexit && iteration > 0 && out !== prevOutput) {
        return -2;
      }
      if (errexit && exitCode !== 0) {
        return exitCode;
      }

      write('\x1b[2J\x1b[H');

      if (!noTitle) {
        const now = new Date();
        const timeStr = now.toTimeString().slice(0, 8);
        write(`\x1b[7mEvery ${interval}.0s: ${command}    ${timeStr}\x1b[27m\r\n\r\n`);
      }

      if (showDiffs && prevOutput && out !== prevOutput) {
        const oldLines = prevOutput.split('\n');
        const newLines = out.split('\n');
        for (let j = 0; j < newLines.length; j++) {
          if (j >= oldLines.length || newLines[j] !== oldLines[j]) {
            write(`\x1b[7m${newLines[j]}\x1b[27m\r\n`);
          } else {
            write(newLines[j] + '\r\n');
          }
        }
      } else {
        const lines = out.split('\n');
        for (const line of lines) {
          write(line + '\r\n');
        }
      }

      prevOutput = out;
      iteration++;
      return exitCode;
    };

    const cleanup = () => {
      running = false;
      terminal.exitRawMode();
      write('\x1b[?25h');
      write('\x1b[?1049l');
    };

    return new Promise<number>((resolve) => {
      let intervalId: ReturnType<typeof setInterval> | null = null;

      const onKey = (key: string) => {
        if (key === 'q' || key === 'Q' || key === '\x03') {
          cleanup();
          if (intervalId) clearInterval(intervalId);
          resolve(0);
        }
      };

      terminal.enterRawMode(onKey);

      // Ctrl+C abort
      const signal = ctx.shell?.abortController?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          cleanup();
          if (intervalId) clearInterval(intervalId);
          resolve(130);
        }, { once: true });
      }

      // Initial render
      render().then(firstResult => {
        if (!running) return;
        if (firstResult === -2 || (errexit && firstResult !== 0)) {
          cleanup();
          resolve(firstResult === -2 ? 0 : firstResult);
          return;
        }

        intervalId = setInterval(async () => {
          if (!running) {
            if (intervalId) clearInterval(intervalId);
            return;
          }
          const result = await render();
          if (result === -2 || (errexit && result !== 0)) {
            cleanup();
            if (intervalId) clearInterval(intervalId);
            resolve(result === -2 ? 0 : result);
          }
        }, interval * 1000);
      });
    });
  },
};
