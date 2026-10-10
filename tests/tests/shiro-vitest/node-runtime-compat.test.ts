/**
 * Node runtime behaviour scripts rely on (williamsharkey/tabcomputer#6):
 * child_process *Sync results read at once and their `input`, eval
 * workers, servers that print nothing of their own, `npm -v` as a bare
 * semver, and npx bins requiring their dependencies from npx's cache.
 */
import { describe, expect, it } from 'vitest';
import { createTestShell } from './helpers';
import { createReadline } from '@shiro/node-compat/modules/readline';

async function node(script: string, prep?: (fs: any) => Promise<void>, stdin?: string) {
  const { shell, fs } = await createTestShell();
  if (prep) await prep(fs);
  await fs.writeFile('/tmp/t.js', script);
  if (stdin !== undefined) await fs.writeFile('/tmp/in.txt', stdin);
  let out = '', err = '';
  const code = await shell.execute(`node /tmp/t.js < ${stdin !== undefined ? '/tmp/in.txt' : '/dev/null'}`, (s) => { out += s; }, (s) => { err += s; });
  return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
}

describe('child_process sync calls', () => {
  it('spawnSync/execSync/execFileSync: the result at once, and { input } as stdin', async () => {
    const r = await node(`
      const cp = require('child_process');
      const a = cp.spawnSync('cat', { input: 'piped' });
      console.log(JSON.stringify(String(a.stdout)), a.status, Array.isArray(a.output));
      console.log(JSON.stringify(String(cp.execSync('tr a-z A-Z', { input: 'up' }))));
      console.log(JSON.stringify(cp.execFileSync('wc', ['-c'], { input: Buffer.from('four'), encoding: 'utf8' }).trim()));
      console.log(JSON.stringify(String(cp.spawnSync('seq', ['2']).stdout)));
      try { cp.execSync('exit 3'); } catch (e) { console.log('threw', e.status); }
      function plain() { return typeof cp.execSync('true'); } // not awaited in a plain function
      console.log(plain());
    `);
    expect(r.out).toBe('"piped" 0 true\n"UP"\n"4"\n"1\\n2\\n"\nthrew 3\nobject\n');
  });
});

describe('worker_threads', () => {
  it('a Worker with eval: true runs its code and talks to the parent', async () => {
    const r = await node(`
      const { Worker } = require('worker_threads');
      new Worker('require("worker_threads").parentPort.postMessage(42)', { eval: true }).on('message', (m) => {
        console.log(m);
        const w = new Worker('const { parentPort, workerData } = require("worker_threads"); parentPort.on("message", (m) => parentPort.postMessage(m * workerData))', { eval: true, workerData: 3 });
        w.on('message', (n) => { console.log('times', n); w.terminate(); });
        w.postMessage(14);
      });
    `);
    expect(r.out).toBe('42\ntimes 42\n');
  });
});

describe('http servers', () => {
  it('print nothing of their own', async () => {
    const r = await node(`
      const h = require('http');
      const s = h.createServer((q, res) => res.end('pong')).listen(8765, () => h.get('http://127.0.0.1:8765', (res) => res.on('data', (d) => { console.log(String(d)); s.close(); })));
    `);
    expect([r.out, r.err]).toEqual(['pong\n', '']);
  });
});

