/**
 * `node` with no script: the REPL on a terminal, the program on a pipe.
 * The terminal stand-in sends keys as xterm does (stdin passthrough).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';
import { TtySession } from '@shiro/kernel/pty';

function keyTerminal() {
  let screen = '';
  let keys: ((d: string) => void) | null = null;
  const term: any = {
    writeOutput: (s: string) => { screen += s; },
    write: (s: string) => { screen += s; },
    getSize: () => ({ cols: 80, rows: 24 }),
    onResize: () => () => {},
    enterStdinPassthrough: (cb: (d: string) => void) => { keys = cb; },
    exitStdinPassthrough: () => { keys = null; },
    enterRawMode() {}, exitRawMode() {}, isRawMode: () => false,
    term: { buffer: { active: { type: 'normal' } } },
  };
  return {
    term,
    // (every line ends \r\n: the terminal is raw)
    screen: () => screen.replace(/\x1b\[[\d;]*m/g, '').replace(/\r\n/g, '\n'),
    bareNewline: () => /[^\r]\n/.test(screen),
    type: (s: string) => { if (!keys) throw new Error('nothing reads the terminal'); keys(s); },
    reading: () => !!keys,
  };
}

const until = async (cond: () => boolean, show: () => string, ms = 8_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${JSON.stringify(show())}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('node REPL', () => {
  it('evaluates entries in one scope, continues unfinished ones, ^D exits', async () => {
    const { shell } = await createTestShell();
    const t = keyTerminal();
    shell.setTerminal(t.term);
    const r = shell.execute('node', () => {}, () => {});
    await until(() => t.reading() && t.screen().endsWith('> '), t.screen);
    expect(t.screen()).toMatch(/^Welcome to Node\.js v\d+/);
    const enter = async (line: string, expectText: string) => {
      t.type(line + '\r');
      await until(() => t.screen().includes(expectText), t.screen);
    };
    await enter('let x = 6', 'undefined\n> ');
    await enter('const f = (n) => n * x', 'undefined\n> ');
    await enter('f(7)', '42\n> ');
    await enter('console.log("hi " + x)', 'hi 6\nundefined\n> ');
    await enter('function g(a) {', '... ');
    await enter('  return a + 1', '... ');
    await enter('}', 'undefined\n> ');
    await enter('g(41) === 42', 'true\n> ');
    await enter('{ a: 1 }', '{ a: 1 }\n> ');
    await enter('nope', 'Uncaught ReferenceError: nope is not defined\n> ');
    await enter('await Promise.resolve(5) + 1', '6\n> ');
    await enter('typeof require("path").join', "'function'\n> ");
    t.type('1 +');
    t.type('\x03');
    await until(() => t.screen().endsWith('1 +\n> '), t.screen);
    t.type('\x04');
    expect(await r).toBe(0);
    expect(t.bareNewline()).toBe(false);
  }, 60_000);

  it('.exit, and ^C twice on an empty line', async () => {
    const { shell } = await createTestShell();
    const t = keyTerminal();
    shell.setTerminal(t.term);
    let r = shell.execute('node', () => {}, () => {});
    await until(() => t.reading() && t.screen().endsWith('> '), t.screen);
    t.type('.exit\r');
    expect(await r).toBe(0);

    r = shell.execute('node', () => {}, () => {});
    await until(() => t.reading() && t.screen().endsWith('> '), t.screen);
    t.type('\x03');
    await until(() => t.screen().includes('(To exit, press Ctrl+C again or Ctrl+D or type .exit)'), t.screen);
    t.type('\x03');
    expect(await r).toBe(0);
  }, 60_000);

  it('a pipe or a file is the program; process.stdin.isTTY says which', async () => {
    const { shell, fs } = await createTestShell();
    const t = keyTerminal();
    shell.setTerminal(t.term);
    let out = '';
    const run = async (c: string) => { out = ''; const code = await shell.execute(c, (s) => { out += s; }, (s) => { out += s; }); return code; };
    const isTTY = `node -e 'console.log(!!process.stdin.isTTY)'`;
    await run(`echo 'console.log(6 * 7)' | node | cat`);
    expect(out.replace(/\r\n/g, '\n')).toBe('42\n');
    await fs.writeFile('/tmp/p.js', 'console.log("from file")');
    await run('node < /tmp/p.js | cat');
    expect(out.replace(/\r\n/g, '\n')).toBe('from file\n');
    await run(`echo x | ${isTTY} | cat`);
    expect(out.replace(/\r\n/g, '\n')).toBe('false\n');
    await run(`${isTTY} <<< x | cat`);
    expect(out.replace(/\r\n/g, '\n')).toBe('false\n');
    await run(`${isTTY} | cat`);
    expect(out.replace(/\r\n/g, '\n')).toBe('true\n');
  }, 60_000);
});

/** A terminal with a pty session, as terminal.ts has: keys go to the pty while a job holds it */
function ptyTerminal() {
  const tty = new TtySession();
  let screen = '';
  tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
  return {
    tty,
    term: {
      tty,
      writeOutput: (s: string) => { screen += s; },
      write: (s: string) => { screen += s; },
      getSize: () => ({ cols: 80, rows: 24 }),
      onResize: () => () => {},
      enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {}, isRawMode: () => false,
      term: { buffer: { active: { type: 'normal' } } },
    } as any,
    screen: () => screen.replace(/\x1b\[[\d;]*m/g, '').replace(/\r\n/g, '\n'),
    /** a key, as the terminal sends it: to the pty when a job has it */
    type: (s: string) => { if (!tty.jobInForeground) throw new Error('nothing holds the tty'); tty.pty.input(s); },
  };
}

describe('node on a pty: process.stdin reads it as the foreground job', () => {
  it('cooked: the line discipline echoes and edits; Enter sends the line, ^D ends', async () => {
    const { shell } = await createTestShell();
    const t = ptyTerminal();
    shell.setTerminal(t.term);
    const r = shell.execute(`node -e 'process.stdin.on("data", (d) => console.log("got " + JSON.stringify(String(d)))); process.stdin.on("end", () => console.log("end"))'`, () => {}, () => {});
    await until(() => t.tty.jobInForeground, t.screen);
    t.type('hellp\x7fo\r');
    await until(() => t.screen().includes('got "hello\\n"'), t.screen);
    expect(t.screen()).toContain('hellp\b \bo\n'); // echoed and erased by the pty
    t.type('\x04');
    await until(() => t.screen().includes('end'), t.screen);
    expect(await r).toBe(0);
    expect([t.tty.pty.fgPgrp, t.tty.leader.pgid]).toEqual([t.tty.leader.pgid, t.tty.leader.pgid]); // the shell has the terminal back
  }, 30_000);

  it('^C is SIGINT: a listener gets it; without one node exits 130', async () => {
    const { shell } = await createTestShell();
    const t = ptyTerminal();
    shell.setTerminal(t.term);
    // (typed once node says it listens: before that ^C ends it, as with node, and a guest takes a moment to start)
    let r = shell.execute(`node -e 'process.on("SIGINT", () => { console.log("caught"); process.exit(3) }); process.stdin.resume(); console.log("ready")'`, () => {}, () => {});
    await until(() => t.tty.jobInForeground && t.screen().includes('ready'), t.screen);
    t.type('\x03');
    expect(await r).toBe(3);
    expect(t.screen()).toContain('caught');
    r = shell.execute(`node -e 'process.stdin.resume(); console.log("ready 2")'`, () => {}, () => {});
    await until(() => t.tty.jobInForeground && t.screen().includes('ready 2'), t.screen);
    t.type('\x03');
    expect(await r).toBe(130);
  }, 30_000);

  it('setRawMode switches the pty termios: keys one by one, no echo; restored after', async () => {
    const { shell } = await createTestShell();
    const t = ptyTerminal();
    shell.setTerminal(t.term);
    const r = shell.execute(`node -e 'process.stdin.setRawMode(true); process.stdin.on("data", (d) => { console.log("key " + JSON.stringify(String(d))); if (String(d) === "q") process.exit(0) })'`, () => {}, () => {});
    await until(() => t.tty.jobInForeground && (t.tty.pty.termios.lflag & 0o12) === 0, t.screen); // ICANON, ECHO off
    t.type('a');
    await until(() => t.screen().includes('key "a"'), t.screen);
    expect(t.screen()).not.toMatch(/^a/m); // not echoed
    t.type('q');
    expect(await r).toBe(0);
    expect(t.tty.pty.termios.lflag & 0o12).toBe(0o12); // the shell's modes again
  }, 30_000);

  it('the REPL runs on the pty: readline in raw mode, ^D exits', async () => {
    const { shell } = await createTestShell();
    const t = ptyTerminal();
    shell.setTerminal(t.term);
    const r = shell.execute('node', () => {}, () => {});
    await until(() => t.tty.jobInForeground && t.screen().endsWith('> '), t.screen);
    t.type('const z = 6\r');
    await until(() => t.screen().includes('undefined\n> '), t.screen);
    t.type('z * 7\r');
    await until(() => t.screen().includes('42\n> '), t.screen);
    t.type('\x04');
    expect(await r).toBe(0);
    expect(t.tty.jobInForeground).toBe(false);
  }, 30_000);
});
