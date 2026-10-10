/**
 * Pseudo-terminals (unix/pty workstream): a master/slave OpenFile pair with
 * Linux termios, the n_tty line discipline (canonical editing, echo, ISIG,
 * VMIN/VTIME), output processing, window size, controlling tty, foreground
 * process group and SIGTTIN/SIGTTOU job control.
 *
 * The master side is the terminal emulator (xterm via `TtySession`); the slave
 * side is what processes get as fds 0/1/2. Byte-level and Linux-shaped: ioctl
 * arguments use the asm-generic `struct termios` (36 bytes) and `struct winsize`.
 *
 * Calls that need the caller's identity (job-control checks, TIOCSCTTY, ...)
 * take an optional trailing argument: a SignalTarget, or the AbortSignal the
 * kernel passes to read/write (job control maps it back to the process, and
 * its abort ends a blocked call with -EINTR).
 */
import {
  JobControl, jobControl, SignalTarget, createSignalTarget, attachKernel, WIFEXITED, SIG_IGN,
  SIGINT, SIGQUIT, SIGTSTP, SIGTTIN, SIGTTOU, SIGWINCH, SIGHUP, SIGCONT, SIGTERM, SIGCHLD,
} from './signals';
import {
  EPERM, ESRCH, EINTR, EIO, EAGAIN, EFAULT, EINVAL, ENOTTY, WNOHANG, S_IFCHR, type KStat,
  O_RDWR, O_NOCTTY, O_NONBLOCK, POLLIN, POLLOUT, POLLERR, POLLHUP,
} from './abi';
import { retain, type OpenFile } from './fd';
import type { Kernel, SpawnOptions } from './kernel';
import type { Process } from './process';
import { klog, LOG_INFO } from './klog';

export { O_RDWR, O_NOCTTY, O_NONBLOCK, POLLIN, POLLOUT, POLLERR, POLLHUP };

// ── termios (Linux asm-generic values) ──────────────────────────────────────
// c_iflag
export const IGNBRK = 0o1, BRKINT = 0o2, IGNPAR = 0o4, PARMRK = 0o10, INPCK = 0o20, ISTRIP = 0o40;
export const INLCR = 0o100, IGNCR = 0o200, ICRNL = 0o400, IUCLC = 0o1000, IXON = 0o2000, IXANY = 0o4000;
export const IXOFF = 0o10000, IMAXBEL = 0o20000, IUTF8 = 0o40000;
// c_oflag
export const OPOST = 0o1, OLCUC = 0o2, ONLCR = 0o4, OCRNL = 0o10, ONOCR = 0o20, ONLRET = 0o40, OFILL = 0o100, OFDEL = 0o200;
// c_cflag
export const CBAUD = 0o10017, B0 = 0, B9600 = 0o15, B19200 = 0o16, B38400 = 0o17;
export const CSIZE = 0o60, CS5 = 0, CS6 = 0o20, CS7 = 0o40, CS8 = 0o60;
export const CSTOPB = 0o100, CREAD = 0o200, PARENB = 0o400, PARODD = 0o1000, HUPCL = 0o2000, CLOCAL = 0o4000;
// c_lflag
export const ISIG = 0o1, ICANON = 0o2, XCASE = 0o4, ECHO = 0o10, ECHOE = 0o20, ECHOK = 0o40, ECHONL = 0o100;
export const NOFLSH = 0o200, TOSTOP = 0o400, ECHOCTL = 0o1000, ECHOPRT = 0o2000, ECHOKE = 0o4000;
export const FLUSHO = 0o10000, PENDIN = 0o40000, IEXTEN = 0o100000, EXTPROC = 0o200000;
// c_cc indices
export const VINTR = 0, VQUIT = 1, VERASE = 2, VKILL = 3, VEOF = 4, VTIME = 5, VMIN = 6, VSWTC = 7;
export const VSTART = 8, VSTOP = 9, VSUSP = 10, VEOL = 11, VREPRINT = 12, VDISCARD = 13, VWERASE = 14;
export const VLNEXT = 15, VEOL2 = 16;
export const NCCS = 19;
/** sizeof(struct termios) as used by TCGETS/TCSETS on Linux */
export const TERMIOS_SIZE = 36;
export const WINSIZE_SIZE = 8;

// ── tty ioctls ──────────────────────────────────────────────────────────────
export const TCGETS = 0x5401, TCSETS = 0x5402, TCSETSW = 0x5403, TCSETSF = 0x5404;
export const TCSBRK = 0x5409, TCXONC = 0x540a, TCFLSH = 0x540b;
export const TIOCEXCL = 0x540c, TIOCNXCL = 0x540d, TIOCSCTTY = 0x540e, TIOCGPGRP = 0x540f, TIOCSPGRP = 0x5410;
export const TIOCOUTQ = 0x5411, TIOCSTI = 0x5412, TIOCGWINSZ = 0x5413, TIOCSWINSZ = 0x5414;
export const FIONREAD = 0x541b, TIOCINQ = FIONREAD, TIOCNOTTY = 0x5422, FIONBIO = 0x5421, TIOCGSID = 0x5429;
export const TIOCPKT = 0x5420, TIOCGPKT = 0x80045438;
export const TIOCGPTN = 0x80045430, TIOCSPTLCK = 0x40045431, TIOCGPTPEER = 0x5441;
export const TCOOFF = 0, TCOON = 1, TCIOFF = 2, TCION = 3;
export const TCIFLUSH = 0, TCOFLUSH = 1, TCIOFLUSH = 2;

export interface Termios {
  iflag: number;
  oflag: number;
  cflag: number;
  lflag: number;
  line: number;
  cc: Uint8Array; // NCCS
}

export interface Winsize {
  rows: number;
  cols: number;
  xpixel: number;
  ypixel: number;
}

const ctrl = (c: string) => c.charCodeAt(0) & 0x1f;

/** `stty sane` defaults (what a fresh Linux pty has) */
export function defaultTermios(): Termios {
  const cc = new Uint8Array(NCCS);
  cc[VINTR] = ctrl('C');
  cc[VQUIT] = 0x1c;
  cc[VERASE] = 0x7f;
  cc[VKILL] = ctrl('U');
  cc[VEOF] = ctrl('D');
  cc[VTIME] = 0;
  cc[VMIN] = 1;
  cc[VSTART] = ctrl('Q');
  cc[VSTOP] = ctrl('S');
  cc[VSUSP] = ctrl('Z');
  cc[VREPRINT] = ctrl('R');
  cc[VDISCARD] = ctrl('O');
  cc[VWERASE] = ctrl('W');
  cc[VLNEXT] = ctrl('V');
  return {
    iflag: ICRNL | IXON | IMAXBEL | IUTF8 | BRKINT,
    oflag: OPOST | ONLCR,
    cflag: B38400 | CS8 | CREAD | HUPCL,
    lflag: ISIG | ICANON | IEXTEN | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE,
    line: 0,
    cc,
  };
}

