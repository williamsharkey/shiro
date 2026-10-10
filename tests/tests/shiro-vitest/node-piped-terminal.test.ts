import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';
import { TtySession } from '@shiro/kernel/pty';

// With a terminal attached, node used to stream stdout straight to it, so
// `node x.js | tr` and `node x.js > file` typed at the prompt bypassed the pipe.
describe('node stdout honors pipes and redirects when a terminal is attached', () => {
  it('pipes and redirects, and still streams to the terminal when last', async () => {
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
    await fs.writeFile('/tmp/n.js', 'console.log("from-node"); process.stdout.write("raw")');
    const run = async (c: string) => {
      let out = '';
      await shell.execute(c, (s) => { out += s; }, (s) => { out += s; });
      return out.replace(/\r\n/g, '\n');
    };

    expect(await run('node /tmp/n.js | tr a-z A-Z')).toBe('FROM-NODE\nRAW');
    expect(screen).toBe('');
    await run('node /tmp/n.js > /tmp/n.out');
    expect(await fs.readFile('/tmp/n.out', 'utf8')).toBe('from-node\nraw');
    expect(screen).toBe('');

    await run('node /tmp/n.js');
    expect(screen.replace(/\r\n/g, '\n')).toBe('from-node\nraw');
  });
});

// (both configs: the page's node here, a guest's under `npm run test:worker`)
describe("a child with stdio 'inherit' has node's terminal", () => {
  it('spawn, spawnSync and execSync: its stdin and stdout are the tty', async () => {
    const { shell, fs } = await createTestShell();
    const tty = new TtySession();
    let screen = '';
    tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
    shell.setTerminal({ tty, writeOutput: (s: string) => { screen += s; }, write: (s: string) => { screen += s; }, getSize: () => ({ cols: 80, rows: 24 }), onResize: () => () => {},
      enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {}, isRawMode: () => false, term: { buffer: { active: { type: 'normal' } } } } as any);
    await fs.writeFile('/tmp/inh.js', `const cp = require('child_process');
const t = (w) => '[ -t 0 ] && [ -t 1 ] && echo ' + w + '=tty || echo ' + w + '=notty';
cp.spawnSync('sh', ['-c', t('spawnSync')], { stdio: 'inherit' });
cp.execSync(t('execSync'), { stdio: 'inherit' });
cp.spawn('sh', ['-c', t('spawn')], { stdio: 'inherit' });
`);
    expect(await shell.execute('node /tmp/inh.js', () => {}, () => {})).toBe(0);
    expect(screen.replace(/\r\n/g, '\n').match(/\w+=\w+/g)).toEqual(['spawnSync=tty', 'execSync=tty', 'spawn=tty']);
  }, 60_000);
});
