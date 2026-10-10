import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a script's timers and the page's", () => {
  it('a page timer set through the global while a script runs survives its exit; the script\'s own timers do not', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/tm', { recursive: true });
    // Page code (xterm's write buffer) schedules through the global while the script runs
    (globalThis as any).__pageSchedule = () => {
      (globalThis as any).__pageTimerFired = false;
      globalThis.setTimeout(() => { (globalThis as any).__pageTimerFired = true; }, 300);
    };
    await fs.writeFile('/tmp/tm/a.js', `
      globalThis.__pageSchedule();
      // its own: by name, through globalThis and through the timers module; none may fire after it ends
      setTimeout(() => require('fs').writeFileSync('/tmp/tm/by-name', 'x'), 300);
      globalThis.setTimeout(() => require('fs').writeFileSync('/tmp/tm/via-global', 'x'), 300);
      require('timers').setTimeout(() => require('fs').writeFileSync('/tmp/tm/via-timers', 'x'), 300);
      setInterval(() => require('fs').writeFileSync('/tmp/tm/interval', 'x'), 250);
      setTimeout(() => { console.log('exiting'); process.exit(0); }, 30);
    `);
    const { output } = await run(shell, 'node /tmp/tm/a.js');
    expect(output).toContain('exiting');
    await sleep(700);
    delete (globalThis as any).__pageSchedule;
    expect((globalThis as any).__pageTimerFired).toBe(true);
    for (const f of ['by-name', 'via-global', 'via-timers', 'interval']) expect(await fs.exists(`/tmp/tm/${f}`)).toBe(false);
  }, 30_000);
});

describe('process.exit() in the page', () => {
  it("ends an interactive script even when its own catch takes the exit (Gemini's \"critical error: process.exit(0)\")", async () => {
    const { TtySession } = await import('@shiro/kernel/pty');
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/tx', { recursive: true });
    await fs.writeFile('/tmp/tx/tui.js', `
      process.stdin.setRawMode(true);
      process.stdin.on('data', () => {});
      console.log('ui up');
      setTimeout(() => {
        try { process.exit(0); } catch (e) { console.error('critical error:', e && e.message); process.stderr.write(String(e) + '\\n'); }
      }, 100);
    `);
    const tty = new TtySession();
    let screen = '';
    tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
    shell.setTerminal({ tty, writeOutput: (s: string) => { screen += s; }, write: (s: string) => { screen += s; }, getSize: () => ({ cols: 80, rows: 24 }), onResize: () => () => {},
      enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {}, isRawMode: () => false, term: { buffer: { active: { type: 'normal' } } } } as any);
    const code = await shell.execute('export TABCOMPUTER_NODE_WORKER=0; node /tmp/tx/tui.js', () => {}, () => {});
    expect(code).toBe(0);
    expect(screen).toContain('ui up');
    expect(screen).not.toContain('critical error');
    expect(screen).not.toContain('process.exit(0)');
  }, 30_000);
});
