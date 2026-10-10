import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

// Output that a redirect takes, with a terminal attached: a server's `> log` gets its
// lines while it runs, stderr follows `2>`, a redirected compound's programs don't
// write on the screen, and npm's redirected script output ends lines with \n.
async function setup() {
  const { shell, fs } = await createTestShell();
  let screen = '';
  const term: any = {
    writeOutput: (s: string) => { screen += s; },
    write: (s: string) => { screen += s; },
    getSize: () => ({ cols: 80, rows: 24 }),
    onResize: () => () => {},
    enterStdinPassthrough: () => {}, exitStdinPassthrough: () => {},
    term: { buffer: { active: { type: 'normal' } } },
  };
  shell.setTerminal(term);
  const run = async (c: string) => {
    let out = '';
    const code = await shell.execute(c, (s) => { out += s; }, (s) => { out += s; });
    return { out: out.replace(/\r\n/g, '\n'), code };
  };
  return { shell, fs, run, screen: () => screen };
}

describe('redirected output with a terminal attached', () => {
  it('node stderr goes to 2> and 2>&1, not the screen', async () => {
    const { fs, run, screen } = await setup();
    await fs.writeFile('/tmp/e.js', 'console.error("e1"); process.stderr.write("e2\\n"); console.log("o1")');
    await run('node /tmp/e.js 2> /tmp/e.err > /tmp/e.out');
    expect(await fs.readFile('/tmp/e.err', 'utf8')).toBe('e1\ne2\n');
    expect(await fs.readFile('/tmp/e.out', 'utf8')).toBe('o1\n');
    await run('node /tmp/e.js > /tmp/both 2>&1');
    expect(await fs.readFile('/tmp/both', 'utf8')).toBe('e1\ne2\no1\n');
    expect(screen()).toBe('');
    // tty.isatty answers per fd
    await run(`node -e "console.log(require('tty').isatty(1), require('tty').isatty(2))" > /tmp/tty.out`);
    expect(await fs.readFile('/tmp/tty.out', 'utf8')).toBe('false true\n');
    await run(`node -e "console.error(require('tty').isatty(1), require('tty').isatty(2))" 2> /tmp/tty.err`);
    expect(await fs.readFile('/tmp/tty.err', 'utf8')).toBe('true false\n');
    // (still on the screen when not redirected)
    await run('node /tmp/e.js');
    expect(screen().replace(/\r\n/g, '\n')).toBe('e1\ne2\no1\n');
  });

  it("a server's redirected output is in its file while it runs", async () => {
    const { fs, run, screen } = await setup();
    await fs.writeFile('/tmp/srv.js', 'console.log("listening"); console.error("warn"); setInterval(() => {}, 1000)');
    await run('node /tmp/srv.js > /tmp/srv.log 2>&1 &');
    let log = '';
    for (let i = 0; i < 100 && !/warn/.test(log); i++) {
      await new Promise((r) => setTimeout(r, 50));
      log = await fs.readFile('/tmp/srv.log', 'utf8').catch(() => '') as string;
    }
    expect(log).toBe('listening\nwarn\n');
    expect(screen()).not.toMatch(/listening|warn/);
    await run('kill %1');
  });

  it('programs in a redirected subshell or group write to the file', async () => {
    const { fs, run, screen } = await setup();
    await run('(node -e "console.log(2)") > /tmp/sub.out');
    expect(await fs.readFile('/tmp/sub.out', 'utf8')).toBe('2\n');
    await run('(node -e "console.error(3)") 2> /tmp/sub.err');
    expect(await fs.readFile('/tmp/sub.err', 'utf8')).toBe('3\n');
    expect(screen()).toBe('');
  });

  it('npm run > file writes \\n line ends, and no undefined@undefined without a name', async () => {
    const { fs, run } = await setup();
    await run('mkdir -p /tmp/np && cd /tmp/np');
    await fs.writeFile('/tmp/np/package.json', JSON.stringify({ scripts: { e: 'echo hi; node -e "console.log(1)"' } }));
    expect((await run('npm run e > /tmp/np/o.txt')).code).toBe(0);
    expect(await fs.readFile('/tmp/np/o.txt', 'utf8')).toBe('> e\n> echo hi; node -e "console.log(1)"\n\nhi\n1\n');
  });
});

describe('redirected output of what a builtin runs', () => {
  it('bash -c, sh -c and a script run node into the redirect, not on the screen', async () => {
    const { fs, run, screen } = await setup();
    await run('bash -c "node -e \\"console.log(4)\\"" > /tmp/b.out');
    expect(await fs.readFile('/tmp/b.out', 'utf8')).toBe('4\n');
    await run('sh -c "node -e \\"console.error(5)\\"" 2> /tmp/b.err');
    expect(await fs.readFile('/tmp/b.err', 'utf8')).toBe('5\n');
    await fs.writeFile('/tmp/s.sh', '#!/bin/sh\nnode -e "console.log(6)"\n', { mode: 0o755 } as any);
    await run('chmod +x /tmp/s.sh; /tmp/s.sh > /tmp/s.out');
    expect(await fs.readFile('/tmp/s.out', 'utf8')).toBe('6\n');
    await run('{ node -e "console.log(7)"; } > /tmp/g.out');
    expect(await fs.readFile('/tmp/g.out', 'utf8')).toBe('7\n');
    expect(screen()).toBe('');
  });
});
