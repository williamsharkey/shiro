import { Command, CommandContext } from './index';

/**
 * nano: Simple text editor with familiar keybindings
 *
 * Unlike vi, nano has no modes - just type to insert text.
 *
 * Keybindings:
 *   Ctrl+O  - Save file (WriteOut)
 *   Ctrl+X  - Exit
 *   Ctrl+K  - Cut current line
 *   Ctrl+U  - Paste cut line
 *   Ctrl+W  - Search
 *   Ctrl+G  - Help
 *   Arrows  - Move cursor
 *   Home    - Start of line
 *   End     - End of line
 *   Ctrl+A  - Start of line
 *   Ctrl+E  - End of line
 */

interface EditorState {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  scrollOffset: number;
  modified: boolean;
  message: string;
  cutBuffer: string[];
  searchQuery: string;
  inputMode: 'edit' | 'save' | 'search' | 'exit-confirm';
  inputBuffer: string;
}

export const nanoCmd: Command = {
  name: 'nano',
  description: 'Simple text editor (Ctrl+O save, Ctrl+X exit)',

  async exec(ctx: CommandContext): Promise<number> {
    if (ctx.args.length === 0) {
      ctx.stderr += 'Usage: nano <file>\n';
      return 1;
    }

    if (!ctx.terminal) {
      ctx.stderr += 'nano: terminal not available for interactive editing\n';
      ctx.stderr += 'Use ed for line-based editing, or cat > file << EOF for file creation.\n';
      return 1;
    }

    const filename = ctx.args[0];
    const filepath = ctx.fs.resolvePath(filename, ctx.cwd);

    // Read file or create new
    let initialContent = '';
    let fileExists = false;
    try {
      initialContent = await ctx.fs.readFile(filepath, 'utf8') as string;
      fileExists = true;
    } catch {
      initialContent = '';
    }

    const state: EditorState = {
      lines: initialContent ? initialContent.split('\n') : [''],
      cursorRow: 0,
      cursorCol: 0,
      scrollOffset: 0,
      modified: false,
      message: fileExists ? `Read ${initialContent.split('\n').length} lines` : 'New File',
      cutBuffer: [],
      searchQuery: '',
      inputMode: 'edit',
      inputBuffer: '',
    };

    const terminal = ctx.terminal;
    const { rows: termHeight, cols: termWidth } = terminal.getSize();

    return new Promise<number>((resolve) => {
      let running = true;

      const write = (text: string) => {
        terminal.writeOutput(text);
      };

      const render = () => {
        write('\x1b[2J\x1b[H'); // Clear screen

        const headerHeight = 2;
        const footerHeight = 3;
        const contentHeight = termHeight - headerHeight - footerHeight;

        // Header
        const title = `  GNU nano 7.0      ${filename}${state.modified ? ' (modified)' : ''}`;
        write(`\x1b[7m${title.padEnd(termWidth)}\x1b[0m\r\n`);
        write('\r\n');

        // Adjust scroll
        if (state.cursorRow < state.scrollOffset) {
          state.scrollOffset = state.cursorRow;
        } else if (state.cursorRow >= state.scrollOffset + contentHeight) {
          state.scrollOffset = state.cursorRow - contentHeight + 1;
        }

        // Content
        for (let i = 0; i < contentHeight; i++) {
          const lineIdx = i + state.scrollOffset;
          if (lineIdx < state.lines.length) {
            const line = state.lines[lineIdx].slice(0, termWidth - 1);
            write(line);
          }
          write('\x1b[K\r\n');
        }

        // Footer - shortcuts
        write('\x1b[7m');
        const shortcuts = state.inputMode === 'edit'
          ? '^G Help  ^O Write Out  ^W Where Is  ^K Cut   ^X Exit'
          : state.inputMode === 'save'
          ? 'File Name to Write: '
          : state.inputMode === 'search'
          ? 'Search: '
          : 'Save modified buffer? (Y/N) ';
        write(shortcuts.padEnd(termWidth).slice(0, termWidth));
        write('\x1b[0m\r\n');

        // Second shortcut row or input
        write('\x1b[7m');
        if (state.inputMode === 'edit') {
          write('^U Paste ^C Cancel   ^\\Replace  ^T Execute'.padEnd(termWidth).slice(0, termWidth));
        } else {
          write(state.inputBuffer.padEnd(termWidth).slice(0, termWidth));
        }
        write('\x1b[0m\r\n');

        // Message line
        write(state.message.slice(0, termWidth));
        write('\x1b[K');

        // Position cursor
        if (state.inputMode === 'edit') {
          const screenRow = state.cursorRow - state.scrollOffset + headerHeight;
          write(`\x1b[${screenRow + 1};${state.cursorCol + 1}H`);
        } else {
          // Cursor at input buffer
          write(`\x1b[${termHeight - 1};${state.inputBuffer.length + 1}H`);
        }
      };

      const cleanup = () => {
        terminal.exitRawMode();
        write('\x1b[2J\x1b[H');
      };

      const saveFile = async () => {
        const content = state.lines.join('\n');
        await ctx.fs.writeFile(filepath, content);
        state.modified = false;
        state.message = `Wrote ${state.lines.length} lines`;
      };

      const search = (query: string, forward: boolean = true) => {
        if (!query) return;
        state.searchQuery = query;

        const startRow = state.cursorRow;
        const startCol = state.cursorCol + 1;

        for (let i = 0; i < state.lines.length; i++) {
          const row = forward
            ? (startRow + i) % state.lines.length
            : (startRow - i + state.lines.length) % state.lines.length;
          const line = state.lines[row];
          const searchStart = (i === 0 && forward) ? startCol : 0;
          const idx = line.indexOf(query, searchStart);

          if (idx !== -1) {
            state.cursorRow = row;
            state.cursorCol = idx;
            state.message = `Found "${query}"`;
            return;
          }
        }
        state.message = `"${query}" not found`;
      };

      const onKey = async (key: string) => {
        if (!running) return;

        // Handle input modes first
        if (state.inputMode === 'save') {
          if (key === 'Enter') {
            await saveFile();
            state.inputMode = 'edit';
            state.inputBuffer = '';
          } else if (key === 'Ctrl+C' || key === 'Escape') {
            state.inputMode = 'edit';
            state.inputBuffer = '';
            state.message = 'Cancelled';
          } else if (key === 'Backspace') {
            state.inputBuffer = state.inputBuffer.slice(0, -1);
          } else if (key.length === 1 && key >= ' ') {
            state.inputBuffer += key;
          }
          render();
          return;
        }

        if (state.inputMode === 'search') {
          if (key === 'Enter') {
            search(state.inputBuffer);
            state.inputMode = 'edit';
            state.inputBuffer = '';
          } else if (key === 'Ctrl+C' || key === 'Escape') {
            state.inputMode = 'edit';
            state.inputBuffer = '';
            state.message = 'Cancelled';
          } else if (key === 'Backspace') {
            state.inputBuffer = state.inputBuffer.slice(0, -1);
          } else if (key.length === 1 && key >= ' ') {
            state.inputBuffer += key;
          }
          render();
          return;
        }

        if (state.inputMode === 'exit-confirm') {
          if (key === 'y' || key === 'Y') {
            await saveFile();
            running = false;
            cleanup();
            resolve(0);
            return;
          } else if (key === 'n' || key === 'N') {
            running = false;
            cleanup();
            resolve(0);
            return;
          } else if (key === 'Ctrl+C' || key === 'Escape') {
            state.inputMode = 'edit';
            state.message = 'Cancelled';
          }
          render();
          return;
        }

        // Edit mode
        state.message = '';
        const currentLine = () => state.lines[state.cursorRow] || '';

        switch (key) {
          // Navigation
          case 'ArrowUp':
            if (state.cursorRow > 0) {
              state.cursorRow--;
              state.cursorCol = Math.min(state.cursorCol, currentLine().length);
            }
            break;
          case 'ArrowDown':
            if (state.cursorRow < state.lines.length - 1) {
              state.cursorRow++;
              state.cursorCol = Math.min(state.cursorCol, currentLine().length);
            }
            break;
          case 'ArrowLeft':
            if (state.cursorCol > 0) {
              state.cursorCol--;
            } else if (state.cursorRow > 0) {
              state.cursorRow--;
              state.cursorCol = currentLine().length;
            }
            break;
          case 'ArrowRight':
            if (state.cursorCol < currentLine().length) {
              state.cursorCol++;
            } else if (state.cursorRow < state.lines.length - 1) {
              state.cursorRow++;
              state.cursorCol = 0;
            }
            break;
          case 'Home':
          case 'Ctrl+A':
            state.cursorCol = 0;
            break;
          case 'End':
          case 'Ctrl+E':
            state.cursorCol = currentLine().length;
            break;

          // Editing
          case 'Enter':
            const before = currentLine().slice(0, state.cursorCol);
            const after = currentLine().slice(state.cursorCol);
            state.lines[state.cursorRow] = before;
            state.lines.splice(state.cursorRow + 1, 0, after);
            state.cursorRow++;
            state.cursorCol = 0;
            state.modified = true;
            break;
          case 'Backspace':
            if (state.cursorCol > 0) {
              state.lines[state.cursorRow] =
                currentLine().slice(0, state.cursorCol - 1) + currentLine().slice(state.cursorCol);
              state.cursorCol--;
              state.modified = true;
            } else if (state.cursorRow > 0) {
              const prevLine = state.lines[state.cursorRow - 1];
              state.cursorCol = prevLine.length;
              state.lines[state.cursorRow - 1] = prevLine + currentLine();
              state.lines.splice(state.cursorRow, 1);
              state.cursorRow--;
              state.modified = true;
            }
            break;
          case 'Delete':
            if (state.cursorCol < currentLine().length) {
              state.lines[state.cursorRow] =
                currentLine().slice(0, state.cursorCol) + currentLine().slice(state.cursorCol + 1);
              state.modified = true;
            } else if (state.cursorRow < state.lines.length - 1) {
              state.lines[state.cursorRow] = currentLine() + state.lines[state.cursorRow + 1];
              state.lines.splice(state.cursorRow + 1, 1);
              state.modified = true;
            }
            break;

          // Commands
          case 'Ctrl+X': // Exit
            if (state.modified) {
              state.inputMode = 'exit-confirm';
              state.message = 'Save modified buffer?';
            } else {
              running = false;
              cleanup();
              resolve(0);
              return;
            }
            break;
          case 'Ctrl+O': // Save
            state.inputMode = 'save';
            state.inputBuffer = filename;
            break;
          case 'Ctrl+K': // Cut line
            state.cutBuffer = [currentLine()];
            state.lines.splice(state.cursorRow, 1);
            if (state.lines.length === 0) state.lines = [''];
            state.cursorRow = Math.min(state.cursorRow, state.lines.length - 1);
            state.cursorCol = Math.min(state.cursorCol, currentLine().length);
            state.modified = true;
            state.message = 'Cut 1 line';
            break;
          case 'Ctrl+U': // Paste
            if (state.cutBuffer.length > 0) {
              state.lines.splice(state.cursorRow, 0, ...state.cutBuffer);
              state.modified = true;
              state.message = `Pasted ${state.cutBuffer.length} line(s)`;
            }
            break;
          case 'Ctrl+W': // Search
            state.inputMode = 'search';
            state.inputBuffer = state.searchQuery;
            break;
          case 'Ctrl+G': // Help
            state.message = '^O Save  ^X Exit  ^K Cut  ^U Paste  ^W Search';
            break;
          case 'Ctrl+C': // Cancel / show position
            state.message = `Line ${state.cursorRow + 1}/${state.lines.length}, Col ${state.cursorCol + 1}`;
            break;

          // Regular character
          default:
            if (key.length === 1 && key >= ' ') {
              state.lines[state.cursorRow] =
                currentLine().slice(0, state.cursorCol) + key + currentLine().slice(state.cursorCol);
              state.cursorCol++;
              state.modified = true;
            }
        }

        render();
      };

      terminal.enterRawMode(onKey);
      render();
    });
  },
};
