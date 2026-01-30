import { Command, CommandContext } from './index';

/**
 * vi: Minimal vi-like text editor for the terminal
 *
 * A simplified modal text editor with basic vi keybindings.
 *
 * Modes:
 *   - Normal mode: Navigate and execute commands
 *   - Insert mode: Type text (i, a, o to enter)
 *   - Command mode: Execute commands (:w, :q, :wq)
 *   - Search mode: Search for text (/ to enter, n/N to navigate)
 *
 * Normal mode commands:
 *   h,j,k,l  - Move cursor left, down, up, right
 *   i        - Enter insert mode at cursor
 *   a        - Enter insert mode after cursor
 *   o        - Insert new line below and enter insert mode
 *   O        - Insert new line above and enter insert mode
 *   x        - Delete character under cursor
 *   dd       - Delete current line
 *   0        - Move to start of line
 *   $        - Move to end of line
 *   gg       - Move to first line
 *   G        - Move to last line
 *   /        - Enter search mode
 *   n        - Next search result
 *   N        - Previous search result
 *   :        - Enter command mode
 *
 * Command mode:
 *   :w       - Write (save) file
 *   :q       - Quit (if no changes)
 *   :q!      - Quit without saving
 *   :wq      - Write and quit
 *
 * Insert mode:
 *   ESC      - Return to normal mode
 *   Any text - Insert at cursor
 */

type Mode = 'normal' | 'insert' | 'command' | 'search';

interface EditorState {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  mode: Mode;
  commandBuffer: string;
  lastKey: string;
  modified: boolean;
  scrollOffset: number;
  message: string;
  searchPattern: string;
  searchBuffer: string;
}

