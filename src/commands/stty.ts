import { Command, CommandContext } from './index';
import { ptyOf } from './tty-of';
import type { Shell } from '../shell';
import {
  Pty, Termios, cloneTermios, defaultTermios, makeRaw, NCCS,
  IGNBRK, BRKINT, IGNPAR, PARMRK, INPCK, ISTRIP, INLCR, IGNCR, ICRNL, IUCLC, IXON, IXANY, IXOFF, IMAXBEL, IUTF8,
  OPOST, OLCUC, ONLCR, OCRNL, ONOCR, ONLRET, OFILL, OFDEL,
  CSIZE, CS5, CS6, CS7, CS8, CSTOPB, CREAD, PARENB, PARODD, HUPCL, CLOCAL,
  ISIG, ICANON, XCASE, ECHO, ECHOE, ECHOK, ECHONL, NOFLSH, TOSTOP, ECHOCTL, ECHOPRT, ECHOKE, FLUSHO, PENDIN, IEXTEN, EXTPROC,
  VINTR, VQUIT, VERASE, VKILL, VEOF, VEOL, VEOL2, VSWTC, VSTART, VSTOP, VSUSP, VREPRINT, VWERASE, VLNEXT, VDISCARD, VMIN, VTIME,
} from '../kernel/pty';

type Field = 'iflag' | 'oflag' | 'cflag' | 'lflag';
/** GNU stty's flag names, in its `-a` order */
const FLAGS: Array<[string, Field, number, number?]> = [
  ['parenb', 'cflag', PARENB], ['parodd', 'cflag', PARODD],
  ['cs5', 'cflag', CS5, CSIZE], ['cs6', 'cflag', CS6, CSIZE], ['cs7', 'cflag', CS7, CSIZE], ['cs8', 'cflag', CS8, CSIZE],
  ['hupcl', 'cflag', HUPCL], ['cstopb', 'cflag', CSTOPB], ['cread', 'cflag', CREAD], ['clocal', 'cflag', CLOCAL],
  ['ignbrk', 'iflag', IGNBRK], ['brkint', 'iflag', BRKINT], ['ignpar', 'iflag', IGNPAR], ['parmrk', 'iflag', PARMRK],
  ['inpck', 'iflag', INPCK], ['istrip', 'iflag', ISTRIP], ['inlcr', 'iflag', INLCR], ['igncr', 'iflag', IGNCR],
  ['icrnl', 'iflag', ICRNL], ['ixon', 'iflag', IXON], ['ixoff', 'iflag', IXOFF], ['iuclc', 'iflag', IUCLC],
  ['ixany', 'iflag', IXANY], ['imaxbel', 'iflag', IMAXBEL], ['iutf8', 'iflag', IUTF8],
  ['opost', 'oflag', OPOST], ['olcuc', 'oflag', OLCUC], ['ocrnl', 'oflag', OCRNL], ['onlcr', 'oflag', ONLCR],
  ['onocr', 'oflag', ONOCR], ['onlret', 'oflag', ONLRET], ['ofill', 'oflag', OFILL], ['ofdel', 'oflag', OFDEL],
  ['isig', 'lflag', ISIG], ['icanon', 'lflag', ICANON], ['iexten', 'lflag', IEXTEN], ['echo', 'lflag', ECHO],
  ['echoe', 'lflag', ECHOE], ['echok', 'lflag', ECHOK], ['echonl', 'lflag', ECHONL], ['noflsh', 'lflag', NOFLSH],
  ['xcase', 'lflag', XCASE], ['tostop', 'lflag', TOSTOP], ['echoprt', 'lflag', ECHOPRT], ['echoctl', 'lflag', ECHOCTL],
  ['echoke', 'lflag', ECHOKE], ['flusho', 'lflag', FLUSHO], ['extproc', 'lflag', EXTPROC], ['pendin', 'lflag', PENDIN],
];
const ALIASES: Record<string, string> = { crterase: 'echoe', crtkill: 'echoke', ctlecho: 'echoctl', prterase: 'echoprt' };

