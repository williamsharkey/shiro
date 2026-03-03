/**
 * tmux-layout.ts — Virtual pane/window/session engine for tmux-lite
 *
 * Each pane is a virtual screen buffer (2D char array) rendered via ANSI escape codes.
 * Multiple panes compose into windows, windows compose into sessions.
 */

import type { FileSystem } from './filesystem';
import type { CommandRegistry } from './commands/index';
import { Shell } from './shell';

// ── Virtual Screen Buffer ───────────────────────────────────────────

export class ScreenBuffer {
  width: number;
  height: number;
  cells: string[][];    // [row][col] — single characters
  cursorRow = 0;
  cursorCol = 0;
  scrollback: string[][] = [];
  maxScrollback = 1000;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => ' ')
    );
  }

  resize(width: number, height: number): void {
    const newCells = Array.from({ length: height }, (_, r) =>
      Array.from({ length: width }, (_, c) =>
        r < this.cells.length && c < (this.cells[r]?.length ?? 0)
          ? this.cells[r][c]
          : ' '
      )
    );
    this.cells = newCells;
    this.width = width;
    this.height = height;
    this.cursorRow = Math.min(this.cursorRow, height - 1);
    this.cursorCol = Math.min(this.cursorCol, width - 1);
  }

  write(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // Handle control characters
      if (ch === '\n') {
        this.cursorCol = 0;
        this.cursorRow++;
        if (this.cursorRow >= this.height) {
          this.scrollUp();
          this.cursorRow = this.height - 1;
        }
        continue;
      }
      if (ch === '\r') {
        this.cursorCol = 0;
        continue;
      }
      if (ch === '\t') {
        const nextTab = (Math.floor(this.cursorCol / 8) + 1) * 8;
        this.cursorCol = Math.min(nextTab, this.width - 1);
        continue;
      }
      if (ch === '\x1b') {
        // Skip ANSI escape sequences (simplified)
        i++;
        if (i < text.length && text[i] === '[') {
          i++;
          while (i < text.length && text[i] >= '0' && text[i] <= '?') i++;
          while (i < text.length && text[i] >= ' ' && text[i] <= '/') i++;
          // Final character consumed by loop increment
        }
        continue;
      }
      if (ch.charCodeAt(0) < 32) continue; // Skip other control chars

      // Write printable character
      if (this.cursorCol >= this.width) {
        this.cursorCol = 0;
        this.cursorRow++;
        if (this.cursorRow >= this.height) {
          this.scrollUp();
          this.cursorRow = this.height - 1;
        }
      }

      this.cells[this.cursorRow][this.cursorCol] = ch;
      this.cursorCol++;
    }
  }

  private scrollUp(): void {
    if (this.cells.length > 0) {
      const line = this.cells.shift()!;
      this.scrollback.push(line);
      if (this.scrollback.length > this.maxScrollback) {
        this.scrollback.shift();
      }
      this.cells.push(Array.from({ length: this.width }, () => ' '));
    }
  }

  clear(): void {
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        this.cells[r][c] = ' ';
      }
    }
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  /** Render buffer to string lines (no ANSI — just raw chars) */
  toLines(): string[] {
    return this.cells.map(row => row.join(''));
  }
}

// ── Pane ─────────────────────────────────────────────────────────────

export type SplitDirection = 'horizontal' | 'vertical';

let nextPaneId = 0;

export class TmuxPane {
  id: number;
  shell: Shell;
  buffer: ScreenBuffer;
  x: number;
  y: number;
  width: number;
  height: number;
  outputBuffer = '';
  running = true;

  constructor(shell: Shell, x: number, y: number, width: number, height: number) {
    this.id = nextPaneId++;
    this.shell = shell;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.buffer = new ScreenBuffer(width, height);
  }

  resize(x: number, y: number, width: number, height: number): void {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.buffer.resize(width, height);
  }

  /** Write text to this pane's virtual buffer */
  writeOutput(text: string): void {
    this.outputBuffer += text;
    this.buffer.write(text);
  }

  /** Get the current prompt string for this pane's shell */
  getPrompt(): string {
    const cwd = this.shell.cwd;
    const home = this.shell.env.HOME || '/home/user';
    const display = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    return `${display}$ `;
  }
}

// ── Window ───────────────────────────────────────────────────────────

let nextWindowId = 0;

export class TmuxWindow {
  id: number;
  name: string;
  panes: TmuxPane[] = [];
  activePane: number = 0; // index into panes array

  constructor(name: string) {
    this.id = nextWindowId++;
    this.name = name;
  }

  getActivePane(): TmuxPane | undefined {
    return this.panes[this.activePane];
  }

  addPane(pane: TmuxPane): void {
    this.panes.push(pane);
  }

  removePane(paneId: number): void {
    const idx = this.panes.findIndex(p => p.id === paneId);
    if (idx >= 0) {
      this.panes.splice(idx, 1);
      if (this.activePane >= this.panes.length) {
        this.activePane = Math.max(0, this.panes.length - 1);
      }
    }
  }

