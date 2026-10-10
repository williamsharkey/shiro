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

  it('stdin from a pipe; async exec', async () => {
    const r = await sh(`printf 'a\\nb\\n' | node -e '
      let t = ""; process.stdin.on("data", (d) => t += d).on("end", () => {
        require("child_process").exec("echo async", (e, out) => console.log(JSON.stringify(t), out.trim()));
      });
    '`);
    expect(r.out).toBe('"a\\nb\\n" async\n');
  }, 60_000);
});
