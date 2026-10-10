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

  it('stdin from a pipe; async exec', async () => {
    const r = await sh(`printf 'a\\nb\\n' | node -e '
      let t = ""; process.stdin.on("data", (d) => t += d).on("end", () => {
        require("child_process").exec("echo async", (e, out) => console.log(JSON.stringify(t), out.trim()));
      });
    '`);
    expect(r.out).toBe('"a\\nb\\n" async\n');
  }, 60_000);
});