/** Control characters in `stty -a` order */
const CCHARS: Array<[string, number]> = [
  ['intr', VINTR], ['quit', VQUIT], ['erase', VERASE], ['kill', VKILL], ['eof', VEOF], ['eol', VEOL],
  ['eol2', VEOL2], ['swtch', VSWTC], ['start', VSTART], ['stop', VSTOP], ['susp', VSUSP],
  ['rprnt', VREPRINT], ['werase', VWERASE], ['lnext', VLNEXT], ['discard', VDISCARD],
];

/** Terminals without a pty (forked shells, tests) still get persistent settings */
const detachedTtys = new WeakMap<Shell, Pty>();

function ttyFor(ctx: CommandContext): Pty {
  const tty = ptyOf(ctx, [0]);
  if (tty) return tty;
  let p = detachedTtys.get(ctx.shell);
  if (!p) {
    const size = ctx.terminal?.getSize() || { rows: 24, cols: 80 };
    p = new Pty({ winsize: { rows: size.rows, cols: size.cols } });
    detachedTtys.set(ctx.shell, p);
  }
  return p;
}

function showCc(c: number): string {
  if (c === 0) return '<undef>';
  if (c === 0x7f) return '^?';
  if (c < 0x20) return '^' + String.fromCharCode(c + 0x40);
  if (c >= 0x80) return 'M-' + showCc(c - 0x80);
  return String.fromCharCode(c);
}

function parseCc(v: string): number | undefined {
  if (v === 'undef' || v === '^-' || v === '') return 0;
  if (v === '^?') return 0x7f;
  if (/^\^.$/.test(v)) return v.charCodeAt(1) & 0x1f;
  if (/^0x[0-9a-f]+$/i.test(v)) return parseInt(v, 16) & 0xff;
  if (/^0[0-7]+$/.test(v)) return parseInt(v, 8) & 0xff;
  if (/^\d+$/.test(v) && v.length > 1) return parseInt(v, 10) & 0xff;
  if (v.length === 1) return v.charCodeAt(0);
  return undefined;
}

function flagOn(t: Termios, field: Field, bit: number, mask?: number): boolean {
  return mask !== undefined ? (t[field] & mask) === bit : (t[field] & bit) !== 0;
}

function formatAll(t: Termios, rows: number, cols: number): string {
  let out = `speed 38400 baud; rows ${rows}; columns ${cols}; line = ${t.line};\n`;
  const ccParts = CCHARS.map(([n, i]) => `${n} = ${showCc(t.cc[i])};`);
  ccParts.push(`min = ${t.cc[VMIN]};`, `time = ${t.cc[VTIME]};`);
  // Wrap like GNU stty (~70 columns)
  let line = '';
  for (const part of ccParts) {
    if (line && line.length + part.length + 1 > 72) { out += line + '\n'; line = ''; }
    line += (line ? ' ' : '') + part;
  }
  out += line + '\n';
  const groups: Field[] = ['cflag', 'iflag', 'oflag', 'lflag'];
  for (const g of groups) {
    const names = FLAGS.filter(([, f]) => f === g)
      .map(([n, f, b, m]) => (m !== undefined ? (flagOn(t, f, b, m) ? n : null) : (flagOn(t, f, b) ? n : '-' + n)))
      .filter((x): x is string => !!x);
    out += names.join(' ') + '\n';
  }
  return out;
}

/** `stty` with no arguments: speed line plus settings that differ from sane */
function formatChanged(t: Termios): string {
  const sane = defaultTermios();
  let out = `speed 38400 baud; line = ${t.line};\n`;
  const cc = CCHARS.filter(([, i]) => t.cc[i] !== sane.cc[i]).map(([n, i]) => `${n} = ${showCc(t.cc[i])};`);
  if (!(t.lflag & ICANON)) {
    if (t.cc[VMIN] !== sane.cc[VMIN]) cc.push(`min = ${t.cc[VMIN]};`);
    if (t.cc[VTIME] !== sane.cc[VTIME]) cc.push(`time = ${t.cc[VTIME]};`);
  }
  if (cc.length) out += cc.join(' ') + '\n';
  const flags = FLAGS.filter(([, f, b, m]) => flagOn(t, f, b, m) !== flagOn(sane, f, b, m))
    .map(([n, f, b, m]) => (m !== undefined ? (flagOn(t, f, b, m) ? n : null) : (flagOn(t, f, b) ? n : '-' + n)))
    .filter((x): x is string => !!x);
  if (flags.length) out += flags.join(' ') + '\n';
  return out;
}

