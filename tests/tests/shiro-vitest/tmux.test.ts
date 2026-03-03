import { describe, it, expect } from 'vitest';

describe('tmux-layout', () => {
  it('ScreenBuffer writes and reads characters', async () => {
    const { ScreenBuffer } = await import('@shiro/tmux-layout');
    const buf = new ScreenBuffer(20, 5);
    buf.write('Hello');
    const lines = buf.toLines();
    expect(lines[0].startsWith('Hello')).toBe(true);
    expect(lines[1].trim()).toBe('');
  });

  it('ScreenBuffer handles newlines', async () => {
    const { ScreenBuffer } = await import('@shiro/tmux-layout');
    const buf = new ScreenBuffer(20, 5);
    buf.write('Line1\nLine2\nLine3');
    const lines = buf.toLines();
    expect(lines[0].startsWith('Line1')).toBe(true);
    expect(lines[1].startsWith('Line2')).toBe(true);
    expect(lines[2].startsWith('Line3')).toBe(true);
  });

  it('ScreenBuffer handles carriage return', async () => {
    const { ScreenBuffer } = await import('@shiro/tmux-layout');
    const buf = new ScreenBuffer(20, 5);
    buf.write('Hello\rWorld');
    const lines = buf.toLines();
    expect(lines[0].startsWith('World')).toBe(true);
  });

  it('ScreenBuffer wraps at width boundary', async () => {
    const { ScreenBuffer } = await import('@shiro/tmux-layout');
    const buf = new ScreenBuffer(5, 3);
    buf.write('ABCDEFGH');
    const lines = buf.toLines();
    expect(lines[0]).toBe('ABCDE');
    expect(lines[1].startsWith('FGH')).toBe(true);
  });

  it('ScreenBuffer scrolls when exceeding height', async () => {
    const { ScreenBuffer } = await import('@shiro/tmux-layout');
    const buf = new ScreenBuffer(10, 3);
    buf.write('A\nB\nC\nD\nE');
    const lines = buf.toLines();
    // First lines should have scrolled away
    expect(lines[2].startsWith('E')).toBe(true);
  });

  it('ScreenBuffer resize preserves content', async () => {
    const { ScreenBuffer } = await import('@shiro/tmux-layout');
    const buf = new ScreenBuffer(10, 5);
    buf.write('Hello');
    buf.resize(20, 10);
    expect(buf.width).toBe(20);
    expect(buf.height).toBe(10);
    const lines = buf.toLines();
    expect(lines[0].startsWith('Hello')).toBe(true);
  });

  it('ScreenBuffer clear resets content', async () => {
    const { ScreenBuffer } = await import('@shiro/tmux-layout');
    const buf = new ScreenBuffer(10, 5);
    buf.write('Hello');
    buf.clear();
    const lines = buf.toLines();
    expect(lines[0].trim()).toBe('');
  });

  it('TmuxPane has correct initial state', async () => {
    const { TmuxPane } = await import('@shiro/tmux-layout');
    const { Shell } = await import('@shiro/shell');
    const { FileSystem } = await import('@shiro/filesystem');
    const { CommandRegistry } = await import('@shiro/commands/index');

    const fs = new FileSystem();
    await fs.init();
    const commands = new CommandRegistry();
    const shell = new Shell(fs, commands);

    const pane = new TmuxPane(shell, 0, 0, 80, 24);
    expect(pane.width).toBe(80);
    expect(pane.height).toBe(24);
    expect(pane.x).toBe(0);
    expect(pane.y).toBe(0);
    expect(pane.running).toBe(true);
  });

  it('TmuxWindow splits horizontally', async () => {
    const { TmuxWindow, TmuxPane } = await import('@shiro/tmux-layout');
    const { Shell } = await import('@shiro/shell');
    const { FileSystem } = await import('@shiro/filesystem');
    const { CommandRegistry } = await import('@shiro/commands/index');

    const fs = new FileSystem();
    await fs.init();
    const commands = new CommandRegistry();
    const shell = new Shell(fs, commands);

    const win = new TmuxWindow('test');
    const pane = new TmuxPane(shell, 0, 0, 80, 24);
    win.addPane(pane);

    const newPane = win.splitHorizontal(shell.fork());
    expect(win.panes.length).toBe(2);
    // Original pane should be narrower
    expect(pane.width).toBeLessThan(80);
    // New pane should fill remaining space
    expect(newPane.x).toBeGreaterThan(0);
    expect(newPane.width + pane.width + 1).toBe(80); // +1 for border
  });

  it('TmuxWindow splits vertically', async () => {
    const { TmuxWindow, TmuxPane } = await import('@shiro/tmux-layout');
    const { Shell } = await import('@shiro/shell');
    const { FileSystem } = await import('@shiro/filesystem');
    const { CommandRegistry } = await import('@shiro/commands/index');

    const fs = new FileSystem();
    await fs.init();
    const commands = new CommandRegistry();
    const shell = new Shell(fs, commands);

    const win = new TmuxWindow('test');
    const pane = new TmuxPane(shell, 0, 0, 80, 24);
    win.addPane(pane);

    const newPane = win.splitVertical(shell.fork());
    expect(win.panes.length).toBe(2);
    expect(pane.height).toBeLessThan(24);
    expect(newPane.y).toBeGreaterThan(0);
    expect(newPane.height + pane.height + 1).toBe(24);
  });

  it('TmuxSession manages windows', async () => {
    const { TmuxSession, TmuxWindow } = await import('@shiro/tmux-layout');

    const session = new TmuxSession('test');
    const win1 = new TmuxWindow('win1');
    const win2 = new TmuxWindow('win2');
    session.addWindow(win1);
    session.addWindow(win2);

    expect(session.windows.length).toBe(2);
    expect(session.activeWindow).toBe(0);

    session.nextWindow();
    expect(session.activeWindow).toBe(1);

    session.nextWindow();
    expect(session.activeWindow).toBe(0);

    session.prevWindow();
    expect(session.activeWindow).toBe(1);
  });

  it('renderWindow produces output', async () => {
    const { TmuxWindow, TmuxPane, renderWindow } = await import('@shiro/tmux-layout');
    const { Shell } = await import('@shiro/shell');
    const { FileSystem } = await import('@shiro/filesystem');
    const { CommandRegistry } = await import('@shiro/commands/index');

    const fs = new FileSystem();
    await fs.init();
    const commands = new CommandRegistry();
    const shell = new Shell(fs, commands);

    const win = new TmuxWindow('test');
    const pane = new TmuxPane(shell, 0, 0, 40, 10);
    pane.writeOutput('Hello tmux');
    win.addPane(pane);

    const output = renderWindow(win, 40, 11);
    expect(output).toContain('Hello tmux');
  });

  it('renderStatusBar includes session name', async () => {
    const { TmuxSession, TmuxWindow, renderStatusBar } = await import('@shiro/tmux-layout');

    const session = new TmuxSession('mysession');
    session.addWindow(new TmuxWindow('bash'));

    const bar = renderStatusBar(session, 80, false);
    expect(bar).toContain('mysession');
    expect(bar).toContain('bash');
  });

  it('renderStatusBar shows PREFIX in prefix mode', async () => {
    const { TmuxSession, TmuxWindow, renderStatusBar } = await import('@shiro/tmux-layout');

    const session = new TmuxSession('test');
    session.addWindow(new TmuxWindow('bash'));

    const bar = renderStatusBar(session, 80, true);
    expect(bar).toContain('PREFIX');
  });

  it('snapshotSession captures state', async () => {
    const { TmuxSession, TmuxWindow, snapshotSession } = await import('@shiro/tmux-layout');

    const session = new TmuxSession('snap-test');
    const win1 = new TmuxWindow('editor');
    const win2 = new TmuxWindow('shell');
    session.addWindow(win1);
    session.addWindow(win2);
    session.activeWindow = 1;

    const snap = snapshotSession(session);
    expect(snap.name).toBe('snap-test');
    expect(snap.windows.length).toBe(2);
    expect(snap.windows[0].name).toBe('editor');
    expect(snap.windows[1].name).toBe('shell');
    expect(snap.activeWindow).toBe(1);
  });

  it('TmuxWindow removePane adjusts active index', async () => {
    const { TmuxWindow, TmuxPane } = await import('@shiro/tmux-layout');
    const { Shell } = await import('@shiro/shell');
    const { FileSystem } = await import('@shiro/filesystem');
    const { CommandRegistry } = await import('@shiro/commands/index');

    const fs = new FileSystem();
    await fs.init();
    const commands = new CommandRegistry();
    const shell = new Shell(fs, commands);

    const win = new TmuxWindow('test');
    const pane1 = new TmuxPane(shell, 0, 0, 40, 24);
    const pane2 = new TmuxPane(shell.fork(), 41, 0, 39, 24);
    win.addPane(pane1);
    win.addPane(pane2);
    win.activePane = 1;

    win.removePane(pane2.id);
    expect(win.panes.length).toBe(1);
    expect(win.activePane).toBe(0);
  });
});
