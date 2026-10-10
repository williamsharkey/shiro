/**
 * process.stdin on a terminal with a pty session (terminal.ts, a desktop
 * window, the tests' stand-ins): node reads the pty slave as the foreground
 * job, so the line discipline does what it does for any program. In cooked
 * mode it echoes and edits the line and sends it on Enter, ^D is the end, and
 * ^C/^\ are SIGINT/SIGQUIT to node. setRawMode switches the pty's termios as
 * libuv does (keys one by one, no echo, no signals). The terminal sends keys
 * to the pty only while a job has it, which is why node takes the foreground.
 */
import type { TtySession, Termios } from '../kernel/pty';
import { cloneTermios, ECHO, ICANON, IEXTEN, ISIG, BRKINT, ICRNL, INPCK, ISTRIP, IXON, ONLCR, VMIN, VTIME } from '../kernel/pty';
import { SIGINT, SIGQUIT, SIGTSTP, SIGTTIN, SIGTTOU, SIG_IGN } from '../kernel/signals';
import type { SignalTarget } from '../kernel/signals';

// The page's timers: node-compat swaps the globals while a script runs (and counts its timers as activity)
const pageSetInterval = globalThis.setInterval.bind(globalThis);
const pageClearInterval = globalThis.clearInterval.bind(globalThis);

/** The pty session behind a terminal, if it has one */
export function ttySessionOf(terminal: unknown): TtySession | undefined {
  const tty = (terminal as { tty?: TtySession } | undefined)?.tty;
  return tty && typeof tty.createJobProcess === 'function' && tty.pty ? tty : undefined;
}

/** uv_tty_set_mode(UV_TTY_MODE_RAW): like cfmakeraw, but output keeps ONLCR */
function uvRaw(t: Termios): Termios {
  const r = cloneTermios(t);
  r.iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
  r.oflag |= ONLCR;
  r.lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
  r.cc[VMIN] = 1;
  r.cc[VTIME] = 0;
  return r;
}

export class TtyStdin {
  private job: (SignalTarget & { finish(code: number): void }) | null = null;
  private slave: ReturnType<TtySession['openSlave']> | null = null;
  private stop: AbortController | null = null;
  private cooked: Termios | null = null;
  private keeper: ReturnType<typeof setInterval> | null = null;
  private raw = false;
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly session: TtySession,
    private readonly on: {
      data: (text: string) => void;
      /** ^D on an empty line (cooked) */
      end: () => void;
      signal: (sig: number) => void;
    },
  ) {}

  get reading(): boolean { return !!this.stop; }

  /** Take the terminal and read it until `pause` */
  start(): void {
    if (this.stop) return;
    const { session } = this;
    if (!this.job) {
      // (a stand-in process: node's signals come here, and ^Z can't stop a page script)
      this.job = session.createJobProcess({ onTerminate: (sig) => this.on.signal(sig) });
      for (const sig of [SIGTSTP, SIGTTIN, SIGTTOU]) this.job.signals.handle(sig, SIG_IGN);
      for (const sig of [SIGINT, SIGQUIT]) this.job.signals.handle(sig, (s) => this.on.signal(s));
      this.cooked = cloneTermios(session.pty.termios);
    }
    this.slave ??= session.openSlave();
    this.stop = new AbortController();
    this.applyMode();
    this.takeTerminal();
    // A kernel job node started (child_process on the tty) hands the terminal
    // back to the shell when it ends, not to node: take it again
    this.keeper = pageSetInterval(() => this.takeTerminal(), 200);
    void this.loop(this.stop.signal);
  }

  /** Stop reading and give the terminal back to the shell (in its own modes) */
  pause(): void {
    if (!this.stop) return;
    this.stop.abort();
    this.stop = null;
    if (this.keeper) pageClearInterval(this.keeper);
    this.keeper = null;
    const { pty, leader } = this.session;
    if (this.job && pty.fgPgrp === this.job.pgid) pty.setForeground(leader.pgid);
    if (this.cooked) pty.setTermios(this.cooked);
  }

  /** setRawMode */
  setRaw(on: boolean): void {
    this.raw = on;
    if (this.stop) this.applyMode();
  }

  /** The script is over: stop, and the stand-in process exits */
  close(): void {
    this.pause();
    void this.slave?.close();
    this.slave = null;
    this.job?.finish(0);
    this.job = null;
  }

  private applyMode(): void {
    if (this.cooked) this.session.pty.setTermios(this.raw ? uvRaw(this.cooked) : this.cooked);
  }

  private takeTerminal(): void {
    const { pty, leader } = this.session;
    if (this.job && (pty.fgPgrp === leader.pgid || !pty.fgPgrp)) {
      pty.setForeground(this.job.pgid);
      this.session.onJobForeground?.();
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const buf = new Uint8Array(4096);
    while (!signal.aborted && this.slave) {
      const n = await this.slave.read(buf, signal);
      if (signal.aborted) return;
      if (n > 0) {
        this.on.data(this.decoder.decode(buf.subarray(0, n), { stream: true }));
      } else if (n === 0) {
        // EOF: ^D on an empty line (or a hangup)
        this.pause();
        this.on.end();
        return;
      } else if (n !== -4) { // other than EINTR (a signal): the tty is gone
        this.pause();
        this.on.end();
        return;
      }
    }
  }
}