describe('npm and npx', () => {
  it('npm -v and npm --version are a bare semver', async () => {
    const { shell } = await createTestShell();
    for (const c of ['npm -v', 'npm --version']) {
      let out = '';
      await shell.execute(c, (s) => { out += s; });
      expect(out.replace(/\r\n/g, '\n')).toMatch(/^\d+\.\d+\.\d+\n$/);
    }
  });

  it('npx without a package.json runs a cached bin that requires its own dependencies', async () => {
    const { shell, fs } = await createTestShell();
    const nm = '/home/user/.npm/_npx/hello-cli_1.0.0/node_modules';
    await fs.mkdir(`${nm}/hello-cli`, { recursive: true });
    await fs.mkdir(`${nm}/greet-dep`, { recursive: true });
    await fs.mkdir(`${nm}/.bin`, { recursive: true });
    await fs.writeFile(`${nm}/hello-cli/package.json`, JSON.stringify({ name: 'hello-cli', version: '1.0.0', bin: { 'hello-cli': 'cli.js' } }));
    await fs.writeFile(`${nm}/hello-cli/cli.js`, "#!/usr/bin/env node\nconsole.log(require('greet-dep')(process.argv[2]));\n");
    await fs.writeFile(`${nm}/greet-dep/package.json`, JSON.stringify({ name: 'greet-dep', version: '1.0.0', main: 'index.js' }));
    await fs.writeFile(`${nm}/greet-dep/index.js`, "module.exports = (n) => 'hello ' + n;\n");
    await fs.symlink('../hello-cli/cli.js', `${nm}/.bin/hello-cli`);
    await fs.mkdir('/tmp/empty-dir', { recursive: true });
    let out = '', err = '';
    const code = await shell.execute('cd /tmp/empty-dir && npx -y hello-cli@1.0.0 world', (s) => { out += s; }, (s) => { err += s; });
    expect([code, out.replace(/\r\n/g, '\n'), err]).toEqual([0, 'hello world\n', '']);
  });
});

describe('readline', () => {
  it("'line' per line (\\n, \\r\\n, a last line without one), then 'close' at the end of input", async () => {
    const r = await node(`
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.on('line', (l) => console.log('line:' + l)).on('close', () => console.log('closed'));
    `, undefined, 'a\nb\r\nc');
    expect(r.out).toBe('line:a\nline:b\nline:c\nclosed\n');
  });

  it('rl.question in turn, readline/promises, the async iterator', async () => {
    const q = await node(`
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      rl.question('name? ', (n) => rl.question('age? ', (a) => { console.log('|' + n + ' is ' + a); rl.close(); }));
    `, undefined, 'Ann\n42\n');
    expect(q.out).toBe('name? age? |Ann is 42\n');
    const p = await node(`
      (async () => {
        const rl = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
        const a = await rl.question('q? ');
        console.log('[' + a + ']');
        rl.close();
        await rl.question('again? ').catch((e) => console.log(e.code));
      })();
    `, undefined, 'p\n');
    expect(p.out).toBe('q? [p]\nERR_USE_AFTER_CLOSE\n');
    const it2 = await node(`
      (async () => {
        const rl = require('readline').createInterface({ input: process.stdin, crlfDelay: Infinity });
        let n = 0;
        for await (const line of rl) n += Number(line);
        console.log('sum', n);
      })();
    `, undefined, '1\n2\n3\n');
    expect(it2.out).toBe('sum 6\n');
  });

  it('on a raw terminal: keys echoed and edited (backspace), Enter ends the line, Ctrl-D closes', () => {
    const handlers: Record<string, (d: any) => void> = {};
    const input: any = { isTTY: true, isRaw: false, on: (e: string, f: any) => { handlers[e] = f; }, off() {}, resume() {}, pause() {}, setRawMode(m: boolean) { this.isRaw = m; } };
    let out = '';
    const rl: any = createReadline(false).createInterface({ input, output: { isTTY: true, write: (s: string) => { out += s; } } });
    const lines: string[] = [];
    let closed = false;
    rl.on('close', () => { closed = true; });
    rl.question('name? ', (n: string) => lines.push('q:' + n));
    rl.on('line', (l: string) => lines.push(l));
    handlers.data('Ab');
    handlers.data('\x7fnn\r');
    handlers.data('x\r\x04');
    expect(out).toBe('name? Ab\b \bnn\r\nx\r\n');
    expect(lines).toEqual(['q:Ann', 'x']);
    expect(closed).toBe(true);
    expect(input.isRaw).toBe(false); // raw mode back off
  });
});
