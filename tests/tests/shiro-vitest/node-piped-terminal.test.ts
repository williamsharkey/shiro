import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

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
