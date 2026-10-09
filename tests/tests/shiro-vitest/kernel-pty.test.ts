import { describe, it, expect, beforeEach } from 'vitest';
import {
  Pty, TtySession, openpty, makeRaw, cloneTermios, decodeTermios, encodeTermios, decodeWinsize,
  O_NONBLOCK, ICANON, ECHO, TOSTOP, VMIN, VTIME, TERMIOS_SIZE,
  TCGETS, TCSETS, TIOCGWINSZ, TIOCSWINSZ, FIONREAD, TIOCGPGRP, TIOCSPGRP, TIOCSCTTY, POLLIN, TIOCPKT, TIOCGPKT,
  type PtyFile,
} from '@shiro/kernel/pty';
import {
  JobControl, jobControl, createSignalTarget, SignalState, signalNumber, signalName, sigset, brokenPipe,
  SIGINT, SIGTSTP, SIGTTIN, SIGTTOU, SIGWINCH, SIGCHLD, SIGCONT, SIGSTOP, SIGTERM, SIGHUP, SIGUSR1, SIGPIPE,
  SIG_IGN, SIG_BLOCK, SIG_UNBLOCK, SA_NOCLDSTOP, WIFSTOPPED, WSTOPSIG, WTERMSIG, WIFSIGNALED, WEXITSTATUS, shellStatus,
} from '@shiro/kernel/signals';
import { runKernelJob, jobsCmd, fgCmd, bgCmd, waitCmd } from '@shiro/commands/jobs';
import { Kernel } from '@shiro/kernel/kernel';
import { attachKernelTty } from '@shiro/kernel/pty';
import * as A from '@shiro/kernel/abi';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';

const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Collect everything the pty sends to the terminal side */
function capture(pty: Pty): { text: () => string } {
  let out = '';
  pty.onOutput((b) => { out += dec.decode(b); });
  return { text: () => out };
}

async function readStr(f: PtyFile, caller?: any, size = 256): Promise<string | number> {
  const buf = new Uint8Array(size);
  const n = await f.read(buf, caller);
  return n < 0 ? n : dec.decode(buf.subarray(0, n));
}

describe('kernel pty: line discipline', () => {
  let pty: Pty;
  let slave: PtyFile;
  let out: { text: () => string };
  beforeEach(() => {
    ({ pty, slave } = openpty({ jc: new JobControl() }));
    out = capture(pty);
  });

  it('canonical mode delivers whole lines and echoes with ONLCR', async () => {
    const r = readStr(slave);
    pty.input('ab');
    await tick();
    expect(slave.poll(POLLIN)).toBe(0); // no complete line yet
    pty.input('\x7fc\r');
    expect(await r).toBe('ac\n');
    expect(out.text()).toBe('ab\b \bc\r\n');
  });

  it('VKILL, VWERASE, VLNEXT and VEOF edit the line', async () => {
    pty.input('abc\x15xy\n');
    expect(await readStr(slave)).toBe('xy\n');
    pty.input('foo bar\x17baz\n');
    expect(await readStr(slave)).toBe('foo baz\n');
    pty.input('\x16\x03\n'); // ^V makes ^C literal
    expect(await readStr(slave)).toBe('\x03\n');
    pty.input('ab\x04');
    expect(await readStr(slave)).toBe('ab');
    pty.input('\x04'); // EOF on an empty line: read returns 0
    expect(await readStr(slave)).toBe('');
  });

  it('partial reads leave the rest of the line queued', async () => {
    pty.input('hello\n');
    expect(await readStr(slave, undefined, 3)).toBe('hel');
    expect(await readStr(slave)).toBe('lo\n');
  });

  it('-echo suppresses echo', async () => {
    const t = cloneTermios(pty.termios);
    t.lflag &= ~ECHO;
    pty.setTermios(t);
    pty.input('secret\n');
    expect(await readStr(slave)).toBe('secret\n');
    expect(out.text()).toBe('');
  });

  it('raw mode passes bytes through without echo or signals', async () => {
    pty.setTermios(makeRaw(pty.termios));
    pty.input('a\x03\r');
    expect(await readStr(slave)).toBe('a\x03\r');
    expect(out.text()).toBe('');
    // output processing is off too
    await slave.write(enc.encode('x\n'));
    expect(out.text()).toBe('x\n');
  });

  it('VMIN/VTIME: MIN=0 TIME=1 times out, MIN=3 waits for three bytes', async () => {
    const t = makeRaw(pty.termios);
    t.cc[VMIN] = 0;
    t.cc[VTIME] = 1;
    pty.setTermios(t);
    const start = Date.now();
    expect(await readStr(slave)).toBe('');
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);

    t.cc[VMIN] = 3;
    t.cc[VTIME] = 0;
    pty.setTermios(t);
    let done = false;
    const r = readStr(slave).then((v) => { done = true; return v; });
    pty.input('ab');
    await tick(20);
    expect(done).toBe(false);
    pty.input('c');
    expect(await r).toBe('abc');
  });

  it('O_NONBLOCK reads return -EAGAIN', async () => {
    slave.flags |= O_NONBLOCK;
    expect(await readStr(slave)).toBe(-11);
  });

  it('switching to raw mode makes pending canonical input readable', async () => {
    pty.input('par');
    pty.setTermios(makeRaw(pty.termios));
    expect(await readStr(slave)).toBe('par');
  });

  it('master read returns slave output when no listener is attached', async () => {
    const { pty: p2, master, slave: s2 } = openpty({ jc: new JobControl() });
    await s2.write(enc.encode('hi\n'));
    expect(await readStr(master)).toBe('hi\r\n');
    void p2;
  });

  it('hangup: slave reads see EOF and writes fail with EIO', async () => {
    await pty.master.close();
    expect(await readStr(slave)).toBe('');
    expect(await slave.write(enc.encode('x'))).toBe(-5);
  });
});

