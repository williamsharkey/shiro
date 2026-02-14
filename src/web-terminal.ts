/**
 * WebTerminal - native HTML renderer for terminal output.
 * Implements TerminalLike so it can replace WindowTerminal for commands
 * that benefit from DOM-native text selection, clickable links, and reflow.
 *
 * Parses ANSI escape sequences (SGR, cursor movement, erase, OSC 8 hyperlinks)
 * and renders to styled <div>/<span> elements instead of xterm.js canvas.
 */

import type { TerminalLike } from './commands/index';
import { setActiveTerminal } from './active-terminal';

// ── Cell & Style types ──────────────────────────────────────────────

interface CellStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

interface Cell {
  char: string;
  style: CellStyle;
  link?: string;
}

interface Segment {
  text: string;
  css: string;
  link?: string;
}

function emptyCell(): Cell {
  return { char: ' ', style: {} };
}

function stylesEqual(a: CellStyle, b: CellStyle): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold &&
    a.dim === b.dim && a.italic === b.italic && a.underline === b.underline &&
    a.strikethrough === b.strikethrough;
}

// ── ANSI color tables ───────────────────────────────────────────────

const ANSI_BASIC: Record<number, string> = {
  30: '#1a1a2e', 31: '#ff6b6b', 32: '#51cf66', 33: '#ffd43b',
  34: '#74c0fc', 35: '#cc5de8', 36: '#66d9e8', 37: '#e0e0e0',
  90: '#4a4a6a', 91: '#ff8787', 92: '#69db7c', 93: '#ffe066',
  94: '#91d5ff', 95: '#e599f7', 96: '#99e9f2', 97: '#ffffff',
};

const ANSI_BASIC_BG: Record<number, string> = {
  40: '#1a1a2e', 41: '#ff6b6b', 42: '#51cf66', 43: '#ffd43b',
  44: '#74c0fc', 45: '#cc5de8', 46: '#66d9e8', 47: '#e0e0e0',
  100: '#4a4a6a', 101: '#ff8787', 102: '#69db7c', 103: '#ffe066',
  104: '#91d5ff', 105: '#e599f7', 106: '#99e9f2', 107: '#ffffff',
};

