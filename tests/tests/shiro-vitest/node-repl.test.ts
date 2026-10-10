/**
 * `node` with no script: the REPL on a terminal, the program on a pipe.
 * The terminal stand-in sends keys as xterm does (stdin passthrough).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

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