describe('kernel pty: ioctls', () => {
  it('TCGETS/TCSETS, TIOCGWINSZ/TIOCSWINSZ, FIONREAD', async () => {
    const { pty, slave } = openpty({ jc: new JobControl(), winsize: { rows: 30, cols: 100 } });
    const tbuf = new Uint8Array(TERMIOS_SIZE);
    expect(await slave.ioctl(TCGETS, tbuf)).toBe(0);
    const t = decodeTermios(tbuf);
    expect(t.lflag & ICANON).toBeTruthy();
    t.lflag &= ~(ICANON | ECHO);
    expect(await slave.ioctl(TCSETS, encodeTermios(t))).toBe(0);
    expect(pty.termios.lflag & ICANON).toBe(0);

    const ws = new Uint8Array(8);
    expect(await slave.ioctl(TIOCGWINSZ, ws)).toBe(0);
    expect(decodeWinsize(ws)).toMatchObject({ rows: 30, cols: 100 });
    new DataView(ws.buffer).setUint16(0, 50, true);
    expect(await slave.ioctl(TIOCSWINSZ, ws)).toBe(0);
    expect(pty.winsize.rows).toBe(50);

    pty.input('xyz');
    const n = new Uint8Array(4);
    expect(await slave.ioctl(FIONREAD, n)).toBe(0);
    expect(new DataView(n.buffer).getInt32(0, true)).toBe(3);
    expect(await slave.ioctl(0x1234, n)).toBe(-25); // ENOTTY
  });

  it('TIOCSCTTY needs a session leader; TIOCSPGRP/TIOCGPGRP move the foreground group', async () => {
    const jc = new JobControl();
    const { pty, slave } = openpty({ jc });
    const leader = createSignalTarget({ jc });
    const child = createSignalTarget({ jc, ppid: leader.pid, pgid: leader.pid, sid: leader.sid });
    expect(await slave.ioctl(TIOCSCTTY, new Uint8Array(4), child)).toBe(-1); // EPERM: not a leader
    expect(await slave.ioctl(TIOCSCTTY, new Uint8Array(4), leader)).toBe(0);
    expect(pty.sid).toBe(leader.sid);
    leader.signals.handle(SIGTTOU, SIG_IGN); // like a job-control shell

    const job = createSignalTarget({ jc, ppid: leader.pid, sid: leader.sid });
    const arg = new Uint8Array(4);
    new DataView(arg.buffer).setInt32(0, job.pgid, true);
    expect(await slave.ioctl(TIOCSPGRP, arg, leader)).toBe(0);
    const got = new Uint8Array(4);
    expect(await slave.ioctl(TIOCGPGRP, got, leader)).toBe(0);
    expect(new DataView(got.buffer).getInt32(0, true)).toBe(job.pgid);
    new DataView(arg.buffer).setInt32(0, 424242, true);
    expect(await slave.ioctl(TIOCSPGRP, arg, leader)).toBe(-3); // no such group
  });
});

