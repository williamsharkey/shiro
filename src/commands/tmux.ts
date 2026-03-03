/**
 * tmux — Terminal multiplexer (tmux-lite)
 *
 * Single xterm.js instance — panes are virtual screen buffers composed via ANSI.
 * Ctrl-B prefix: % split-h, " split-v, arrows select pane, d detach, c new window, n/p next/prev
 */

import type { Command, CommandContext, TerminalLike } from './index';
import {
  TmuxSession, TmuxWindow, TmuxPane,
  renderWindow, renderStatusBar, snapshotSession,
  ScreenBuffer,
} from '../tmux-layout';
import { Shell } from '../shell';

// ── Session store (in-memory, persists within browser session) ───────

const sessions: Map<string, TmuxSession> = new Map();

function getOrCreateSession(name: string): TmuxSession {
  let session = sessions.get(name);
  if (!session) {
    session = new TmuxSession(name);
    sessions.set(name, session);
  }
  return session;
}

// ── Input buffer for each pane ──────────────────────────────────────

const paneInputBuffers: Map<number, string> = new Map();

function getPaneInput(paneId: number): string {
  return paneInputBuffers.get(paneId) || '';
}

function setPaneInput(paneId: number, input: string): void {
  paneInputBuffers.set(paneId, input);
}

// ── tmux command ────────────────────────────────────────────────────

export const tmuxCmd: Command = {
  name: 'tmux',
  description: 'Terminal multiplexer',

  async exec(ctx: CommandContext): Promise<number> {
    const terminal = ctx.terminal;
    if (!terminal) {
      ctx.stderr += 'tmux: requires a terminal\n';
      return 1;
    }

    const sessionName = ctx.args[0] || 'main';

    // Handle subcommands
    if (ctx.args[0] === 'ls' || ctx.args[0] === 'list-sessions') {
      if (sessions.size === 0) {
        ctx.stdout += 'no server running on /tmp/tmux-user/default\n';
      } else {
        for (const [name, session] of sessions) {
          const winCount = session.windows.length;
          ctx.stdout += `${name}: ${winCount} windows\n`;
        }
      }
      return 0;
    }

    if (ctx.args[0] === 'kill-server') {
      sessions.clear();
      ctx.stdout += 'tmux: server killed\n';
      return 0;
    }

    // Create or attach to session
    const session = getOrCreateSession(
      ctx.args[0] === 'new' || ctx.args[0] === 'new-session'
        ? (ctx.args[1] || 'main')
        : (ctx.args[0] === 'attach' || ctx.args[0] === 'a'
          ? (ctx.args[1] || 'main')
          : sessionName)
    );

    const { rows: termRows, cols: termCols } = terminal.getSize();

    // Create initial window and pane if session is new
    if (session.windows.length === 0) {
      const win = new TmuxWindow('bash');
      const paneShell = ctx.shell.fork();
      const pane = new TmuxPane(paneShell, 0, 0, termCols, termRows - 1);

      // Show initial prompt
      pane.writeOutput(`${pane.getPrompt()}`);

      win.addPane(pane);
      session.addWindow(win);
    }

    // Enter TUI mode
    return runTmuxTUI(session, terminal, ctx);
  },
};

// ── TUI Main Loop ───────────────────────────────────────────────────

async function runTmuxTUI(
  session: TmuxSession,
  terminal: TerminalLike,
  ctx: CommandContext,
): Promise<number> {
  let running = true;
  let prefixMode = false;
  let cols: number, rows: number;
  ({ rows, cols } = terminal.getSize());

  const write = (s: string) => terminal.writeOutput(s);

  // Enter alternate screen + hide cursor
  write('\x1b[?1049h\x1b[?25l');

  function render(): void {
    if (!running) return;

    const win = session.getActiveWindow();
    if (!win) return;

    // Clear screen and home cursor
    write('\x1b[2J\x1b[H');

    // Render all panes composited
    const content = renderWindow(win, cols, rows - 1);
    write(content);

    // Status bar on last line
    write(`\x1b[${rows};1H`);
    write(renderStatusBar(session, cols, prefixMode));
  }

  // Resize handler
  const unsubResize = terminal.onResize((newCols, newRows) => {
    cols = newCols;
    rows = newRows;

    // Resize all panes in active window
    const win = session.getActiveWindow();
    if (win && win.panes.length === 1) {
      win.panes[0].resize(0, 0, cols, rows - 1);
    }
    render();
  });

  // Periodic render for clock updates
  const renderInterval = setInterval(() => {
    if (running) render();
  }, 1000);

  function cleanup(): void {
    running = false;
    clearInterval(renderInterval);
    unsubResize();
    terminal.exitRawMode();
    write('\x1b[?25h');     // Show cursor
    write('\x1b[?1049l');   // Exit alternate screen
  }

  // Key handler
  function handleKey(key: string): void {
    if (!running) return;

    const win = session.getActiveWindow();
    if (!win) return;
    const pane = win.getActivePane();
    if (!pane) return;

    // Ctrl-B prefix mode
    if (key === '\x02' || key === 'Ctrl+B') {
      prefixMode = true;
      render();
      return;
    }

    if (prefixMode) {
      prefixMode = false;
      handlePrefixKey(key, session, win, pane, ctx, terminal, cleanup, render);
      render();
      return;
    }

    // Normal mode: forward keystrokes to active pane
    handlePaneInput(key, pane, ctx, render);
  }

  return new Promise<number>((resolve) => {
    const wrappedCleanup = () => {
      cleanup();
      resolve(0);
    };

    // Store resolve for prefix-d (detach)
    (session as any)._resolve = wrappedCleanup;

    terminal.enterRawMode(handleKey);

    // Handle abort signal (Ctrl+C from outer shell)
    const signal = ctx.shell?.abortController?.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        wrappedCleanup();
      }, { once: true });
    }

    render();
  });
}