export function cloneTermios(t: Termios): Termios {
  return { ...t, cc: new Uint8Array(t.cc) };
}

/** cfmakeraw(3) */
export function makeRaw(t: Termios): Termios {
  const r = cloneTermios(t);
  r.iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON);
  r.oflag &= ~OPOST;
  r.lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
  r.cflag = (r.cflag & ~(CSIZE | PARENB)) | CS8;
  r.cc[VMIN] = 1;
  r.cc[VTIME] = 0;
  return r;
}

export function encodeTermios(t: Termios, out: Uint8Array = new Uint8Array(TERMIOS_SIZE)): Uint8Array {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(0, t.iflag >>> 0, true);
  dv.setUint32(4, t.oflag >>> 0, true);
  dv.setUint32(8, t.cflag >>> 0, true);
  dv.setUint32(12, t.lflag >>> 0, true);
  out[16] = t.line;
  out.set(t.cc.subarray(0, NCCS), 17);
  return out;
}

export function decodeTermios(buf: Uint8Array): Termios {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    iflag: dv.getUint32(0, true),
    oflag: dv.getUint32(4, true),
    cflag: dv.getUint32(8, true),
    lflag: dv.getUint32(12, true),
    line: buf[16],
    cc: new Uint8Array(buf.subarray(17, 17 + NCCS)),
  };
}

export function encodeWinsize(w: Winsize, out: Uint8Array = new Uint8Array(WINSIZE_SIZE)): Uint8Array {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint16(0, w.rows, true);
  dv.setUint16(2, w.cols, true);
  dv.setUint16(4, w.xpixel, true);
  dv.setUint16(6, w.ypixel, true);
  return out;
}

export function decodeWinsize(buf: Uint8Array): Winsize {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { rows: dv.getUint16(0, true), cols: dv.getUint16(2, true), xpixel: dv.getUint16(4, true), ypixel: dv.getUint16(6, true) };
}

const readInt = (arg: Uint8Array) => (arg.byteLength >= 4 ? new DataView(arg.buffer, arg.byteOffset, 4).getInt32(0, true) : -1);
const writeInt = (arg: Uint8Array, v: number) => new DataView(arg.buffer, arg.byteOffset, 4).setInt32(0, v, true);

/** What read/write/ioctl may get as their last argument */
export type CallerHint = SignalTarget | AbortSignal | undefined;

/** Session id → its controlling tty (a session has at most one) */
const controllingTtys = new Map<number, Pty>();
export function controllingTty(sid: number): Pty | undefined {
  return controllingTtys.get(sid);
}

/** A pty end as a kernel OpenFile (the trailing argument also accepts the caller) */
export interface PtyFile extends OpenFile {
  kind: 'pty';
  readonly pty: Pty;
  readonly side: 'master' | 'slave';
  read(buf: Uint8Array, hint?: CallerHint): Promise<number>;
  write(buf: Uint8Array, hint?: CallerHint): Promise<number>;
  ioctl(req: number, arg: Uint8Array, hint?: CallerHint): Promise<number>;
  stat(): Promise<KStat>;
}

/** Kernels that get /dev/pts/N nodes for new ptys */
const ptyKernels = new Set<Kernel>();
const livePtys = new Set<Pty>();

let nextPtyIndex = 0;
/** Alternate screens (restoreScreen leaves them first) */
const ALT_SCREENS = new Set([47, 1047, 1049]);
/** DEC private modes restoreScreen puts back: the alternate screens, cursor visibility, application cursor keys, mouse reporting, bracketed paste */
const SCREEN_MODES = new Set([...ALT_SCREENS, 25, 1, 1000, 1002, 1003, 1005, 1006, 1015, 2004]);
const utf8 = new TextEncoder();

interface CanonLine { data: number[]; }
interface Who { caller?: SignalTarget; abort?: AbortSignal }

export class Pty {
  readonly index = nextPtyIndex++;
  readonly jc: JobControl;
  termios: Termios = defaultTermios();
  winsize: Winsize = { rows: 24, cols: 80, xpixel: 0, ypixel: 0 };
  /** Session that has this as its controlling tty (0 = none) */
  sid = 0;
  /** Foreground process group (0 = none) */
  fgPgrp = 0;
  /** TIOCPKT: master reads start with a status byte (0 = data). */
  packetMode = false;
  readonly master: PtyFile;

  private rawq: number[] = [];
  private lines: CanonLine[] = [];
  private edit: number[] = [];
  /** echo width of each byte in `edit` (0 for UTF-8 continuation bytes) */
  private editWidth: number[] = [];
  private lnext = false;
  private outputStopped = false;
  private column = 0;
  private outq: Uint8Array[] = [];
  private outListener: ((data: Uint8Array) => void) | null = null;
  private readyCbs = new Set<() => void>();
  private waiters = new Set<() => void>();
  private slaveCount = 0;
  private slaveEverOpened = false;
  private masterClosed = false;
  private hungUp = false;

  constructor(opts: { jc?: JobControl; winsize?: Partial<Winsize> } = {}) {
    this.jc = opts.jc ?? jobControl;
    if (opts.winsize) Object.assign(this.winsize, opts.winsize);
    this.master = this.makeMaster();
    livePtys.add(this);
    for (const k of ptyKernels) this.registerDevice(k);
  }

  /** Make this pty's slave openable as /dev/pts/N in `kernel` */
  registerDevice(kernel: Kernel): void {
    kernel.registerDevice(this.name, (proc, flags) => (this.masterClosed ? -EIO : this.openSlave(flags, this.jc.get(proc.pid))));
  }

  get name(): string {
    return `/dev/pts/${this.index}`;
  }

  // ── terminal-emulator side ──

  /**
   * Deliver output to a callback instead of queueing it for `master.read`
   * (how the xterm terminals consume it). Queued output is flushed first.
   */
  onOutput(cb: ((data: Uint8Array) => void) | null): void {
    this.outListener = cb;
    if (cb && this.outq.length) {
      const q = this.outq;
      this.outq = [];
      for (const chunk of q) cb(chunk);
    }
  }

  /** Keyboard input as a string (UTF-8 encoded) */
  input(text: string | Uint8Array): void {
    this.receive(typeof text === 'string' ? utf8.encode(text) : text);
  }

  /** TIOCSWINSZ: resizing sends SIGWINCH to the foreground group. */
  setWinsize(ws: Partial<Winsize>): void {
    const next = { ...this.winsize, ...ws };
    const changed = next.rows !== this.winsize.rows || next.cols !== this.winsize.cols
      || next.xpixel !== this.winsize.xpixel || next.ypixel !== this.winsize.ypixel;
    this.winsize = next;
    if (changed && this.fgPgrp) this.jc.kill(-this.fgPgrp, SIGWINCH);
  }