describe('kernel pty: packet mode and the controlling tty (screen)', () => {
  it('TIOCPKT: master reads start with a TIOCPKT_DATA byte', async () => {
    const { master, slave } = openpty({ jc: new JobControl() });
    const on = new Uint8Array(4);
    new DataView(on.buffer).setInt32(0, 1, true);
    expect(await slave.ioctl(TIOCPKT, on)).toBe(-25); // master only
    expect(await master.ioctl(TIOCPKT, on)).toBe(0);
    const got = new Uint8Array(4);
    expect(await master.ioctl(TIOCGPKT, got)).toBe(0);
    expect(new DataView(got.buffer).getInt32(0, true)).toBe(1);
    await slave.write(enc.encode('ab'));
    const buf = new Uint8Array(16);
    expect(await master.read(buf)).toBe(3);
    expect([...buf.subarray(0, 3)]).toEqual([0, 0x61, 0x62]);
    expect(await master.ioctl(TIOCPKT, new Uint8Array(4))).toBe(0);
    await slave.write(enc.encode('c'));
    expect(await readStr(master)).toBe('c');
  });

  it("stat of /dev/pts/N doesn't make it the caller's controlling tty, nor keep a slave open", async () => {
    const { fs, shell } = await createTestShell();
    const kernel = new Kernel({ fs, shell, registerWithProcessTable: false });
    attachKernelTty(kernel);
    const leader = kernel.spawn({ path: 'srv', fds: {}, setsid: true, run: () => new Promise<number>(() => {}) } as any);
    const { pty } = openpty({ jc: jobControl });
    const slaves = (pty as any).slaveCount;
    const st = await kernel.statPath(leader, pty.name);
    expect(typeof st !== 'number' && (st.mode & A.S_IFMT)).toBe(A.S_IFCHR);
    expect(pty.sid).toBe(0);
    expect((pty as any).slaveCount).toBe(slaves);
    // ... while opening it (without O_NOCTTY) as a session leader does
    const f = await kernel.open(leader, pty.name, A.O_RDWR);
    expect(typeof f).not.toBe('number');
    expect(pty.sid).toBe(leader.sid);
    kernel.kill(leader.pid, A.SIGKILL);
  });
});

describe('kernel signals', () => {
  it('parses names and numbers like kill(1)', () => {
    expect(signalNumber('INT')).toBe(SIGINT);
    expect(signalNumber('sigterm')).toBe(SIGTERM);
    expect(signalNumber('9')).toBe(9);
    expect(signalNumber('RTMIN+1')).toBe(35);
    expect(signalNumber('BOGUS')).toBeUndefined();
    expect(signalName(SIGTSTP)).toBe('TSTP');
  });

  it('blocked signals stay pending until unblocked; SIGKILL/SIGSTOP cannot be caught', async () => {
    const jc = new JobControl();
    const p = createSignalTarget({ jc });
    const got: number[] = [];
    p.signals.handle(SIGUSR1, (s) => got.push(s));
    p.signals.sigprocmask(SIG_BLOCK, sigset.of(SIGUSR1));
    jc.kill(p.pid, SIGUSR1);
    await tick();
    expect(got).toEqual([]);
    expect(sigset.has(p.signals.pending, SIGUSR1)).toBe(true);
    p.signals.sigprocmask(SIG_UNBLOCK, sigset.of(SIGUSR1));
    jc.flushPending(p);
    await tick();
    expect(got).toEqual([SIGUSR1]);
    expect(p.signals.handle(9, SIG_IGN)).toBe(-22);
    expect(p.signals.handle(SIGSTOP, SIG_IGN)).toBe(-22);
  });

  it('stop/continue/exit report SIGCHLD to the parent (honouring SA_NOCLDSTOP)', async () => {
    const jc = new JobControl();
    const parent = createSignalTarget({ jc });
    const child = createSignalTarget({ jc, ppid: parent.pid, sid: parent.sid });
    let chld = 0;
    parent.signals.handle(SIGCHLD, () => chld++);
    jc.kill(child.pid, SIGSTOP);
    expect(child.runState).toBe('stopped');
    expect(WIFSTOPPED(jc.status(child.pid)!)).toBe(true);
    jc.kill(child.pid, SIGCONT);
    expect(child.runState).toBe('running');
    await tick();
    expect(chld).toBe(2);
    parent.signals.setAction(SIGCHLD, { handler: () => chld++, flags: SA_NOCLDSTOP, mask: 0n });
    jc.kill(child.pid, SIGSTOP);
    jc.kill(child.pid, SIGTERM); // fatal signals kill stopped processes too
    await tick();
    expect(chld).toBe(3);
    expect(WTERMSIG(jc.status(child.pid)!)).toBe(SIGTERM);
  });

  it('fork inherits dispositions without pending; exec resets caught handlers', () => {
    const st = new SignalState();
    st.handle(SIGINT, SIG_IGN);
    st.handle(SIGUSR1, 0x1234);
    st.pending = sigset.of(SIGUSR1);
    const child = st.fork();
    expect(child.pending).toBe(0n);
    child.exec();
    expect(child.isIgnored(SIGINT)).toBe(true);
    expect(child.isCaught(SIGUSR1)).toBe(false);
  });

  it('guest handlers set the pending flag; brokenPipe raises SIGPIPE', () => {
    const jc = new JobControl();
    let flagged = 0;
    const p = createSignalTarget({ jc });
    p.notifyPending = () => flagged++;
    p.signals.handle(SIGPIPE, 0x4000);
    expect(brokenPipe(p, jc)).toBe(-32);
    expect(flagged).toBe(1);
    expect(p.signals.dequeue()).toBe(SIGPIPE);
    const q = createSignalTarget({ jc });
    brokenPipe(q, jc);
    expect(WTERMSIG(jc.status(q.pid)!)).toBe(SIGPIPE);
  });

  it('wait-status helpers', () => {
    expect(shellStatus(2)).toBe(130);
    expect(WIFSIGNALED(9)).toBe(true);
    expect(WEXITSTATUS(3 << 8)).toBe(3);
    expect(WSTOPSIG((20 << 8) | 0x7f)).toBe(20);
  });
});