// ── Prefix key handler ──────────────────────────────────────────────

function handlePrefixKey(
  key: string,
  session: TmuxSession,
  win: TmuxWindow,
  pane: TmuxPane,
  ctx: CommandContext,
  terminal: TerminalLike,
  cleanup: () => void,
  render: () => void,
): void {
  const { rows, cols } = terminal.getSize();

  switch (key) {
    case '%': {
      // Split horizontally
      const newShell = ctx.shell.fork();
      const newPane = win.splitHorizontal(newShell);
      newPane.writeOutput(newPane.getPrompt());
      break;
    }

    case '"': {
      // Split vertically
      const newShell = ctx.shell.fork();
      const newPane = win.splitVertical(newShell);
      newPane.writeOutput(newPane.getPrompt());
      break;
    }

    case 'd': {
      // Detach
      const resolve = (session as any)._resolve;
      if (resolve) resolve();
      return;
    }

    case 'c': {
      // New window
      const newWin = new TmuxWindow(`bash`);
      const newShell = ctx.shell.fork();
      const newPane = new TmuxPane(newShell, 0, 0, cols, rows - 1);
      newPane.writeOutput(newPane.getPrompt());
      newWin.addPane(newPane);
      session.addWindow(newWin);
      session.activeWindow = session.windows.length - 1;
      break;
    }

    case 'n': {
      // Next window
      session.nextWindow();
      break;
    }

    case 'p': {
      // Previous window
      session.prevWindow();
      break;
    }

    case 'ArrowLeft':
    case 'ArrowUp': {
      // Select previous pane
      if (win.panes.length > 1) {
        win.activePane = (win.activePane - 1 + win.panes.length) % win.panes.length;
      }
      break;
    }

    case 'ArrowRight':
    case 'ArrowDown': {
      // Select next pane
      if (win.panes.length > 1) {
        win.activePane = (win.activePane + 1) % win.panes.length;
      }
      break;
    }

    case 'x': {
      // Kill pane
      if (win.panes.length > 1) {
        win.removePane(pane.id);
        // Resize remaining pane to fill
        if (win.panes.length === 1) {
          win.panes[0].resize(0, 0, cols, rows - 1);
        }
      } else if (session.windows.length > 1) {
        // Kill window
        const idx = session.windows.indexOf(win);
        session.windows.splice(idx, 1);
        session.activeWindow = Math.min(session.activeWindow, session.windows.length - 1);
      } else {
        // Last pane in last window — detach
        const resolve = (session as any)._resolve;
        if (resolve) resolve();
        return;
      }
      break;
    }

    case '?': {
      // Show help (write to active pane)
      pane.writeOutput('\r\n  tmux key bindings:\r\n');
      pane.writeOutput('  Ctrl-B %       Split horizontal\r\n');
      pane.writeOutput('  Ctrl-B "       Split vertical\r\n');
      pane.writeOutput('  Ctrl-B arrows  Select pane\r\n');
      pane.writeOutput('  Ctrl-B c       New window\r\n');
      pane.writeOutput('  Ctrl-B n/p     Next/prev window\r\n');
      pane.writeOutput('  Ctrl-B x       Kill pane/window\r\n');
      pane.writeOutput('  Ctrl-B d       Detach\r\n');
      pane.writeOutput('  Ctrl-B ?       This help\r\n\r\n');
      pane.writeOutput(pane.getPrompt());
      break;
    }

    default:
      // Unknown prefix key — ignore
      break;
  }
}

// ── Pane input handler (simulated shell) ────────────────────────────

function handlePaneInput(
  key: string,
  pane: TmuxPane,
  ctx: CommandContext,
  render: () => void,
): void {
  const input = getPaneInput(pane.id);

  if (key === '\r' || key === 'Enter') {
    pane.writeOutput('\r\n');

    const command = input.trim();
    setPaneInput(pane.id, '');

    if (command === 'exit') {
      pane.writeOutput('[pane closed]\r\n');
      pane.running = false;
      render();
      return;
    }

    if (command) {
      // Execute command in pane's shell asynchronously
      executeInPane(pane, command, ctx).then(() => {
        pane.writeOutput(pane.getPrompt());
        render();
      });
    } else {
      pane.writeOutput(pane.getPrompt());
    }
    render();
    return;
  }

  if (key === '\x7f' || key === 'Backspace') {
    if (input.length > 0) {
      setPaneInput(pane.id, input.slice(0, -1));
      pane.writeOutput('\b \b');
    }
    render();
    return;
  }

  if (key === '\x03' || key === 'Ctrl+C') {
    setPaneInput(pane.id, '');
    pane.writeOutput('^C\r\n');
    pane.writeOutput(pane.getPrompt());
    render();
    return;
  }

  if (key === '\x0c' || key === 'Ctrl+L') {
    // Clear screen
    pane.buffer.clear();
    pane.writeOutput(pane.getPrompt() + getPaneInput(pane.id));
    render();
    return;
  }

  // Regular character
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    setPaneInput(pane.id, input + key);
    pane.writeOutput(key);
    render();
  }
}

// ── Execute command in pane ─────────────────────────────────────────

async function executeInPane(pane: TmuxPane, command: string, ctx: CommandContext): Promise<void> {
  try {
    await pane.shell.execute(command, (output: string) => {
      // Convert \n to \r\n for terminal display
      const converted = output.replace(/\n/g, '\r\n');
      pane.writeOutput(converted);
    });
  } catch (e: any) {
    pane.writeOutput(`\r\nError: ${e.message}\r\n`);
  }
}