  /** Open another slave descriptor (like open("/dev/pts/N")) */
  openSlave(flags = O_RDWR, caller?: SignalTarget): PtyFile {
    this.slaveCount++;
    this.slaveEverOpened = true;
    const file = this.makeSlave(flags);
    // A session leader without a controlling tty acquires this one (unless O_NOCTTY)
    const who = caller;
    if (who && !(flags & O_NOCTTY) && who.pid === who.sid && !controllingTtys.has(who.sid) && !this.sid) {
      this.acquire(who);
    }
    return file;
  }

  isControllingTtyOf(p: SignalTarget): boolean {
    return this.sid !== 0 && p.sid === this.sid;
  }

  /** Readable bytes for FIONREAD */
  inputAvailable(): number {
    if (this.termios.lflag & ICANON) return this.lines.reduce((n, l) => n + l.data.length, 0);
    return this.rawq.length;
  }

  /** Hang up: SIGHUP (+SIGCONT) to the session leader and foreground group; slave reads see EOF, writes EIO. */
  hangup(): void {
    if (this.hungUp) return;
    this.hungUp = true;
    const pgrp = this.fgPgrp;
    const leader = this.sid ? this.jc.get(this.sid) : undefined;
    if (leader) { this.jc.send(leader, SIGHUP); this.jc.send(leader, SIGCONT); }
    if (pgrp && pgrp !== this.sid) { this.jc.kill(-pgrp, SIGHUP); this.jc.kill(-pgrp, SIGCONT); }
    this.release();
    this.wake();
  }

  /** Make `p` (a session leader) the controlling process of this tty */
  acquire(p: SignalTarget): void {
    if (this.sid && this.sid !== p.sid) controllingTtys.delete(this.sid);
    this.sid = p.sid;
    this.fgPgrp = p.pgid;
    controllingTtys.set(p.sid, this);
    // The session leader's exit gives the tty up (Linux disassociate_ctty): apt
    // runs each dpkg in a new session on the same pty, and its TIOCSCTTY failed
    this.unwatchLeader?.();
    this.unwatchLeader = this.jc.subscribe((ev) => {
      if (ev.type === 'exited' && ev.pid === this.sid) this.leaderExited();
    });
  }

  private unwatchLeader?: () => void;

  private leaderExited(): void {
    const pgrp = this.fgPgrp;
    this.release();
    if (pgrp) this.jc.kill(-pgrp, SIGHUP); // what's left of the foreground group
  }

  release(): void {
    if (this.sid && controllingTtys.get(this.sid) === this) controllingTtys.delete(this.sid);
    this.unwatchLeader?.();
    this.unwatchLeader = undefined;
    this.sid = 0;
    this.fgPgrp = 0;
  }

  /** tcsetpgrp from the terminal/shell side, without job-control checks */
  setForeground(pgid: number): void {
    this.fgPgrp = pgid;
    this.wake();
  }

  // ── termios ──

  /** TCSETS*: switching ICANON moves pending input between the line and raw queues */
  setTermios(t: Termios, flushInput = false): void {
    const wasCanon = !!(this.termios.lflag & ICANON);
    this.termios = cloneTermios(t);
    const isCanon = !!(t.lflag & ICANON);
    if (flushInput) this.flushInput();
    else if (wasCanon && !isCanon) {
      for (const l of this.lines) this.rawq.push(...l.data);
      this.rawq.push(...this.edit);
      this.lines = [];
      this.edit = [];
      this.editWidth = [];
    } else if (!wasCanon && isCanon) {
      const pending = this.rawq;
      this.rawq = [];
      for (const b of pending) {
        this.edit.push(b);
        this.editWidth.push(1);
        if (b === 0x0a) this.commitLine();
      }
    }
    if (!(t.iflag & IXON)) this.outputStopped = false;
    this.wake();
  }

  flushInput(): void {
    this.rawq = [];
    this.lines = [];
    this.edit = [];
    this.editWidth = [];
    this.lnext = false;
  }

  // ── line discipline (input) ──

  private receive(bytes: Uint8Array): void {
    const t = this.termios;
    const cc = t.cc;
    const lflag = t.lflag;
    const canon = !!(lflag & ICANON);
    for (let c of bytes) {
      if (t.iflag & ISTRIP) c &= 0x7f;

      if (this.lnext) {
        this.lnext = false;
        this.addChar(c, true);
        continue;
      }

      if (t.iflag & IXON) {
        if (c === cc[VSTOP] && c) { this.outputStopped = true; continue; }
        if (c === cc[VSTART] && c) { this.outputStopped = false; this.wake(); continue; }
        if (this.outputStopped && (t.iflag & IXANY)) { this.outputStopped = false; this.wake(); }
      }

      if (lflag & ISIG) {
        const sig = c === cc[VINTR] && c ? SIGINT : c === cc[VQUIT] && c ? SIGQUIT : c === cc[VSUSP] && c ? SIGTSTP : 0;
        if (sig) {
          if (!(lflag & NOFLSH)) this.flushInput();
          if (this.outputStopped) { this.outputStopped = false; }
          this.echoChar(c);
          if (this.fgPgrp) this.jc.kill(-this.fgPgrp, sig);
          this.wake();
          continue;
        }
      }

      if (c === 0x0d) {
        if (t.iflag & IGNCR) continue;
        if (t.iflag & ICRNL) c = 0x0a;
      } else if (c === 0x0a && (t.iflag & INLCR)) {
        c = 0x0d;
      }
      if ((t.iflag & IUCLC) && (lflag & IEXTEN) && c >= 0x41 && c <= 0x5a) c += 0x20;

      if (canon) {
        if ((lflag & IEXTEN) && c === cc[VLNEXT] && c) {
          this.lnext = true;
          if (lflag & ECHO) { if (lflag & ECHOCTL) this.output([0x5e, 0x08]); }
          continue;
        }
        if (c === cc[VERASE] && c) { this.eraseChars('char'); continue; }
        if ((lflag & IEXTEN) && c === cc[VWERASE] && c) { this.eraseChars('word'); continue; }
        if (c === cc[VKILL] && c) { this.eraseChars('line'); continue; }
        if ((lflag & IEXTEN) && c === cc[VREPRINT] && c) {
          if (lflag & ECHO) {
            this.echoChar(c);
            this.output([0x0a]);
            for (const b of this.edit) this.echoChar(b);
          }
          continue;
        }
        if (c === cc[VEOF] && c) {
          this.commitLine();
          continue;
        }
        if (c === 0x0a || (c === cc[VEOL] && c) || ((lflag & IEXTEN) && c === cc[VEOL2] && c)) {
          if (c === 0x0a ? (lflag & (ECHO | ECHONL)) : (lflag & ECHO)) this.echoChar(c, true);
          this.edit.push(c);
          this.editWidth.push(0);
          this.commitLine();
          continue;
        }
        this.addChar(c, false);
      } else {
        this.rawq.push(c);
        if (lflag & ECHO) this.echoChar(c);
        else if (c === 0x0a && (lflag & ECHONL)) this.echoChar(c, true);
      }
    }
    this.wake();
  }

