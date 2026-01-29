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
      lineHeight: 1.2,
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

  async start() {
    this.term.writeln('\x1b[36m╔═══════════════════════════════════════╗\x1b[0m');
    this.term.writeln('\x1b[36m║\x1b[0m   \x1b[1;97mShiro OS\x1b[0m v0.1.0                    \x1b[36m║\x1b[0m');
    this.term.writeln('\x1b[36m║\x1b[0m   Browser-Native Cloud Operating System\x1b[36m║\x1b[0m');
    this.term.writeln('\x1b[36m║\x1b[0m   Type \x1b[33mhelp\x1b[0m for available commands      \x1b[36m║\x1b[0m');
    this.term.writeln('\x1b[36m╚═══════════════════════════════════════╝\x1b[0m');
    this.term.writeln('');
    this.showPrompt();
  }

  private showPrompt() {
    const cwd = this.shell.cwd;
    const home = this.shell.env['HOME'] || '/home/user';
    const displayCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    this.term.write(`\x1b[32muser@shiro\x1b[0m:\x1b[34m${displayCwd}\x1b[0m$ `);
  }

  private async handleInput(data: string) {
    if (this.running) return;

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
          this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos - 1) + this.lineBuffer.slice(this.cursorPos);
          this.cursorPos--;
          this.redrawLine();
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

      // Tab (basic completion)
      if (ch === '\t') {
        await this.tabComplete();
        continue;
      }

      // Regular character
      if (ch >= ' ') {
        this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + ch + this.lineBuffer.slice(this.cursorPos);
        this.cursorPos++;
        this.redrawLine();
      }
    }
  }

  private redrawLine() {
    this.term.write('\r\x1b[K');
    this.showPrompt();
    this.term.write(this.lineBuffer);
    // Move cursor to correct position
    const diff = this.lineBuffer.length - this.cursorPos;
    if (diff > 0) {
      this.term.write(`\x1b[${diff}D`);
    }
  }

  private async tabComplete() {
    const before = this.lineBuffer.slice(0, this.cursorPos);
    const parts = before.split(/\s+/);
    const partial = parts[parts.length - 1];

    if (parts.length <= 1) {
      // Command completion
      const cmds = this.shell.commands.list().map(c => c.name);
      const matches = cmds.filter(c => c.startsWith(partial));
      if (matches.length === 1) {
        const completion = matches[0].slice(partial.length) + ' ';
        this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + completion + this.lineBuffer.slice(this.cursorPos);
        this.cursorPos += completion.length;
        this.redrawLine();
      } else if (matches.length > 1) {
        this.term.writeln('');
        this.term.writeln(matches.join('  '));
        this.showPrompt();
        this.term.write(this.lineBuffer);
      }
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
          this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + completion + suffix + this.lineBuffer.slice(this.cursorPos);
          this.cursorPos += completion.length + suffix.length;
          this.redrawLine();
        } else if (matches.length > 1) {
          this.term.writeln('');
          this.term.writeln(matches.join('  '));
          this.showPrompt();
          this.term.write(this.lineBuffer);
        }
      } catch {
        // No completions available
      }
    }
  }
}