/** `stty -g`: GNU format, flags then 32 control chars in hex */
function formatSave(t: Termios): string {
  const cc: string[] = [];
  for (let i = 0; i < 32; i++) cc.push((i < NCCS ? t.cc[i] : 0).toString(16));
  return [t.iflag, t.oflag, t.cflag, t.lflag].map((n) => n.toString(16)).concat(cc).join(':') + '\n';
}

function parseSave(s: string): Termios | undefined {
  const parts = s.split(':');
  if (parts.length < 4 + NCCS || !parts.every((p) => /^[0-9a-f]+$/i.test(p))) return undefined;
  const n = parts.map((p) => parseInt(p, 16));
  const t = defaultTermios();
  [t.iflag, t.oflag, t.cflag, t.lflag] = n.slice(0, 4);
  for (let i = 0; i < NCCS; i++) t.cc[i] = n[4 + i] & 0xff;
  return t;
}

function setFlag(t: Termios, name: string, on: boolean): boolean {
  const n = ALIASES[name] ?? name;
  const f = FLAGS.find(([fn]) => fn === n);
  if (!f) return false;
  const [, field, bit, mask] = f;
  if (mask !== undefined) {
    if (!on) return false; // -cs8 isn't a thing
    t[field] = (t[field] & ~mask) | bit;
  } else {
    t[field] = on ? t[field] | bit : t[field] & ~bit;
  }
  return true;
}

/** Combination settings from stty(1) */
function applyCombo(t: Termios, name: string, on: boolean): Termios | null {
  switch (name) {
    case 'sane':
      return defaultTermios();
    case 'raw':
      if (on) return makeRaw(t);
      // -raw == cooked
      return applyCombo(t, 'cooked', true);
    case 'cooked':
      if (!on) return applyCombo(t, 'raw', true);
      t.iflag |= BRKINT | IGNPAR | ISTRIP | ICRNL | IXON;
      t.oflag |= OPOST;
      t.lflag |= ISIG | ICANON;
      return t;
    case 'cbreak':
      if (on) t.lflag &= ~ICANON; else t.lflag |= ICANON;
      return t;
    case 'nl':
      if (on) { t.iflag &= ~(ICRNL | INLCR | IGNCR); t.oflag &= ~(OCRNL | ONLRET); }
      else { t.iflag = (t.iflag | ICRNL) & ~(INLCR | IGNCR); t.oflag = (t.oflag | ONLCR) & ~(OCRNL | ONLRET); }
      return t;
    case 'ek':
      t.cc[VERASE] = 0x7f;
      t.cc[VKILL] = 0x15;
      return t;
    case 'evenp':
    case 'parity':
      t.cflag = on ? (t.cflag & ~(PARODD | CSIZE)) | PARENB | CS7 : (t.cflag & ~(PARENB | CSIZE)) | CS8;
      return t;
    case 'oddp':
      t.cflag = on ? (t.cflag & ~CSIZE) | PARENB | PARODD | CS7 : (t.cflag & ~(PARENB | CSIZE)) | CS8;
      return t;
    case 'pass8':
      if (on) { t.cflag = (t.cflag & ~(PARENB | CSIZE)) | CS8; t.iflag &= ~ISTRIP; }
      else { t.cflag = (t.cflag & ~CSIZE) | PARENB | CS7; t.iflag |= ISTRIP; }
      return t;
    case 'litout':
      if (on) { t.cflag = (t.cflag & ~(PARENB | CSIZE)) | CS8; t.oflag &= ~OPOST; }
      else { t.cflag = (t.cflag & ~CSIZE) | PARENB | CS7; t.oflag |= OPOST; }
      return t;
    case 'crt':
      t.lflag |= ECHOE | ECHOCTL | ECHOKE;
      return t;
    case 'dec':
      t.lflag |= ECHOE | ECHOCTL | ECHOKE;
      t.iflag &= ~IXANY;
      t.cc[VINTR] = 3; t.cc[VERASE] = 0x7f; t.cc[VKILL] = 0x15;
      return t;
    case 'lcase':
    case 'LCASE':
      if (on) { t.lflag |= XCASE; t.iflag |= IUCLC; t.oflag |= OLCUC; }
      else { t.lflag &= ~XCASE; t.iflag &= ~IUCLC; t.oflag &= ~OLCUC; }
      return t;
    default:
      return null;
  }
}

