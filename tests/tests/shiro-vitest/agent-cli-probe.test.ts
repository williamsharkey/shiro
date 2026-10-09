import { it } from 'vitest';
import { readdirSync, lstatSync, readlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestShell } from './helpers';

/**
 * Manual probe (skipped unless AGENT_PROBE_ROOT is set): load a rootfs (a
 * host directory with the agent CLI, its ELF interpreter and libraries) into
 * the test FS, run one command line in Blink as a kernel process, and report
 * wall time, the node process's peak RSS, the kernel syscalls that failed
 * (by number and errno), the time spent in each syscall number, and the output. docs/COMPAT.md "Agent CLIs".
 * AGENT_PROBE_ROOT may list several directories (comma-separated), loaded
 * in order over each other.
 *
 *   AGENT_PROBE_ROOT=/tmp/rootfs AGENT_PROBE_ARGV='/opt/claude/claude --version' \
 *   AGENT_PROBE_ENV='HOME=/root,BUN_JSC_useJIT=0' AGENT_PROBE_TIMEOUT=600000 \
 *     npx vitest run --config vitest.config.ts tests/shiro-vitest/agent-cli-probe.test.ts
 *
 * AGENT_PROBE_TRACE=1 logs every kernel syscall (with its path argument).
 * AGENT_PROBE_ENV_FROM=NAME,... copies those variables from the host env
 * without printing them. AGENT_PROBE_RELAY_PORTS=host:port,... starts a TCP
 * relay (server.mjs createTcpRelay, in a child process) that may dial those loopback ports, so a
 * guest can reach an HTTP(S) proxy outside the test; AGENT_PROBE_DOH points
 * the kernel's resolver at a DoH URL.
 */
const ROOT = process.env.AGENT_PROBE_ROOT!;

async function load(fs: any, host: string, guest: string) {
  for (const n of readdirSync(host)) {
    const h = join(host, n), g = guest + '/' + n;
    const st = lstatSync(h);
    if (st.isSymbolicLink()) { try { await fs.symlink(readlinkSync(h), g); } catch {} }
    else if (st.isDirectory()) { await fs.mkdir(g, { recursive: true }); await load(fs, h, g); }
    else await fs.writeFile(g, readFileSync(h), { mode: st.mode & 0o777 });
  }
}

const envList = (s: string | undefined) => Object.fromEntries((s || '').split(',').filter(Boolean).map((kv) => {
  const i = kv.indexOf('=');
  return [kv.slice(0, i), kv.slice(i + 1)];
}));