/* 256-color palette: 0-7 standard, 8-15 bright, 16-231 color cube, 232-255 grayscale */
function color256(n: number): string {
  if (n < 8) return Object.values(ANSI_BASIC)[n];
  if (n < 16) return Object.values(ANSI_BASIC)[n - 8 + 8]; // bright
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36) * 51;
    const g = Math.floor((idx % 36) / 6) * 51;
    const b = (idx % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

// ── Parser states ───────────────────────────────────────────────────

const enum ParseState { NORMAL, ESC, CSI, OSC }

// ── WebTerminal ─────────────────────────────────────────────────────

export class WebTerminal implements TerminalLike {
  term: any;

  private container: HTMLDivElement;
  private scrollbackEl: HTMLDivElement;
  private screenEl: HTMLDivElement;

  private buffer: Cell[][] = [];
  private scrollback: Cell[][] = [];
  private cursor = { row: 0, col: 0 };
  private rows = 24;
  private cols = 80;
  private charWidth = 0;
  private lineHeight = 0;

  private currentStyle: CellStyle = {};
  private currentLink: string | undefined;
  private parseState: ParseState = ParseState.NORMAL;
  private csiParams = '';
  private oscData = '';

  private dirtyRows = new Set<number>();
  private rafPending = false;
  private scrollbackDirty = false;
  private scrollbackRendered = 0;
  private prevSegments: Segment[][] = [];

  private stdinPassthrough: ((data: string) => void) | null = null;
  private forceExitCallback: (() => void) | null = null;
  private rawModeCallback: ((key: string) => void) | null = null;
  private lastCtrlCTime = 0;
  private resizeCallbacks: ((cols: number, rows: number) => void)[] = [];
  private resizeObserver: ResizeObserver;
  private disposed = false;

  secretMasker: ((text: string) => string) | null = null;

  constructor(container: HTMLDivElement) {
    this.container = container;

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      .web-terminal {
        font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 14px;
        line-height: 1.4;
        color: #e0e0e0;
        background: #1a1a2e;
        padding: 8px 12px;
        overflow-y: auto;
        overflow-x: hidden;
        white-space: pre-wrap;
        word-wrap: break-word;
        user-select: text;
        -webkit-user-select: text;
        cursor: text;
        height: 100%;
        box-sizing: border-box;
        outline: none;
      }
      .web-terminal .line { min-height: 1.4em; }
      .web-terminal .line-clickable { cursor: pointer; transition: background 0.1s; }
      .web-terminal .line-clickable:hover { background: rgba(255,255,255,0.06); border-radius: 3px; }
      .web-terminal a { color: #74c0fc; text-decoration: underline; cursor: pointer; }
      .web-terminal a:hover { color: #91d5ff; }
    `;
    container.appendChild(style);

    // Scrollback region
    this.scrollbackEl = document.createElement('div');
    this.scrollbackEl.className = 'web-terminal-scrollback';

    // Active screen region
    this.screenEl = document.createElement('div');
    this.screenEl.className = 'web-terminal-screen';

    // Wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'web-terminal';
    wrapper.tabIndex = 0;
    wrapper.appendChild(this.scrollbackEl);
    wrapper.appendChild(this.screenEl);
    container.appendChild(wrapper);

    // Measure character size
    this.measureFont(wrapper);

    // Calculate grid size
    this.recalcSize();
    this.initBuffer();

    // Input handling
    wrapper.addEventListener('keydown', (e) => this.onKeyDown(e));
    wrapper.addEventListener('focus', () => setActiveTerminal(this));

    // ResizeObserver
    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      this.recalcSize();
      for (const cb of this.resizeCallbacks) cb(this.cols, this.rows);
    });
    this.resizeObserver.observe(container);

    // term stub for ServerWindow / active-terminal compatibility
    this.term = {
      paste: (text: string) => this.injectInput(text),
      focus: () => wrapper.focus(),
      select: () => {},
    };

    // Auto-focus
    requestAnimationFrame(() => wrapper.focus());
  }

  // ── Font measurement ────────────────────────────────────────────

  private measureFont(el: HTMLElement): void {
    const probe = document.createElement('span');
    probe.textContent = 'M';
    probe.style.cssText = 'visibility:hidden;position:absolute;white-space:pre';
    el.appendChild(probe);
    this.charWidth = probe.getBoundingClientRect().width;
    this.lineHeight = probe.getBoundingClientRect().height;
    el.removeChild(probe);
    if (this.charWidth === 0) this.charWidth = 8.4;
    if (this.lineHeight === 0) this.lineHeight = 19.6;
  }

  private recalcSize(): void {
    const w = this.container.clientWidth - 24; // padding
    const h = this.container.clientHeight - 16;
    const newCols = Math.max(20, Math.floor(w / this.charWidth));
    const newRows = Math.max(4, Math.floor(h / this.lineHeight));
    if (newCols !== this.cols || newRows !== this.rows) {
      this.cols = newCols;
      this.rows = newRows;
      this.resizeBuffer();
    }
  }

  // ── Buffer management ───────────────────────────────────────────

  private initBuffer(): void {
    this.buffer = [];
    for (let r = 0; r < this.rows; r++) {
      this.buffer.push(this.emptyRow());
    }
  }

  private emptyRow(): Cell[] {
    const row: Cell[] = [];
    for (let c = 0; c < this.cols; c++) row.push(emptyCell());
    return row;
  }

  private resizeBuffer(): void {
    // Extend or shrink rows
    while (this.buffer.length < this.rows) {
      this.buffer.push(this.emptyRow());
    }
    while (this.buffer.length > this.rows) {
      // Push overflow to scrollback
      this.scrollback.push(this.buffer.shift()!);
      this.scrollbackDirty = true;
      if (this.cursor.row > 0) this.cursor.row--;
    }
    // Extend columns if needed
    for (const row of this.buffer) {
      while (row.length < this.cols) row.push(emptyCell());
    }
    // Cap scrollback
    while (this.scrollback.length > 2000) this.scrollback.shift();
    // Mark all dirty
    for (let r = 0; r < this.rows; r++) this.dirtyRows.add(r);
    this.scheduleRender();
  }

  private scrollUp(): void {
    this.scrollback.push(this.buffer.shift()!);
    this.scrollbackDirty = true;
    this.buffer.push(this.emptyRow());
    if (this.scrollback.length > 2000) this.scrollback.shift();
    // Entire screen shifted
    for (let r = 0; r < this.rows; r++) this.dirtyRows.add(r);
  }

  // ── ANSI Parser ─────────────────────────────────────────────────

  writeOutput(text: string): void {
    if (this.disposed) return;
    if (this.secretMasker) text = this.secretMasker(text);

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const code = ch.charCodeAt(0);

      switch (this.parseState) {
        case ParseState.NORMAL:
          if (code === 0x1b) {
            this.parseState = ParseState.ESC;
          } else if (ch === '\r') {
            this.cursor.col = 0;
          } else if (ch === '\n') {
            this.cursor.row++;
            if (this.cursor.row >= this.rows) {
              this.cursor.row = this.rows - 1;
              this.scrollUp();
            }
          } else if (ch === '\b') {
            if (this.cursor.col > 0) this.cursor.col--;
          } else if (ch === '\t') {
            const next = (Math.floor(this.cursor.col / 8) + 1) * 8;
            this.cursor.col = Math.min(next, this.cols - 1);
          } else if (code >= 0x20) {
            this.putChar(ch);
          }
          break;

        case ParseState.ESC:
          if (ch === '[') {
            this.parseState = ParseState.CSI;
            this.csiParams = '';
          } else if (ch === ']') {
            this.parseState = ParseState.OSC;
            this.oscData = '';
          } else {
            // Unknown escape — ignore and return to normal
            this.parseState = ParseState.NORMAL;
          }
          break;

        case ParseState.CSI:
          if ((code >= 0x30 && code <= 0x3f)) {
            // Parameter bytes: 0-9, ;, <, =, >, ?
            this.csiParams += ch;
          } else if (code >= 0x40 && code <= 0x7e) {
            // Final byte
            this.executeCsi(ch);
            this.parseState = ParseState.NORMAL;
          }
          // Intermediate bytes (0x20-0x2f) — accumulate with params
          else if (code >= 0x20 && code <= 0x2f) {
            this.csiParams += ch;
          }
          break;

        case ParseState.OSC:
          if (ch === '\x07' || (ch === '\\' && i > 0 && text[i - 1] === '\x1b')) {
            this.executeOsc();
            this.parseState = ParseState.NORMAL;
          } else {
            this.oscData += ch;
          }
          break;
      }
    }

    this.scheduleRender();
  }

  private putChar(ch: string): void {
    // Ensure row exists
    while (this.cursor.row >= this.buffer.length) {
      this.buffer.push(this.emptyRow());
    }
    const row = this.buffer[this.cursor.row];
    // Extend row if cursor is beyond current width
    while (this.cursor.col >= row.length) row.push(emptyCell());

    row[this.cursor.col] = {
      char: ch,
      style: { ...this.currentStyle },
      link: this.currentLink,
    };
    this.dirtyRows.add(this.cursor.row);
    this.cursor.col++;
    if (this.cursor.col >= this.cols) {
      this.cursor.col = 0;
      this.cursor.row++;
      if (this.cursor.row >= this.rows) {
        this.cursor.row = this.rows - 1;
        this.scrollUp();
      }
    }
  }

  private executeCsi(final: string): void {
    const params = this.csiParams.split(';').map(s => parseInt(s, 10) || 0);

    switch (final) {
      case 'm': this.applySgr(params); break;

      case 'H': case 'f': {
        // Cursor position: ESC[row;colH
        const row = (params[0] || 1) - 1;
        const col = (params[1] || 1) - 1;
        this.cursor.row = Math.min(row, this.rows - 1);
        this.cursor.col = Math.min(col, this.cols - 1);
        break;
      }

      case 'A': // Cursor up
        this.cursor.row = Math.max(0, this.cursor.row - (params[0] || 1));
        break;
      case 'B': // Cursor down
        this.cursor.row = Math.min(this.rows - 1, this.cursor.row + (params[0] || 1));
        break;
      case 'C': // Cursor right
        this.cursor.col = Math.min(this.cols - 1, this.cursor.col + (params[0] || 1));
        break;
      case 'D': // Cursor left
        this.cursor.col = Math.max(0, this.cursor.col - (params[0] || 1));
        break;

      case 'G': // Cursor horizontal absolute
        this.cursor.col = Math.min(this.cols - 1, (params[0] || 1) - 1);
        break;

      case 'J': { // Erase display
        const mode = params[0] || 0;
        if (mode === 0) {
          // Erase from cursor to end
          this.eraseLineFrom(this.cursor.row, this.cursor.col);
          for (let r = this.cursor.row + 1; r < this.rows; r++) {
            this.buffer[r] = this.emptyRow();
            this.dirtyRows.add(r);
          }
        } else if (mode === 1) {
          // Erase from start to cursor
          for (let r = 0; r < this.cursor.row; r++) {
            this.buffer[r] = this.emptyRow();
            this.dirtyRows.add(r);
          }
          this.eraseLineTo(this.cursor.row, this.cursor.col);
        } else if (mode === 2) {
          // Erase display — just clear buffer, don't push to scrollback.
          // Ink uses this for frame redraws, not for archiving content.
          for (let r = 0; r < this.rows; r++) {
            this.buffer[r] = this.emptyRow();
            this.dirtyRows.add(r);
          }
          this.cursor.row = 0;
          this.cursor.col = 0;
        } else if (mode === 3) {
          // Erase scrollback
          this.scrollback = [];
          this.scrollbackDirty = false;
          this.scrollbackRendered = 0;
          this.scrollbackEl.innerHTML = '';
        }
        break;
      }

      case 'K': { // Erase line
        const mode = params[0] || 0;
        if (mode === 0) {
          this.eraseLineFrom(this.cursor.row, this.cursor.col);
        } else if (mode === 1) {
          this.eraseLineTo(this.cursor.row, this.cursor.col);
        } else if (mode === 2) {
          this.buffer[this.cursor.row] = this.emptyRow();
          this.dirtyRows.add(this.cursor.row);
        }
        break;
      }

      case 'L': { // Insert lines
        const count = params[0] || 1;
        for (let n = 0; n < count; n++) {
          this.buffer.splice(this.cursor.row, 0, this.emptyRow());
          this.buffer.pop();
        }
        for (let r = this.cursor.row; r < this.rows; r++) this.dirtyRows.add(r);
        break;
      }

      case 'M': { // Delete lines
        const count = params[0] || 1;
        this.buffer.splice(this.cursor.row, count);
        while (this.buffer.length < this.rows) this.buffer.push(this.emptyRow());
        for (let r = this.cursor.row; r < this.rows; r++) this.dirtyRows.add(r);
        break;
      }

      // Hide/show cursor — no-op for DOM
      case 'h': case 'l': break;

      default: break; // Unhandled — ignore
    }
  }

  private eraseLineFrom(row: number, col: number): void {
    if (row >= this.buffer.length) return;
    const line = this.buffer[row];
    for (let c = col; c < line.length; c++) {
      line[c] = emptyCell();
    }
    this.dirtyRows.add(row);
  }

  private eraseLineTo(row: number, col: number): void {
    if (row >= this.buffer.length) return;
    const line = this.buffer[row];
    for (let c = 0; c <= Math.min(col, line.length - 1); c++) {
      line[c] = emptyCell();
    }
    this.dirtyRows.add(row);
  }

  private applySgr(params: number[]): void {
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) {
        this.currentStyle = {};
      } else if (p === 1) {
        this.currentStyle.bold = true;
      } else if (p === 2) {
        this.currentStyle.dim = true;
      } else if (p === 3) {
        this.currentStyle.italic = true;
      } else if (p === 4) {
        this.currentStyle.underline = true;
      } else if (p === 9) {
        this.currentStyle.strikethrough = true;
      } else if (p === 22) {
        this.currentStyle.bold = false;
        this.currentStyle.dim = false;
      } else if (p === 23) {
        this.currentStyle.italic = false;
      } else if (p === 24) {
        this.currentStyle.underline = false;
      } else if (p === 29) {
        this.currentStyle.strikethrough = false;
      } else if (ANSI_BASIC[p]) {
        this.currentStyle.fg = ANSI_BASIC[p];
      } else if (p === 39) {
        delete this.currentStyle.fg;
      } else if (ANSI_BASIC_BG[p]) {
        this.currentStyle.bg = ANSI_BASIC_BG[p];
      } else if (p === 49) {
        delete this.currentStyle.bg;
      } else if (p === 38 && params[i + 1] === 5) {
        // 256-color foreground
        this.currentStyle.fg = color256(params[i + 2] || 0);
        i += 2;
      } else if (p === 48 && params[i + 1] === 5) {
        // 256-color background
        this.currentStyle.bg = color256(params[i + 2] || 0);
        i += 2;
      } else if (p === 38 && params[i + 1] === 2) {
        // 24-bit foreground
        this.currentStyle.fg = `rgb(${params[i + 2] || 0},${params[i + 3] || 0},${params[i + 4] || 0})`;
        i += 4;
      } else if (p === 48 && params[i + 1] === 2) {
        // 24-bit background
        this.currentStyle.bg = `rgb(${params[i + 2] || 0},${params[i + 3] || 0},${params[i + 4] || 0})`;
        i += 4;
      }
    }
  }

  private executeOsc(): void {
    // OSC 8 ;params;uri ST  — hyperlinks
    if (this.oscData.startsWith('8;')) {
      const parts = this.oscData.split(';');
      // parts[0] = '8', parts[1] = params (ignored), parts[2..] = uri
      const uri = parts.slice(2).join(';');
      this.currentLink = uri || undefined;
    }
  }

  // ── DOM Rendering ───────────────────────────────────────────────

  private scheduleRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.render();
    });
  }

  private render(): void {
    if (this.disposed) return;

    // Render new scrollback lines (append-only)
    if (this.scrollbackDirty) {
      for (let i = this.scrollbackRendered; i < this.scrollback.length; i++) {
        this.scrollbackEl.appendChild(this.renderRow(this.scrollback[i]));
      }
      this.scrollbackRendered = this.scrollback.length;
      this.scrollbackDirty = false;
    }

    // Ensure screenEl has the right number of children
    while (this.screenEl.children.length < this.rows) {
      this.screenEl.appendChild(document.createElement('div'));
    }
    while (this.screenEl.children.length > this.rows) {
      this.screenEl.removeChild(this.screenEl.lastChild!);
    }

    // Re-render dirty rows with segment diffing
    for (const r of this.dirtyRows) {
      if (r >= this.rows || r >= this.buffer.length) continue;
      const newSegs = this.rowToSegments(this.buffer[r]);
      const prevSegs = this.prevSegments[r];

      // Skip if segments haven't changed
      if (prevSegs && this.segmentsEqual(prevSegs, newSegs)) continue;

      const old = this.screenEl.children[r] as HTMLDivElement;
      if (!old) continue;

      // If segment count + structure matches, try span-level text mutation
      if (prevSegs && prevSegs.length === newSegs.length && newSegs.length > 0) {
        let canMutate = true;
        for (let i = 0; i < newSegs.length; i++) {
          if (newSegs[i].css !== prevSegs[i].css || newSegs[i].link !== prevSegs[i].link) {
            canMutate = false;
            break;
          }
        }
        if (canMutate) {
          // Mutate text content of existing spans
          const spans = old.querySelectorAll('span');
          if (spans.length === newSegs.length) {
            for (let i = 0; i < newSegs.length; i++) {
              if (spans[i].textContent !== newSegs[i].text) {
                spans[i].textContent = newSegs[i].text;
              }
            }
            this.prevSegments[r] = newSegs;
            continue;
          }
        }
      }

      // Full replace
      const newLine = this.renderRow(this.buffer[r]);
      this.screenEl.replaceChild(newLine, old);
      this.prevSegments[r] = newSegs;
    }
    this.dirtyRows.clear();

    // Auto-scroll to bottom
    const wrapper = this.container.querySelector('.web-terminal');
    if (wrapper) {
      const atBottom = wrapper.scrollHeight - wrapper.scrollTop - wrapper.clientHeight < 50;
      if (atBottom) wrapper.scrollTop = wrapper.scrollHeight;
    }
  }

  private styleToCss(style: CellStyle): string {
    let css = '';
    if (style.fg) css += `color:${style.fg};`;
    if (style.bg) css += `background:${style.bg};`;
    if (style.bold) css += 'font-weight:bold;';
    if (style.dim) css += 'opacity:0.6;';
    if (style.italic) css += 'font-style:italic;';
    if (style.underline && style.strikethrough) {
      css += 'text-decoration:underline line-through;';
    } else if (style.underline) {
      css += 'text-decoration:underline;';
    } else if (style.strikethrough) {
      css += 'text-decoration:line-through;';
    }
    return css;
  }

  private rowToSegments(cells: Cell[]): Segment[] {
    // Find last non-space character (same trim logic as renderRow)
    let lastContent = cells.length - 1;
    while (lastContent >= 0 && cells[lastContent].char === ' ' &&
      !cells[lastContent].link && !cells[lastContent].style.bg) {
      lastContent--;
    }
    if (lastContent < 0) return [];

    const segments: Segment[] = [];
    let spanStart = 0;
    while (spanStart <= lastContent) {
      const startCell = cells[spanStart];
      let spanEnd = spanStart;
      while (spanEnd < lastContent &&
        stylesEqual(cells[spanEnd + 1].style, startCell.style) &&
        cells[spanEnd + 1].link === startCell.link) {
        spanEnd++;
      }
      const text = cells.slice(spanStart, spanEnd + 1).map(c => c.char).join('');
      const css = this.styleToCss(startCell.style);
      segments.push({ text, css, link: startCell.link });
      spanStart = spanEnd + 1;
    }
    return segments;
  }

  private segmentsEqual(a: Segment[], b: Segment[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].text !== b[i].text || a[i].css !== b[i].css || a[i].link !== b[i].link) return false;
    }
    return true;
  }

  private renderRow(cells: Cell[]): HTMLDivElement {
    const div = document.createElement('div');
    div.className = 'line';

    // Find last non-space character to trim trailing spaces
    let lastContent = cells.length - 1;
    while (lastContent >= 0 && cells[lastContent].char === ' ' &&
      !cells[lastContent].link && !cells[lastContent].style.bg) {
      lastContent--;
    }

    if (lastContent < 0) {
      div.innerHTML = '\u200b'; // zero-width space to preserve line height
      return div;
    }

    // Merge adjacent cells with same style + link into spans
    let spanStart = 0;
    while (spanStart <= lastContent) {
      const startCell = cells[spanStart];
      let spanEnd = spanStart;
      while (spanEnd < lastContent &&
        stylesEqual(cells[spanEnd + 1].style, startCell.style) &&
        cells[spanEnd + 1].link === startCell.link) {
        spanEnd++;
      }

      const text = cells.slice(spanStart, spanEnd + 1).map(c => c.char).join('');
      const el = this.createStyledSpan(text, startCell.style, startCell.link);
      div.appendChild(el);
      spanStart = spanEnd + 1;
    }

    // Auto-detect URLs in text content that aren't already linked
    this.linkifyUrls(div);

    // Inline clickable menu items: detect "1) Label" or "1. Label" patterns
    if (this.stdinPassthrough) {
      const plainText = cells.slice(0, lastContent + 1).map(c => c.char).join('');
      const menuMatch = plainText.match(/^\s*(\d+)[.)]\s+(.+?)$/);
      if (menuMatch) {
        div.classList.add('line-clickable');
        const digit = menuMatch[1];
        div.addEventListener('click', (e) => {
          if (window.getSelection()?.toString()) return; // don't interfere with text selection
          e.stopPropagation();
          this.handleInput(digit + '\r');
        });
      }
    }

    return div;
  }

  private createStyledSpan(text: string, style: CellStyle, link?: string): HTMLElement {
    const span = document.createElement('span');
    span.textContent = text;

    let css = '';
    if (style.fg) css += `color:${style.fg};`;
    if (style.bg) css += `background:${style.bg};`;
    if (style.bold) css += 'font-weight:bold;';
    if (style.dim) css += 'opacity:0.6;';
    if (style.italic) css += 'font-style:italic;';
    if (style.underline) css += 'text-decoration:underline;';
    if (style.strikethrough) css += 'text-decoration:line-through;';
    if (style.underline && style.strikethrough) css += 'text-decoration:underline line-through;';
    if (css) span.style.cssText = css;

    if (link) {
      const a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.appendChild(span);
      return a;
    }
    return span;
  }

  private linkifyUrls(div: HTMLDivElement): void {
    // Walk text nodes and wrap URLs in <a> tags
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    const urlRe = /https?:\/\/[^\s<>)\]'"]+/g;
    const nodesToReplace: { node: Text; matches: { start: number; end: number; url: string }[] }[] = [];

    let textNode: Text | null;
    while ((textNode = walker.nextNode() as Text | null)) {
      // Skip if already inside an <a>
      if (textNode.parentElement?.closest('a')) continue;
      const text = textNode.textContent || '';
      const matches: { start: number; end: number; url: string }[] = [];
      let m: RegExpExecArray | null;
      while ((m = urlRe.exec(text)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, url: m[0] });
      }
      if (matches.length) nodesToReplace.push({ node: textNode, matches });
    }

    for (const { node, matches } of nodesToReplace) {
      const text = node.textContent || '';
      const parent = node.parentNode!;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const { start, end, url } of matches) {
        if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = url;
        frag.appendChild(a);
        last = end;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      parent.replaceChild(frag, node);
    }
  }

  // ── Input handling ──────────────────────────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    // Don't capture input when not in passthrough/raw mode
    if (!this.stdinPassthrough && !this.rawModeCallback) return;

    e.preventDefault();
    e.stopPropagation();

    const data = this.keyToAnsi(e);
    if (data) this.handleInput(data);
  }

  private keyToAnsi(e: KeyboardEvent): string {
    const { key, ctrlKey, altKey } = e;

    // Ctrl+key combinations
    if (ctrlKey && key.length === 1) {
      const code = key.toLowerCase().charCodeAt(0);
      if (code >= 97 && code <= 122) { // a-z
        return String.fromCharCode(code - 96);
      }
    }

    // Special keys
    switch (key) {
      case 'Enter': return '\r';
      case 'Backspace': return '\x7f';
      case 'Tab': return '\t';
      case 'Escape': return '\x1b';
      case 'ArrowUp': return '\x1b[A';
      case 'ArrowDown': return '\x1b[B';
      case 'ArrowRight': return '\x1b[C';
      case 'ArrowLeft': return '\x1b[D';
      case 'Home': return '\x1b[H';
      case 'End': return '\x1b[F';
      case 'Delete': return '\x1b[3~';
      case 'PageUp': return '\x1b[5~';
      case 'PageDown': return '\x1b[6~';
    }

    // Alt+key
    if (altKey && key.length === 1) return '\x1b' + key;

    // Regular printable character
    if (key.length === 1) return key;

    return '';
  }

  private handleInput(data: string): void {
    if (this.stdinPassthrough) {
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

    if (this.rawModeCallback) {
      this.rawModeCallback(data);
      return;
    }
  }

  injectInput(data: string): void {
    this.handleInput(data);
  }

  // ── TerminalLike interface ──────────────────────────────────────

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
    return { rows: this.rows, cols: this.cols };
  }

  getBufferContent(): string {
    const lines: string[] = [];
    for (const row of this.scrollback) {
      lines.push(row.map(c => c.char).join('').replace(/\s+$/, ''));
    }
    for (const row of this.buffer) {
      lines.push(row.map(c => c.char).join('').replace(/\s+$/, ''));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  forceKill(): void {
    if (this.forceExitCallback) this.forceExitCallback();
    this.exitStdinPassthrough();
    this.exitRawMode();
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.resizeCallbacks = [];
    this.stdinPassthrough = null;
    this.forceExitCallback = null;
    this.rawModeCallback = null;
  }
}
