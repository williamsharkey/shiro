/**
 * node as a kernel guest in a Worker (TABCOMPUTER_NODE_WORKER=1, src/node-worker):
 * files through blocking syscalls, children as real processes, and the
 * *Sync child_process calls blocking for real (in a plain function too).
 * The guest is bundled with esbuild and runs in a Node worker_thread.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';
import { TtySession } from '@shiro/kernel/pty';

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

  it('a miss is not remembered; copies, modes and directories land before the next call', async () => {
    const r = await sh(`node -e '
      const fs = require("fs"), cp = require("child_process");
      fs.mkdirSync("/tmp/nr/stage", { recursive: true });
      const before = fs.existsSync("/tmp/nr/a.json");
      fs.writeFileSync("/tmp/nr/a.json.tmp", "{\\"v\\":1}");
      fs.renameSync("/tmp/nr/a.json.tmp", "/tmp/nr/a.json");
      console.log(before, fs.readFileSync("/tmp/nr/a.json", "utf8"), require("/tmp/nr/a.json").v);
      fs.writeFileSync("/tmp/nr/bin", Buffer.from([0, 255, 1]));          // binary: never in the text cache
      cp.execSync("cp /tmp/nr/bin /tmp/nr/stage/x");                      // a copy the cache never saw
      fs.copyFileSync("/tmp/nr/stage/x", "/tmp/nr/stage/y");
      fs.renameSync("/tmp/nr/stage", "/tmp/nr/final");                   // stage, then rename (pnpm)
      console.log(fs.readdirSync("/tmp/nr/final").join(","), fs.existsSync("/tmp/nr/stage"), [...fs.readFileSync("/tmp/nr/final/y")].join(" "));
      fs.writeFileSync("/tmp/nr/run.sh", "#!/bin/sh\\necho ran\\n", { mode: 0o755 });
      console.log(cp.execSync("/tmp/nr/run.sh").toString().trim(), fs.existsSync("/tmp/nr/final/"), fs.statSync("/tmp/nr/final").isDirectory());
    ' < /dev/null`);
    expect(r.err).toBe('');
    expect(r.out).toBe('false {"v":1} 1\nx,y false 0 255 1\nran true true\n');
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

  it("timeout signals its command's own process group, not the node and shell that run timeout (tabcomputer#13)", async () => {
    const r = await sh(`node -e '
      const r = require("child_process").spawnSync("sh", ["-c", "timeout 1 node -e \\"setInterval(() => {}, 1000)\\"; echo rc=$?; echo after"], { encoding: "utf8" });
      console.log(r.status, r.signal, JSON.stringify(r.stdout));
    ' < /dev/null; echo "node=$?"`);
    expect(r.err).toBe('');
    expect(r.out).toBe('0 null "rc=124\\nafter\\n"\nnode=0\n');
  }, 60_000);

  it('in a script, node is the shell\'s child; its redirects and pipes are the shell\'s', async () => {
    const r = await sh(`node -e '
      const out = String(require("child_process").execSync("echo $$; node -e \\"console.log(require(\\\\\\"fs\\\\\\").readFileSync(\\\\\\"/proc/self/stat\\\\\\", \\\\\\"utf8\\\\\\").split(\\\\\\" \\\\\\")[3])\\" > /tmp/nk3; cat /tmp/nk3; node -p 6*7 | tr 4 x"));
      const [sh, ppid, piped] = out.trim().split("\\n");
      console.log(sh === ppid, piped);
    ' < /dev/null`);
    expect(r.err).toBe('');
    expect(r.out).toBe('true x2\n');
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

  it.each([
    ['node server.js > log 2>&1 &', 18495],
    ['npm run dev > log 2>&1 &', 18496],
  ])('`%s` serves from a guest: Running while it listens, its log written as it comes; kill ends it', async (cmd, port) => {
    const { iframeServer } = await import('@shiro/iframe-server');
    const { shell, fs } = await createTestShell();
    const tty = new TtySession();
    tty.pty.onOutput(() => {});
    shell.setTerminal({ tty, writeOutput() {}, write() {}, getSize: () => ({ cols: 80, rows: 24 }), onResize: () => () => {},
      enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {}, isRawMode: () => false, term: { buffer: { active: { type: 'normal' } } } } as any);
    await fs.mkdir('/tmp/bg', { recursive: true });
    await fs.writeFile('/tmp/bg/server.js', `require('http').createServer((q, s) => { console.log('req ' + q.url); console.error('err ' + q.url); s.end('ok'); })
  .listen(+process.env.PORT, () => console.log('listening', require('fs').readFileSync('/proc/self/stat', 'utf8').split(' ')[0]));`);
    await fs.writeFile('/tmp/bg/package.json', JSON.stringify({ name: 'bg', scripts: { dev: 'node server.js' } }));
    const run = async (c: string) => { let out = ''; await shell.execute(c, (t) => { out += t; }, (t) => { out += t; }); return out.replace(/\r\n/g, '\n'); };
    const until = async (cond: () => boolean | Promise<boolean>, what: string) => {
      const t0 = Date.now();
      while (!(await cond())) { if (Date.now() - t0 > 20_000) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 50)); }
    };
    await run(`export TABCOMPUTER_NODE_WORKER=1 PORT=${port}; cd /tmp/bg; ${cmd}`);
    await until(() => iframeServer.isPortInUse(port), 'the port');
    await new Promise((r) => setTimeout(r, 1500)); // (an in-page script would have returned by now)
    expect(await run('jobs')).toMatch(/Running/);
    expect((await iframeServer.fetch(port, '/a')).status).toBe(200);
    await until(async () => /err \/a/.test(await fs.readFile('/tmp/bg/log', 'utf8') as string), 'the request in the log');
    const log = await fs.readFile('/tmp/bg/log', 'utf8') as string;
    expect(log).toMatch(/listening \d+\nreq \/a\nerr \/a\n/);
    if (cmd.startsWith('node')) expect(log).toContain(`listening ${(await run('echo $!')).trim()}\n`); // $! is node's pid
    await run('kill %1');
    await until(() => !iframeServer.isPortInUse(port), 'the port to close');
    await until(async () => !/Running/.test(await run('jobs')), 'the job to end');
  }, 60_000);

  it('worker_threads: each Worker is a thread of the process, running in parallel', async () => {
    const r = await sh(`node /tmp/nt/main.js < /dev/null`, async (fs) => {
      await fs.mkdir('/tmp/nt', { recursive: true });
      await fs.writeFile('/tmp/nt/w.js', `const { parentPort, workerData, isMainThread, threadId } = require('worker_threads');
const fs = require('fs');
parentPort.on('message', (m) => {
  if (m.cmd === 'sum') parentPort.postMessage({ sum: m.n.reduce((a, b) => a + b, 0), data: workerData.tag, isMainThread, same: threadId === workerData.id });
  if (m.cmd === 'wake') { const a = new Int32Array(m.sab); Atomics.store(a, 0, 42); Atomics.notify(a, 0); }
  if (m.cmd === 'file') { fs.writeFileSync('/tmp/nt/from-thread', 'hi'); parentPort.postMessage('wrote'); }
  if (m.cmd === 'bye') process.exit(7);
});
`);
      await fs.writeFile('/tmp/nt/main.js', `const { Worker, isMainThread } = require('worker_threads');
const fs = require('fs');
const w = new Worker('/tmp/nt/w.js', { workerData: { tag: 't1', id: 0 } });
const replies = [];
w.on('online', () => replies.push('online'));
w.on('message', (m) => {
  replies.push(m);
  if (m.sum !== undefined) {
    // the main thread blocks; only a worker running in parallel can wake it
    const sab = new SharedArrayBuffer(4), a = new Int32Array(sab);
    w.postMessage({ cmd: 'wake', sab });
    const r = Atomics.wait(a, 0, 0, 5000);
    replies.push(r + ' ' + Atomics.load(a, 0));
    w.postMessage({ cmd: 'file' });
  } else if (m === 'wrote') {
    replies.push(fs.readFileSync('/tmp/nt/from-thread', 'utf8'));
    w.postMessage({ cmd: 'bye' });
  }
});
w.on('exit', (code) => {
  console.log(isMainThread, JSON.stringify(replies.map((x) => typeof x === 'object' ? { ...x, same: undefined } : x)), code);
  new Worker('throw new Error("bad thread")', { eval: true }).on('error', (e) => console.log('error:', /bad thread/.test(e.message))).on('exit', (c) => console.log('exit', c));
});
w.postMessage({ cmd: 'sum', n: [1, 2, 3] });
`);
    });
    expect(r.err).toBe('');
    expect(r.out).toBe('true ["online",{"sum":6,"data":"t1","isMainThread":false},"ok 42","wrote","hi"] 7\nerror: true\nexit 1\n');
  }, 60_000);

  it('worker_threads: a message posted at once waits for the listener; the main thread can block on the worker', async () => {
    const r = await sh(`node /tmp/nt2/m.js < /dev/null`, async (fs) => {
      await fs.mkdir('/tmp/nt2', { recursive: true });
      // the listener comes after a slow require: the message waits for it
      await fs.writeFile('/tmp/nt2/w.js', `const { parentPort } = require('worker_threads');
const t0 = Date.now(); while (Date.now() - t0 < 100) {}
parentPort.on('message', (m) => { const a = new Int32Array(m.sab); Atomics.store(a, 0, 42); Atomics.notify(a, 0); });
`);
      await fs.writeFile('/tmp/nt2/m.js', `const { Worker } = require('worker_threads');
const w = new Worker('/tmp/nt2/w.js');
const sab = new SharedArrayBuffer(4), a = new Int32Array(sab);
w.postMessage({ sab });
console.log(Atomics.wait(a, 0, 0, 10000), Atomics.load(a, 0));
w.terminate();
`);
    });
    expect(r.err).toBe('');
    expect(r.out).toBe('ok 42\n');
  }, 60_000);

  it("a guest's server-sent events stream to the page as they are written", async () => {
    const { iframeServer } = await import('@shiro/iframe-server');
    const { shell, fs } = await createTestShell();
    await fs.writeFile('/tmp/nh-sse.js', `require('http').createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let n = 0;
  const t = setInterval(() => { res.write('data: ' + (++n) + '\\n\\n'); if (n === 3) { clearInterval(t); res.end(); setTimeout(() => process.exit(0), 50); } }, 150);
}).listen(18494);`);
    const run = shell.execute('export TABCOMPUTER_NODE_WORKER=1; node /tmp/nh-sse.js < /dev/null', () => {}, () => {});
    const t0 = Date.now();
    while (!iframeServer.isPortInUse(18494) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
    const start = Date.now();
    const res = await iframeServer.fetch(18494, '/events');
    expect(res.headers?.['content-type']).toBe('text/event-stream');
    expect(res.body).toBeInstanceOf(ReadableStream);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    const firstAt = Date.now() - start;
    let all = new TextDecoder().decode(first.value);
    for (;;) { const { value, done } = await reader.read(); if (done) break; all += new TextDecoder().decode(value); }
    expect(firstAt).toBeLessThan(Date.now() - start - 150); // the first event came well before the end
    expect(all).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n');
    expect(await run).toBe(0);
  }, 60_000);

  it('on a pty: cooked lines, ^C to a listener or exit 130, setRawMode and back', async () => {
    const { shell } = await createTestShell();
    const tty = new TtySession();
    let screen = '';
    tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
    shell.setTerminal({ tty, writeOutput: (s: string) => { screen += s; }, write: (s: string) => { screen += s; }, getSize: () => ({ cols: 80, rows: 24 }), onResize: () => () => {},
      enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {}, isRawMode: () => false, term: { buffer: { active: { type: 'normal' } } } } as any);
    const until = async (cond: () => boolean) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > 15_000) throw new Error(`timed out: ${JSON.stringify(screen)}`); await new Promise((r) => setTimeout(r, 10)); } };
    const run = (js: string) => { screen = ''; return shell.execute(`export TABCOMPUTER_NODE_WORKER=1; node -e '${js}'`, () => {}, () => {}); };
    // cooked: the pty echoes and edits; the line comes on Enter; ^D ends
    let r = run('process.stdin.on("data", (d) => console.log("got " + JSON.stringify(String(d)))); process.stdin.on("end", () => console.log("end")); console.log("ready")');
    await until(() => screen.includes('ready'));
    tty.pty.input('hellp\x7fo\r');
    await until(() => screen.includes('got "hello\\n"'));
    expect(screen).toContain('hellp\b \bo\r\n');
    tty.pty.input('\x04');
    expect(await r).toBe(0);
    expect(screen).toContain('end');
    // ^C: SIGINT to a listener; without one, exit 130
    r = run('process.on("SIGINT", () => { console.log("caught"); process.exit(3) }); process.stdin.resume(); console.log("ready")');
    await until(() => screen.includes('ready'));
    tty.pty.input('\x03');
    expect(await r).toBe(3);
    expect(screen).toContain('caught');
    r = run('process.stdin.resume(); console.log("ready")');
    await until(() => screen.includes('ready'));
    tty.pty.input('\x03');
    expect(await r).toBe(130);
    // raw: keys one by one, no echo, no signals; the shell's modes again after
    r = run('process.stdin.setRawMode(true); process.stdin.on("data", (d) => { console.log("key " + JSON.stringify(String(d))); if (String(d) === "q") process.exit(0) }); console.log("ready")');
    await until(() => screen.includes('ready'));
    expect(tty.pty.termios.lflag & 0o12).toBe(0); // ICANON, ECHO off
    tty.pty.input('a');
    await until(() => screen.includes('key "a"'));
    tty.pty.input('\x03');
    await until(() => screen.includes('key "\\u0003"'));
    tty.pty.input('q');
    expect(await r).toBe(0);
    expect(tty.pty.termios.lflag & 0o12).toBe(0o12);
  }, 60_000);

  for (const mode of ['1', '0']) {
    it(`spawn() with stdio 'inherit' gives the child the terminal itself (codex's launcher), ${mode === '1' ? 'as a guest' : 'in the page'}`, async () => {
      const { shell, fs } = await createTestShell();
      await fs.mkdir('/tmp/inh', { recursive: true });
      await fs.writeFile('/tmp/inh/child.js', 'console.log("tty", !!process.stdin.isTTY, !!process.stdout.isTTY, "ready"); process.stdin.once("data", (d) => { console.log("got-" + String(d).trim()); process.exit(0); });');
      await fs.writeFile('/tmp/inh/parent.js', 'const c = require("child_process").spawn("node", ["/tmp/inh/child.js"], { stdio: "inherit" }); c.on("exit", (code) => console.log("child exit", code));');
      const tty = new TtySession();
      let screen = '';
      // (colours off: a terminal's console.log colours its values)
      const plain = (t: string) => t.replace(/\x1b\[[\d;]*m/g, '');
      tty.pty.onOutput((b) => { screen += plain(new TextDecoder().decode(b)); });
      shell.setTerminal({ tty, writeOutput: (s: string) => { screen += plain(s); }, write: (s: string) => { screen += plain(s); }, getSize: () => ({ cols: 80, rows: 24 }), onResize: () => () => {},
        enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {}, isRawMode: () => false, term: { buffer: { active: { type: 'normal' } } } } as any);
      const until = async (cond: () => boolean) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > 15_000) throw new Error(`timed out: ${JSON.stringify(screen)}`); await new Promise((r) => setTimeout(r, 10)); } };
      const r = shell.execute(`export TABCOMPUTER_NODE_WORKER=${mode}; node /tmp/inh/parent.js`, () => {}, () => {});
      await until(() => screen.includes('ready'));
      expect(screen).toContain('tty true true ready');
      tty.pty.input('hello\r');
      await until(() => screen.includes('child exit'));
      expect(await r).toBe(0);
      expect(screen.replace(/\r\n/g, '\n')).toMatch(/got-hello\n[\s\S]*child exit 0/);
    }, 60_000);
  }

  for (const mode of ['1', '0']) it(`a #!node script run by path (npm run dev's .bin/vite) streams its output while it runs, ${mode === '1' ? 'as a guest' : 'in the page'}`, async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/ss/node_modules/.bin', { recursive: true });
    await fs.writeFile('/tmp/ss/srv.js', '#!/usr/bin/env node\nconsole.log("ready"); setTimeout(() => console.log("bye"), 1500);\n');
    await fs.chmod('/tmp/ss/srv.js', 0o755);
    await fs.symlink('../../srv.js', '/tmp/ss/node_modules/.bin/srv');
    await fs.writeFile('/tmp/ss/package.json', JSON.stringify({ name: 'ss', version: '1.0.0', scripts: { dev: 'srv' } }));
    /** Run `cmd`; when "ready" showed up, and when it ended */
    const timing = async (cmd: string, seen: () => string, run: (cmd: string) => Promise<number>) => {
      let readyAt = 0;
      const poll = setInterval(() => { if (!readyAt && seen().includes('ready')) readyAt = Date.now(); }, 5);
      expect(await run(`export TABCOMPUTER_NODE_WORKER=${mode}; ${cmd}`)).toBe(0);
      clearInterval(poll);
      expect(seen()).toContain('bye');
      return { readyAt, endAt: Date.now() };
    };
    // its output into the caller's writer, as it comes
    let out = '';
    let t = await timing('cd /tmp/ss && ./srv.js', () => out, (c) => shell.execute(c, (s) => { out += s; }, (s) => { out += s; }));
    expect(t.endAt - t.readyAt).toBeGreaterThan(1000);
    // npm run dev at a terminal: on the terminal, after npm's header
    const tty = new TtySession();
    let screen = '';
    tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
    shell.setTerminal({ tty, writeOutput: (s: string) => { screen += s; }, write: (s: string) => { screen += s; }, getSize: () => ({ cols: 80, rows: 24 }), onResize: () => () => {},
      enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {}, isRawMode: () => false, term: { buffer: { active: { type: 'normal' } } } } as any);
    t = await timing('cd /tmp/ss && npm run dev', () => screen, (c) => shell.execute(c, () => {}, () => {}));
    expect(t.endAt - t.readyAt).toBeGreaterThan(1000);
    expect(screen.indexOf('> ss@1.0.0 dev')).toBeLessThan(screen.indexOf('ready'));
  }, 60_000);

  it("spawn(): a fast child's output reaches listeners added after spawn() returns", async () => {
    const r = await sh(`node -e '
      const { spawn } = require("child_process");
      let left = 5; const got = [];
      for (let i = 0; i < 5; i++) {
        const c = spawn("sh", ["-c", "echo fast" + i], { env: { ...process.env, X: "1" } });
        let out = ""; c.stdout.on("data", (d) => out += d);
        c.on("close", () => { got[i] = out.trim(); if (!--left) console.log(got.join(",")); });
      }
    '`);
    expect(r.out).toBe('fast0,fast1,fast2,fast3,fast4\n');
  }, 60_000);

  it('a worker whose guest ended cleanly runs the next node (warm); a killed one is not reused', async () => {
    // the realm carries over, as the page's does for in-page node
    let r = await sh(`node -e 'globalThis.__poolProbe = (globalThis.__poolProbe || 0) + 1; console.log(globalThis.__poolProbe)' < /dev/null; node -e 'console.log(globalThis.__poolProbe)' < /dev/null`);
    expect(r.out).toBe('1\n1\n'); // the second run saw the first's global: the same worker
    // a guest killed mid-run: its worker is gone, the next node starts fresh
    r = await sh(`node -e 'globalThis.__poolKilled = 1; setInterval(() => {}, 1000)' < /dev/null & sleep 0.5; kill -9 %1; wait; node -e 'console.log(String(globalThis.__poolKilled))' < /dev/null`);
    expect(r.out.trim().split('\n').pop()).toBe('undefined');
  }, 60_000);

  it("pbcopy from a guest reaches the page's clipboard", async () => {
    let copied: string | null = null;
    const nav: any = globalThis.navigator;
    const had = Object.getOwnPropertyDescriptor(nav, 'clipboard');
    Object.defineProperty(nav, 'clipboard', { value: { writeText: async (t: string) => { copied = t; } }, configurable: true });
    try {
      await sh(`node -e 'const c = require("child_process").spawn("pbcopy"); c.stdin.write("from the guest"); c.stdin.end()' < /dev/null`);
      for (let i = 0; i < 100 && copied === null; i++) await new Promise((r) => setTimeout(r, 10));
      expect(copied).toBe('from the guest');
    } finally {
      if (had) Object.defineProperty(nav, 'clipboard', had); else delete nav.clipboard;
    }
  }, 60_000);

  it('stdin from a pipe; async exec', async () => {
    const r = await sh(`printf 'a\\nb\\n' | node -e '
      let t = ""; process.stdin.on("data", (d) => t += d).on("end", () => {
        require("child_process").exec("echo async", (e, out) => console.log(JSON.stringify(t), out.trim()));
      });
    '`);
    expect(r.out).toBe('"a\\nb\\n" async\n');
  }, 60_000);

  it('fork(): an IPC channel both ways (jest-worker); the child sees disconnect; the env keeps no channel', async () => {
    const r = await sh('cd /tmp/nf && node parent.js', async (fs) => {
      await fs.mkdir('/tmp/nf', { recursive: true });
      await fs.writeFile('/tmp/nf/child.js', `
process.on('message', (m) => {
  if (m.cmd === 'square') process.send({ n: m.n, sq: m.n * m.n, connected: process.connected, env: process.env.NODE_CHANNEL_FD === undefined });
  if (m.cmd === 'bye') process.disconnect();
});
process.on('disconnect', () => require('fs').writeFileSync('/tmp/nf/child-disconnected', 'yes'));
process.send({ ready: process.argv.slice(2) });`);
      await fs.writeFile('/tmp/nf/parent.js', `
const { fork } = require('child_process');
const c = fork('child.js', ['a1'], { silent: true });
const got = [];
c.on('message', (m) => {
  got.push(m);
  if (m.ready) for (const n of [2, 3]) c.send({ cmd: 'square', n });
  if (m.sq === 9) c.send({ cmd: 'bye' });
});
c.on('disconnect', () => got.push('disconnect'));
c.on('exit', (code) => console.log(JSON.stringify(got), code, c.connected));`);
    });
    expect(r.err).toBe('');
    expect(r.out).toBe('[{"ready":["a1"]},{"n":2,"sq":4,"connected":true,"env":true},{"n":3,"sq":9,"connected":true,"env":true},"disconnect"] 0 false\n');
    expect(await r.fs.readFile('/tmp/nf/child-disconnected', 'utf8')).toBe('yes');
  }, 60_000);

  it("fork(): the child's output is the parent's unless silent; the parent's disconnect() ends a child that only listens", async () => {
    const r = await sh('cd /tmp/nf2 && node parent.js', async (fs) => {
      await fs.mkdir('/tmp/nf2', { recursive: true });
      await fs.writeFile('/tmp/nf2/child.js', `console.log('child says hi'); process.on('message', () => {});`);
      await fs.writeFile('/tmp/nf2/parent.js', `
const c = require('child_process').fork('./child.js');
setTimeout(() => c.disconnect(), 300);
c.on('exit', (code) => console.log('exit', code, c.stdout === null));`);
    });
    expect(r.out).toBe('child says hi\nexit 0 true\n');
  }, 60_000);

  it('jest-worker in child_process mode: tasks go to forked workers over IPC, each its own process', async () => {
    const r = await sh(`mkdir -p /home/user/jw && cd /home/user/jw && npm init -y > /dev/null && npm install jest-worker@29.7.0 > /dev/null 2>&1 && node main.js`, async (fs) => {
      await fs.mkdir('/home/user/jw', { recursive: true });
      await fs.writeFile('/home/user/jw/task.js', `exports.square = (n) => ({ sq: n * n, pid: process.pid, ppid: process.ppid, id: process.env.JEST_WORKER_ID });`);
      await fs.writeFile('/home/user/jw/main.js', `const { Worker } = require('jest-worker');
const w = new Worker(require.resolve('./task.js'), { numWorkers: 2, enableWorkerThreads: false });
Promise.all([1, 2, 3, 4].map((n) => w.square(n))).then(async (r) => {
  const pids = new Set(r.map((x) => x.pid));
  console.log(JSON.stringify(r.map((x) => x.sq)), !pids.has(process.pid), r.every((x) => x.ppid === process.pid && /^[12]$/.test(x.id)));
  await w.end();
  console.log('ended');
}, (e) => { console.log('ERR', e.stack); process.exit(1); });`);
    });
    expect(r.out).toBe('[1,4,9,16] true true\nended\n');
  }, 240_000);

  it("Claude Code as a guest starts onboarded: ~/.claude.json is seeded before it runs, as in the page", async () => {
    const r = await sh('rm -f ~/.claude.json; node /tmp/nc/claude-code/cli.js', async (fs) => {
      await fs.mkdir('/tmp/nc/claude-code', { recursive: true });
      await fs.writeFile('/tmp/nc/claude-code/cli.js', `const c = JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.claude.json', 'utf8')); console.log(c.hasCompletedOnboarding, typeof c.theme);`);
    });
    expect(r.out).toBe('true string\n');
  }, 60_000);
});