export const sttyCmd: Command = {
  name: 'stty',
  description: 'Get/set terminal settings',
  async exec(ctx) {
    const pty = ttyFor(ctx);
    const args = [...ctx.args];
    let mode: 'changed' | 'all' | 'save' = 'changed';
    const settings: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-a' || a === '--all') mode = 'all';
      else if (a === '-g' || a === '--save') mode = 'save';
      else if (a === '-F' || a === '--file' || a.startsWith('--file=')) {
        const dev = a.startsWith('--file=') ? a.slice(7) : args[++i];
        if (dev !== '/dev/tty' && dev !== pty.name && dev !== '/dev/stdin') {
          ctx.stderr = `stty: ${dev}: No such device or address\n`;
          return 1;
        }
      } else settings.push(a);
    }

    if (settings.length === 0) {
      const t = pty.termios;
      ctx.stdout = mode === 'all' ? formatAll(t, pty.winsize.rows, pty.winsize.cols)
        : mode === 'save' ? formatSave(t) : formatChanged(t);
      return 0;
    }
    if (mode !== 'changed') {
      ctx.stderr = 'stty: when specifying an output style, modes may not be set\n';
      return 1;
    }

    let t = cloneTermios(pty.termios);
    const ws = { ...pty.winsize };
    let flushInput = false;
    for (let i = 0; i < settings.length; i++) {
      const a = settings[i];
      const needArg = () => {
        const v = settings[++i];
        if (v === undefined) throw new Error(`missing argument to '${a}'`);
        return v;
      };
      try {
        if (a === 'size') { ctx.stdout += `${ws.rows} ${ws.cols}\n`; continue; }
        if (a === 'speed') { ctx.stdout += '38400\n'; continue; }
        if (a === 'rows' || a === 'cols' || a === 'columns') {
          const v = needArg();
          if (!/^\d+$/.test(v)) throw new Error(`invalid integer argument: '${v}'`);
          if (a === 'rows') ws.rows = parseInt(v, 10); else ws.cols = parseInt(v, 10);
          continue;
        }
        if (a === 'min' || a === 'time') {
          const v = needArg();
          if (!/^\d+$/.test(v) || parseInt(v, 10) > 255) throw new Error(`invalid integer argument: '${v}'`);
          t.cc[a === 'min' ? VMIN : VTIME] = parseInt(v, 10);
          continue;
        }
        if (a === 'ispeed' || a === 'ospeed' || a === 'line') { needArg(); continue; }
        if (/^\d+$/.test(a)) continue; // a bare baud rate
        const cc = CCHARS.find(([n]) => n === a);
        if (cc) {
          const v = needArg();
          const c = parseCc(v);
          if (c === undefined) throw new Error(`invalid integer argument: '${v}'`);
          t.cc[cc[1]] = c;
          continue;
        }
        if (a === 'flush' || a === '-flush') { flushInput = true; continue; }
        const parsed = parseSave(a);
        if (parsed) { t = parsed; continue; }
        const on = !a.startsWith('-');
        const name = on ? a : a.slice(1);
        const combo = applyCombo(t, name, on);
        if (combo) { t = combo; continue; }
        if (setFlag(t, name, on)) continue;
        throw new Error(`invalid argument '${a}'`);
      } catch (e: any) {
        ctx.stderr = `stty: ${e.message}\nTry 'stty --help' for more information.\n`;
        return 1;
      }
    }
    pty.setTermios(t, flushInput);
    pty.setWinsize(ws);
    return 0;
  },
};

/**
 * reset (ncurses tset/reset): sane tty modes, then the terminal's own reset
 * (RIS: the main screen, a visible cursor, no mouse reporting, cleared).
 */
export const resetCmd: Command = {
  name: 'reset',
  description: 'Restore the terminal to a sane state',
  async exec(ctx) {
    const pty = ttyFor(ctx);
    pty.setTermios(defaultTermios(), true);
    pty.restoreScreen();
    ctx.stdout = '\x1bc';
    return 0;
  },
};