  private addChar(c: number, literal: boolean): void {
    if (!(this.termios.lflag & ICANON)) {
      this.rawq.push(c);
      if (this.termios.lflag & ECHO) this.echoChar(c);
      return;
    }
    // Linux caps the canonical line at 4095 bytes (+ newline)
    if (this.edit.length >= 4095) {
      if (this.termios.iflag & IMAXBEL) this.output([0x07]);
      return;
    }
    this.edit.push(c);
    this.editWidth.push(this.echoChar(c, literal));
  }

  private commitLine(): void {
    this.lines.push({ data: this.edit });
    this.edit = [];
    this.editWidth = [];
  }

  /** Echo one input byte; returns the number of columns it took */
  private echoChar(c: number, force = false): number {
    const lflag = this.termios.lflag;
    if (!(lflag & ECHO) && !force) return 0;
    if (c === 0x0a || c === 0x09) { this.output([c]); return c === 0x09 ? 1 : 0; }
    if ((lflag & ECHOCTL) && (c < 0x20 || c === 0x7f)) {
      this.output([0x5e, c ^ 0x40]);
      return 2;
    }
    this.output([c]);
    // UTF-8 continuation bytes don't advance the cursor
    return (this.termios.iflag & IUTF8) && (c & 0xc0) === 0x80 ? 0 : 1;
  }

  private eraseChars(kind: 'char' | 'word' | 'line'): void {
    const lflag = this.termios.lflag;
    const t = this.termios;
    if (this.edit.length === 0) return;
    if (kind === 'line' && !(lflag & ECHOKE) && (lflag & ECHO)) {
      // Classic kill echo: show the kill char, then a newline
      this.edit = [];
      this.editWidth = [];
      this.echoChar(t.cc[VKILL]);
      if (lflag & ECHOK) this.output([0x0a]);
      return;
    }
    const isSpace = (b: number) => b === 0x20 || b === 0x09;
    let seenWord = false;
    while (this.edit.length) {
      const last = this.edit[this.edit.length - 1];
      if (kind === 'word') {
        if (isSpace(last)) { if (seenWord) break; }
        else seenWord = true;
      }
      // Remove one character (a whole UTF-8 sequence)
      let width = 0;
      while (this.edit.length) {
        const b = this.edit.pop()!;
        width += this.editWidth.pop() ?? 1;
        if (!(t.iflag & IUTF8) || (b & 0xc0) !== 0x80) break;
      }
      if (lflag & ECHO) {
        if ((lflag & ECHOE) || kind === 'line') {
          for (let i = 0; i < width; i++) this.output([0x08, 0x20, 0x08]);
        } else {
          this.echoChar(t.cc[VERASE]);
        }
      }
      if (kind === 'char') break;
    }
  }

  // ── output ──

  /** Output processing (OPOST) and delivery to the master side */
  private output(bytes: ArrayLike<number>): void {
    const t = this.termios;
    let out: number[];
    if (!(t.oflag & OPOST)) {
      out = Array.from(bytes);
    } else {
      out = [];
      for (let i = 0; i < bytes.length; i++) {
        let c = bytes[i];
        if (c === 0x0a) {
          if (t.oflag & ONLCR) { out.push(0x0d, 0x0a); this.column = 0; continue; }
          if (t.oflag & ONLRET) this.column = 0;
        } else if (c === 0x0d) {
          if ((t.oflag & ONOCR) && this.column === 0) continue;
          if (t.oflag & OCRNL) { c = 0x0a; if (t.oflag & ONLRET) this.column = 0; }
          else this.column = 0;
        } else if (c === 0x08) {
          if (this.column > 0) this.column--;
        } else if (c >= 0x20 && (c & 0xc0) !== 0x80) {
          if ((t.oflag & OLCUC) && c >= 0x61 && c <= 0x7a) c -= 0x20;
          this.column++;
        }
        out.push(c);
      }
    }
    if (out.length === 0) return;
    const chunk = Uint8Array.from(out);
    if (this.outListener) this.outListener(chunk);
    else this.outq.push(chunk);
    this.notifyReady();
  }

  // ── blocking helpers ──

  private wake(): void {
    const w = [...this.waiters];
    this.waiters.clear();
    for (const fn of w) fn();
    this.notifyReady();
  }

  private notifyReady(): void {
    for (const cb of [...this.readyCbs]) {
      try { cb(); } catch (e) { console.error('[pty] onReady callback failed', e); }
    }
  }