  /** Split the active pane horizontally (new pane to the right) */
  splitHorizontal(shell: Shell): TmuxPane {
    const active = this.getActivePane();
    if (!active) throw new Error('No active pane');

    const newWidth = Math.floor(active.width / 2);
    const oldWidth = active.width - newWidth - 1; // -1 for border
    active.resize(active.x, active.y, oldWidth, active.height);

    const newPane = new TmuxPane(shell, active.x + oldWidth + 1, active.y, newWidth, active.height);
    this.panes.push(newPane);
    this.activePane = this.panes.length - 1;
    return newPane;
  }

  /** Split the active pane vertically (new pane below) */
  splitVertical(shell: Shell): TmuxPane {
    const active = this.getActivePane();
    if (!active) throw new Error('No active pane');

    const newHeight = Math.floor(active.height / 2);
    const oldHeight = active.height - newHeight - 1; // -1 for border
    active.resize(active.x, active.y, active.width, oldHeight);

    const newPane = new TmuxPane(shell, active.x, active.y + oldHeight + 1, active.width, newHeight);
    this.panes.push(newPane);
    this.activePane = this.panes.length - 1;
    return newPane;
  }
}

// ── Session ──────────────────────────────────────────────────────────

let nextSessionId = 0;

export class TmuxSession {
  id: number;
  name: string;
  windows: TmuxWindow[] = [];
  activeWindow: number = 0;

  constructor(name: string) {
    this.id = nextSessionId++;
    this.name = name;
  }

  getActiveWindow(): TmuxWindow | undefined {
    return this.windows[this.activeWindow];
  }

  addWindow(window: TmuxWindow): void {
    this.windows.push(window);
  }

  nextWindow(): void {
    if (this.windows.length > 1) {
      this.activeWindow = (this.activeWindow + 1) % this.windows.length;
    }
  }

  prevWindow(): void {
    if (this.windows.length > 1) {
      this.activeWindow = (this.activeWindow - 1 + this.windows.length) % this.windows.length;
    }
  }
}

// ── Layout Renderer ─────────────────────────────────────────────────

/** Render all panes of a window into a single screen buffer string */
export function renderWindow(window: TmuxWindow, totalCols: number, totalRows: number): string {
  // Create composite screen
  const screen = Array.from({ length: totalRows }, () =>
    Array.from({ length: totalCols }, () => ' ')
  );

  // Draw each pane's content
  for (const pane of window.panes) {
    const lines = pane.buffer.toLines();
    for (let r = 0; r < pane.height && r < lines.length; r++) {
      const screenRow = pane.y + r;
      if (screenRow >= totalRows - 1) break; // Reserve last row for status
      for (let c = 0; c < pane.width && c < lines[r].length; c++) {
        const screenCol = pane.x + c;
        if (screenCol < totalCols) {
          screen[screenRow][screenCol] = lines[r][c];
        }
      }
    }
  }

  // Draw pane borders (│ between horizontal splits, ─ between vertical splits)
  for (const pane of window.panes) {
    // Right border
    if (pane.x + pane.width < totalCols) {
      const borderCol = pane.x + pane.width;
      for (let r = pane.y; r < pane.y + pane.height && r < totalRows - 1; r++) {
        if (borderCol < totalCols) screen[r][borderCol] = '│';
      }
    }
    // Bottom border
    if (pane.y + pane.height < totalRows - 1) {
      const borderRow = pane.y + pane.height;
      if (borderRow < totalRows) {
        for (let c = pane.x; c < pane.x + pane.width && c < totalCols; c++) {
          screen[borderRow][c] = '─';
        }
      }
    }
  }

  // Highlight active pane border
  const activePane = window.getActivePane();
  if (activePane && window.panes.length > 1) {
    // Draw bright border around active pane
    const ax = activePane.x;
    const ay = activePane.y;
    const aw = activePane.width;
    const ah = activePane.height;

    // Top edge
    if (ay > 0) {
      for (let c = ax; c < ax + aw && c < totalCols; c++) {
        screen[ay - 1][c] = '━';
      }
    }
  }

  // Convert to string
  return screen.map(row => row.join('')).join('\r\n');
}

/** Render tmux status bar */
export function renderStatusBar(session: TmuxSession, cols: number, prefixMode: boolean): string {
  const windowList = session.windows.map((w, i) => {
    const active = i === session.activeWindow ? '*' : '-';
    return `${i}:${w.name}${active}`;
  }).join(' ');

  const prefix = prefixMode ? '\x1b[33m[PREFIX]\x1b[0m ' : '';
  const left = `[${session.name}] ${windowList}`;
  const right = new Date().toLocaleTimeString();
  const padding = Math.max(0, cols - left.length - right.length - (prefixMode ? 10 : 0));

  return `\x1b[7m${prefix}${left}${' '.repeat(padding)}${right}\x1b[27m`;
}

// ── Session persistence ─────────────────────────────────────────────

export interface SessionSnapshot {
  name: string;
  windows: { name: string; paneCount: number; activePaneIndex: number }[];
  activeWindow: number;
}

export function snapshotSession(session: TmuxSession): SessionSnapshot {
  return {
    name: session.name,
    windows: session.windows.map(w => ({
      name: w.name,
      paneCount: w.panes.length,
      activePaneIndex: w.activePane,
    })),
    activeWindow: session.activeWindow,
  };
}
