/**
 * Dynamic Favicon & Title Manager
 *
 * Favicon: 32x32 pixel visualization of terminal content.
 * Title: Shows recent commands with source indicators.
 *   ● = local command (user typed)
 *   ◇ = remote command (from MCP/Claude)
 *
 * Format: "newest ◇ older ● oldest ● domain.com"
 */

import type { Terminal, IBufferCell } from '@xterm/xterm';

// === Favicon state ===
let lastUpdate = 0;
let updateScheduled = false;
let enabled = true;
let originalFavicon: string | null = null;

// === Title state ===
interface CommandEntry {
  cmd: string;
  remote: boolean;
}
const recentCommands: CommandEntry[] = [];
const MAX_TITLE_LENGTH = 50;
let hostname: string = '';

// 16-color palette names in order
const PALETTE_16 = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
] as const;

// Default fallback colors if theme doesn't specify
const DEFAULT_PALETTE: Record<string, string> = {
  black: '#000000', red: '#cd0000', green: '#00cd00', yellow: '#cdcd00',
  blue: '#0000cd', magenta: '#cd00cd', cyan: '#00cdcd', white: '#e5e5e5',
  brightBlack: '#7f7f7f', brightRed: '#ff0000', brightGreen: '#00ff00',
  brightYellow: '#ffff00', brightBlue: '#5c5cff', brightMagenta: '#ff00ff',
  brightCyan: '#00ffff', brightWhite: '#ffffff'
};

/**
 * Initialize the dynamic favicon updater.
 * Call this once after terminal is created.
 */
export function initFaviconUpdater(term: Terminal): void {
  // Save original favicon for restoration
  const existingLink = document.querySelector("link[rel*='icon']") as HTMLLinkElement;
  if (existingLink) {
    originalFavicon = existingLink.href;
  }

  // Update on various terminal events
  term.onWriteParsed(() => scheduleUpdate(term));
  term.onRender(() => scheduleUpdate(term));

  // Initial render
  updateFavicon(term);
}

/**
 * Enable or disable dynamic favicon
 */
export function setFaviconEnabled(value: boolean, term?: Terminal): void {
  enabled = value;
  if (!enabled && originalFavicon) {
    // Restore original favicon
    const link = document.querySelector("link[rel*='icon']") as HTMLLinkElement;
    if (link) link.href = originalFavicon;
  } else if (enabled && term) {
    updateFavicon(term);
  }
}

export function isFaviconEnabled(): boolean {
  return enabled;
}

/**
 * Schedule an update, throttled to max 1/second
 */
function scheduleUpdate(term: Terminal): void {
  if (!enabled || updateScheduled) return;

  const now = Date.now();
  const elapsed = now - lastUpdate;

  if (elapsed >= 1000) {
    updateFavicon(term);
    lastUpdate = now;
  } else {
    updateScheduled = true;
    setTimeout(() => {
      updateScheduled = false;
      if (enabled) {
        updateFavicon(term);
        lastUpdate = Date.now();
      }
    }, 1000 - elapsed);
  }
}

/**
 * Render the terminal content to a 32x32 canvas and update favicon
 */
