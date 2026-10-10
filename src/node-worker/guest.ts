/**
 * node as a kernel guest (TABCOMPUTER_NODE_WORKER=1): this runs in a
 * Worker. It turns the kernel's start message into the CommandContext
 * node-compat expects (files through SyscallFs, children through real
 * processes, fds 0/1/2 for stdio and the terminal), runs the `node`
 * command with argv, writes what it printed and exits with its status.
 */
import * as A from '../kernel/abi';
import { connectGuest, isStartMessage, ChannelClosed, type GuestStartMessage, type GuestSys } from '../kernel/channel';
import { decodeTermios, encodeTermios, decodeWinsize, makeRaw, TCSETS, TERMIOS_SIZE, WINSIZE_SIZE } from '../kernel/pty';
import { SyscallFs } from './sys-fs';
import { runChild, runChildSync } from './child';
import type { NodeGuestHooks } from './hooks';

const dec = new TextDecoder();

/** ioctl(fd, req) with `arg` in and out of the data area; the result, or -errno */
function ioctl(sys: GuestSys, fd: number, req: number, arg: Uint8Array): number {
  sys.ch.data.set(arg);
  const r = sys.ch.call(A.SYS_ioctl, fd, req, arg.length);
  if (r >= 0) arg.set(sys.ch.data.subarray(0, arg.length));
  return r;
}

const isatty = (sys: GuestSys, fd: number) => ioctl(sys, fd, A.TCGETS, new Uint8Array(TERMIOS_SIZE)) >= 0;

/** node-compat's view of the terminal, over fds 0 and 1 and their pty */
function terminalFacade(sys: GuestSys, stdinTTY: boolean) {
  let saved: Uint8Array | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const buf = new Uint8Array(4096);
  return {
    tty: true,
    writeOutput: (s: string) => { sys.write(1, s); },
    getSize: () => {
      const w = new Uint8Array(WINSIZE_SIZE);
      if (ioctl(sys, 1, A.TIOCGWINSZ, w) < 0) return { cols: 80, rows: 24 };
      const ws = decodeWinsize(w);
      return { cols: ws.cols || 80, rows: ws.rows || 24 };
    },
    onResize: (_cb: (cols: number, rows: number) => void) => () => {},
    /** Raw keys from fd 0 to `onData` (polled: the worker can't block while the program's event loop runs) */
    enterStdinPassthrough: (onData: (d: string) => void, _onForceExit?: () => void) => {
      if (!stdinTTY || timer) return;
      const t = new Uint8Array(TERMIOS_SIZE);
      if (ioctl(sys, 0, A.TCGETS, t) >= 0) {
        saved = t.slice();
        ioctl(sys, 0, TCSETS, encodeTermios(makeRaw(decodeTermios(t))));
      }
      let idle = 0;
      const tick = () => {
        timer = null;
        const { ready } = sys.poll([{ fd: 0, events: A.POLLIN }], 0);
        if (ready > 0) {
          const n = sys.read(0, buf);
          if (n > 0) { idle = 0; onData(dec.decode(buf.subarray(0, n))); }
        } else idle = Math.min(16, idle + 1);
        timer = setTimeout(tick, idle);
      };
      timer = setTimeout(tick, 0);
    },
    exitStdinPassthrough: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (saved) { ioctl(sys, 0, TCSETS, saved); saved = null; }
    },
  };
}

/** Run node for one start message; exits the process (does not return normally). */
export async function runNodeGuest(start: GuestStartMessage, post: (m: unknown) => void): Promise<void> {
  const sys = connectGuest(start, post);
  try {
    const fs = new SyscallFs(sys);
    const stdinTTY = isatty(sys, 0);
    const stdoutTTY = isatty(sys, 1);
    const hooks: NodeGuestHooks = {
      readText(path) {
        const b = fs.readRaw(path);
        if (typeof b === 'number') return undefined;
        try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return undefined; }
      },
      // a child may change the tree: fs forgets the directories it knew
      runChildSync: (cmd, opts) => { try { return runChildSync(sys, cmd, opts); } finally { fs.invalidate(); } },
      runChild: (cmd, opts) => runChild(sys, cmd, opts).finally(() => fs.invalidate()),
    };
    const env = { ...start.env };
    const shell: any = { cwd: start.cwd, env, abortController: null, fork() { throw new Error('no shell in a node guest'); } };
    const ctx: any = {
      args: start.argv.slice(1),
      fs,
      cwd: start.cwd,
      env,
      stdin: '',
      stdout: '',
      stderr: '',
      shell,
      stdoutIsTTY: stdoutTTY,
      stdinIsTTY: stdinTTY,
      terminal: stdoutTTY ? terminalFacade(sys, stdinTTY) : undefined,
      nodeGuest: hooks,
    };
    // stdin: read when the program asks for it (a pipe until its end)
    if (!stdinTTY) {
      ctx.readStdin = async () => {
        const r = sys.readAll(0);
        return typeof r === 'number' ? '' : dec.decode(r);
      };
      // `node < script.js` / `cat x.js | node`: the program comes from stdin
      const code = start.argv.slice(1).some((a) => !a.startsWith('-') || a === '-e' || a === '--eval' || a === '-p' || a === '--print');
      if (!code) ctx.stdin = await ctx.readStdin();
    }
    const { runNode } = await import('../commands/jseval/node-run');
    let status: number;
    try {
      status = await runNode(ctx);
    } catch (e: any) {
      if (e instanceof ChannelClosed) throw e;
      ctx.stderr += `node: ${e?.stack ?? e}\n`;
      status = 1;
    }
    if (ctx.stdout) sys.write(1, ctx.stdout);
    if (ctx.stderr) sys.write(2, ctx.stderr);
    sys.exit(status);
  } catch (e) {
    if (e instanceof ChannelClosed) return; // killed: the kernel is done with us
    try { sys.write(2, `node: ${(e as any)?.stack ?? e}\n`); sys.exit(1); } catch { /* channel gone */ }
  }
}

/** The worker's message handler: the first start message runs node */
export function nodeGuestMain(on: (handler: (m: unknown) => void) => void, post: (m: unknown) => void): void {
  let started = false;
  on((m) => {
    if (started || !isStartMessage(m)) return;
    started = true;
    void runNodeGuest(m, post);
  });
}
