/**
 * node as a kernel guest in a Worker (TABCOMPUTER_NODE_WORKER=1, src/node-worker):
 * files through blocking syscalls, children as real processes, and the
 * *Sync child_process calls blocking for real (in a plain function too).
 * The guest is bundled with esbuild and runs in a Node worker_thread.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

async function sh(cmd: string, prep?: (fs: any) => Promise<void>) {
  const { shell, fs } = await createTestShell();
  if (prep) await prep(fs);
  let out = '', err = '';
  const code = await shell.execute(`export TABCOMPUTER_NODE_WORKER=1; ${cmd}`, (s) => { out += s; }, (s) => { err += s; });
  return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), fs };
}

describe('node as a kernel guest', () => {
  it('runs a script; its exit status', async () => {
    const r = await sh(`node -e 'console.log(1 + 1, typeof process.pid)' < /dev/null; node -e 'process.exit(3)' < /dev/null; echo "status $?"`);
    expect(r.out).toBe('2 number\nstatus 3\n');
  }, 60_000);

  it('files through syscalls, both ways, at once', async () => {
    const r = await sh(`mkdir -p /tmp/nw && echo from-shell > /tmp/nw/a.txt && node -e '
      const fs = require("fs");
      console.log(fs.readFileSync("/tmp/nw/a.txt", "utf8").trim(), fs.existsSync("/tmp/nw/none"), fs.statSync("/tmp/nw").isDirectory());
      fs.writeFileSync("/tmp/nw/b.txt", "from-node\\n");
      fs.mkdirSync("/tmp/nw/d/e", { recursive: true });
      console.log(fs.readdirSync("/tmp/nw").sort().join(","));
    ' < /dev/null && cat /tmp/nw/b.txt`);
    expect(r.out).toBe('from-shell false true\na.txt,b.txt,d\nfrom-node\n');
  }, 60_000);

  it('execSync/spawnSync block for real, in a plain function too; input is stdin', async () => {
    const r = await sh(`node -e '
      const cp = require("child_process");
      function plain() { return String(cp.execSync("echo hi; echo err >&2")); }
      console.log(JSON.stringify(plain()));
      const s = cp.spawnSync("cat", { input: "piped" });
      console.log(JSON.stringify(String(s.stdout)), s.status);
      console.log(cp.execFileSync("wc", ["-c"], { input: "four", encoding: "utf8" }).trim());
      try { cp.execSync("exit 4"); } catch (e) { console.log("threw", e.status); }
      require("fs").writeFileSync("/tmp/nw-out.txt", "x");
      console.log(String(cp.execSync("cat /tmp/nw-out.txt; echo y > /tmp/nw-out.txt")), require("fs").readFileSync("/tmp/nw-out.txt", "utf8").trim());
    ' < /dev/null`);
    expect(r.out).toBe('"hi\\n"\n"piped" 0\n4\nthrew 4\nx y\n');
  }, 60_000);

  it('cached files and directories see what children change', async () => {
    const r = await sh(`mkdir -p /tmp/nc/d /tmp/nc/o && echo aaa > /tmp/nc/d/f && echo bbb > /tmp/nc/o/f && node -e '
      const fs = require("fs"), cp = require("child_process");
      const read = () => fs.readFileSync("/tmp/nc/d/f", "utf8").trim();
      const first = read();
      cp.execSync("echo ccc > /tmp/nc/d/f");                        // same size, new content
      const second = read();
      cp.execSync("mv /tmp/nc/d /tmp/nc/d2 && ln -s o /tmp/nc/d");  // the directory is now a link
      console.log(first, second, read(), fs.realpathSync("/tmp/nc/d/f"), fs.lstatSync("/tmp/nc/d").isSymbolicLink());
      fs.writeFileSync("/tmp/nc/x.tmp.1", "atomic");                 // write-then-rename
      fs.renameSync("/tmp/nc/x.tmp.1", "/tmp/nc/x");
      fs.symlinkSync("/tmp/nc/x", "/tmp/nc/y");
      fs.unlinkSync("/tmp/nc/x");
      console.log(fs.existsSync("/tmp/nc/y"), fs.existsSync("/tmp/nc/x.tmp.1"));
      fs.writeFileSync("/tmp/nc/x", "back");
      console.log(fs.readFileSync("/tmp/nc/y", "utf8"), fs.statSync("/tmp/nc/y").size);
    ' < /dev/null`);
    expect(r.err).toBe('');
    expect(r.out).toBe('aaa ccc bbb /tmp/nc/o/f true\nfalse false\nback 4\n');
  }, 60_000);

  it('node the kernel starts (sh -c, a #! script) is the guest itself', async () => {
    const r = await sh(`chmod +x /tmp/nk/inner.js && node /tmp/nk/outer.js < /dev/null`, async (fs) => {
      await fs.mkdir('/tmp/nk', { recursive: true });
      await fs.writeFile('/tmp/nk/inner.js', `#!/usr/bin/env node
const fs = require('fs');
console.log(process.argv.slice(2).join(','), fs.readFileSync('/proc/self/stat', 'utf8').split(' ')[3]);
`);
      await fs.writeFile('/tmp/nk/outer.js', `const fs = require('fs'), cp = require('child_process');
const me = fs.readFileSync('/proc/self/stat', 'utf8').split(' ')[0];
const a = cp.execSync('node /tmp/nk/inner.js x').toString().trim().split(' ');
const b = cp.execSync('/tmp/nk/inner.js y z').toString().trim().split(' ');
console.log(a[0], a[1] === me, b[0], b[1] === me);
`);
    });
    // the inner node's parent is the outer node: sh -c exec'd it in place, no node in between
    expect(r.err).toBe('');
    expect(r.out).toBe('x true y,z true\n');
  }, 60_000);

  it('output to a pipe streams, and spawn() delivers it as it comes', async () => {
    // inner node waits for a file its parent makes on seeing inner's first line:
    // with output held until exit (either end) that never happens
    const r = await sh(`node /tmp/ns/outer.js < /dev/null`, async (fs) => {
      await fs.mkdir('/tmp/ns', { recursive: true });
      await fs.writeFile('/tmp/ns/inner.js', `const fs = require('fs');
console.log('early'); process.stderr.write('err-early\\n');
const t0 = Date.now();
const t = setInterval(() => {
  if (fs.existsSync('/tmp/ns/go')) { clearInterval(t); console.log('late'); }
  else if (Date.now() - t0 > 8000) { clearInterval(t); console.log('timed out'); }
}, 20);
`);
      await fs.writeFile('/tmp/ns/outer.js', `const fs = require('fs'), cp = require('child_process');
const c = cp.spawn('node', ['/tmp/ns/inner.js']);
let out = '', err = '';
c.stdout.on('data', (d) => { out += d; if (out.includes('early')) fs.writeFileSync('/tmp/ns/go', ''); });
c.stderr.on('data', (d) => { err += d; });
c.on('close', (code) => console.log(JSON.stringify(out), JSON.stringify(err), code));
`);
    });
    expect(r.err).toBe('');
    expect(r.out).toBe('"early\\nlate\\n" "err-early\\n" 0\n');
  }, 60_000);

  it('a ref\'d interval keeps the guest running until cleared; an unref\'d one does not', async () => {
    const r = await sh(`node -e '
      const t0 = Date.now(); let n = 0;
      const t = setInterval(() => { if (++n === 30) { clearInterval(t); console.log("ticks", n, Date.now() - t0 >= 500); } }, 20);
    ' < /dev/null; node -e 'setInterval(() => console.log("never"), 5000).unref(); console.log("bye")' < /dev/null`);
    expect(r.out).toBe('ticks 30 true\nbye\n');
  }, 60_000);

  it('http and net over kernel sockets: a server, its client, and a child process as a client', async () => {
    const r = await sh(`node /tmp/nh/s.js < /dev/null`, async (fs) => {
      await fs.mkdir('/tmp/nh', { recursive: true });
      await fs.writeFile('/tmp/nh/s.js', `const http = require('http'), net = require('net'), cp = require('child_process');
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => body += d).on('end', () => { res.setHeader('x-who', 'guest'); res.end(req.method + ' ' + req.url + ' ' + body); });
});
srv.listen(18491, () => {
  http.get('http://localhost:18491/a?b=1', (res) => {
    let t = ''; res.on('data', (d) => t += d).on('end', () => {
      console.log(res.statusCode, res.headers['x-who'], t);
      // another process (a child node guest) reaches this server through the kernel
      cp.exec("node -e \\"require('http').get('http://127.0.0.1:18491/child', (r) => { let t = ''; r.on('data', (d) => t += d).on('end', () => console.log(t)); })\\"", (e, out) => {
        console.log('child:', out.trim());
        srv.close();
        const echo = net.createServer((c) => c.pipe(c)).listen(18492, () => {
          const c = net.connect(18492, '127.0.0.1', () => c.end('ping'));
          let got = ''; c.on('data', (d) => got += d).on('close', () => { console.log('echo:', got); echo.close(); });
        });
      });
    });
  });
});
`);
    });
    expect(r.err).toBe('');
    expect(r.out).toBe('200 guest GET /a?b=1 \nchild: GET /child\necho: ping\n');
  }, 60_000);

  it("a guest server is on the page's port table (previews reach it)", async () => {
    const { iframeServer } = await import('@shiro/iframe-server');
    const { shell, fs } = await createTestShell();
    await fs.writeFile('/tmp/nh-page.js', `require('http').createServer((req, res) => { res.end('hi ' + req.url); this.done = true; setTimeout(() => process.exit(0), 50); }).listen(18493);`);
    let out = '', err = '';
    const run = shell.execute('export TABCOMPUTER_NODE_WORKER=1; node /tmp/nh-page.js < /dev/null', (s) => { out += s; }, (s) => { err += s; });
    const t0 = Date.now();
    while (!iframeServer.isPortInUse(18493) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
    const res = await iframeServer.fetch(18493, '/preview');
    expect(res.status).toBe(200);
    expect(typeof res.body === 'string' ? res.body : new TextDecoder().decode(res.body as Uint8Array)).toBe('hi /preview');
    expect(await run).toBe(0);
    expect(err).toBe('');
  }, 60_000);

  it('stdin from a pipe; async exec', async () => {
    const r = await sh(`printf 'a\\nb\\n' | node -e '
      let t = ""; process.stdin.on("data", (d) => t += d).on("end", () => {
        require("child_process").exec("echo async", (e, out) => console.log(JSON.stringify(t), out.trim()));
      });
    '`);
    expect(r.out).toBe('"a\\nb\\n" async\n');
  }, 60_000);
});
