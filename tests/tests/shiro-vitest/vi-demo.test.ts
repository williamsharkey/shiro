import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { viCmd } from '@shiro/commands/vi';
import type { TerminalLike, CommandContext } from '@shiro/commands/index';
import type { Shell } from '@shiro/shell';

/**
 * Mock terminal that captures raw-mode key handler so we can feed keys to vi.
 */
function createMockTerminal() {
  let rawHandler: ((key: string) => void) | null = null;
  const output: string[] = [];

  const terminal: TerminalLike = {
    writeOutput(text: string) { output.push(text); },
    enterStdinPassthrough() {},
    exitStdinPassthrough() {},
    enterRawMode(cb: (key: string) => void) { rawHandler = cb; },
    exitRawMode() { rawHandler = null; },
    isRawMode() { return rawHandler !== null; },
    onResize() { return () => {}; },
    getSize() { return { rows: 24, cols: 80 }; },
    term: {},
  };

  return {
    terminal,
    output,
    /** Send a single key to the vi raw mode handler */
    async sendKey(key: string) {
      if (rawHandler) await rawHandler(key);
      // Give async ops a tick to settle
      await new Promise(r => setTimeout(r, 0));
    },
    /** Send each character of a string as individual key presses */
    async typeString(s: string) {
      for (const ch of s) {
        if (ch === '\n') {
          await this.sendKey('\r');
        } else {
          await this.sendKey(ch);
        }
      }
    },
  };
}

describe('Vi demo sequence', () => {
  let fs: FileSystem;

  beforeEach(async () => {
    fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp', { recursive: true });
    await fs.mkdir('/tmp/vi-site', { recursive: true });
  });

  it('creates, edits, and saves a file matching demo expectations', async () => {
    const mock = createMockTerminal();

    const ctx: CommandContext = {
      args: ['/tmp/vi-site/index.html'],
      fs,
      cwd: '/tmp/vi-site',
      env: {},
      stdin: '',
      stdout: '',
      stderr: '',
      shell: {} as Shell,
      terminal: mock.terminal,
    };

    // Start vi (returns a promise that resolves when :wq is entered)
    const viPromise = viCmd.exec(ctx);

    // Wait for vi to render initial state
    await new Promise(r => setTimeout(r, 50));

    // Step 1: i — enter insert mode
    await mock.sendKey('i');

    // Step 2: type the HTML content (newlines become Enter presses)
    await mock.typeString('<!DOCTYPE html>\n<html><body>\n<h1>Built with vi</h1>\n<p>In a browser.</p>\n</body></html>');

    // Step 3: Escape — back to normal mode
    await mock.sendKey('\x1b');

    // Step 4: :w — save
    await mock.sendKey(':');
    await mock.sendKey('w');
    await mock.sendKey('\r');

    // Verify intermediate file content after :w
    const saved = await fs.readFile('/tmp/vi-site/index.html', 'utf8') as string;
    expect(saved).toBe(
      '<!DOCTYPE html>\n<html><body>\n<h1>Built with vi</h1>\n<p>In a browser.</p>\n</body></html>'
    );

    // Step 5: /Built — search for "Built"
    await mock.sendKey('/');
    await mock.typeString('Built');
    await mock.sendKey('\r');

    // Step 6: dd — delete the line containing "Built with vi"
    await mock.sendKey('d');
    await mock.sendKey('d');

    // Step 7: O — open line above and enter insert mode
    await mock.sendKey('O');

    // Step 8: type replacement heading
    await mock.typeString('<h1>Edited with vi</h1>');

    // Step 9: Escape
    await mock.sendKey('\x1b');

    // Step 10: :wq — save and quit
    await mock.sendKey(':');
    await mock.sendKey('w');
    await mock.sendKey('q');
    await mock.sendKey('\r');

    // Wait for vi to exit
    const exitCode = await viPromise;
    expect(exitCode).toBe(0);

    // Verify final file content
    const content = await fs.readFile('/tmp/vi-site/index.html', 'utf8') as string;
    const lines = content.split('\n');

    expect(lines).toEqual([
      '<!DOCTYPE html>',
      '<html><body>',
      '<h1>Edited with vi</h1>',
      '<p>In a browser.</p>',
      '</body></html>',
    ]);

    // This is what page :4000 text "h1" should return
    expect(lines.find(l => l.includes('<h1>'))).toBe('<h1>Edited with vi</h1>');
    // There should be exactly one h1
    expect(lines.filter(l => l.includes('<h1>')).length).toBe(1);
  });

  it('opening a new file starts with empty content', async () => {
    const mock = createMockTerminal();

    const ctx: CommandContext = {
      args: ['/tmp/vi-site/fresh.html'],
      fs,
      cwd: '/tmp/vi-site',
      env: {},
      stdin: '',
      stdout: '',
      stderr: '',
      shell: {} as Shell,
      terminal: mock.terminal,
    };

    const viPromise = viCmd.exec(ctx);
    await new Promise(r => setTimeout(r, 50));

    // Type just a single line and save+quit
    await mock.sendKey('i');
    await mock.typeString('hello');
    await mock.sendKey('\x1b');
    await mock.sendKey(':');
    await mock.typeString('wq');
    await mock.sendKey('\r');

    await viPromise;

    const content = await fs.readFile('/tmp/vi-site/fresh.html', 'utf8') as string;
    // Should only contain what we typed — no leftover content from other demos
    expect(content).toBe('hello');
  });
});