  /** Wait for any state change, a timeout (ms), an abort, or a signal for `caller`. Resolves true on timeout. */
  private waitChange(caller: SignalTarget | undefined, timeoutMs?: number, abort?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsub: (() => void) | undefined;
      const finish = (timedOut: boolean) => {
        if (done) return;
        done = true;
        this.waiters.delete(onWake);
        if (timer) clearTimeout(timer);
        abort?.removeEventListener('abort', onWake);
        unsub?.();
        resolve(timedOut);
      };
      const onWake = () => finish(false);
      this.waiters.add(onWake);
      if (abort) {
        if (abort.aborted) { finish(false); return; }
        abort.addEventListener('abort', onWake, { once: true });
      }
      if (timeoutMs !== undefined) timer = setTimeout(() => finish(true), timeoutMs);
      if (caller) {
        // A caught signal, termination or a stop/continue interrupts the wait
        unsub = this.jc.subscribe((ev) => { if (ev.pid === caller.pid) finish(false); });
      }
    });
  }

  /** A blocked call should give up with EINTR: aborted by the kernel, caller died, or a caught signal is pending */
  private interrupted(caller: SignalTarget | undefined, abort?: AbortSignal): boolean {
    if (abort?.aborted) return true;
    if (!caller) return false;
    return caller.runState === 'zombie' || caller.signals.deliverable() !== 0n;
  }

  /**
   * Background job-control check (n_tty job_control / tty_check_change).
   * Returns 0 to proceed or a negative errno. A stopped caller waits here
   * until continued and then re-checks, which is the syscall restart.
   */
  private async jobCheck(caller: SignalTarget | undefined, sig: typeof SIGTTIN | typeof SIGTTOU): Promise<number> {
    for (;;) {
      if (!caller || !this.isControllingTtyOf(caller) || !this.fgPgrp || caller.pgid === this.fgPgrp) return 0;
      const st = caller.signals;
      const ignored = st.isIgnored(sig) || st.isBlocked(sig);
      if (ignored) return sig === SIGTTOU ? 0 : -EIO;
      if (this.jc.isOrphanedPgrp(caller.pgid)) return -EIO;
      klog.logRatelimited(LOG_INFO, `tty: ${this.name}: pid ${caller.pid} in background process group ${caller.pgid} ` +
        `${sig === SIGTTIN ? 'read' : 'wrote or changed'} the terminal (foreground ${this.fgPgrp}): ${sig === SIGTTIN ? 'SIGTTIN' : 'SIGTTOU'}`);
      this.jc.kill(-caller.pgid, sig);
      if (caller.runState === 'stopped') {
        await this.jc.whileStopped(caller);
        if ((caller.runState as string) === 'zombie') return -EINTR;
        continue;
      }
      return -EINTR;
    }
  }

  // ── slave read/write ──

  /** Split a trailing argument into the calling process and the kernel's abort signal */
  private who(hint: CallerHint): Who {
    const abort = hint instanceof AbortSignal ? hint : undefined;
    return { caller: this.jc.resolveCaller(hint), abort };
  }

  private async slaveRead(file: PtyFile, buf: Uint8Array, w: Who): Promise<number> {
    const { caller, abort } = w;
    if (buf.length === 0) return 0;
    for (;;) {
      const jc = await this.jobCheck(caller, SIGTTIN);
      if (jc < 0) return jc;
      if (this.termios.lflag & ICANON) {
        if (this.lines.length) return this.takeLine(buf);
        if (this.hungUp || this.masterClosed) return 0;
        if (file.flags & O_NONBLOCK) return -EAGAIN;
        await this.waitChange(caller, undefined, abort);
        if (this.interrupted(caller, abort) && !this.lines.length) return -EINTR;
        continue;
      }
      return this.readNonCanonical(file, buf, w);
    }
  }

  private takeLine(buf: Uint8Array): number {
    const line = this.lines[0];
    const n = Math.min(buf.length, line.data.length);
    for (let i = 0; i < n; i++) buf[i] = line.data[i];
    if (n === line.data.length) this.lines.shift();
    else line.data = line.data.slice(n);
    this.notifyReady();
    return n;
  }

  private takeRaw(buf: Uint8Array): number {
    const n = Math.min(buf.length, this.rawq.length);
    for (let i = 0; i < n; i++) buf[i] = this.rawq[i];
    this.rawq.splice(0, n);
    this.notifyReady();
    return n;
  }

  /** VMIN/VTIME semantics (termios(3) "Noncanonical mode") */
  private async readNonCanonical(file: PtyFile, buf: Uint8Array, w: Who): Promise<number> {
    const { caller, abort } = w;
    const min = this.termios.cc[VMIN];
    const timeMs = this.termios.cc[VTIME] * 100;
    const want = Math.min(min, buf.length);
    const hung = () => this.hungUp || this.masterClosed;
    if (file.flags & O_NONBLOCK) {
      if (this.rawq.length) return this.takeRaw(buf);
      return hung() ? 0 : -EAGAIN;
    }
    if (min === 0 && timeMs === 0) return this.takeRaw(buf);
    if (min === 0) {
      // Timer starts now; return as soon as anything arrives
      const deadline = Date.now() + timeMs;
      while (!this.rawq.length && !hung()) {
        const left = deadline - Date.now();
        if (left <= 0) return 0;
        await this.waitChange(caller, left, abort);
        if (this.interrupted(caller, abort) && !this.rawq.length) return -EINTR;
        if (this.termios.lflag & ICANON) return this.slaveRead(file, buf, w);
      }
      return this.takeRaw(buf);
    }
    // MIN > 0: block for the first byte, then (with VTIME) use an inter-byte timer
    while (!this.rawq.length && !hung()) {
      await this.waitChange(caller, undefined, abort);
      if (this.interrupted(caller, abort) && !this.rawq.length) return -EINTR;
      if (this.termios.lflag & ICANON) return this.slaveRead(file, buf, w);
      const jc = await this.jobCheck(caller, SIGTTIN);
      if (jc < 0) return jc;
    }
    while (this.rawq.length < want && !hung()) {
      const have = this.rawq.length;
      const timedOut = await this.waitChange(caller, timeMs > 0 ? timeMs : undefined, abort);
      if (this.interrupted(caller, abort)) break;
      if (timedOut && this.rawq.length === have) break;
    }
    return this.takeRaw(buf);
  }

  private async slaveWrite(buf: Uint8Array, w: Who): Promise<number> {
    const { caller, abort } = w;
    if (this.hungUp || this.masterClosed) return -EIO;
    if (this.termios.lflag & TOSTOP) {
      const jc = await this.jobCheck(caller, SIGTTOU);
      if (jc < 0) return jc;
    }
    while (this.outputStopped && !this.hungUp) {
      await this.waitChange(caller, undefined, abort);
      if (this.interrupted(caller, abort)) return -EINTR;
    }
    if (this.hungUp) return -EIO;
    this.trackScreenModes(buf);
    this.output(buf);
    return buf.length;
  }

  /**
   * DEC private modes programs set on the terminal that a shell prompt can't
   * live with: the alternate screen, a hidden cursor, mouse reporting,
   * application cursor keys, bracketed paste. A TUI resets them as it exits;
   * when one dies inside them, `restoreScreen` does.
   */
  private screenModes = new Set<number>();
  private modeTail = '';

  private trackScreenModes(buf: Uint8Array): void {
    if (!this.modeTail && !buf.includes(0x1b)) return;
    let text = this.modeTail;
    for (let i = 0; i < buf.length; i++) text += String.fromCharCode(buf[i]);
    for (const m of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
      for (const n of m[1].split(';').map(Number)) {
        if (!SCREEN_MODES.has(n)) continue;
        // (for the cursor, 25, what needs undoing is hiding it)
        if ((m[2] === 'h') !== (n === 25)) this.screenModes.add(n);
        else this.screenModes.delete(n);
      }
    }
    // An escape sequence cut off at the end of the write
    const cut = /\x1b(\[(\?[\d;]*)?)?$/.exec(text.slice(-16));
    this.modeTail = cut ? cut[0] : '';
  }

  /** Undo the screen modes a program left set (see trackScreenModes) */
  restoreScreen(): void {
    this.modeTail = '';
    if (!this.screenModes.size) return;
    const off = [...this.screenModes].filter((n) => n !== 25 && !ALT_SCREENS.has(n));
    let seq = '';
    // Leave the alternate screen first (1049 restores the cursor it saved)
    for (const n of [1049, 1047, 47]) if (this.screenModes.has(n)) seq += `\x1b[?${n}l`;
    if (off.length) seq += `\x1b[?${off.join(';')}l`;
    if (this.screenModes.has(25)) seq += '\x1b[?25h';
    this.screenModes.clear();
    const chunk = utf8.encode(seq);
    if (this.outListener) this.outListener(chunk);
    else this.outq.push(chunk);
    this.notifyReady();
  }

  // ── ioctl ──

  private async doIoctl(file: PtyFile, req: number, arg: Uint8Array, hint: CallerHint): Promise<number> {
    const isMaster = file.side === 'master';
    const caller = this.jc.resolveCaller(hint);
    // Job-control check for calls that change the tty from a background group
    const changes = req === TCSETS || req === TCSETSW || req === TCSETSF || req === TIOCSPGRP || req === TCFLSH || req === TCXONC;
    if (changes && !isMaster) {
      const jc = await this.jobCheck(caller, SIGTTOU);
      if (jc < 0) return jc;
    }
    const need = (n: number) => arg.byteLength >= n;
    switch (req) {
      case TCGETS:
        if (!need(TERMIOS_SIZE)) return -EFAULT;
        encodeTermios(this.termios, arg);
        return 0;
      case TCSETS:
      case TCSETSW:
      case TCSETSF:
        if (!need(TERMIOS_SIZE)) return -EFAULT;
        this.setTermios(decodeTermios(arg), req === TCSETSF);
        return 0;
      case TIOCGWINSZ:
        if (!need(WINSIZE_SIZE)) return -EFAULT;
        encodeWinsize(this.winsize, arg);
        return 0;
      case TIOCSWINSZ:
        if (!need(WINSIZE_SIZE)) return -EFAULT;
        this.setWinsize(decodeWinsize(arg));
        return 0;
      case FIONREAD:
        if (!need(4)) return -EFAULT;
        writeInt(arg, isMaster ? this.outq.reduce((n, c) => n + c.length, 0) : this.inputAvailable());
        return 0;
      case TIOCPKT:
        if (!isMaster) return -ENOTTY;
        if (!need(4)) return -EFAULT;
        this.packetMode = readInt(arg) !== 0;
        return 0;
      case TIOCGPKT:
        if (!need(4)) return -EFAULT;
        writeInt(arg, this.packetMode ? 1 : 0);
        return 0;
      case TIOCOUTQ:
        if (!need(4)) return -EFAULT;
        writeInt(arg, isMaster ? 0 : this.outq.reduce((n, c) => n + c.length, 0));
        return 0;
      case FIONBIO:
        if (!need(4)) return -EFAULT;
        file.flags = readInt(arg) ? file.flags | O_NONBLOCK : file.flags & ~O_NONBLOCK;
        return 0;
      case TCFLSH: {
        const how = arg.byteLength >= 4 ? readInt(arg) : arg[0];
        if (how === TCIFLUSH || how === TCIOFLUSH) this.flushInput();
        if (how === TCOFLUSH || how === TCIOFLUSH) this.outq = [];
        if (how < 0 || how > 2) return -EINVAL;
        this.wake();
        return 0;
      }
      case TCXONC: {
        const how = arg.byteLength >= 4 ? readInt(arg) : arg[0];
        if (how === TCOOFF) this.outputStopped = true;
        else if (how === TCOON) { this.outputStopped = false; this.wake(); }
        else if (how !== TCIOFF && how !== TCION) return -EINVAL;
        return 0;
      }
      case TCSBRK:
        return 0;
      case TIOCSTI:
        if (!need(1)) return -EFAULT;
        this.receive(arg.subarray(0, 1));
        return 0;
      case TIOCGPTN:
        if (!isMaster) return -ENOTTY;
        if (!need(4)) return -EFAULT;
        writeInt(arg, this.index);
        return 0;
      case TIOCSPTLCK:
        return isMaster ? 0 : -ENOTTY;
      case TIOCEXCL:
      case TIOCNXCL:
        return 0;
      case TIOCSCTTY: {
        if (!caller) return -EPERM;
        if (caller.pid !== caller.sid) return -EPERM;
        if (this.sid === caller.sid) return 0;
        if (controllingTtys.has(caller.sid)) return -EPERM;
        // Stealing another session's tty needs arg == 1 (and CAP_SYS_ADMIN); allow it as root does
        if (this.sid && readInt(arg) !== 1) return -EPERM;
        this.acquire(caller);
        return 0;
      }
      case TIOCNOTTY: {
        if (!caller || !this.isControllingTtyOf(caller)) return -ENOTTY;
        if (caller.pid === caller.sid) {
          const pgrp = this.fgPgrp;
          this.release();
          if (pgrp) { this.jc.kill(-pgrp, SIGHUP); this.jc.kill(-pgrp, SIGCONT); }
        }
        return 0;
      }
      case TIOCGPGRP:
        if (!need(4)) return -EFAULT;
        if (!isMaster && caller && !this.isControllingTtyOf(caller)) return -ENOTTY;
        writeInt(arg, this.fgPgrp);
        return 0;
      case TIOCSPGRP: {
        if (!need(4)) return -EFAULT;
        const pgid = readInt(arg);
        if (pgid < 0) return -EINVAL;
        if (!isMaster && caller && !this.isControllingTtyOf(caller)) return -ENOTTY;
        const members = this.jc.group(pgid);
        if (members.length === 0) return -ESRCH;
        if (this.sid && !members.some((m) => m.sid === this.sid)) return -EPERM;
        this.setForeground(pgid);
        return 0;
      }
      case TIOCGSID:
        if (!need(4)) return -EFAULT;
        if (!isMaster && caller && !this.isControllingTtyOf(caller)) return -ENOTTY;
        if (!this.sid) return -ENOTTY;
        writeInt(arg, this.sid);
        return 0;
      default:
        return -ENOTTY;
    }
  }

  private stat(isMaster: boolean): KStat {
    const now = Date.now();
    return {
      dev: 0x16, ino: 3 + this.index, mode: S_IFCHR | 0o620, nlink: 1, uid: 0, gid: 5,
      rdev: isMaster ? (5 << 8) | 2 : (136 << 8) | this.index,
      size: 0, blksize: 1024, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
    };
  }

  private makeMaster(): PtyFile {
    const pty = this;
    const file: PtyFile = {
      kind: 'pty',
      flags: O_RDWR,
      pty,
      side: 'master',
      async read(buf, hint) {
        const abort = hint instanceof AbortSignal ? hint : undefined;
        for (;;) {
          if (pty.outq.length) {
            // Packet mode: a TIOCPKT_DATA byte, then the data
            let n = pty.packetMode ? 1 : 0;
            if (n) { if (buf.length < 2) return -EINVAL; buf[0] = 0; }
            while (pty.outq.length && n < buf.length) {
              const chunk = pty.outq[0];
              const take = Math.min(chunk.length, buf.length - n);
              buf.set(chunk.subarray(0, take), n);
              n += take;
              if (take === chunk.length) pty.outq.shift();
              else pty.outq[0] = chunk.subarray(take);
            }
            return n;
          }
          if (pty.slaveEverOpened && pty.slaveCount === 0) return -EIO;
          if (file.flags & O_NONBLOCK) return -EAGAIN;
          await pty.waitChange(undefined, undefined, abort);
          if (abort?.aborted && !pty.outq.length) return -EINTR;
        }
      },
      async write(buf) {
        if (pty.masterClosed) return -EIO;
        pty.receive(buf);
        return buf.length;
      },
      poll(events) {
        let r = 0;
        if (pty.outq.length) r |= POLLIN;
        if (pty.slaveEverOpened && pty.slaveCount === 0) r |= POLLHUP;
        r |= POLLOUT;
        return r & (events | POLLHUP | POLLERR);
      },
      onReady(cb) {
        pty.readyCbs.add(cb);
        return () => pty.readyCbs.delete(cb);
      },
      ioctl(req, arg, hint) { return pty.doIoctl(file, req, arg, hint); },
      async stat() { return pty.stat(true); },
      async close() {
        if (pty.masterClosed) return;
        pty.masterClosed = true;
        livePtys.delete(pty);
        pty.hangup();
        // The terminal is gone: drop /dev/pts/N and the output callback, which
        // otherwise keep the pty and its terminal and shell (a closed pane) alive
        for (const k of ptyKernels) k.unregisterDevice(pty.name);
        pty.outListener = null;
        pty.outq.length = 0;
      },
    };
    return file;
  }

  private makeSlave(flags: number): PtyFile {
    const pty = this;
    let closed = false;
    const file: PtyFile = {
      kind: 'pty',
      flags,
      pty,
      side: 'slave',
      path: this.name,
      read(buf, hint) { return pty.slaveRead(file, buf, pty.who(hint)); },
      write(buf, hint) { return pty.slaveWrite(buf, pty.who(hint)); },
      poll(events) {
        let r = 0;
        const canon = !!(pty.termios.lflag & ICANON);
        const min = Math.max(1, pty.termios.cc[VMIN]);
        if (canon ? pty.lines.length > 0 : pty.rawq.length >= (pty.termios.cc[VTIME] ? 1 : min)) r |= POLLIN;
        if (pty.hungUp || pty.masterClosed) r |= POLLHUP | POLLIN;
        else if (!pty.outputStopped) r |= POLLOUT;
        return r & (events | POLLHUP | POLLERR);
      },
      onReady(cb) {
        pty.readyCbs.add(cb);
        return () => pty.readyCbs.delete(cb);
      },
      ioctl(req, arg, hint) { return pty.doIoctl(file, req, arg, hint); },
      async stat() { return pty.stat(false); },
      async close() {
        if (closed) return;
        closed = true;
        pty.slaveCount--;
        pty.wake();
      },
    };
    return file;
  }
}