describe('kernel pty: job control', () => {
  let tty: TtySession;
  let jc: JobControl;
  beforeEach(() => {
    jc = new JobControl();
    tty = new TtySession({ jc });
    capture(tty.pty);
  });

  it('Ctrl-C sends SIGINT to the foreground process group', async () => {
    const p = tty.createJobProcess();
    const slave = tty.openSlave();
    const fg = tty.foreground({ pgid: p.pgid });
    const read = readStr(slave, p);
    tty.pty.input('half a line\x03');
    const r = await fg;
    expect(r.type).toBe('exited');
    expect(WTERMSIG((r as any).status)).toBe(SIGINT);
    expect(await read).toBe(-4); // EINTR: the reader died
    expect(tty.jobInForeground).toBe(false);
  });

  it('onJobForeground: keys typed while the job was starting reach its read', async () => {
    const p = tty.createJobProcess();
    const slave = tty.openSlave();
    const typedAhead = ['ls -l\r'];
    let calls = 0;
    // what the page's terminal does: queued keys go into the pty once the job has the tty
    tty.onJobForeground = () => { calls++; for (const d of typedAhead.splice(0)) tty.pty.input(d); };
    const fg = tty.foreground({ pgid: p.pgid });
    expect(calls).toBe(1);
    expect(tty.jobInForeground).toBe(true);
    expect(await readStr(slave, p)).toBe('ls -l\n');
    p.finish(0);
    await fg;
  });

  it('Ctrl-Z stops the job; fg (SIGCONT + foreground) resumes its read', async () => {
    const p = tty.createJobProcess();
    const slave = tty.openSlave();
    const job = { pgid: p.pgid };
    const f = tty.foreground(job);
    const read = readStr(slave, p);
    await tick();
    tty.pty.input('\x1a');
    const r1 = await f;
    expect(r1).toEqual({ type: 'stopped', sig: SIGTSTP });
    expect(p.runState).toBe('stopped');
    const r2 = tty.foreground(job, true);
    await tick();
    expect(p.runState).toBe('running');
    tty.pty.input('resumed\n');
    expect(await read).toBe('resumed\n');
    p.finish(0);
    expect(await r2).toEqual({ type: 'exited', status: 0 });
  });

  it('a stopped job keeps its raw mode; the shell gets its own modes back', async () => {
    const p = tty.createJobProcess();
    const job: any = { pgid: p.pgid };
    const f = tty.foreground(job);
    tty.pty.setTermios(makeRaw(tty.pty.termios)); // the job goes raw (like vim)
    tty.pty.input('\x1a'); // raw mode: no ISIG, so stop it with a signal
    jc.kill(-p.pgid, SIGTSTP);
    await f;
    expect(tty.pty.termios.lflag & ICANON).toBeTruthy();
    expect(job.termios.lflag & ICANON).toBe(0);
    const f2 = tty.foreground(job, true);
    expect(tty.pty.termios.lflag & ICANON).toBe(0);
    p.finish(0);
    await f2;
  });

  it('resizing sends SIGWINCH to the foreground job', async () => {
    const p = tty.createJobProcess();
    const got: number[] = [];
    p.signals.handle(SIGWINCH, (s) => got.push(s));
    const f = tty.foreground({ pgid: p.pgid });
    tty.resize(40, 120);
    await tick();
    expect(got).toEqual([SIGWINCH]);
    const ws = new Uint8Array(8);
    await tty.openSlave().ioctl(TIOCGWINSZ, ws, p);
    expect(decodeWinsize(ws)).toMatchObject({ rows: 40, cols: 120 });
    p.finish(0);
    await f;
  });

  it('a background read stops the job with SIGTTIN; it reads after fg', async () => {
    const p = tty.createJobProcess();
    const slave = tty.openSlave();
    const read = readStr(slave, p);
    const r = await jc.waitJob(p.pgid);
    expect(r).toEqual({ type: 'stopped', sig: SIGTTIN });
    const f = tty.foreground({ pgid: p.pgid }, true);
    tty.pty.input('now\n');
    expect(await read).toBe('now\n');
    p.finish(0);
    await f;
  });

  it('background read with SIGTTIN ignored, or from an orphaned group, fails with EIO', async () => {
    const p = tty.createJobProcess();
    p.signals.handle(SIGTTIN, SIG_IGN);
    expect(await readStr(tty.openSlave(), p)).toBe(-5);
    const orphan = createSignalTarget({ jc, ppid: 0, sid: tty.leader.sid });
    expect(await readStr(tty.openSlave(), orphan)).toBe(-5);
  });

  it('TOSTOP: a background write stops the job with SIGTTOU', async () => {
    const t = cloneTermios(tty.pty.termios);
    t.lflag |= TOSTOP;
    tty.pty.setTermios(t);
    const p = tty.createJobProcess();
    const w = tty.openSlave().write(enc.encode('bg output\n'), p);
    expect(await jc.waitJob(p.pgid)).toEqual({ type: 'stopped', sig: SIGTTOU });
    const f = tty.foreground({ pgid: p.pgid }, true);
    expect(await w).toBe(10);
    p.finish(0);
    await f;
  });

  it('hangup sends SIGHUP to the foreground group', async () => {
    const p = tty.createJobProcess();
    const f = tty.foreground({ pgid: p.pgid });
    await tty.pty.master.close();
    const r = await f;
    expect(WTERMSIG((r as any).status)).toBe(SIGHUP);
  });
});

