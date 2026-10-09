/**
 * The kernel log (src/kernel/klog.ts): the ring buffer, /dev/kmsg, syslog(2),
 * trap and OOM lines, and the dmesg builtin. Relay refusals reaching the log
 * are in kernel-net.test.ts (they need the relay harness).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import * as A from '@shiro/kernel/abi';
import {
  KernelLog, KmsgFile, klog, formatKmsg, formatTimestamp, LOG_ERR, LOG_WARNING, LOG_INFO, LOG_USER, LOG_KERN,
  SYSLOG_ACTION_READ_ALL, SYSLOG_ACTION_SIZE_BUFFER, SYSLOG_ACTION_CLEAR, SYSLOG_ACTION_READ, SYSLOG_ACTION_SIZE_UNREAD,
} from '@shiro/kernel/klog';
import { Kernel } from '@shiro/kernel/kernel';
import type { OpenFile } from '@shiro/kernel/fd';

const dec = new TextDecoder();
const enc = new TextEncoder();

async function readRecord(f: OpenFile, size = 1024): Promise<string | number> {
  const buf = new Uint8Array(size);
  const n = await f.read(buf);
  return n < 0 ? n : dec.decode(buf.subarray(0, n));
}

describe('ring buffer', () => {
  it('keeps the newest records when the record limit wraps', () => {
    const log = new KernelLog(64 * 1024, 5);
    for (let i = 0; i < 8; i++) log.log(LOG_INFO, `line ${i}`);
    expect(log.size).toBe(5);
    expect(log.firstSeq).toBe(3);
    expect(log.lastSeq).toBe(8);
    expect(log.all().map(r => r.text)).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
    expect(log.get(2)).toBeUndefined();
    expect(log.get(7)?.text).toBe('line 7');
    // Many more wraps (the backing array compacts)
    for (let i = 8; i < 3000; i++) log.log(LOG_INFO, `line ${i}`);
    expect(log.all().map(r => r.seq)).toEqual([2995, 2996, 2997, 2998, 2999]);
  });

  it('keeps under the byte limit, splits lines, and clears', () => {
    const log = new KernelLog(1024, 1000);
    for (let i = 0; i < 100; i++) log.log(LOG_INFO, `${i} ` + 'x'.repeat(60));
    expect(log.size).toBeLessThan(20);
    expect(log.all().at(-1)!.text.startsWith('99 ')).toBe(true);
    log.log(LOG_ERR, 'first\nsecond\n');
    expect(log.all().slice(-2).map(r => r.text)).toEqual(['first', 'second']);
    log.clear();
    expect(log.all()).toEqual([]);
    expect(log.since(log.firstSeq).length).toBeGreaterThan(0); // still readable through /dev/kmsg
  });

  it('timestamps are [ seconds.micro ] since boot', () => {
    expect(formatTimestamp(1_234_567)).toBe('[    1.234567]');
    expect(formatTimestamp(98_765_432_100)).toBe('[98765.432100]');
    const log = new KernelLog();
    log.clock = () => 2_000_001;
    log.log(LOG_WARNING, 'hello');
    expect(log.text()).toBe('[    2.000001] hello\n');
  });

  it('rate-limits identical lines and says how many it dropped', () => {
    const log = new KernelLog();
    let now = 0;
    log.clock = () => now;
    for (let i = 0; i < 50; i++) log.logRatelimited(LOG_WARNING, 'net: relay refused connect to x:1: handshake refused');
    log.logRatelimited(LOG_WARNING, 'net: something else');
    expect(log.all().filter(r => r.text.includes('handshake refused')).length).toBe(5);
    now = 6_000_000; // past the 5 s window
    log.logRatelimited(LOG_WARNING, 'net: relay refused connect to x:1: handshake refused');
    const texts = log.all().map(r => r.text);
    expect(texts).toContain('net: 45 similar messages suppressed');
    expect(texts.at(-1)).toBe('net: relay refused connect to x:1: handshake refused');
  });
});

describe('/dev/kmsg', () => {
  it('reads one prio,seq,usec,-;text record per read, then EAGAIN', async () => {
    const log = new KernelLog();
    log.clock = () => 1_500_000;
    log.log(LOG_WARNING, 'net: relay refused');
    log.log(LOG_ERR, 'multi\\back\x01slash');
    const f = new KmsgFile(log, A.O_RDONLY | A.O_NONBLOCK);
    expect(await readRecord(f)).toBe('4,0,1500000,-;net: relay refused\n');
    expect(await readRecord(f)).toBe('3,1,1500000,-;multi\\x5cback\\x01slash\n');
    expect(await readRecord(f)).toBe(-A.EAGAIN);
    expect(f.poll(A.POLLIN)).toBe(0);
    log.log(LOG_INFO, 'later');
    expect(f.poll(A.POLLIN)).toBe(A.POLLIN);
    expect(await readRecord(f, 5)).toBe(-A.EINVAL); // buffer too small for the record
    expect(await readRecord(f)).toBe('6,2,1500000,-;later\n');
  });

  it('blocks for the next record, EPIPE after overwritten records, seeks, writes', async () => {
    const log = new KernelLog(64 * 1024, 3);
    const f = new KmsgFile(log, A.O_RDWR);
    const pending = readRecord(f);
    log.log(LOG_INFO, 'woke');
    expect(await pending).toMatch(/^6,0,\d+,-;woke\n$/);
    for (let i = 0; i < 5; i++) log.log(LOG_INFO, `n${i}`); // seq 1..5; 1 and 2 are gone
    expect(await readRecord(f)).toBe(-A.EPIPE);
    expect(await readRecord(f)).toMatch(/;n2\n$/);
    expect(f.seek(0, A.SEEK_END)).toBe(0);
    log.clear();
    log.log(LOG_INFO, 'after clear');
    expect(f.seek(0, 3 /* SEEK_DATA */)).toBe(0);
    expect(await readRecord(f)).toMatch(/;after clear\n$/);
    // Writes log as userspace; <N> sets the level
    expect(await f.write(enc.encode('<3>myapp: disk on fire\n'))).toBe(23);
    await f.write(enc.encode('plain'));
    const [a, b] = log.all().slice(-2);
    expect([a.facility, a.level, a.text]).toEqual([LOG_USER, 3, 'myapp: disk on fire']);
    expect([b.facility, b.level]).toEqual([LOG_USER, 4]);
    expect(formatKmsg(a)).toMatch(/^11,\d+,\d+,-;myapp: disk on fire\n$/);
  });

  it('is a kernel device, and syslog(2) reads the same log', async () => {
    const kernel = new Kernel({ registerWithProcessTable: false });
    const proc = kernel.spawn({ path: 'reader', fds: {}, run: () => new Promise<number>(() => {}) });
    klog.log(LOG_WARNING, 'klog-test: hello from the kernel');
    const f = await kernel.open(proc, '/dev/kmsg', A.O_RDONLY | A.O_NONBLOCK) as OpenFile;
    expect(typeof f).toBe('object');
    let found = false;
    for (;;) {
      const r = await readRecord(f, 8192);
      if (typeof r === 'number') { expect(r === -A.EAGAIN || r === -A.EPIPE).toBe(true); if (r === -A.EAGAIN) break; continue; }
      expect(r).toMatch(/^\d+,\d+,\d+,-;/);
      if (r.includes('klog-test: hello from the kernel')) found = true;
    }
    expect(found).toBe(true);
    expect(((await f.stat()).mode & A.S_IFMT)).toBe(A.S_IFCHR);

    const data = new Uint8Array(1 << 16);
    const n = await kernel.syscall(proc, A.SYS_syslog, [SYSLOG_ACTION_READ_ALL, data.length], data);
    expect(n).toBeGreaterThan(0);
    const text = dec.decode(data.subarray(0, n));
    expect(text).toMatch(/<4>\[ *\d+\.\d{6}\] klog-test: hello from the kernel\n/);
    expect(await kernel.syscall(proc, A.SYS_syslog, [SYSLOG_ACTION_SIZE_BUFFER, 0], data)).toBe(64 * 1024);
    // A small buffer gets the newest whole records
    const small = await kernel.syscall(proc, A.SYS_syslog, [SYSLOG_ACTION_READ_ALL, 60], data);
    expect(small).toBeLessThanOrEqual(60);
    expect(dec.decode(data.subarray(0, small)).endsWith('\n')).toBe(true);
    // Clearing and the destructive read need root
    expect(await kernel.syscall(proc, A.SYS_syslog, [SYSLOG_ACTION_CLEAR, 0], data)).toBe(-A.EPERM);
    expect(await kernel.syscall(proc, A.SYS_syslog, [SYSLOG_ACTION_READ, 100], data)).toBe(-A.EPERM);
    expect(await kernel.syscall(proc, A.SYS_syslog, [99, 0], data)).toBe(-A.EPERM);
    proc.uid = 0;
    expect(await kernel.syscall(proc, A.SYS_syslog, [99, 0], data)).toBe(-A.EINVAL);
    expect(await kernel.syscall(proc, A.SYS_syslog, [SYSLOG_ACTION_SIZE_UNREAD, 0], data)).toBeGreaterThan(0);
    kernel.kill(proc.pid, A.SIGKILL);
    kernel.dispose();
  });
});

