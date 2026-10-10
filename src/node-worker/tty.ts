/**
 * process.stdin on a terminal for node as a kernel guest: the guest is the
 * process on the pty, so it reads fd 0 and the kernel's line discipline does
 * the rest (cooked: echo, editing, Enter sends the line, ^D is the end).
 * setRawMode sets the pty's termios as libuv does; ^C and ^\ are SIGINT and
 * SIGQUIT to this process, caught here and handed to node's listeners (or,
 * without one, the script ends 128+signal, as node does). The same surface
 * as node-compat's TtyStdin, which does this for node in the page.
 */
import * as A from '../kernel/abi';
import type { GuestSys } from '../kernel/channel';
import { decodeTermios, encodeTermios, TCSETS, TERMIOS_SIZE } from '../kernel/pty';
import { uvRaw } from '../node-compat/tty-stdin';

// Timers the script's own don't count (node-compat swaps the globals while a script runs)
const baseSetTimeout = globalThis.setTimeout.bind(globalThis);
const baseClearTimeout = globalThis.clearTimeout.bind(globalThis);

export interface TtyStdinEvents {
  data: (text: string) => void;
  end: () => void;
  signal: (sig: number) => void;
}

export class GuestTtyStdin {
  private polling = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cooked: Uint8Array | null = null;
  private raw = false;
  private idle = 0;
  private signalsCaught = false;
  private readonly decoder = new TextDecoder();
  private readonly buf = new Uint8Array(4096);

  constructor(private readonly sys: GuestSys, private readonly on: TtyStdinEvents) {}

  /** A handler's process.exit() is how the script ends, not an error (the page's reader lets it reject) */
  private call(fn: () => void): void {
    try { fn(); } catch (e) { if (!(e as { _isProcessExit?: boolean })?._isProcessExit) throw e; }
  }

  get reading(): boolean { return this.polling; }

  start(): void {
    if (this.polling) return;
    this.polling = true;
    this.catchSignals();
    this.applyMode();
    this.idle = 0;
    this.schedule(0);
  }

  pause(): void {
    if (!this.polling) return;
    this.polling = false;
    if (this.timer) baseClearTimeout(this.timer);
    this.timer = null;
    if (this.cooked) this.setTermios(this.cooked);
  }

  setRaw(on: boolean): void {
    this.raw = on;
    if (this.polling) this.applyMode();
  }

  close(): void { this.pause(); }

  /** SIGINT/SIGQUIT come to node, not the kernel's default (killing the process) */
  private catchSignals(): void {
    if (this.signalsCaught) return;
    this.signalsCaught = true;
    const prev = this.sys.ch.onSignal;
    this.sys.ch.onSignal = (sig) => {
      if (sig === A.SIGINT || sig === A.SIGQUIT) baseSetTimeout(() => this.call(() => this.on.signal(sig)), 0);
      else prev?.(sig);
    };
    for (const sig of [A.SIGINT, A.SIGQUIT]) this.sys.sigaction(sig, { handler: 2 }); // any number but SIG_DFL/SIG_IGN
  }

  private setTermios(t: Uint8Array): void {
    this.sys.ch.data.set(t);
    this.sys.ch.call(A.SYS_ioctl, 0, TCSETS, t.length);
  }

  private applyMode(): void {
    if (!this.cooked) {
      const t = new Uint8Array(TERMIOS_SIZE);
      this.sys.ch.data.fill(0, 0, TERMIOS_SIZE);
      if (this.sys.ch.call(A.SYS_ioctl, 0, A.TCGETS, TERMIOS_SIZE) < 0) return;
      t.set(this.sys.ch.data.subarray(0, TERMIOS_SIZE));
      this.cooked = t;
    }
    this.setTermios(this.raw ? encodeTermios(uvRaw(decodeTermios(this.cooked))) : this.cooked);
  }

  private schedule(ms: number): void {
    this.timer = baseSetTimeout(() => this.tick(), ms);
  }

  private tick(): void {
    this.timer = null;
    if (!this.polling) return;
    const { ready, revents } = this.sys.poll([{ fd: 0, events: A.POLLIN }], 0);
    if (ready > 0 && revents[0]) {
      const n = this.sys.read(0, this.buf);
      if (n > 0) {
        this.idle = 0;
        const text = this.decoder.decode(this.buf.subarray(0, n), { stream: true });
        this.call(() => this.on.data(text));
      } else if (n === 0 || (n !== -A.EAGAIN && n !== -A.EINTR)) {
        // ^D on an empty line, or the terminal is gone
        this.pause();
        this.call(() => this.on.end());
        return;
      }
    } else this.idle = Math.min(16, this.idle + 1);
    if (this.polling) this.schedule(this.idle);
  }
}
