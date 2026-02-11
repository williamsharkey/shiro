/**
 * WindowTerminal - lightweight xterm.js wrapper for windowed processes.
 * Implements TerminalLike so it can be used as ctx.terminal in CommandContext.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalLike } from './commands/index';
import { bufferToString } from './utils/copy-utils';
import { setActiveTerminal } from './active-terminal';

export class WindowTerminal implements TerminalLike {
  term: Terminal;
  private fitAddon: FitAddon;
  private container: HTMLDivElement;
  private stdinPassthrough: ((data: string) => void) | null = null;
  private forceExitCallback: (() => void) | null = null;
  private rawModeCallback: ((key: string) => void) | null = null;
  private lastCtrlCTime = 0;
  private resizeCallbacks: ((cols: number, rows: number) => void)[] = [];
  private resizeObserver: ResizeObserver;
  private disposed = false;
  private menuDebounce: ReturnType<typeof setTimeout> | null = null;
  private menuBar: HTMLDivElement | null = null;
  private outputBuffer = '';
  /** Optional callback to mask secrets in output (set by spawn) */
  secretMasker: ((text: string) => string) | null = null;

  constructor(container: HTMLDivElement) {
    this.container = container;
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
      scrollback: 5000,
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (_event: MouseEvent, uri: string) => {
          if (uri.startsWith('shiro://copy?text=')) {
            const text = decodeURIComponent(uri.slice('shiro://copy?text='.length));
            navigator.clipboard.writeText(text).then(() => {
              this.term.writeln('\r\n\x1b[32m  URL copied to clipboard\x1b[0m');
            }).catch(() => { prompt('Copy this URL:', text); });
            return;
          }
          window.open(uri, '_blank', 'noopener');
        },
      },
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);

    // Initial fit after a frame so the container has layout
    requestAnimationFrame(() => {
      if (!this.disposed) this.fitAddon.fit();
    });

    // Route input
    this.term.onData((data) => this.handleInput(data));

    // Register as active terminal on focus (for mobile toolbar routing)
    this.term.textarea?.addEventListener('focus', () => {
      setActiveTerminal(this);
    });

    // ResizeObserver to refit on window resize/drag
    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      this.fitAddon.fit();
      const { rows, cols } = this.getSize();
      for (const cb of this.resizeCallbacks) cb(cols, rows);
    });
    this.resizeObserver.observe(container);
  }

  writeOutput(text: string): void {
    if (this.disposed) return;
    if (this.secretMasker) text = this.secretMasker(text);
    this.term.write(text);

    // Buffer output for menu detection (keep last 2KB, strip ANSI)
    this.outputBuffer += text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');
    if (this.outputBuffer.length > 2048) {
      this.outputBuffer = this.outputBuffer.slice(-2048);
    }
    // Debounce menu scan
    if (this.menuDebounce) clearTimeout(this.menuDebounce);
    this.menuDebounce = setTimeout(() => this.scanForMenu(), 150);
  }

  /** Inject raw input as if typed. Used by mobile toolbar and menu buttons. */
  injectInput(data: string): void {
    this.hideMenu();
    this.handleInput(data);
  }

  enterStdinPassthrough(cb: (data: string) => void, forceExitCb?: () => void): void {
    this.stdinPassthrough = cb;
    this.forceExitCallback = forceExitCb || null;
    this.lastCtrlCTime = 0;
  }

  exitStdinPassthrough(): void {
    this.stdinPassthrough = null;
    this.forceExitCallback = null;
    this.lastCtrlCTime = 0;
  }

  enterRawMode(cb: (key: string) => void): void {
    this.rawModeCallback = cb;
  }

  exitRawMode(): void {
    this.rawModeCallback = null;
  }

  isRawMode(): boolean {
    return this.rawModeCallback !== null;
  }

  onResize(cb: (cols: number, rows: number) => void): () => void {
    this.resizeCallbacks.push(cb);
    return () => { this.resizeCallbacks = this.resizeCallbacks.filter(c => c !== cb); };
  }

  getSize(): { rows: number; cols: number } {
    return { rows: this.term.rows, cols: this.term.cols };
  }

  private handleInput(data: string): void {
    // Stdin passthrough takes priority (used by ink/Claude Code)
    if (this.stdinPassthrough) {
      // Double Ctrl+C force exit
      if (data === '\x03') {
        const now = Date.now();
        if (now - this.lastCtrlCTime < 1000 && this.forceExitCallback) {
          this.forceExitCallback();
          return;
        }
        this.lastCtrlCTime = now;
      }
      this.stdinPassthrough(data);
      return;
    }

    // Raw mode (vi-like editors)
    if (this.rawModeCallback) {
      this.rawModeCallback(data);
      return;
    }
  }

  getBufferContent(): string {
    return bufferToString(this.term);
  }

  forceKill(): void {
    if (this.forceExitCallback) this.forceExitCallback();
    this.exitStdinPassthrough();
    this.exitRawMode();
  }

  /** Scan buffered output for numbered menu items and show tappable buttons. */
  private scanForMenu(): void {
    const lines = this.outputBuffer.split('\n');
    const menuRe = /^\s*(\d+)[.)]\s+(.+?)$/;
    const items: { num: string; label: string }[] = [];

    // Scan last lines for consecutive numbered items
    let streak: { num: string; label: string }[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(menuRe);
      if (m) {
        streak.unshift({ num: m[1], label: m[2].trim() });
      } else if (streak.length >= 2) {
        break;
      } else {
        streak = [];
      }
    }
    if (streak.length >= 2) {
      items.push(...streak);
    }

    if (items.length >= 2) {
      this.showMenu(items);
    } else {
      this.hideMenu();
    }
  }

  /** Show a floating bar of tappable number buttons at the bottom of the terminal container. */
  private showMenu(items: { num: string; label: string }[]): void {
    this.hideMenu();

    const bar = document.createElement('div');
    bar.style.cssText = `
      position: absolute; bottom: 4px; left: 4px; right: 4px;
      display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 8px;
      background: rgba(20, 20, 40, 0.92); border-radius: 8px;
      z-index: 10; justify-content: center;
    `;

    for (const item of items) {
      const btn = document.createElement('button');
      // Truncate label to keep buttons compact
      const shortLabel = item.label.length > 18 ? item.label.slice(0, 16) + '\u2026' : item.label;
      btn.textContent = `${item.num}: ${shortLabel}`;
      btn.style.cssText = `
        background: #2a2a4a; color: #e0e0e0; border: 1px solid #4a4a6a;
        border-radius: 12px; padding: 4px 12px; font-size: 13px;
        font-family: inherit; cursor: pointer; white-space: nowrap;
      `;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hideMenu();
        this.handleInput(item.num + '\r');
      });
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideMenu();
        this.handleInput(item.num + '\r');
      }, { passive: false });
      bar.appendChild(btn);
    }

    this.menuBar = bar;
    this.container.appendChild(bar);

    // Auto-hide after 15 seconds
    setTimeout(() => {
      if (this.menuBar === bar) this.hideMenu();
    }, 15000);
  }

  /** Remove the menu button bar. */
  private hideMenu(): void {
    if (this.menuBar) {
      this.menuBar.remove();
      this.menuBar = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.hideMenu();
    if (this.menuDebounce) clearTimeout(this.menuDebounce);
    this.resizeObserver.disconnect();
    this.resizeCallbacks = [];
    this.stdinPassthrough = null;
    this.forceExitCallback = null;
    this.rawModeCallback = null;
    this.term.dispose();
  }
}