/** openpty(3): a fresh master plus one slave descriptor */
export function openpty(opts: { jc?: JobControl; winsize?: Partial<Winsize> } = {}): { master: PtyFile; slave: PtyFile; pty: Pty } {
  const pty = new Pty(opts);
  return { pty, master: pty.master, slave: pty.openSlave(O_RDWR | O_NOCTTY) };
}

export type JobResult = { type: 'exited'; status: number } | { type: 'stopped'; sig: number };

/** A job as the tty sees it: its process group and its saved tty modes while stopped */
export interface TtyJob {
  pgid: number;
  /** Members to wait for (default: the live members of pgid) */
  pids?: number[];
  /** Modes the job had when it stopped; restored by `foreground` */
  termios?: Termios;
}

/**
 * One terminal's session: a pty plus a session-leader process standing in for
 * the interactive shell. The xterm terminals own one each; the shell uses it to
 * hand the tty to a job (`foreground`) and take it back, like bash's
 * give_terminal_to / wait_for.
 */
export class TtySession {
  readonly pty: Pty;
  readonly jc: JobControl;
  /**
   * The interactive shell as a process: session leader, ignores the
   * job-control stop signals. An in-page stand-in until `bindKernel` replaces
   * it with a kernel process.
   */
  leader: SignalTarget;
  /** The shell's tty modes, restored when a job stops or dies from a signal */
  shellTermios: Termios;
  private standIn: ReturnType<typeof createSignalTarget>;
  private kernel?: Kernel;
  private leaderProc?: Process;