/** A terminal stand-in carrying a TtySession for shell-level tests */
function fakeTerminal(tty: TtySession) {
  let out = '';
  return {
    tty,
    output: () => out,
    writeOutput: (s: string) => { out += s; },
    enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {},
    isRawMode: () => false, onResize: () => () => {},
    getSize: () => ({ rows: tty.pty.winsize.rows, cols: tty.pty.winsize.cols }),
    term: null,
  };
}

describe('shell job control for kernel jobs', () => {
  let shell: Shell;
  let tty: TtySession;
  let term: ReturnType<typeof fakeTerminal>;
  const sh = async (cmd: string) => {
    let output = '';
    const exitCode = await shell.execute(cmd, (s) => { output += s; }, (s) => { output += s; }, false, term);
    return { output: output.replace(/\r\n/g, '\n'), exitCode };
  };

  beforeEach(async () => {
    ({ shell } = await createTestShell());
    for (const c of [jobsCmd, fgCmd, bgCmd, waitCmd]) shell.commands.register(c);
    tty = new TtySession(); // the shared jobControl, as the shell's builtins use
    capture(tty.pty);
    term = fakeTerminal(tty);
  });

  /** A kernel "cat" that echoes one line from the tty, then exits */
  function startCat() {
    const p = tty.createJobProcess();
    const slave = tty.openSlave();
    const done = (async () => {
      await tick(); // the shell hands it the terminal first
      const line = await readStr(slave, p);
      if (typeof line === 'string') await slave.write(enc.encode(`got ${line}`), p);
      if (p.runState !== 'zombie') p.finish(0);
    })();
    return { p, done };
  }

  it('Ctrl-Z → jobs shows Stopped → bg → SIGTTIN → fg → finishes', async () => {
    const { p, done } = startCat();
    let printed = '';
    const run = runKernelJob(shell, { command: 'cat', pgid: p.pgid, tty, write: (s) => { printed += s; } });
    await tick();
    expect(tty.jobInForeground).toBe(true);
    tty.pty.input('\x1a');
    expect(await run).toBe(128 + SIGTSTP);
    expect(printed).toMatch(/\[1\]\+\s+Stopped\s+cat/);

    expect((await sh('jobs')).output).toMatch(/\[1\]\+\s+Stopped\s+cat/);

    // bg: continues in the background, where reading the tty stops it again
    expect((await sh('bg')).output).toContain('[1]+ cat &');
    await jc().waitJob(p.pgid);
    expect(p.runState).toBe('stopped');
    expect(shell.backgroundJobs.get(1)!.status).toBe('stopped');

    const fg = sh('fg %1');
    await tick();
    expect(tty.jobInForeground).toBe(true);
    tty.pty.input('hello\n');
    expect((await fg).exitCode).toBe(0);
    await done;
    expect(term.output()).toContain('cat');
    expect(shell.backgroundJobs.size).toBe(0);
  });

  it('Ctrl-C kills the foreground job (status 130)', async () => {
    const { p } = startCat();
    const run = runKernelJob(shell, { command: 'cat', pgid: p.pgid, tty });
    await tick();
    tty.pty.input('\x03');
    expect(await run).toBe(130);
    expect(p.runState).toBe('zombie');
  });

  it('kill %N signals the job and wait reports its status', async () => {
    const { p } = startCat();
    await runKernelJob(shell, { command: 'cat', pgid: p.pgid, tty, background: true });
    const w = sh('wait %1');
    expect((await sh('kill -TERM %1')).exitCode).toBe(0);
    expect((await w).exitCode).toBe(128 + SIGTERM);
  });

  it('kill: -l, -STOP/-CONT by pid, process groups, errors', async () => {
    expect((await sh('kill -l')).output).toContain('HUP INT QUIT');
    expect((await sh('kill -l 130')).output).toBe('INT\n');
    expect((await sh('kill -l TERM')).output).toBe('15\n');
    const p = tty.createJobProcess();
    expect((await sh(`kill -s STOP ${p.pid}`)).exitCode).toBe(0);
    expect(p.runState).toBe('stopped');
    expect((await sh(`kill -CONT ${p.pid}`)).exitCode).toBe(0);
    expect(p.runState).toBe('running');
    expect((await sh(`kill -9 -- -${p.pgid}`)).exitCode).toBe(0);
    expect(WTERMSIG(jobControl.status(p.pid)!)).toBe(9);
    const bad = await sh('kill 987654');
    expect(bad.exitCode).toBe(1);
    expect(bad.output).toContain('No such process');
    expect((await sh('kill -BOGUS 1')).output).toContain('invalid signal specification');
  });

  it('stty reads and changes the terminal pty', async () => {
    expect((await sh('stty -echo -icanon min 0 time 5')).exitCode).toBe(0);
    expect(tty.pty.termios.lflag & (ECHO | ICANON)).toBe(0);
    expect(tty.pty.termios.cc[VMIN]).toBe(0);
    expect(tty.pty.termios.cc[VTIME]).toBe(5);
    const changed = (await sh('stty')).output;
    expect(changed).toContain('-icanon');
    expect(changed).toContain('-echo');
    const saved = (await sh('stty -g')).output.trim();
    await sh('stty sane');
    expect(tty.pty.termios.lflag & ICANON).toBeTruthy();
    await sh(`stty ${saved}`);
    expect(tty.pty.termios.lflag & ICANON).toBe(0);
    await sh('stty raw');
    expect((await sh('stty -a')).output).toMatch(/-isig -icanon/);
    await sh('stty cooked echo');
    expect(tty.pty.termios.lflag & (ICANON | ECHO)).toBe(ICANON | ECHO);
    await sh('stty intr ^X');
    expect(tty.pty.termios.cc[0]).toBe(0x18);
    expect((await sh('stty bogus')).exitCode).toBe(1);
  });

  it('stty rows/cols resize the pty (SIGWINCH) and tput follows', async () => {
    const p = tty.createJobProcess();
    const got: number[] = [];
    p.signals.handle(SIGWINCH, (s) => got.push(s));
    tty.pty.setForeground(p.pgid);
    await sh('stty rows 33 cols 99');
    await tick();
    expect(got).toEqual([SIGWINCH]);
    tty.pty.setForeground(tty.leader.pgid);
    expect((await sh('stty size')).output).toBe('33 99\n');
    expect((await sh('tput lines')).output).toBe('33\n');
    expect((await sh('tput cols')).output).toBe('99\n');
    expect((await sh('COLUMNS=50 tput cols')).output).toBe('50\n');
    p.finish(0);
  });

  it('a real kernel job: Ctrl-Z, jobs, fg', async () => {
    const kernel = new Kernel({ registerWithProcessTable: false });
    attachKernelTty(kernel); // the shared jobControl
    const proc = tty.spawnJob(kernel, {
      path: 'reader',
      run: async (p, k) => {
        const data = new Uint8Array(256);
        const n = await k.syscall(p, A.SYS_read, [0, 256], data);
        return n > 0 ? 0 : 1;
      },
    });
    const run = runKernelJob(shell, { command: 'reader', pgid: proc.pgid, pids: [proc.pid], tty });
    await tick();
    tty.pty.input('\x1a');
    expect(await run).toBe(128 + SIGTSTP);
    expect((await sh('jobs')).output).toMatch(/Stopped\s+reader/);
    const fg = sh('fg');
    await tick();
    tty.pty.input('data\n');
    expect((await fg).exitCode).toBe(0);
    expect(proc.state).toBe('zombie');
  });

  const jc = () => jobControl;
});