it.skipIf(!ROOT)('probe', async () => {
  const { fs, shell } = await createTestShell();
  let t = Date.now();
  for (const dir of ROOT.split(',')) await load(fs, dir, '');
  console.log('load ms', Date.now() - t);
  const { Kernel } = await import('@shiro/kernel/kernel');
  const { BufferFile } = await import('@shiro/kernel/fd');
  const { registerBlinkLoader } = await import('@shiro/x86-engine/blink');
  const kernel = new Kernel({ fs, registerWithProcessTable: false });
  kernel.shell = shell as any;
  registerBlinkLoader(kernel);

  const relayPorts = (process.env.AGENT_PROBE_RELAY_PORTS || '').split(',').filter(Boolean);
  let closeRelay = () => {};
  if (relayPorts.length) {
    const { netStack } = await import('@shiro/kernel/net');
    // The relay runs in a child Node process: server.mjs doesn't load under this config's polyfills
    const serverPath = new URL('../../../server.mjs', import.meta.url).pathname;
    const origin = 'http://shiro.test';
    const cfg = JSON.stringify({
      allowedOrigins: [origin],
      ports: relayPorts.map((p) => +p.split(':').pop()!),
      allowCidrs: ['127.0.0.1/32'],
      maxBytesPerConn: 1 << 30,
      connectsPerMinute: 1000,
    });
    const script = `import { createServer } from 'node:http';
const { createTcpRelay } = await import(${JSON.stringify(serverPath)});
const relay = createTcpRelay(${cfg}, { log: () => {} });
const srv = createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname === '/tcp/token') return relay.handleToken(req, res);
  res.writeHead(404).end();
});
srv.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
srv.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: srv.address().port })));`;
    const cp = (process as any).getBuiltinModule('child_process') as typeof import('node:child_process');
    const child = cp.spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise<number>((resolve, reject) => {
      let buf = '';
      child.stdout!.on('data', (d) => { buf += d; const m = /\{"port":(\d+)\}/.exec(buf); if (m) resolve(+m[1]); });
      child.once('exit', (c) => reject(new Error(`relay exited ${c}`)));
    });
    class OriginWebSocket extends WebSocket {
      constructor(url: string | URL) { super(url, { headers: { origin } } as any); }
    }
    netStack.configure({
      relayUrl: `ws://127.0.0.1:${port}/tcp`,
      tokenUrl: `http://127.0.0.1:${port}/tcp/token`,
      fetch: ((u: any, init: any = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), origin } })) as typeof fetch,
      WebSocket: OriginWebSocket as unknown as typeof WebSocket,
      relayLoopback: true,
      portHost: null,
      ...(process.env.AGENT_PROBE_DOH ? { dohUrl: process.env.AGENT_PROBE_DOH } : {}),
    });
    closeRelay = () => child.kill();
  }

  // Count failing kernel syscalls by number and errno
  // and the wall time spent in each syscall number (blocking waits included)
  const fails = new Map<string, number>();
  const counts = new Map<number, number>();
  const spent = new Map<number, number>();
  const origSys = kernel.syscall.bind(kernel);
  const trace = process.env.AGENT_PROBE_TRACE === '1';
  (kernel as any).syscall = (proc: any, nr: number, args: any, data: any) => {
    counts.set(nr, (counts.get(nr) || 0) + 1);
    const t0 = performance.now();
    // AGENT_PROBE_TRACE=1: every kernel syscall, with the path for the path-taking ones
    const path = trace && (nr === 257 || nr === 262 || nr === 21 || nr === 4 || nr === 6 || nr === 89)
      ? new TextDecoder().decode((data as Uint8Array).slice(0, 256)).split('\0')[0] : '';
    const r = origSys(proc, nr, args, data);
    if (trace) r.then((v: number) => console.log(`[sys] ${proc.pid} ${nr}(${Array.from(args as ArrayLike<number>).slice(0, 4).join(',')}) = ${v} ${path}`), () => {});
    r.then((v: number) => {
      spent.set(nr, (spent.get(nr) || 0) + performance.now() - t0);
      if (v < 0 && v > -4096) { const k = `${nr}:${-v}`; fails.set(k, (fails.get(k) || 0) + 1); }
    }, () => {});
    return r;
  };

  const hostEnv: Record<string, string> = {};
  for (const n of (process.env.AGENT_PROBE_ENV_FROM || '').split(',').filter(Boolean)) if (process.env[n]) hostEnv[n] = process.env[n]!;
  const argv = (process.env.AGENT_PROBE_ARGV || '/opt/claude/claude --version').match(/'[^']*'|"[^"]*"|\S+/g)!.map((a) => a.replace(/^(['"])(.*)\1$/, '$2'));
  const out = new BufferFile(null);
  let peak = 0;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  t = Date.now();
  const p = kernel.spawn({
    path: argv[0], argv, cwd: process.env.AGENT_PROBE_CWD || '/root',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', TERM: 'dumb', ...envList(process.env.AGENT_PROBE_ENV), ...hostEnv },
    fds: { 0: new BufferFile(process.env.AGENT_PROBE_STDIN || ''), 1: out, 2: out },
  });
  const timeout = +(process.env.AGENT_PROBE_TIMEOUT || 300_000);
  const timer = setTimeout(() => kernel.kill(p.pid, 9), timeout);
  let last = 0;
  const progress = setInterval(() => {
    const txt = out.text();
    if (txt.length !== last) { console.log('[out]', txt.slice(last, last + 2000)); last = txt.length; }
  }, 5000);
  const st = await p.wait();
  clearTimeout(timer); clearInterval(sample); clearInterval(progress);
  peak = Math.max(peak, process.memoryUsage().rss);
  const secret = Object.values(hostEnv);
  let text = out.text();
  for (const s of secret) if (s.length > 8) text = text.split(s).join('<redacted>');
  console.log(JSON.stringify({
    argv, status: st, ms: Date.now() - t, peakRssMB: Math.round(peak / 2 ** 20),
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    failedSyscalls: Object.fromEntries([...fails].sort((a, b) => b[1] - a[1])),
    syscalls: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, 25)),
    syscallMs: Object.fromEntries([...spent].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, Math.round(v)])),
  }, null, 1));
  console.log('--- output ---\n' + text.slice(-8000));
  closeRelay();
}, 3_600_000);