describe('trap and OOM lines', () => {
  it('a process killed by SIGSEGV logs a traps line; OOM errors log like the OOM killer', async () => {
    const kernel = new Kernel({ registerWithProcessTable: false });
    const seg = kernel.spawn({ path: '/usr/bin/crashy', argv: ['crashy'], fds: {}, run: () => new Promise<number>(() => {}) });
    seg.data.trapReason = 'at 0x0';
    await kernel.exit(seg, A.W_TERMSIG(A.SIGSEGV));
    expect(klog.all().at(-1)!.text).toBe(`traps: crashy[${seg.pid}] segfault (at 0x0), killed by SIGSEGV`);
    // Ordinary kills aren't traps
    const before = klog.lastSeq;
    const term = kernel.spawn({ path: 'sleepy', fds: {}, run: () => new Promise<number>(() => {}) });
    kernel.kill(term.pid, A.SIGTERM);
    await term.wait();
    expect(klog.lastSeq).toBe(before);

    const big = kernel.spawn({ path: 'hog', fds: {}, run: () => new Promise<number>(() => {}) });
    kernel.reportFatal(big, 'blink aborted: OOM');
    expect(klog.all().at(-1)!.text).toBe(`Out of memory: Killed process ${big.pid} (hog): blink aborted: OOM`);
    expect(klog.all().at(-1)!.level).toBe(LOG_ERR);
    const trap = kernel.spawn({ path: 'w', fds: {}, run: () => new Promise<number>(() => {}) });
    kernel.reportFatal(trap, 'wasm trap: unreachable');
    expect(klog.all().at(-1)!.text).toBe(`traps: w[${trap.pid}] wasm trap: unreachable`);
    // Logged once even if the process then dies of a fault signal
    await kernel.exit(trap, A.W_TERMSIG(A.SIGSEGV));
    expect(klog.all().at(-1)!.text).toBe(`traps: w[${trap.pid}] wasm trap: unreachable`);
    for (const p of [big]) kernel.kill(p.pid, A.SIGKILL);
    kernel.dispose();
  });
});