function updateFavicon(term: Terminal): void {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const theme = term.options.theme || {};
  const bgColor = theme.background || '#1e1e1e';
  const fgColor = theme.foreground || '#d4d4d4';

  // Fill entire canvas with terminal background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, 32, 32);

  const buffer = term.buffer.active;

  // Calculate which lines to render:
  // - Take the last 32 lines of content
  // - Oldest line goes to row 0 (top), newest to row 31 (bottom)
  // - If fewer than 32 lines, content starts at row 0
  const totalLines = buffer.baseY + buffer.cursorY + 1;
  const linesToRender = Math.min(32, totalLines);
  const startLine = Math.max(0, totalLines - 32);

  for (let y = 0; y < linesToRender; y++) {
    const lineIndex = startLine + y;
    const line = buffer.getLine(lineIndex);
    if (!line) continue;

    for (let x = 0; x < 32; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;

      const char = cell.getChars();
      // Skip empty cells and spaces - leave as background
      if (!char || char === ' ' || char === '\u00A0') continue;

      const color = getCellFgColor(cell, theme, fgColor);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // Update the favicon element
  let link = document.querySelector("link[rel='icon']") as HTMLLinkElement;
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/png';
  link.href = canvas.toDataURL('image/png');
}

/**
 * Get the foreground color for a cell, handling all color modes
 */
function getCellFgColor(cell: IBufferCell, theme: any, defaultFg: string): string {
  const mode = cell.getFgColorMode();
  const color = cell.getFgColor();

  // xterm.js color modes (from Attributes):
  // 0 = DEFAULT
  // 16777216 = P16 (16-color palette)
  // 33554432 = P256 (256-color palette)
  // 50331648 = RGB (24-bit color)

  if (mode === 0) {
    // Default foreground
    return defaultFg;
  }

  if (mode === 16777216) {
    // 16-color palette (0-15)
    if (color >= 0 && color < 16) {
      const name = PALETTE_16[color];
      return theme[name] || DEFAULT_PALETTE[name] || defaultFg;
    }
  }

  if (mode === 33554432) {
    // 256-color palette
    if (color < 16) {
      // First 16 are same as 16-color palette
      const name = PALETTE_16[color];
      return theme[name] || DEFAULT_PALETTE[name] || defaultFg;
    }

    if (color < 232) {
      // 6x6x6 color cube (indices 16-231)
      const idx = color - 16;
      const r = Math.floor(idx / 36);
      const g = Math.floor((idx % 36) / 6);
      const b = idx % 6;
      // Convert to RGB: 0 -> 0, 1-5 -> 95 + 40*(n-1)
      const toRgb = (v: number) => v === 0 ? 0 : 55 + v * 40;
      return `rgb(${toRgb(r)},${toRgb(g)},${toRgb(b)})`;
    }

    // Grayscale (indices 232-255)
    // 232 -> 8, 233 -> 18, ... 255 -> 238
    const gray = 8 + (color - 232) * 10;
    return `rgb(${gray},${gray},${gray})`;
  }

  if (mode === 50331648) {
    // 24-bit RGB color (packed as single number)
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    return `rgb(${r},${g},${b})`;
  }

  // Unknown mode, use default
  return defaultFg;
}

// === Title Management ===

/**
 * Initialize title with hostname. Call once on startup.
 */
export function initTitle(): void {
  // Get hostname (e.g., "yolo.shiro.computer" or "localhost:5173")
  hostname = window.location.host;
  updateTitle();
}

/**
 * Record a command execution and update the title.
 * @param cmd - The command that was executed
 * @param remote - Whether this was a remote/MCP command
 */
export function recordCommand(cmd: string, remote: boolean = false): void {
  // Extract just the command name (first word), ignore args
  const cmdName = cmd.trim().split(/\s+/)[0];
  if (!cmdName) return;

  // Add to front of list
  recentCommands.unshift({ cmd: cmdName, remote });

  // Keep list reasonable (we'll trim in updateTitle based on length)
  if (recentCommands.length > 10) {
    recentCommands.pop();
  }

  updateTitle();
}

/**
 * Clear command history (e.g., on `clear` command)
 */
export function clearCommandHistory(): void {
  recentCommands.length = 0;
  updateTitle();
}

/**
 * Update document.title with recent commands and hostname
 */
function updateTitle(): void {
  if (!hostname) {
    hostname = window.location.host;
  }

  if (recentCommands.length === 0) {
    document.title = hostname;
    return;
  }

  // Build title from newest to oldest, respecting max length
  // Format: "cmd1 ◇ cmd2 ● cmd3 ● hostname"
  const LOCAL = ' ● ';
  const REMOTE = ' ◇ ';

  let title = '';
  let hostnameWithSep = '';

  // Always include hostname at end
  // We'll build backwards and check length
  for (let i = 0; i < recentCommands.length; i++) {
    const entry = recentCommands[i];
    const sep = entry.remote ? REMOTE : LOCAL;
    const addition = entry.cmd + sep;

    // Check if adding this would exceed limit
    if ((title + addition + hostname).length > MAX_TITLE_LENGTH) {
      break;
    }

    title += addition;
  }

  document.title = title + hostname;
}
