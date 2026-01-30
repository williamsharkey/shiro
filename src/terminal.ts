import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Shell } from './shell';

export class ShiroTerminal {
  private term: Terminal;
  private fitAddon: FitAddon;
  private shell: Shell;
  private lineBuffer = '';
  private cursorPos = 0;
  private historyIndex = -1;
  private savedLine = '';
  private running = false;
  private userInputCallback: ((input: string) => void) | null = null;
  private userInputBuffer = '';
  private userInputCursorPos = 0;
  private rawModeCallback: ((key: string) => void) | null = null;

  // Reverse history search state (Ctrl+R)
  private reverseSearchMode = false;
  private reverseSearchQuery = '';
  private reverseSearchIndex = -1;

  constructor(container: HTMLElement, shell: Shell) {
    this.shell = shell;
    this.term = new Terminal({
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#00d4ff',
        cursorAccent: '#1a1a2e',
        selectionBackground: '#3d3d5c',
        black: '#1a1a2e',
        red: '#ff6b6b',
        green: '#51cf66',
        yellow: '#ffd43b',
        blue: '#74c0fc',
        magenta: '#cc5de8',
        cyan: '#66d9e8',
        white: '#e0e0e0',
        brightBlack: '#4a4a6a',
        brightRed: '#ff8787',
        brightGreen: '#69db7c',
        brightYellow: '#ffe066',
        brightBlue: '#91d5ff',
        brightMagenta: '#e599f7',
        brightCyan: '#99e9f2',
        brightWhite: '#ffffff',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: 14,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);
    this.fitAddon.fit();

    window.addEventListener('resize', () => this.fitAddon.fit());

    this.term.onData((data: string) => this.handleInput(data));
  }

  writeOutput(text: string): void {
    this.term.write(text);
  }

  /**
   * Enter raw mode - all keystrokes go directly to the callback.
   * Used by interactive commands like vi that need character-by-character input.
   */
  enterRawMode(callback: (key: string) => void): void {
    this.rawModeCallback = callback;
  }

  /**
   * Exit raw mode - return to normal line-editing mode.
   */
  exitRawMode(): void {
    this.rawModeCallback = null;
  }

  /**
   * Check if terminal is in raw mode.
   */
  isRawMode(): boolean {
    return this.rawModeCallback !== null;
  }

  /**
   * Get terminal dimensions (rows and cols).
   */
  getSize(): { rows: number; cols: number } {
    return { rows: this.term.rows, cols: this.term.cols };
  }

  /**
   * Called by ShiroProvider.readFromUser() to collect a line of input
   * from the user while a command (e.g. Spirit) is running.
   */
  waitForUserInput(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.userInputBuffer = '';
      this.userInputCursorPos = 0;
      this.userInputCallback = resolve;
    });
  }

  async start() {
    this.term.writeln('\x1b[36m╔═════════════════════════════════════════════╗\x1b[0m');
    this.term.writeln('\x1b[36m║\x1b[0m   \x1b[1;97mShiro OS\x1b[0m \x1b[95mv0.1.0\x1b[0m                           \x1b[36m║\x1b[0m');
    this.term.writeln('\x1b[36m║\x1b[0m   \x1b[92mBrowser-Native Cloud Operating System\x1b[0m     \x1b[36m║\x1b[0m');
    this.term.writeln('\x1b[36m║\x1b[0m                                             \x1b[36m║\x1b[0m');
    this.term.writeln('\x1b[36m║\x1b[0m   \x1b[33mhelp\x1b[0m        \x1b[90m—\x1b[0m list all commands           \x1b[36m║\x1b[0m');
    this.term.writeln('\x1b[36m║\x1b[0m   \x1b[33mspirit\x1b[0m      \x1b[90m—\x1b[0m AI coding agent (Claude)    \x1b[36m║\x1b[0m');
    this.term.writeln('\x1b[36m║\x1b[0m   \x1b[33mupload\x1b[0m      \x1b[90m—\x1b[0m upload files from host      \x1b[36m║\x1b[0m');
    this.term.writeln('\x1b[36m║\x1b[0m   \x1b[33mdownload\x1b[0m    \x1b[90m—\x1b[0m download files to host      \x1b[36m║\x1b[0m');
    this.term.writeln('\x1b[36m╚═════════════════════════════════════════════╝\x1b[0m');
    this.term.writeln('');
    this.showPrompt();
  }

  private showPrompt() {
    const cwd = this.shell.cwd;
    const home = this.shell.env['HOME'] || '/home/user';
    const displayCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    const user = this.shell.env['USER'] || 'user';
    this.term.write(`\x1b[32m${user}@shiro\x1b[0m:\x1b[34m${displayCwd}\x1b[0m$ `);
  }

  private async handleInput(data: string) {
    // Raw mode: send all keystrokes directly to the callback (e.g., vi editor)
    if (this.rawModeCallback) {
      // Parse escape sequences for raw mode
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];

        // Handle escape sequences
        if (ch === '\x1b' && data[i + 1] === '[') {
          const code = data[i + 2];
          if (code === 'A') { this.rawModeCallback('ArrowUp'); i += 2; continue; }
          if (code === 'B') { this.rawModeCallback('ArrowDown'); i += 2; continue; }
          if (code === 'C') { this.rawModeCallback('ArrowRight'); i += 2; continue; }
          if (code === 'D') { this.rawModeCallback('ArrowLeft'); i += 2; continue; }
          if (code === 'H') { this.rawModeCallback('Home'); i += 2; continue; }
          if (code === 'F') { this.rawModeCallback('End'); i += 2; continue; }
          if (code === '3' && data[i + 3] === '~') { this.rawModeCallback('Delete'); i += 3; continue; }
          // Unknown escape sequence - skip
          i += 2;
          continue;
        }

        // Handle special characters
        if (ch === '\x1b') { this.rawModeCallback('Escape'); continue; }
        if (ch === '\r' || ch === '\n') { this.rawModeCallback('Enter'); continue; }
        if (ch === '\x7f' || ch === '\b') { this.rawModeCallback('Backspace'); continue; }
        if (ch === '\t') { this.rawModeCallback('Tab'); continue; }
        if (ch === '\x03') { this.rawModeCallback('Ctrl+C'); continue; }

        // Regular character
        this.rawModeCallback(ch);
      }
      return;
    }

    // When a command is running and Spirit is waiting for user input,
    // route keystrokes to the user-input buffer instead of the shell.
    if (this.running) {
      if (this.userInputCallback) {
        this.handleUserInput(data);
      }
      return;
    }

    // Handle reverse history search mode (Ctrl+R)
    if (this.reverseSearchMode) {
      this.handleReverseSearchInput(data);
      return;
    }

    for (let i = 0; i < data.length; i++) {
      const ch = data[i];

      if (ch === '\r' || ch === '\n') {
        this.term.writeln('');
        this.historyIndex = -1;
        this.savedLine = '';

        if (this.lineBuffer.trim()) {
          this.running = true;
          await this.shell.execute(this.lineBuffer, (s: string) => this.term.write(s));
          this.running = false;
        }
        this.lineBuffer = '';
        this.cursorPos = 0;
        this.showPrompt();
        return;
      }

      // Backspace
      if (ch === '\x7f' || ch === '\b') {
        if (this.cursorPos > 0) {
          const deletingAtEnd = this.cursorPos === this.lineBuffer.length;
          this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos - 1) + this.lineBuffer.slice(this.cursorPos);
          this.cursorPos--;

          // Optimization: if deleting at end, just backspace and clear
          if (deletingAtEnd) {
            this.term.write('\b \b'); // Move back, write space, move back again
          } else {
            this.redrawLine();
          }
        }
        continue;
      }

      // Escape sequences
      if (ch === '\x1b' && data[i + 1] === '[') {
        const code = data[i + 2];
        if (code === 'A') { // Up arrow - history
          i += 2;
          if (this.shell.history.length > 0) {
            if (this.historyIndex === -1) {
              this.savedLine = this.lineBuffer;
              this.historyIndex = this.shell.history.length - 1;
            } else if (this.historyIndex > 0) {
              this.historyIndex--;
            }
            this.lineBuffer = this.shell.history[this.historyIndex];
            this.cursorPos = this.lineBuffer.length;
            this.redrawLine();
          }
          continue;
        }
        if (code === 'B') { // Down arrow
          i += 2;
          if (this.historyIndex !== -1) {
            this.historyIndex++;
            if (this.historyIndex >= this.shell.history.length) {
              this.historyIndex = -1;
              this.lineBuffer = this.savedLine;
            } else {
              this.lineBuffer = this.shell.history[this.historyIndex];
            }
            this.cursorPos = this.lineBuffer.length;
            this.redrawLine();
          }
          continue;
        }
        if (code === 'C') { // Right arrow
          i += 2;
          if (this.cursorPos < this.lineBuffer.length) {
            this.cursorPos++;
            this.term.write('\x1b[C');
          }
          continue;
        }
        if (code === 'D') { // Left arrow
          i += 2;
          if (this.cursorPos > 0) {
            this.cursorPos--;
            this.term.write('\x1b[D');
          }
          continue;
        }
        // Home (H) / End (F)
        if (code === 'H') { i += 2; this.cursorPos = 0; this.redrawLine(); continue; }
        if (code === 'F') { i += 2; this.cursorPos = this.lineBuffer.length; this.redrawLine(); continue; }
        // Delete key: \x1b[3~
        if (code === '3' && data[i + 3] === '~') {
          i += 3;
          if (this.cursorPos < this.lineBuffer.length) {
            this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + this.lineBuffer.slice(this.cursorPos + 1);
            this.redrawLine();
          }
          continue;
        }
        i += 2;
        continue;
      }

      // Ctrl+C
      if (ch === '\x03') {
        this.term.writeln('^C');
        this.lineBuffer = '';
        this.cursorPos = 0;
        this.showPrompt();
        return;
      }

      // Ctrl+L (clear)
      if (ch === '\x0c') {
        this.term.write('\x1b[2J\x1b[H');
        this.showPrompt();
        this.term.write(this.lineBuffer);
        continue;
      }

      // Ctrl+A (home)
      if (ch === '\x01') {
        this.cursorPos = 0;
        this.redrawLine();
        continue;
      }

      // Ctrl+E (end)
      if (ch === '\x05') {
        this.cursorPos = this.lineBuffer.length;
        this.redrawLine();
        continue;
      }

      // Ctrl+U (clear line)
      if (ch === '\x15') {
        this.lineBuffer = '';
        this.cursorPos = 0;
        this.redrawLine();
        continue;
      }

      // Ctrl+K (kill to end)
      if (ch === '\x0b') {
        this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos);
        this.redrawLine();
        continue;
      }

      // Ctrl+W (delete word backward)
      if (ch === '\x17') {
        const before = this.lineBuffer.slice(0, this.cursorPos);
        const after = this.lineBuffer.slice(this.cursorPos);
        const trimmed = before.replace(/\S+\s*$/, '');
        this.lineBuffer = trimmed + after;
        this.cursorPos = trimmed.length;
        this.redrawLine();
        continue;
      }

      // Ctrl+R (reverse history search)
      if (ch === '\x12') {
        this.startReverseSearch();
        continue;
      }

      // Tab (basic completion)
      if (ch === '\t') {
        await this.tabComplete();
        continue;
      }

      // Regular character
      if (ch >= ' ') {
        const insertingAtEnd = this.cursorPos === this.lineBuffer.length;
        this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + ch + this.lineBuffer.slice(this.cursorPos);
        this.cursorPos++;

        // Optimization: if inserting at end, just write the character
        if (insertingAtEnd) {
          this.term.write(ch);
        } else {
          // Otherwise redraw the rest of the line
          this.redrawLine();
        }
      }
    }
  }

  /**
   * Handle keystrokes while Spirit is waiting for user input.
   * Supports basic line editing (backspace, enter, Ctrl+C).
   */
  private handleUserInput(data: string) {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];

      if (ch === '\r' || ch === '\n') {
        this.term.writeln('');
        const cb = this.userInputCallback!;
        const input = this.userInputBuffer;
        this.userInputCallback = null;
        this.userInputBuffer = '';
        this.userInputCursorPos = 0;
        cb(input);
        return;
      }

      // Ctrl+C — cancel input with empty string
      if (ch === '\x03') {
        this.term.writeln('^C');
        const cb = this.userInputCallback!;
        this.userInputCallback = null;
        this.userInputBuffer = '';
        this.userInputCursorPos = 0;
        cb('');
        return;
      }

      // Backspace
      if (ch === '\x7f' || ch === '\b') {
        if (this.userInputCursorPos > 0) {
          this.userInputBuffer = this.userInputBuffer.slice(0, this.userInputCursorPos - 1) + this.userInputBuffer.slice(this.userInputCursorPos);
          this.userInputCursorPos--;
          this.term.write('\b \b');
        }
        continue;
      }

      // Skip escape sequences
      if (ch === '\x1b' && data[i + 1] === '[') {
        i += 2;
        continue;
      }

      // Regular character
      if (ch >= ' ') {
        this.userInputBuffer = this.userInputBuffer.slice(0, this.userInputCursorPos) + ch + this.userInputBuffer.slice(this.userInputCursorPos);
        this.userInputCursorPos++;
        this.term.write(ch);
      }
    }
  }

  private redrawLine() {
    // Build the entire update as a single string to minimize rendering flicker
    let output = '\r\x1b[K'; // Clear line

    // Add prompt
    const user = this.shell.env['USER'] || 'user';
    const home = this.shell.env['HOME'] || '/home/user';
    const displayCwd = this.shell.cwd.startsWith(home) ? '~' + this.shell.cwd.slice(home.length) : this.shell.cwd;
    output += `\x1b[32m${user}@shiro\x1b[0m:\x1b[34m${displayCwd}\x1b[0m$ `;

    // Add input buffer
    output += this.lineBuffer;

    // Move cursor to correct position
    const diff = this.lineBuffer.length - this.cursorPos;
    if (diff > 0) {
      output += `\x1b[${diff}D`;
    }

    // Write everything at once
    this.term.write(output);
  }

  /**
   * Start reverse history search mode (Ctrl+R)
   */
  private startReverseSearch(): void {
    this.reverseSearchMode = true;
    this.reverseSearchQuery = '';
    this.reverseSearchIndex = this.shell.history.length; // Start searching from most recent
    this.redrawReverseSearchLine();
  }

  /**
   * Exit reverse search mode
   */
  private exitReverseSearch(accept: boolean): void {
    this.reverseSearchMode = false;
    if (accept && this.reverseSearchIndex >= 0 && this.reverseSearchIndex < this.shell.history.length) {
      this.lineBuffer = this.shell.history[this.reverseSearchIndex];
      this.cursorPos = this.lineBuffer.length;
    }
    this.reverseSearchQuery = '';
    this.reverseSearchIndex = -1;
    this.redrawLine();
  }

  /**
   * Search history backwards for the query
   */
  private findPreviousMatch(): void {
    if (this.reverseSearchQuery === '') return;

    const query = this.reverseSearchQuery.toLowerCase();
    for (let i = this.reverseSearchIndex - 1; i >= 0; i--) {
      if (this.shell.history[i].toLowerCase().includes(query)) {
        this.reverseSearchIndex = i;
        return;
      }
    }
    // No match found, don't change index
  }

  /**
   * Find the most recent match from the current search position
   */
  private findLatestMatch(): void {
    if (this.reverseSearchQuery === '') {
      this.reverseSearchIndex = this.shell.history.length;
      return;
    }

    const query = this.reverseSearchQuery.toLowerCase();
    for (let i = Math.min(this.reverseSearchIndex, this.shell.history.length - 1); i >= 0; i--) {
      if (this.shell.history[i].toLowerCase().includes(query)) {
        this.reverseSearchIndex = i;
        return;
      }
    }
    this.reverseSearchIndex = -1; // No match
  }

  /**
   * Redraw the reverse search prompt and match
   */
  private redrawReverseSearchLine(): void {
    const cols = this.term.cols;
    const matchText = this.reverseSearchIndex >= 0 && this.reverseSearchIndex < this.shell.history.length
      ? this.shell.history[this.reverseSearchIndex]
      : '';

    // Build the search line: (reverse-i-search)`query': match
    const prefix = this.reverseSearchIndex >= 0 ? '(reverse-i-search)' : '(failing reverse-i-search)';
    const display = `${prefix}\`${this.reverseSearchQuery}': ${matchText}`;

    // Clear line and show search
    let output = '\r';
    output += ' '.repeat(cols); // Clear line
    output += '\r';
    output += display.slice(0, cols - 1);

    this.term.write(output);
  }

  /**
   * Handle input while in reverse search mode
   */
  private handleReverseSearchInput(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];

      // Enter - accept current match
      if (ch === '\r' || ch === '\n') {
        this.exitReverseSearch(true);
        this.term.writeln('');
        if (this.lineBuffer.trim()) {
          this.running = true;
          this.shell.execute(this.lineBuffer, (s: string) => this.term.write(s)).then(() => {
            this.running = false;
            this.lineBuffer = '';
            this.cursorPos = 0;
            this.showPrompt();
          });
        } else {
          this.lineBuffer = '';
          this.cursorPos = 0;
          this.showPrompt();
        }
        return;
      }

      // Escape or Ctrl+G - cancel search
      if (ch === '\x1b' || ch === '\x07') {
        this.exitReverseSearch(false);
        return;
      }

      // Ctrl+C - cancel and clear
      if (ch === '\x03') {
        this.exitReverseSearch(false);
        this.term.writeln('^C');
        this.lineBuffer = '';
        this.cursorPos = 0;
        this.showPrompt();
        return;
      }

      // Ctrl+R - search backwards for next match
      if (ch === '\x12') {
        this.findPreviousMatch();
        this.redrawReverseSearchLine();
        continue;
      }

      // Backspace - remove last char from query
      if (ch === '\x7f' || ch === '\b') {
        if (this.reverseSearchQuery.length > 0) {
          this.reverseSearchQuery = this.reverseSearchQuery.slice(0, -1);
          this.reverseSearchIndex = this.shell.history.length;
          this.findLatestMatch();
        }
        this.redrawReverseSearchLine();
        continue;
      }

      // Regular character - add to search query
      if (ch >= ' ') {
        this.reverseSearchQuery += ch;
        this.findLatestMatch();
        this.redrawReverseSearchLine();
        continue;
      }
    }
  }

  /**
   * Find the longest common prefix among strings
   */
  private findCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return '';
    if (strings.length === 1) return strings[0];

    let prefix = strings[0];
    for (let i = 1; i < strings.length; i++) {
      while (!strings[i].startsWith(prefix)) {
        prefix = prefix.slice(0, -1);
        if (prefix === '') return '';
      }
    }
    return prefix;
  }

  /**
   * Get available executables from node_modules/.bin
   */
  private async getBinExecutables(): Promise<string[]> {
    const bins: string[] = [];

    // Walk up from cwd looking for node_modules/.bin
    let dir = this.shell.cwd;
    while (dir !== '/') {
      const binDir = `${dir}/node_modules/.bin`;
      try {
        const entries = await this.shell.fs.readdir(binDir);
        bins.push(...entries);
      } catch {
        // No bin directory at this level
      }
      const parent = dir.substring(0, dir.lastIndexOf('/')) || '/';
      if (parent === dir) break;
      dir = parent;
    }

    // Also check root node_modules/.bin
    try {
      const entries = await this.shell.fs.readdir('/node_modules/.bin');
      bins.push(...entries);
    } catch {
      // No root bin directory
    }

    return [...new Set(bins)]; // Deduplicate
  }

  // Subcommands for common tools
  private static readonly GIT_SUBCOMMANDS = [
    'add', 'branch', 'checkout', 'clone', 'commit', 'diff', 'fetch',
    'init', 'log', 'merge', 'pull', 'push', 'rebase', 'remote',
    'reset', 'restore', 'rm', 'show', 'stash', 'status', 'switch', 'tag'
  ];

  private static readonly NPM_SUBCOMMANDS = [
    'cache', 'i', 'init', 'install', 'list', 'ls', 'remove', 'rm',
    'run', 'test', 'uninstall', '--version'
  ];

  private static readonly SHIRO_SUBCOMMANDS = [
    'config'
  ];

  private static readonly SHIRO_CONFIG_SUBCOMMANDS = [
    'get', 'list', 'set'
  ];

  private async tabComplete() {
    const before = this.lineBuffer.slice(0, this.cursorPos);
    const parts = before.split(/\s+/).filter(p => p.length > 0);
    const partial = parts[parts.length - 1] || '';
    const isFirstWord = parts.length <= 1;

    // Helper to apply completion
    const applyCompletion = (completion: string, suffix = ' ') => {
      const toAdd = completion + suffix;
      this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + toAdd + this.lineBuffer.slice(this.cursorPos);
      this.cursorPos += toAdd.length;
      this.redrawLine();
    };

    // Helper to show matches and apply common prefix
    const showMatches = (matches: string[]) => {
      if (matches.length === 0) return;

      if (matches.length === 1) {
        applyCompletion(matches[0].slice(partial.length));
      } else {
        // Complete to common prefix if longer than current partial
        const commonPrefix = this.findCommonPrefix(matches);
        if (commonPrefix.length > partial.length) {
          applyCompletion(commonPrefix.slice(partial.length), '');
        } else {
          // Show all matches
          this.term.writeln('');
          this.term.writeln(matches.join('  '));
          this.showPrompt();
          this.term.write(this.lineBuffer);
        }
      }
    };

    // Check for subcommand completion
    if (!isFirstWord) {
      const command = parts[0];

      // Git subcommand completion
      if (command === 'git' && parts.length === 2) {
        const matches = ShiroTerminal.GIT_SUBCOMMANDS.filter(s => s.startsWith(partial));
        if (matches.length > 0) {
          showMatches(matches);
          return;
        }
      }

      // npm subcommand completion
      if (command === 'npm' && parts.length === 2) {
        const matches = ShiroTerminal.NPM_SUBCOMMANDS.filter(s => s.startsWith(partial));
        if (matches.length > 0) {
          showMatches(matches);
          return;
        }
      }

      // shiro config subcommand completion
      if (command === 'shiro') {
        if (parts.length === 2) {
          const matches = ShiroTerminal.SHIRO_SUBCOMMANDS.filter(s => s.startsWith(partial));
          if (matches.length > 0) {
            showMatches(matches);
            return;
          }
        } else if (parts.length === 3 && parts[1] === 'config') {
          const matches = ShiroTerminal.SHIRO_CONFIG_SUBCOMMANDS.filter(s => s.startsWith(partial));
          if (matches.length > 0) {
            showMatches(matches);
            return;
          }
        } else if (parts.length === 4 && parts[1] === 'config' && (parts[2] === 'get' || parts[2] === 'set')) {
          const configKeys = ['api_key', 'github_token'];
          const matches = configKeys.filter(s => s.startsWith(partial));
          if (matches.length > 0) {
            showMatches(matches);
            return;
          }
        }
      }

      // Environment variable completion ($VAR)
      if (partial.startsWith('$')) {
        const varPrefix = partial.slice(1);
        const envVars = Object.keys(this.shell.env).filter(v => v.startsWith(varPrefix));
        if (envVars.length > 0) {
          const matches = envVars.map(v => '$' + v);
          showMatches(matches);
          return;
        }
      }
    }

    if (isFirstWord) {
      // Command completion - include both built-in commands and npm bin executables
      const cmds = this.shell.commands.list().map(c => c.name);
      const bins = await this.getBinExecutables();
      const allCommands = [...new Set([...cmds, ...bins])].sort();
      const matches = allCommands.filter(c => c.startsWith(partial));
      showMatches(matches);
    } else {
      // File path completion
      let dir: string, prefix: string;
      if (partial.includes('/')) {
        const lastSlash = partial.lastIndexOf('/');
        dir = this.shell.fs.resolvePath(partial.slice(0, lastSlash) || '/', this.shell.cwd);
        prefix = partial.slice(lastSlash + 1);
      } else {
        dir = this.shell.cwd;
        prefix = partial;
      }

      try {
        const entries = await this.shell.fs.readdir(dir);
        const matches = entries.filter(e => e.startsWith(prefix));
        if (matches.length === 1) {
          const completion = matches[0].slice(prefix.length);
          const fullPath = this.shell.fs.resolvePath(
            (partial.includes('/') ? partial.slice(0, partial.lastIndexOf('/') + 1) : '') + matches[0],
            this.shell.cwd
          );
          const stat = await this.shell.fs.stat(fullPath).catch(() => null);
          const suffix = stat?.isDirectory() ? '/' : ' ';
          applyCompletion(completion, suffix);
        } else if (matches.length > 1) {
          // Complete to common prefix
          const commonPrefix = this.findCommonPrefix(matches);
          if (commonPrefix.length > prefix.length) {
            applyCompletion(commonPrefix.slice(prefix.length), '');
          } else {
            this.term.writeln('');
            this.term.writeln(matches.join('  '));
            this.showPrompt();
            this.term.write(this.lineBuffer);
          }
        }
      } catch {
        // No completions available
      }
    }
  }
}