describe('dmesg builtin', () => {
  let shell: Shell;
  beforeAll(async () => { ({ shell } = await createTestShell()); });
  afterEach(() => { (shell as { uid?: number }).uid = undefined; });

  const run = async (cmd: string) => {
    let out = '', err = '';
    const code = await shell.execute(cmd, s => { out += s; }, s => { err += s; });
    return { code, out: out.replace(/\r\n/g, '\n'), err };
  };

  it('prints the log with timestamps, and -t/-r/-x/-T/-l/-k/-u', async () => {
    klog.log(LOG_WARNING, 'dmesg-test: warn line');
    klog.log(LOG_INFO, 'dmesg-test: info line', LOG_USER);
    const plain = await run('dmesg');
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/^\[ *\d+\.\d{6}\] dmesg-test: warn line$/m);
    expect((await run('dmesg -t')).out).toMatch(/^dmesg-test: warn line$/m);
    expect((await run('dmesg -r')).out).toMatch(/^<4>\[ *\d+\.\d{6}\] dmesg-test: warn line$/m);
    expect((await run('dmesg -r')).out).toMatch(/^<14>\[ *\d+\.\d{6}\] dmesg-test: info line$/m);
    expect((await run('dmesg -x')).out).toMatch(/^kern  :warn  : \[ *\d+\.\d{6}\] dmesg-test: warn line$/m);
    expect((await run('dmesg -T')).out).toMatch(/^\[(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}\] dmesg-test: warn line$/m);
    const warnOnly = (await run('dmesg -l warn')).out;
    expect(warnOnly).toContain('dmesg-test: warn line');
    expect(warnOnly).not.toContain('dmesg-test: info line');
    expect((await run('dmesg --level=info,err')).out).toContain('dmesg-test: info line');
    expect((await run('dmesg -k')).out).not.toContain('dmesg-test: info line');
    expect((await run('dmesg -u')).out).toContain('dmesg-test: info line');
    expect((await run('dmesg -u')).out).not.toContain('dmesg-test: warn line');
    expect((await run('dmesg -l nope')).code).toBe(1);
    expect((await run('dmesg --bogus')).code).toBe(1);
    expect((await run('dmesg -h')).out).toContain('--follow');
  });

  it('-C needs root; -c reads then clears', async () => {
    klog.log(LOG_WARNING, 'dmesg-test: before clear');
    const denied = await run('dmesg -C');
    expect(denied.code).toBe(1);
    expect(denied.err).toContain('Operation not permitted');
    (shell as { uid?: number }).uid = 0;
    const rc = await run('dmesg -c');
    expect(rc.out).toContain('dmesg-test: before clear');
    expect((await run('dmesg')).out).toBe('');
    klog.log(LOG_INFO, 'dmesg-test: after clear');
    expect((await run('dmesg')).out).toMatch(/after clear/);
    expect((await run('dmesg -C')).code).toBe(0);
    expect((await run('dmesg')).out).toBe('');
  });
});
