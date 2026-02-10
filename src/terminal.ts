import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Shell } from './shell';
import buildNumber from '../build-number.txt?raw';

/**
 * HUD (Heads-Up Display) state for dynamic banner updates.
 * Tracks where the banner was drawn and allows in-place updates.
 */
interface HudState {
  startRow: number;      // Absolute row in buffer where HUD starts
  lineCount: number;     // Number of lines in the HUD
  // Positions of updatable elements (row offset from startRow, column)
  slots: {
    remoteCode: { row: number; col: number; width: number };
    recStatus: { row: number; col: number; width: number };
  };
}

export class ShiroTerminal {
  term: Terminal;
  fitAddon: FitAddon;
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
  private stdinPassthrough: ((data: string) => void) | null = null;
  private stdinForceExitCallback: (() => void) | null = null;
  private lastCtrlCTime = 0;
  private pendingStdinInput: string[] = [];
  private iframeContainer: HTMLElement | null = null;
  private displayedRows = 1; // track how many terminal rows the current prompt+input spans
  private resizeCallbacks: ((cols: number, rows: number) => void)[] = [];

  // HUD state for dynamic updates
  private hud: HudState | null = null;

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
      lineHeight: 1.12,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      linkHandler: {
        activate: (_event: MouseEvent, uri: string) => {
          // Handle special shiro:// URLs for banner actions
          if (uri === 'shiro://rec') {
            // Toggle termcast recording
            const session = (window as any).__termcastSession;
            const cmd = session ? 'termcast stop' : 'termcast start';
            // Execute through shell and display output
            this.term.writeln('');
            this.shell.execute(
              cmd,
              (s) => this.term.write(s),
              (s) => this.term.write(`\x1b[31m${s}\x1b[0m`)
            ).then(() => {
              this.showPrompt();
            });
            return;
          }
          // Open regular links directly without confirmation popup
          window.open(uri, '_blank', 'noopener');
        },
      },
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);
    this.fitAddon.fit();

    // Create iframe container for virtual servers
    this.iframeContainer = document.createElement('div');
    this.iframeContainer.id = 'shiro-iframes';
    this.iframeContainer.style.cssText = `
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      background: #1a1a2e;
      border-top: 2px solid #3d3d5c;
      display: none;
    `;
    document.body.appendChild(this.iframeContainer);

    // Refit on window resize
    window.addEventListener('resize', () => {
      this.fitAddon.fit();
      this.resizeCallbacks.forEach(cb => cb(this.term.cols, this.term.rows));
    });

    // ResizeObserver catches container size changes that don't trigger window resize
    // (e.g., dev tools opening/closing, CSS layout changes)
    const resizeObserver = new ResizeObserver(() => {
      this.fitAddon.fit();
      this.resizeCallbacks.forEach(cb => cb(this.term.cols, this.term.rows));
    });
    resizeObserver.observe(container);

    this.term.onData((data: string) => this.handleInput(data));
  }

  private _writeCount = 0;
  writeOutput(text: string): void {
    // Mask any secret env values (tokens, API keys) before rendering
    text = this.shell.maskSecrets(text);
    const n = ++this._writeCount;
    this.term.write(text, () => {
      // Diagnostic: log first 5 writes and check xterm.js buffer after processing
      if (n <= 20) {
        const line0 = this.term.buffer.active.getLine(0)?.translateToString(true) || '';
        console.warn(`[xterm] write #${n} (${text.length}b) line0="${line0.slice(0,60)}"`);
      }
    });
  }

  /**
   * Get the iframe container for virtual servers.
   * Shows the container when called.
   */
  getIframeContainer(): HTMLElement | null {
    if (this.iframeContainer) {
      this.iframeContainer.style.display = 'block';
    }
    return this.iframeContainer;
  }

  /**
   * Hide the iframe container
   */
  hideIframeContainer(): void {
    if (this.iframeContainer) {
      this.iframeContainer.style.display = 'none';
      this.iframeContainer.innerHTML = '';
    }
  }

  /**
   * Get the terminal buffer content as a string.
   * Used by clip-report to copy terminal history.
   */
  getBufferContent(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    // Trim empty lines from end
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    return lines.join('\n');
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
   * Enter stdin passthrough mode — raw xterm.js data is forwarded to the callback
   * without any key parsing. Used by Node.js scripts that need real stdin (e.g., ink).
   * Takes precedence over rawModeCallback.
   * @param forceExitCallback Optional callback for double Ctrl+C force kill
   */
  enterStdinPassthrough(callback: (data: string) => void, forceExitCallback?: () => void): void {
    this.stdinPassthrough = callback;
    this.stdinForceExitCallback = forceExitCallback || null;
    this.lastCtrlCTime = 0;
    // Flush any input that arrived while passthrough was null
    if (this.pendingStdinInput.length > 0) {
      const pending = this.pendingStdinInput;
      this.pendingStdinInput = [];
      for (const data of pending) {
        callback(data);
      }
    }
  }

  /**
   * Exit stdin passthrough mode.
   */
  exitStdinPassthrough(): void {
    this.stdinPassthrough = null;
    this.stdinForceExitCallback = null;
    this.lastCtrlCTime = 0;
    this.pendingStdinInput = [];
  }

  /**
   * Register a callback for terminal resize events (used by ink for layout).
   */
  onResize(callback: (cols: number, rows: number) => void): () => void {
    this.resizeCallbacks.push(callback);
    return () => { this.resizeCallbacks = this.resizeCallbacks.filter(cb => cb !== callback); };
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
    this.drawBanner();
    // Source ~/.profile if it exists (env vars, aliases, etc. — persisted in IndexedDB)
    try {
      const profile = await this.shell.fs.readFile('/home/user/.profile');
      const text = typeof profile === 'string' ? profile : new TextDecoder().decode(profile);
      if (text.trim()) {
        await this.shell.execute(text, () => {}, () => {});
      }
    } catch {}
    this.showPrompt();
  }

  /**
   * Draw the HUD (heads-up display) banner and track its position for dynamic updates.
   * Can be called anytime to draw a fresh HUD at the current cursor position.
   */
  drawHud() {
    const build = buildNumber.trim().padStart(4, '0');

    // Detect subdomain
    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'shiro.computer';
    const subdomainMatch = hostname.match(/^([^.]+)\.shiro\.computer$/);
    const displayHost = subdomainMatch ? `${subdomainMatch[1]}.shiro.computer` : 'shiro.computer';

    // OSC 8 hyperlink helper: \x1b]8;;URL\x07text\x1b]8;;\x07
    const link = (url: string, text: string, color: string = '33') =>
      `\x1b]8;;${url}\x07\x1b[${color}m${text}\x1b[0m\x1b]8;;\x07`;

    // Build URLs preserving subdomain
    const baseUrl = `https://${hostname}`;
    const aboutUrl = `${baseUrl}/about`;
    const mcpUrl = `${baseUrl}/mcp.html`;
    const githubUrl = 'https://github.com/williamsharkey/shiro';
    const discordUrl = 'https://discord.gg/Wkw4SZ2V';

    // Pad hostname to fit layout (max ~20 chars for subdomain display)
    const hostDisplay = displayHost.length <= 20 ? displayHost : displayHost.slice(0, 17) + '...';
    const hostPad = ' '.repeat(Math.max(0, 22 - hostDisplay.length));

    // Record HUD start position (absolute row in buffer)
    const buffer = this.term.buffer.active;
    const startRow = buffer.baseY + buffer.cursorY;

    // Check for active remote session
    const remoteSession = (window as any).__shiroRemoteSession;
    const remoteCode = remoteSession?.displayCode; // e.g., "chibi-gray"

    // Row 0: Top border - with or without remote code
    // Box is 43 chars wide. Right end is always ╒══╗ (4 chars) for alignment.
    // Format: ╔ + ═padding + ╛ + code + ╒══╗ = 43
    // So: 1 + padding + 1 + codeLen + 4 = 43 → padding = 37 - codeLen
    if (remoteCode) {
      const codeLen = remoteCode.length;
      const leftPad = Math.max(1, 37 - codeLen);
      this.term.writeln(`\x1b[36m╔${'═'.repeat(leftPad)}╛\x1b[93m${remoteCode}\x1b[36m╒══╗\x1b[0m`);
    } else {
      this.term.writeln('\x1b[36m╔═════════════════════════════════════════╗\x1b[0m');
    }

    // Row 1: Host and version
    this.term.writeln(`\x1b[36m║\x1b[0m  \x1b[1;97m${hostDisplay}\x1b[0m${hostPad}\x1b[95mv0.1.0\x1b[0m   \x1b[95m#${build}\x1b[0m   \x1b[36m║\x1b[0m`);
    // Row 2: Tagline
    this.term.writeln('\x1b[36m║\x1b[0m                \x1b[92mcloud operating system\x1b[0m   \x1b[36m║\x1b[0m');
    // Row 3: Empty
    this.term.writeln('\x1b[36m║\x1b[0m                                         \x1b[36m║\x1b[0m');
    // Row 4: help / mcp
    this.term.writeln(`\x1b[36m║\x1b[0m  \x1b[33mhelp\x1b[0m                             ${link(mcpUrl, 'mcp', '94')}   \x1b[36m║\x1b[0m`);
    // Row 5: spirit / about
    this.term.writeln(`\x1b[36m║\x1b[0m  \x1b[33mspirit\x1b[0m                         ${link(aboutUrl, 'about', '94')}   \x1b[36m║\x1b[0m`);
    // Row 6: upload / github
    this.term.writeln(`\x1b[36m║\x1b[0m  \x1b[33mupload\x1b[0m                        ${link(githubUrl, 'github', '94')}   \x1b[36m║\x1b[0m`);
    // Row 7: download / discord
    this.term.writeln(`\x1b[36m║\x1b[0m  \x1b[33mdownload\x1b[0m                     ${link(discordUrl, 'discord', '94')}   \x1b[36m║\x1b[0m`);
    // Row 8: Bottom border
    this.term.writeln('\x1b[36m╚═══════════════════╛\x1b[97m白\x1b[36m╒══════════════════╝\x1b[0m');
    // Row 9: Empty line
    this.term.writeln('');

    // Store HUD state for dynamic updates
    this.hud = {
      startRow,
      lineCount: 10,
      slots: {
        // Remote code appears in top border, centered around column 28
        remoteCode: { row: 0, col: 28, width: 20 },
        // Rec status appears on row 4, around column 36
        recStatus: { row: 4, col: 34, width: 8 },
      },
    };
  }

  /**
   * Check if the HUD is still visible (hasn't scrolled out of buffer).
   */
  isHudVisible(): boolean {
    if (!this.hud) return false;
    const buffer = this.term.buffer.active;
    const scrollback = this.term.options.scrollback || 1000;
    return this.hud.startRow >= buffer.baseY - scrollback;
  }

  /**
   * Update a specific position in the HUD without disturbing terminal content.
   * Does nothing if HUD has scrolled out of view.
   */
  updateHudAt(rowOffset: number, col: number, text: string) {
    if (!this.isHudVisible()) return;

    const targetRow = this.hud!.startRow + rowOffset + 1; // +1 because terminal rows are 1-indexed
    this.term.write('\x1b7');                          // Save cursor
    this.term.write(`\x1b[${targetRow};${col}H`);      // Move to position
    this.term.write(text);                             // Write text
    this.term.write('\x1b8');                          // Restore cursor
  }

  /**
   * Update the remote code display in the HUD top border.
   */
  updateHudRemoteCode(code: string | null) {
    if (!this.isHudVisible()) return;

    // Calculate viewport-relative row position
    const buffer = this.term.buffer.active;
    const viewportRow = this.hud!.startRow - buffer.baseY + 1; // Convert to 1-indexed viewport position

    // Only update if the HUD row is actually in the viewport
    if (viewportRow < 1 || viewportRow > this.term.rows) return;

    this.term.write('\x1b7'); // Save cursor (DECSC)
    this.term.write(`\x1b[${viewportRow};1H`); // Move to start of row (viewport-relative)

    // Box is 43 chars wide. Right end is always ╒══╗ (4 chars) for alignment.
    if (code) {
      const codeLen = code.length;
      const leftPad = Math.max(1, 37 - codeLen);
      this.term.write(`\x1b[36m╔${'═'.repeat(leftPad)}╛\x1b[93m${code}\x1b[36m╒══╗\x1b[0m`);
    } else {
      this.term.write('\x1b[36m╔═════════════════════════════════════════╗\x1b[0m');
    }

    this.term.write('\x1b8'); // Restore cursor (DECRC)
  }

  /**
   * Update the rec status display in the HUD.
   */
  updateHudRecStatus(status: string) {
    if (!this.isHudVisible()) return;

    const slot = this.hud!.slots.recStatus;
    const padded = status.padEnd(slot.width);
    this.updateHudAt(slot.row, slot.col, padded);
  }

  // Keep old name as alias for backwards compatibility
  drawBanner() {
    this.drawHud();
  }

  private showPrompt() {
    const cwd = this.shell.cwd;
    const home = this.shell.env['HOME'] || '/home/user';
    const displayCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    const user = this.shell.env['USER'] || 'user';
    const hostDisplay = this.getHostDisplay();
    this.term.write(`\x1b[32m${user}@${hostDisplay}\x1b[0m:\x1b[34m${displayCwd}\x1b[0m$ `);
    this.displayedRows = 1;
  }

  /**
   * Execute a command from a remote source (e.g., MCP) and display it in the terminal
   * as if the user typed it. Returns { stdout, stderr, exitCode }.
   */
  async executeRemoteCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Clear existing prompt line before showing remote command
    this.term.write('\r\x1b[K');

    // Show remote prompt: orange user@host, blue cwd, orange ℝ (instead of $)
    const cwd = this.shell.cwd;
    const home = this.shell.env['HOME'] || '/home/user';
    const displayCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    const user = this.shell.env['USER'] || 'user';
    const hostDisplay = this.getHostDisplay();

    // Orange (208) for remote indicator, ℝ (U+211D) as remote symbol
    this.term.write(`\x1b[38;5;208m${user}@${hostDisplay}\x1b[0m:\x1b[34m${displayCwd}\x1b[38;5;208mℝ\x1b[0m `);
    this.term.writeln(command);

    let stdout = '';
    let stderr = '';

    const exitCode = await this.shell.execute(
      command,
      (s: string) => {
        stdout += s;
        this.term.write(s);
      },
      (s: string) => {
        stderr += s;
        this.term.write(`\x1b[31m${s}\x1b[0m`);
      },
      true, // remote command
    );

    this.showPrompt();
    return { stdout, stderr, exitCode };
  }

  private async handleInput(data: string) {
    // Stdin passthrough: forward raw data without parsing (e.g., ink/React terminal apps)
    if (this.stdinPassthrough) {
      // Double Ctrl+C force kill: if pressed twice within 1s, force exit
      if (data.includes('\x03') && this.stdinForceExitCallback) {
        const now = Date.now();
        if (now - this.lastCtrlCTime < 1000) {
          this.stdinForceExitCallback();
          return;
        }
        this.lastCtrlCTime = now;
      }
      this.stdinPassthrough(data);
      return;
    }

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
      // Allow Ctrl+C to force-kill even without stdinPassthrough
      // (ink may have disabled raw mode while "thinking")
      if (data.includes('\x03') && this.stdinForceExitCallback) {
        const now = Date.now();
        if (now - this.lastCtrlCTime < 1000) {
          this.stdinForceExitCallback();
          return;
        }
        this.lastCtrlCTime = now;
      }
      if (this.userInputCallback) {
        this.handleUserInput(data);
      } else {
        // Queue input for delivery when stdinPassthrough is re-enabled
        // (ink briefly disables raw mode between render cycles)
        this.pendingStdinInput.push(data);
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
        const totalChars = this.promptVisualLength() + this.lineBuffer.length;
        this.displayedRows = Math.max(1, Math.ceil(totalChars / this.term.cols));
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
          // Update displayed row count when content may have wrapped to a new row
          const totalChars = this.promptVisualLength() + this.lineBuffer.length;
          this.displayedRows = Math.max(1, Math.ceil(totalChars / this.term.cols));
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

  private getHostDisplay(): string {
    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'shiro.computer';
    const subdomainMatch = hostname.match(/^([^.]+)\.shiro\.computer$/);
    return subdomainMatch ? subdomainMatch[1] : 'shiro';
  }

  private promptVisualLength(): number {
    const user = this.shell.env['USER'] || 'user';
    const home = this.shell.env['HOME'] || '/home/user';
    const displayCwd = this.shell.cwd.startsWith(home) ? '~' + this.shell.cwd.slice(home.length) : this.shell.cwd;
    const hostDisplay = this.getHostDisplay();
    // "user@host:cwd$ "
    return user.length + '@'.length + hostDisplay.length + ':'.length + displayCwd.length + '$ '.length;
  }

  private redrawLine() {
    const cols = this.term.cols;

    // Move cursor to the start of the first row of the old content
    let output = '';
    if (this.displayedRows > 1) {
      output += `\x1b[${this.displayedRows - 1}A`; // move up
    }
    output += '\r\x1b[J'; // carriage return + erase from cursor to end of screen

    // Add prompt
    const user = this.shell.env['USER'] || 'user';
    const home = this.shell.env['HOME'] || '/home/user';
    const displayCwd = this.shell.cwd.startsWith(home) ? '~' + this.shell.cwd.slice(home.length) : this.shell.cwd;
    const hostDisplay = this.getHostDisplay();
    output += `\x1b[32m${user}@${hostDisplay}\x1b[0m:\x1b[34m${displayCwd}\x1b[0m$ `;

    // Add input buffer (strip any control chars that leaked from interactive programs)
    const safeBuffer = this.lineBuffer.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    output += safeBuffer;

    // Calculate how many rows the new content occupies
    const totalChars = this.promptVisualLength() + this.lineBuffer.length;
    this.displayedRows = Math.max(1, Math.ceil(totalChars / cols));

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