  constructor(opts: { jc?: JobControl; winsize?: Partial<Winsize>; onOutput?: (data: Uint8Array) => void } = {}) {
    this.jc = opts.jc ?? jobControl;
    this.pty = new Pty({ jc: this.jc, winsize: opts.winsize });
    this.standIn = createSignalTarget({ jc: this.jc });
    this.leader = this.standIn;
    shellDispositions(this.leader);
    this.pty.acquire(this.leader);
    this.shellTermios = cloneTermios(this.pty.termios);
    if (opts.onOutput) this.pty.onOutput(opts.onOutput);
  }

  /**
   * Called when a job takes the terminal (`foreground`): the page's terminal
   * hands it what was typed while the command was starting, as a tty would.
   */
  onJobForeground?: () => void;

  /** True while a job (not the shell) owns the terminal */
  get jobInForeground(): boolean {
    return this.pty.fgPgrp !== 0 && this.pty.fgPgrp !== this.leader.pgid;
  }

  /** A slave fd for a job's stdio (no controlling-tty side effects) */
  openSlave(): PtyFile {
    return this.pty.openSlave(O_RDWR | O_NOCTTY);
  }

  /**
   * Create an in-page process for a new job in this session. `pgid` 0 (the
   * default) makes it the leader of a new process group.
   */
  createJobProcess(opts: { pgid?: number; onTerminate?: (sig: number) => void } = {}): ReturnType<typeof createSignalTarget> {
    const pid = this.jc.allocPid();
    return createSignalTarget({
      jc: this.jc, pid, ppid: this.leader.pid, pgid: opts.pgid || pid, sid: this.leader.sid, onTerminate: opts.onTerminate,
    });
  }

  /**
   * Back the session with a kernel process: an idle `-sh` session leader
   * whose controlling tty is this pty, so jobs can be its children. Idempotent.
   */
  bindKernel(kernel: Kernel): Process {
    if (this.leaderProc && this.kernel === kernel && this.leaderProc.state !== 'zombie') return this.leaderProc;
    attachKernelTty(kernel, this.jc);
    const ctty = this.openSlave();
    retain(ctty); // the session's /dev/tty stays open as long as the session
    const proc = kernel.spawn({
      path: '-sh', argv: ['-sh'], setsid: true, fds: { 0: ctty, 1: ctty, 2: ctty },
      run: () => new Promise<void>(() => {}),
    });
    proc.ctty = ctty;
    const t = this.jc.get(proc.pid)!;
    shellDispositions(t);
    t.signals.handle(SIGCHLD, () => this.reap());
    const fg = this.jobInForeground ? this.pty.fgPgrp : 0;
    this.pty.release();
    this.pty.acquire(t);
    if (fg) this.pty.setForeground(fg);
    this.leader = t;
    this.kernel = kernel;
    this.leaderProc = proc;
    return proc;
  }

