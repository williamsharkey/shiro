
import type { Command } from './index';
import { parseArgs, readInput } from './flags';

export const less: Command = {
  name: "less",
  description: "View file contents with pagination",
  async exec(ctx) {
    const { flags, positional } = parseArgs(ctx.args);

    try {
      const { content, files } = await readInput(
        positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath
      );

      const showNumbers = !!(flags.N || flags.n);
      const passAnsi = !!flags.R;
      const chopLong = !!flags.S;
      const quitIfFit = !!flags.F;

      // Non-interactive fallback: no terminal, or piped output
      if (!ctx.terminal) {
        const lines = content.split('\n');
        if (showNumbers) {
          ctx.stdout += lines.map((l, i) => `${String(i + 1).padStart(6)}  ${l}`).join('\n');
        } else {
          ctx.stdout += content;
        }
        if (ctx.stdout && !ctx.stdout.endsWith('\n')) ctx.stdout += '\n';
        return 0;
      }

      const allLines = content.split('\n');
      // Remove trailing empty line from final newline
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
        allLines.pop();
      }

      const terminal = ctx.terminal!;
      const { rows: termRows, cols: termCols } = terminal.getSize();
      let rows = termRows;
      let cols = termCols;
      const contentRows = rows - 1; // reserve 1 line for status bar

      // -F: quit if content fits on screen
      if (quitIfFit && allLines.length <= contentRows) {
        const lines = content.split('\n');
        if (showNumbers) {
          ctx.stdout += lines.map((l, i) => `${String(i + 1).padStart(6)}  ${l}`).join('\n');
        } else {
          ctx.stdout += content;
        }
        if (ctx.stdout && !ctx.stdout.endsWith('\n')) ctx.stdout += '\n';
        return 0;
      }

      const filename = files.length > 0 ? files[0] : '(stdin)';

      return new Promise<number>((resolve) => {
        let offset = 0; // first visible line index
        let searchPattern = '';
        let searchMatches: number[] = []; // line indices matching search
        let searchMode = false;
        let searchInput = '';

        const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

        const visibleLength = (s: string) => stripAnsi(s).length;

        const formatLine = (line: string, lineNum: number): string => {
          let out = '';
          if (showNumbers) {
            out = `\x1b[33m${String(lineNum).padStart(6)}\x1b[0m  `;
          }
          let displayLine = passAnsi ? line : stripAnsi(line);
          if (chopLong) {
            // Truncate to fit available width
            const prefix = showNumbers ? 8 : 0;
            const maxW = cols - prefix;
            const plain = stripAnsi(displayLine);
            if (plain.length > maxW) {
              displayLine = plain.slice(0, maxW);
            }
          }
          // Highlight search matches
          if (searchPattern) {
            try {
              const re = new RegExp(searchPattern, 'gi');
              const plain = stripAnsi(displayLine);
              displayLine = plain.replace(re, (m) => `\x1b[7m${m}\x1b[27m`);
            } catch {}
          }
          return out + displayLine;
        };

        const render = () => {
          const write = (s: string) => terminal.writeOutput(s);
          write('\x1b[?25l');     // hide cursor
          write('\x1b[H');       // cursor home

          for (let i = 0; i < contentRows; i++) {
            const lineIdx = offset + i;
            write('\x1b[2K');    // clear line
            if (lineIdx < allLines.length) {
              write(formatLine(allLines[lineIdx], lineIdx + 1));
            } else {
              write('\x1b[36m~\x1b[0m');
            }
            if (i < contentRows - 1) write('\r\n');
          }

          // Status bar
          write('\r\n\x1b[2K');
          if (searchMode) {
            write(`\x1b[7m/${searchInput}\x1b[27m`);
          } else {
            const pct = allLines.length <= contentRows
              ? '100'
              : offset + contentRows >= allLines.length
                ? 'END'
                : offset === 0
                  ? 'TOP'
                  : String(Math.round(((offset + contentRows) / allLines.length) * 100)) + '%';
            const status = ` ${filename} lines ${offset + 1}-${Math.min(offset + contentRows, allLines.length)} / ${allLines.length} (${pct}) `;
            write(`\x1b[7m${status.padEnd(cols)}\x1b[27m`);
          }
        };

        const scrollTo = (n: number) => {
          const maxOffset = Math.max(0, allLines.length - contentRows);
          offset = Math.max(0, Math.min(n, maxOffset));
        };

        const findSearch = () => {
          if (!searchPattern) return;
          try {
            const re = new RegExp(searchPattern, 'i');
            searchMatches = [];
            for (let i = 0; i < allLines.length; i++) {
              if (re.test(stripAnsi(allLines[i]))) searchMatches.push(i);
            }
          } catch {
            searchMatches = [];
          }
        };

        const nextMatch = (forward: boolean) => {
          if (searchMatches.length === 0) return;
          if (forward) {
            const idx = searchMatches.find(i => i > offset);
            if (idx !== undefined) scrollTo(idx);
            else scrollTo(searchMatches[0]); // wrap
          } else {
            const idx = [...searchMatches].reverse().find(i => i < offset);
            if (idx !== undefined) scrollTo(idx);
            else scrollTo(searchMatches[searchMatches.length - 1]); // wrap
          }
        };

        const cleanup = () => {
          terminal.exitRawMode();
          terminal.writeOutput('\x1b[?25h');  // show cursor
          terminal.writeOutput('\x1b[2J\x1b[H'); // clear screen
        };

        let unsubResize: (() => void) | null = null;

        const onKey = (key: string) => {
          if (searchMode) {
            if (key === '\r' || key === 'Enter') {
              searchMode = false;
              searchPattern = searchInput;
              findSearch();
              // Jump to first match after current offset
              nextMatch(true);
              render();
            } else if (key === '\x1b' || key === 'Escape') {
              searchMode = false;
              searchInput = '';
              render();
            } else if (key === '\x7f' || key === 'Backspace') {
              searchInput = searchInput.slice(0, -1);
              render();
            } else if (key.length === 1 && key >= ' ') {
              searchInput += key;
              render();
            }
            return;
          }

          switch (key) {
            case 'q':
            case 'Q':
              if (unsubResize) unsubResize();
              cleanup();
              resolve(0);
              return;
            case 'Ctrl+C':
              if (unsubResize) unsubResize();
              cleanup();
              resolve(1);
              return;
            case 'j':
            case '\x1b[B': // down arrow
            case 'ArrowDown':
              scrollTo(offset + 1);
              break;
            case 'k':
            case '\x1b[A': // up arrow
            case 'ArrowUp':
              scrollTo(offset - 1);
              break;
            case ' ':
            case 'f':
              scrollTo(offset + contentRows);
              break;
            case 'b':
              scrollTo(offset - contentRows);
              break;
            case 'd':
              scrollTo(offset + Math.floor(contentRows / 2));
              break;
            case 'u':
              scrollTo(offset - Math.floor(contentRows / 2));
              break;
            case 'g':
              scrollTo(0);
              break;
            case 'G':
              scrollTo(allLines.length - contentRows);
              break;
            case '/':
              searchMode = true;
              searchInput = '';
              break;
            case 'n':
              nextMatch(true);
              break;
            case 'N':
              nextMatch(false);
              break;
          }
          render();
        };

        // Enter alternate screen + raw mode
        terminal.writeOutput('\x1b[?1049h'); // alternate screen
        terminal.enterRawMode(onKey);

        unsubResize = terminal.onResize((newCols, newRows) => {
          cols = newCols;
          rows = newRows;
          render();
        });

        render();
      });
    } catch (e: unknown) {
      ctx.stderr += `less: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
