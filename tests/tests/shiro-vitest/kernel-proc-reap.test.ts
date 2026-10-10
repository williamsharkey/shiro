/**
 * tabcomputer#14, kernel parts: init reaps orphans at once, the load
 * averages decay as Linux's do, and /proc/PID/fd names pipes and anonymous
 * inodes the way Linux does; `kill PID` ends a `bash -c` blocked in a
 * command; `ls -a`'s . and .. are directories.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { LoadAvg, LOAD_FREQ_MS } from '@shiro/kernel/procfs';

const hang = () => new Promise<number>(() => {});

describe('tabcomputer#14 kernel parts', () => {
  let fs: FileSystem;
  let shell: Shell;
  let kernel: Kernel;

  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    await fs.mkdir('/tmp', { recursive: true }).catch(() => {});
  });
  beforeEach(() => { kernel = new Kernel({ shell }); });
  afterEach(() => kernel.dispose());

  it('init reaps an orphan as soon as it exits, and an orphaned zombie at once', async () => {
    const parent = kernel.spawn({ path: 'parent', cwd: '/tmp', fds: {}, run: hang });
    const live = kernel.vfork(parent);
    const dead = kernel.vfork(parent);
    await kernel.exit(dead, 0); // a zombie its parent never waits for
    expect(kernel.procs.get(dead.pid)?.state).toBe('zombie');
    await kernel.exit(parent, 0);
    expect(kernel.procs.has(dead.pid)).toBe(false);
    expect(live.ppid).toBe(1);
    await kernel.exit(live, 0);
    expect(kernel.procs.has(live.pid)).toBe(false);
    // the page's own children (ppid 1 from spawn) stay for their runner's waitpid
    expect(kernel.procs.has(parent.pid)).toBe(true);
    expect((await kernel.waitpid(parent.pid, A.WNOHANG)).pid).toBe(parent.pid);
  });

  it('load averages move toward the run count with 1, 5 and 15 minute windows', () => {
    const t0 = 1_000_000;
    const l = new LoadAvg(t0);
    l.sample(2, t0 + LOAD_FREQ_MS - 1);
    expect(l.avg).toEqual([0, 0, 0]); // under one period: nothing yet
    l.sample(2, t0 + 60_000); // 12 periods at 2
    const [a, b, c] = l.avg;
    expect(a).toBeCloseTo(2 * (1 - Math.exp(-1)), 6);
    expect(b).toBeCloseTo(2 * (1 - Math.exp(-0.2)), 6);
    expect(c).toBeCloseTo(2 * (1 - Math.exp(-1 / 15)), 6);
    l.sample(0, t0 + 120_000); // a minute idle: decays
    expect(l.avg[0]).toBeCloseTo(a * Math.exp(-1), 6);
    expect(l.avg[1]).toBeCloseTo(b * Math.exp(-0.2), 6); // the longer windows decay slower
  });

  it('/proc/loadavg and sysinfo report the same decaying averages', async () => {
    const proc = kernel.spawn({ path: 'la', cwd: '/tmp', fds: {}, run: hang });
    kernel.procfs.load.avg = [1.5, 0.75, 0.25];
    const f = await kernel.open(proc, '/proc/loadavg', A.O_RDONLY);
    if (typeof f === 'number') throw new Error(String(f));
    const buf = new Uint8Array(128);
    const text = new TextDecoder().decode(buf.subarray(0, await f.read(buf)));
    expect(text).toMatch(/^1\.50 0\.75 0\.25 \d+\/\d+ \d+\n$/);
    const data = new Uint8Array(A.SYSINFO_SIZE);
    expect(await kernel.syscall(proc, A.SYS_sysinfo, [], data)).toBe(0);
    const v = new DataView(data.buffer);
    expect([0, 1, 2].map((i) => Number(v.getBigUint64(8 + i * 8, true)) / 65536)).toEqual([1.5, 0.75, 0.25]);
    kernel.kill(proc.pid, A.SIGKILL);
  });

  it('/proc/PID/fd: pipe:[N] shared by both ends, anon_inode for eventfd, timerfd and epoll', async () => {
    const proc = kernel.spawn({ path: 'fds', cwd: '/tmp', fds: {}, run: hang });
    const data = new Uint8Array(4096);
    const readlink = async (p: string) => {
      const b = new TextEncoder().encode(p); data.fill(0); data.set(b);
      const n = await kernel.syscall(proc, A.SYS_readlink, [b.length, 4096], data);
      return n < 0 ? n : new TextDecoder().decode(data.subarray(0, n));
    };
    expect(await kernel.syscall(proc, A.SYS_pipe2, [0], data)).toBe(0);
    const [r, w] = [new DataView(data.buffer).getInt32(0, true), new DataView(data.buffer).getInt32(4, true)];
    const rt = await readlink(`/proc/self/fd/${r}`);
    expect(rt).toMatch(/^pipe:\[[1-9]\d*\]$/);
    expect(await readlink(`/proc/self/fd/${w}`)).toBe(rt);
    const ev = await kernel.syscall(proc, A.SYS_eventfd2, [0, 0], data);
    expect(await readlink(`/proc/self/fd/${ev}`)).toBe('anon_inode:[eventfd]');
    const tf = await kernel.syscall(proc, A.SYS_timerfd_create, [1, 0], data);
    expect(await readlink(`/proc/self/fd/${tf}`)).toBe('anon_inode:[timerfd]');
    const ep = await kernel.syscall(proc, A.SYS_epoll_create1, [0], data);
    expect(await readlink(`/proc/self/fd/${ep}`)).toBe('anon_inode:[eventpoll]');
    kernel.kill(proc.pid, A.SIGKILL);
  });
});

describe('tabcomputer#14: kill PID ends a bash -c blocked in a command', () => {
  let shell: Shell;
  beforeAll(async () => {
    ({ shell } = await createTestShell());
  });
  const timed = async (cmd: string) => {
    const t = Date.now();
    const r = await Promise.race([run(shell, cmd), new Promise<{ output: string; exitCode: number }>((res) => setTimeout(() => res({ output: 'HUNG', exitCode: -1 }), 5000))]);
    return { out: r.output.replace(/\r\n/g, '\n').replace(/^\[\d+\] \d+\n/m, ''), ms: Date.now() - t };
  };

  it('SIGTERM: 143, SIGKILL: 137, at once', async () => {
    let r = await timed("bash -c 'sleep 30' & p=$!; sleep 0.2; kill $p; wait $p; echo st=$?");
    expect(r.out).toBe('st=143\n');
    expect(r.ms).toBeLessThan(3000);
    r = await timed("sh -c 'sleep 30' & p=$!; sleep 0.2; kill -9 $p; wait $p; echo st=$?");
    expect(r.out).toBe('st=137\n');
    await fs_mkfifo();
    r = await timed("bash -c 'cat /tmp/kill14.fifo' & p=$!; sleep 0.2; kill $p; wait $p; echo st=$?");
    expect(r.out).toBe('st=143\n');
  });

  it('its EXIT trap runs; a TERM trap or trap "" waits for the command, as bash does', async () => {
    let r = await timed(`bash -c 'trap "echo bye" EXIT; sleep 30' & p=$!; sleep 0.2; kill $p; wait $p; echo st=$?`);
    expect(r.out).toBe('bye\nst=143\n');
    r = await timed(`bash -c 'trap "echo got-term" TERM; sleep 0.5; echo after' & p=$!; sleep 0.2; kill $p; wait $p; echo st=$?`);
    expect(r.out).toBe('got-term\nafter\nst=0\n');
    r = await timed(`bash -c 'trap "" TERM; sleep 0.5; echo survived' & p=$!; sleep 0.2; kill $p; wait $p; echo st=$?`);
    expect(r.out).toBe('survived\nst=0\n');
    r = await timed(`bash -c 'kill $$; echo no'; echo st=$?`);
    expect(r.out).toBe('st=143\n');
  });

  async function fs_mkfifo() {
    await run(shell, 'rm -f /tmp/kill14.fifo; mkfifo /tmp/kill14.fifo');
  }
});

describe("tabcomputer#14: ls -a's . and ..", () => {
  it('are the directory and its parent, never links (/proc/self/fd/.. is /proc/PID)', async () => {
    const { shell } = await createTestShell();
    const r = await run(shell, 'ls -la /proc/self/fd');
    const lines = r.output.split(/\r?\n/);
    expect(lines.find((l) => / \.$/.test(l))).toMatch(/^d/);
    expect(lines.find((l) => / \.\.$/.test(l))).toMatch(/^d/);
    expect((await run(shell, 'mkdir -p /tmp/lsa/x && ls -a /tmp/lsa')).output.replace(/\r\n/g, '\n')).toBe('.\n..\nx\n');
  });
});

describe("killing a program's sh -c child doesn't interrupt the page shell's foreground job", () => {
  let shell: Shell;
  let kernel: Kernel;
  beforeAll(async () => {
    ({ shell } = await createTestShell());
  });
  beforeEach(() => { kernel = new Kernel({ shell }); });
  afterEach(() => kernel.dispose());

  // codex (the page shell's foreground job) kills its `git fetch` after a timeout;
  // the page shell's abort used to fire and SIGINT codex's group ("turn interrupted")
  it('SIGKILL to a kernel sh -c leaves the page shell alone', async () => {
    const page = new AbortController();
    shell.abortController = page;
    try {
      const child = kernel.spawn({ path: 'sh', argv: ['sh', '-c', 'sleep 5'], cwd: '/tmp', fds: {} });
      await new Promise((r) => setTimeout(r, 100));
      expect(kernel.kill(child.pid, A.SIGKILL)).toBe(0);
      await child.wait();
      await new Promise((r) => setTimeout(r, 50));
      expect(page.signal.aborted).toBe(false);
    } finally {
      shell.abortController = null;
    }
  });
});