  /**
   * Spawn a kernel job in this session: a new process group (unless `pgid`
   * names an existing one) whose stdio is the pty slave and whose parent is
   * the session leader. Pair with `foreground` or `runKernelJob`.
   */
  spawnJob(kernel: Kernel, opts: Omit<SpawnOptions, 'parent' | 'setsid'>): Process {
    const parent = this.bindKernel(kernel);
    let fds = opts.fds;
    if (!fds) {
      const slave = this.openSlave();
      fds = { 0: slave, 1: slave, 2: slave };
    }
    return kernel.spawn({ ...opts, fds, parent, pgid: opts.pgid ?? 0 });
  }

  /** Reap exited children of the kernel leader (its SIGCHLD handler); job control already has their status. */
  reap(): void {
    const k = this.kernel, lp = this.leaderProc;
    if (!k || !lp) return;
    void (async () => {
      for (;;) {
        const r = await k.waitpid(-1, WNOHANG, lp);
        if (r.pid <= 0) return;
      }
    })();
  }

  /**
   * Give the terminal to `job`, optionally SIGCONT it (fg), and wait until it
   * exits or stops; then take the terminal back. A job that exits normally
   * keeps the tty modes it set (so `stty -echo` sticks, as in bash); a job that
   * stops or is killed gets its modes saved and the shell's restored.
   */
  async foreground(job: TtyJob, cont = false): Promise<JobResult> {
    this.shellTermios = cloneTermios(this.pty.termios);
    if (job.termios) this.pty.setTermios(job.termios);
    this.pty.setForeground(job.pgid);
    this.onJobForeground?.();
    if (cont) this.jc.kill(-job.pgid, SIGCONT);
    const r = await this.jc.waitJob(job.pgid, job.pids);
    this.pty.setForeground(this.leader.pgid);
    afterForeground(this.pty, job, r, this.shellTermios);
    return r;
  }

  resize(rows: number, cols: number): void {
    this.pty.setWinsize({ rows, cols });
  }

  dispose(): void {
    void this.pty.master.close(); // hangup: SIGHUP to the leader and the foreground job
    if (this.leaderProc && this.kernel) void this.kernel.exit(this.leaderProc, 0);
    this.standIn.finish(0);
    this.jc.unregister(this.standIn.pid);
  }
}

/**
 * The terminal after a foreground job: one that stopped keeps its tty modes
 * for `fg` and the shell's come back. One killed by a signal, or that exited
 * leaving the tty raw (non-canonical: a TUI that never got to clean up),
 * gets the shell's modes back, and the screen modes it left set (alternate
 * screen, hidden cursor, mouse) undone, as bash restores its saved tty state.
 * A job that exits normally otherwise keeps its modes (`stty -echo` sticks).
 */
function afterForeground(pty: Pty, job: TtyJob, r: JobResult, shellTermios: Termios): void {
  if (r.type === 'stopped') {
    job.termios = cloneTermios(pty.termios);
    pty.setTermios(shellTermios);
  } else if (!WIFEXITED(r.status) || !(pty.termios.lflag & ICANON)) {
    pty.setTermios(shellTermios);
    pty.restoreScreen();
  }
}

/** Interactive bash ignores the job-control signals and catches SIGINT itself */
function shellDispositions(t: SignalTarget): void {
  for (const sig of [SIGTSTP, SIGTTIN, SIGTTOU, SIGQUIT, SIGTERM]) t.signals.handle(sig, SIG_IGN);
  t.signals.handle(SIGINT, () => {});
}

/**
 * Wire a kernel to job control and the pty devices: /dev/ptmx opens a new pty
 * master, /dev/pts/N its slaves (main.ts calls this at boot). Idempotent.
 */
export function attachKernelTty(kernel: Kernel, jc: JobControl = jobControl): void {
  attachKernel(kernel, jc);
  if (ptyKernels.has(kernel)) return;
  ptyKernels.add(kernel);
  kernel.registerDevice('/dev/ptmx', (_proc, flags) => {
    const pty = new Pty({ jc });
    pty.master.flags = flags;
    return pty.master;
  });
  // /dev/tty: the process's controlling terminal. Besides the one a session
  // was spawned with (proc.ctty), a session leader acquires a pty by opening
  // its slave without O_NOCTTY or with TIOCSCTTY (xterm, script, ssh do this).
  kernel.registerDevice('/dev/tty', (proc) => {
    if (proc.ctty) return proc.ctty;
    const pty = controllingTtys.get(proc.sid);
    return pty ? pty.openSlave(O_RDWR | O_NOCTTY) : -6 /* ENXIO */;
  });
  for (const p of livePtys) p.registerDevice(kernel);
}

/**
 * Job control for a shell that is itself a kernel process on a pty (`sh` in
 * a screen or tmux window, `sh -i`): what TtySession does for the page's
 * terminal, on the shell's controlling pty, with the shell's process as the
 * leader. Its jobs are its children, each in a process group of its own that
 * gets the terminal while it runs; Ctrl-Z stops it and the shell takes the
 * terminal (and its tty modes) back.
 */
export class ProcessTty {
  shellTermios: Termios;

  constructor(readonly proc: Process, readonly pty: Pty, readonly jc: JobControl = jobControl) {
    this.shellTermios = cloneTermios(pty.termios);
  }

  get jobInForeground(): boolean {
    return this.pty.fgPgrp !== 0 && this.pty.fgPgrp !== this.proc.pgid;
  }

  openSlave(): PtyFile {
    return this.pty.openSlave(O_RDWR | O_NOCTTY);
  }

  spawnJob(kernel: Kernel, opts: Omit<SpawnOptions, 'parent' | 'setsid'>): Process {
    let fds = opts.fds;
    if (!fds) {
      const slave = this.openSlave();
      fds = { 0: slave, 1: slave, 2: slave };
    }
    return kernel.spawn({ ...opts, fds, parent: this.proc, pgid: opts.pgid ?? 0 });
  }

  async foreground(job: TtyJob, cont = false): Promise<JobResult> {
    this.shellTermios = cloneTermios(this.pty.termios);
    if (job.termios) this.pty.setTermios(job.termios);
    this.pty.setForeground(job.pgid);
    if (cont) this.jc.kill(-job.pgid, SIGCONT);
    const r = await this.jc.waitJob(job.pgid, job.pids);
    this.pty.setForeground(this.proc.pgid);
    afterForeground(this.pty, job, r, this.shellTermios);
    return r;
  }
}