describe('kernel processes on a pty', () => {
  let kernel: Kernel;
  let jc: JobControl;
  let tty: TtySession;
  let screen: { text: () => string };
  beforeEach(() => {
    kernel = new Kernel({ registerWithProcessTable: false });
    jc = new JobControl();
    attachKernelTty(kernel, jc);
    tty = new TtySession({ jc });
    screen = capture(tty.pty);
  });

  /** A kernel program that reads lines from fd 0 through the syscall layer and echoes them to fd 1 */
  const echoLines = (n: number) => async (proc: any, k: Kernel) => {
    const data = new Uint8Array(1024);
    for (let i = 0; i < n; i++) {
      const r = await k.syscall(proc, A.SYS_read, [0, 512], data);
      if (r <= 0) return r === 0 ? 0 : 100 - r;
      data.copyWithin(0, 0, r);
      await k.syscall(proc, A.SYS_write, [1, r], data);
    }
    return 0;
  };

  it('jobs get the pty as stdio and controlling tty, in their own group under the session leader', async () => {
    const p = tty.spawnJob(kernel, { path: 'echo-lines', run: echoLines(1) });
    const f = tty.foreground({ pgid: p.pgid }); // before the program runs, like the shell does
    const leader = tty.leader;
    expect(p.ppid).toBe(leader.pid);
    expect(p.sid).toBe(leader.pid);
    expect(p.pgid).toBe(p.pid);
    expect(p.fds.get(0)?.kind).toBe('pty');
    const devTty = await kernel.open(p, '/dev/tty', A.O_RDWR);
    expect((devTty as any).kind).toBe('pty');
    await tick();
    tty.pty.input('line one\r');
    expect(await f).toEqual({ type: 'exited', status: 0 });
    expect(screen.text()).toBe('line one\r\nline one\r\n');
  });

  it('Ctrl-C kills a kernel job; Ctrl-Z stops it and fg resumes the blocked read', async () => {
    const a = tty.spawnJob(kernel, { path: 'a', run: echoLines(1) });
    const fa = tty.foreground({ pgid: a.pgid });
    await tick();
    tty.pty.input('\x03');
    const ra = await fa;
    expect(WTERMSIG((ra as any).status)).toBe(SIGINT);
    expect(a.state).toBe('zombie');

    const b = tty.spawnJob(kernel, { path: 'b', run: echoLines(1) });
    const job = { pgid: b.pgid };
    const fb = tty.foreground(job);
    await tick();
    tty.pty.input('\x1a');
    expect(await fb).toEqual({ type: 'stopped', sig: SIGTSTP });
    expect(b.state).toBe('stopped');
    // the parent can collect the stop with waitpid(WUNTRACED)
    const w = await kernel.waitpid(b.pid, A.WUNTRACED | A.WNOHANG, kernel.procs.get(tty.leader.pid)!);
    expect(WIFSTOPPED(w.status)).toBe(true);
    const fb2 = tty.foreground(job, true);
    await tick();
    expect(b.state).toBe('running');
    tty.pty.input('back\n');
    expect(await fb2).toEqual({ type: 'exited', status: 0 });
    expect(screen.text()).toContain('back\r\n');
  });

  it('a background kernel read gets SIGTTIN (caller found from its syscall signal)', async () => {
    const p = tty.spawnJob(kernel, { path: 'bg', run: echoLines(1) });
    expect(await jc.waitJob(p.pgid)).toEqual({ type: 'stopped', sig: SIGTTIN });
    expect(p.state).toBe('stopped');
    const f = tty.foreground({ pgid: p.pgid }, true);
    tty.pty.input('fg now\n');
    expect(await f).toEqual({ type: 'exited', status: 0 });
  });

  it('a guest-handled signal interrupts a blocked tty read with EINTR', async () => {
    let result = 0;
    const p = tty.spawnJob(kernel, {
      path: 'guest',
      run: async (proc, k) => {
        const data = new Uint8Array(64);
        result = await k.syscall(proc, A.SYS_read, [0, 64], data);
        return 0;
      },
    });
    p.dispositions.set(SIGUSR1, 0x1000); // a guest handler address
    const f = tty.foreground({ pgid: p.pgid });
    await tick();
    expect(kernel.kill(p.pid, SIGUSR1)).toBe(0);
    await f;
    expect(result).toBe(-A.EINTR);
    expect([...p.pendingSignals]).toContain(SIGUSR1);
  });

  it('kernel kill, SIGCHLD to the leader, and reaping', async () => {
    const p = tty.spawnJob(kernel, { path: 'sleeper', run: () => new Promise<number>(() => {}) });
    expect(jc.get(p.pid)).toBeDefined();
    jc.kill(p.pid, SIGTERM);
    await tick();
    expect(p.state).toBe('zombie');
    expect(WTERMSIG(p.exitStatus!)).toBe(SIGTERM);
    await tick(); // the leader's SIGCHLD handler reaps it
    await tick();
    expect(kernel.procs.has(p.pid)).toBe(false);
    expect(jc.get(p.pid)).toBeUndefined();
  });

  it('a background tcsetattr through the ioctl syscall gets SIGTTOU (the kernel passes the caller)', async () => {
    const p = tty.spawnJob(kernel, {
      path: 'bg-ioctl',
      run: async (proc, k) => {
        const data = new Uint8Array(64);
        await k.syscall(proc, A.SYS_ioctl, [0, TCGETS, TERMIOS_SIZE], data);
        return await k.syscall(proc, A.SYS_ioctl, [0, TCSETS, TERMIOS_SIZE], data) === 0 ? 0 : 1;
      },
    });
    expect(await jc.waitJob(p.pgid)).toEqual({ type: 'stopped', sig: SIGTTOU });
    const f = tty.foreground({ pgid: p.pgid }, true);
    expect(await f).toEqual({ type: 'exited', status: 0 });
  });

  it('TIOCSCTTY through the syscall layer uses the caller', async () => {
    const other = new TtySession({ jc });
    const p = kernel.spawn({ path: 'leader', setsid: true, fds: { 0: other.openSlave() }, run: () => new Promise<number>(() => {}) });
    other.pty.release(); // let the new session take it
    const data = new Uint8Array(4);
    expect(await kernel.syscall(p, A.SYS_ioctl, [0, TIOCSCTTY, 4], data)).toBe(0);
    expect(other.pty.sid).toBe(p.pid);
    jc.kill(p.pid, 9);
  });

  it('signals blocked with sigprocmask wait and arrive on unblock', async () => {
    const p = tty.spawnJob(kernel, { path: 'masked', run: () => new Promise<number>(() => {}) });
    kernel.setSigmask(p, new Set([SIGTERM]));
    jc.kill(p.pid, SIGTERM);
    await tick();
    expect(p.state).toBe('running');
    expect(p.deferredSignals.has(SIGTERM)).toBe(true);
    kernel.setSigmask(p, new Set());
    await tick();
    expect(p.state).toBe('zombie');
  });

  it('/dev/ptmx opens a new pty whose slave is /dev/pts/N', async () => {
    const p = kernel.spawn({ path: 'opener', fds: {}, run: () => new Promise<number>(() => {}) });
    const m = await kernel.open(p, '/dev/ptmx', A.O_RDWR) as PtyFile;
    expect(m.kind).toBe('pty');
    const n = new Uint8Array(4);
    expect(await m.ioctl(0x80045430, n)).toBe(0); // TIOCGPTN
    const idx = new DataView(n.buffer).getInt32(0, true);
    const s = await kernel.open(p, `/dev/pts/${idx}`, A.O_RDWR | A.O_NOCTTY) as PtyFile;
    await s.write(enc.encode('ping\n'));
    expect(await readStr(m)).toBe('ping\r\n');
    jc.kill(p.pid, 9);
  });
});
