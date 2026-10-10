/**
 * Node runtime behaviour scripts rely on (williamsharkey/tabcomputer#6):
 * child_process *Sync results read at once and their `input`, eval
 * workers, servers that print nothing of their own, `npm -v` as a bare
 * semver, and npx bins requiring their dependencies from npx's cache.
 */
import { describe, expect, it } from 'vitest';
import { createTestShell } from './helpers';

async function node(script: string, prep?: (fs: any) => Promise<void>) {
  const { shell, fs } = await createTestShell();
  if (prep) await prep(fs);
  await fs.writeFile('/tmp/t.js', script);
  let out = '', err = '';
  const code = await shell.execute('node /tmp/t.js < /dev/null', (s) => { out += s; }, (s) => { err += s; });
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