export const viCmd: Command = {
  name: 'vi',
  description: 'Minimal vi-like text editor',

  async exec(ctx: CommandContext): Promise<number> {
    if (ctx.args.length === 0) {
      ctx.stderr += 'Usage: vi <file>\n';
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
      // New file
      initialContent = '';
    }

    const state: EditorState = {
      lines: initialContent ? initialContent.split('\n') : [''],
      cursorRow: 0,
      cursorCol: 0,
      mode: 'normal',
      commandBuffer: '',
      lastKey: '',
      modified: false,
      scrollOffset: 0,
      message: fileExists ? `"${filename}" ${initialContent.split('\n').length} lines` : `"${filename}" [New File]`,
      searchPattern: '',
      searchBuffer: '',
    };

    // Run the editor in an interactive loop
    return new Promise<number>((resolve) => {
      let running = true;

      const render = () => {
        // Clear screen and render editor
        ctx.stdout += '\x1b[2J\x1b[H'; // Clear screen, move cursor to home

        const termHeight = 24; // Assume 24 lines for now
        const contentHeight = termHeight - 2; // Leave room for status and command line

        // Render lines
        for (let i = 0; i < contentHeight; i++) {
          const lineIdx = i + state.scrollOffset;
          if (lineIdx < state.lines.length) {
            const line = state.lines[lineIdx];
            ctx.stdout += line;
          } else {
            ctx.stdout += '~'; // Empty line indicator
          }
          ctx.stdout += '\x1b[K\n'; // Clear to end of line and newline
        }

        // Render status line
        const modeStr = state.mode === 'insert' ? '-- INSERT --' : state.mode === 'command' ? '' : '';
        const modifiedStr = state.modified ? '[+]' : '';
        const posStr = `${state.cursorRow + 1},${state.cursorCol + 1}`;
        const statusLine = `${modeStr} ${modifiedStr} ${filename} ${posStr}`.padEnd(80);
        ctx.stdout += `\x1b[7m${statusLine}\x1b[0m\n`; // Reverse video

        // Render command line or message
        if (state.mode === 'command') {
          ctx.stdout += `:${state.commandBuffer}`;
        } else if (state.mode === 'search') {
          ctx.stdout += `/${state.searchBuffer}`;
        } else {
          ctx.stdout += state.message;
        }

        // Move cursor to editing position
        const screenRow = state.cursorRow - state.scrollOffset;
        ctx.stdout += `\x1b[${screenRow + 1};${state.cursorCol + 1}H`;
      };

      const handleKey = async (key: string) => {
        state.message = ''; // Clear message

        if (state.mode === 'normal') {
          await handleNormalMode(key);
        } else if (state.mode === 'insert') {
          await handleInsertMode(key);
        } else if (state.mode === 'command') {
          await handleCommandMode(key);
        } else if (state.mode === 'search') {
          await handleSearchMode(key);
        }

        if (running) {
          render();
        }
      };

      const handleNormalMode = async (key: string) => {
        const currentLine = () => state.lines[state.cursorRow] || '';
        const clampCol = () => {
          const maxCol = Math.max(0, currentLine().length - 1);
          state.cursorCol = Math.min(state.cursorCol, maxCol);
        };

        switch (key) {
          case 'h': // Move left
            state.cursorCol = Math.max(0, state.cursorCol - 1);
            break;
          case 'j': // Move down
            if (state.cursorRow < state.lines.length - 1) {
              state.cursorRow++;
              clampCol();
            }
            break;
          case 'k': // Move up
            if (state.cursorRow > 0) {
              state.cursorRow--;
              clampCol();
            }
            break;
          case 'l': // Move right
            state.cursorCol = Math.min(currentLine().length, state.cursorCol + 1);
            break;
          case '0': // Start of line
            state.cursorCol = 0;
            break;
          case '$': // End of line
            state.cursorCol = Math.max(0, currentLine().length - 1);
            break;
          case 'i': // Insert mode at cursor
            state.mode = 'insert';
            break;
          case 'a': // Insert mode after cursor
            state.cursorCol = Math.min(currentLine().length, state.cursorCol + 1);
            state.mode = 'insert';
            break;
          case 'o': // New line below
            state.lines.splice(state.cursorRow + 1, 0, '');
            state.cursorRow++;
            state.cursorCol = 0;
            state.mode = 'insert';
            state.modified = true;
            break;
          case 'O': // New line above
            state.lines.splice(state.cursorRow, 0, '');
            state.cursorCol = 0;
            state.mode = 'insert';
            state.modified = true;
            break;
          case 'x': // Delete character
            if (currentLine().length > 0) {
              const line = currentLine();
              state.lines[state.cursorRow] = line.slice(0, state.cursorCol) + line.slice(state.cursorCol + 1);
              state.modified = true;
              clampCol();
            }
            break;
          case 'd': // Delete line (dd)
            if (state.lastKey === 'd') {
              state.lines.splice(state.cursorRow, 1);
              if (state.lines.length === 0) state.lines = [''];
              state.cursorRow = Math.min(state.cursorRow, state.lines.length - 1);
              state.modified = true;
              state.lastKey = '';
              return;
            }
            break;
          case 'g': // Go to first line (gg)
            if (state.lastKey === 'g') {
              state.cursorRow = 0;
              state.cursorCol = 0;
              state.lastKey = '';
              return;
            }
            break;
          case 'G': // Go to last line
            state.cursorRow = state.lines.length - 1;
            state.cursorCol = 0;
            break;
          case ':': // Command mode
            state.mode = 'command';
            state.commandBuffer = '';
            break;
          case '/': // Search mode
            state.mode = 'search';
            state.searchBuffer = '';
            break;
          case 'n': // Next search result
            if (state.searchPattern) {
              searchNext(state);
            } else {
              state.message = 'No previous search pattern';
            }
            break;
          case 'N': // Previous search result
            if (state.searchPattern) {
              searchPrevious(state);
            } else {
              state.message = 'No previous search pattern';
            }
            break;
        }

        state.lastKey = key;
      };

      const handleInsertMode = async (key: string) => {
        if (key === '\x1b' || key === 'Escape') {
          // ESC - return to normal mode
          state.mode = 'normal';
          state.cursorCol = Math.max(0, state.cursorCol - 1);
          return;
        }

        const currentLine = state.lines[state.cursorRow];

        if (key === 'Enter' || key === '\r' || key === '\n') {
          // Split line at cursor
          const before = currentLine.slice(0, state.cursorCol);
          const after = currentLine.slice(state.cursorCol);
          state.lines[state.cursorRow] = before;
          state.lines.splice(state.cursorRow + 1, 0, after);
          state.cursorRow++;
          state.cursorCol = 0;
          state.modified = true;
        } else if (key === 'Backspace' || key === '\x7f') {
          if (state.cursorCol > 0) {
            // Delete character before cursor
            state.lines[state.cursorRow] =
              currentLine.slice(0, state.cursorCol - 1) + currentLine.slice(state.cursorCol);
            state.cursorCol--;
            state.modified = true;
          } else if (state.cursorRow > 0) {
            // Join with previous line
            const prevLine = state.lines[state.cursorRow - 1];
            state.cursorCol = prevLine.length;
            state.lines[state.cursorRow - 1] = prevLine + currentLine;
            state.lines.splice(state.cursorRow, 1);
            state.cursorRow--;
            state.modified = true;
          }
        } else if (key.length === 1 && key >= ' ') {
          // Insert character
          state.lines[state.cursorRow] =
            currentLine.slice(0, state.cursorCol) + key + currentLine.slice(state.cursorCol);
          state.cursorCol++;
          state.modified = true;
        }
      };

      const searchNext = (state: EditorState) => {
        if (!state.searchPattern) return;

        const startRow = state.cursorRow;
        const startCol = state.cursorCol + 1;

        // Search from current position to end of file
        for (let row = startRow; row < state.lines.length; row++) {
          const line = state.lines[row];
          const searchStart = row === startRow ? startCol : 0;
          const index = line.indexOf(state.searchPattern, searchStart);

          if (index !== -1) {
            state.cursorRow = row;
            state.cursorCol = index;
            state.message = `Found: ${state.searchPattern}`;
            return;
          }
        }

        // Wrap to beginning of file
        for (let row = 0; row <= startRow; row++) {
          const line = state.lines[row];
          const searchEnd = row === startRow ? startCol - 1 : line.length;
          const index = line.indexOf(state.searchPattern);

          if (index !== -1 && index < searchEnd) {
            state.cursorRow = row;
            state.cursorCol = index;
            state.message = `Found: ${state.searchPattern} (wrapped)`;
            return;
          }
        }

        state.message = `Pattern not found: ${state.searchPattern}`;
      };

      const searchPrevious = (state: EditorState) => {
        if (!state.searchPattern) return;

        const startRow = state.cursorRow;
        const startCol = state.cursorCol - 1;

        // Search from current position backward to start of file
        for (let row = startRow; row >= 0; row--) {
          const line = state.lines[row];
          const searchEnd = row === startRow ? startCol : line.length - 1;

          // Search backward in the line
          for (let col = searchEnd; col >= 0; col--) {
            if (line.slice(col, col + state.searchPattern.length) === state.searchPattern) {
              state.cursorRow = row;
              state.cursorCol = col;
              state.message = `Found: ${state.searchPattern}`;
              return;
            }
          }
        }

        // Wrap to end of file
        for (let row = state.lines.length - 1; row >= startRow; row--) {
          const line = state.lines[row];
          const searchEnd = row === startRow ? line.length - 1 : line.length - 1;

          for (let col = searchEnd; col >= 0; col--) {
            if (line.slice(col, col + state.searchPattern.length) === state.searchPattern) {
              state.cursorRow = row;
              state.cursorCol = col;
              state.message = `Found: ${state.searchPattern} (wrapped)`;
              return;
            }
          }
        }

        state.message = `Pattern not found: ${state.searchPattern}`;
      };

      const handleSearchMode = async (key: string) => {
        if (key === '\x1b' || key === 'Escape') {
          // ESC - cancel search
          state.mode = 'normal';
          state.searchBuffer = '';
          return;
        }

        if (key === 'Enter' || key === '\r' || key === '\n') {
          // Execute search
          state.searchPattern = state.searchBuffer;
          state.mode = 'normal';

          if (state.searchPattern) {
            searchNext(state);
          }

          state.searchBuffer = '';
          return;
        }

        if (key === 'Backspace' || key === '\x7f') {
          // Delete character from search buffer
          state.searchBuffer = state.searchBuffer.slice(0, -1);
          if (state.searchBuffer.length === 0) {
            state.mode = 'normal';
          }
        } else if (key.length === 1 && key >= ' ') {
          // Add to search buffer
          state.searchBuffer += key;
        }
      };

      const handleCommandMode = async (key: string) => {
        if (key === '\x1b' || key === 'Escape') {
          // ESC - cancel command
          state.mode = 'normal';
          state.commandBuffer = '';
          return;
        }

        if (key === 'Enter' || key === '\r' || key === '\n') {
          // Execute command
          const cmd = state.commandBuffer.trim();

          if (cmd === 'w') {
            // Write file
            const content = state.lines.join('\n');
            await ctx.fs.writeFile(filepath, content);
            state.modified = false;
            state.message = `"${filename}" ${state.lines.length} lines written`;
          } else if (cmd === 'q') {
            // Quit
            if (state.modified) {
              state.message = 'No write since last change (use :q! to override)';
            } else {
              running = false;
              resolve(0);
              return;
            }
          } else if (cmd === 'q!') {
            // Quit without saving
            running = false;
            resolve(0);
            return;
          } else if (cmd === 'wq') {
            // Write and quit
            const content = state.lines.join('\n');
            await ctx.fs.writeFile(filepath, content);
            state.message = `"${filename}" ${state.lines.length} lines written`;
            running = false;
            resolve(0);
            return;
          } else {
            state.message = `Not an editor command: ${cmd}`;
          }

          state.mode = 'normal';
          state.commandBuffer = '';
        } else if (key === 'Backspace' || key === '\x7f') {
          // Delete character from command buffer
          state.commandBuffer = state.commandBuffer.slice(0, -1);
          if (state.commandBuffer.length === 0) {
            state.mode = 'normal';
          }
        } else if (key.length === 1 && key >= ' ') {
          // Add to command buffer
          state.commandBuffer += key;
        }
      };

      // Initial render
      render();

      // Note: This is a simplified version. In a real implementation, we'd need
      // to hook into the terminal's input handling. For now, this demonstrates
      // the structure. The actual input handling would need to be integrated
      // with the ShiroTerminal class.
      ctx.stdout += '\n[vi editor not fully interactive in this version - use built-in editor or echo/cat]\n';
      resolve(0);
    });
  },
};
