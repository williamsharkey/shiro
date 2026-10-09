/**
 * dmesg - print or control the kernel log (src/kernel/klog.ts)
 *
 * The util-linux options people use: -T (human times), -t, -r (raw <prio>),
 * -x (decode facility and level), -l/-f (filter), -k/-u, -c/-C (clear; root
 * only, as on Linux), -w/-W (follow). In Debian mode Debian's own dmesg
 * replaces this one (the overlay's default for programs it has no policy
 * for) and reads the same log through /dev/kmsg or syslog(2).
 */

import type { Command, CommandContext } from './index';
import {
  klog, formatTimestamp, LEVEL_NAMES, FACILITY_NAMES, LOG_KERN, LOG_USER, type KlogRecord,
} from '../kernel/klog';
import { bootMs } from '../kernel/procfs';

const USAGE = `Usage:
 dmesg [options]

Display or control the kernel ring buffer.

Options:
 -C, --clear                 clear the kernel ring buffer
 -c, --read-clear            read and clear all messages
 -f, --facility <list>       restrict output to defined facilities
 -k, --kernel                display kernel messages
 -l, --level <list>          restrict output to defined levels
 -r, --raw                   print the raw message buffer
 -T, --ctime                 show human-readable timestamp
 -t, --notime                don't show any timestamp with messages
 -u, --userspace             display userspace messages
 -w, --follow                wait for new messages
 -W, --follow-new            wait and print only new messages
 -x, --decode                decode facility and level to readable string
 -h, --help                  display this help
`;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ctime(3) without the newline: `Thu Oct  9 17:28:58 2026` */
function ctime(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
}

interface Opts {
  ctime: boolean; notime: boolean; raw: boolean; decode: boolean;
  levels: Set<number> | null; facilities: Set<number> | null;
}

function parseList(arg: string | undefined, names: string[], what: string): Set<number> | string {
  if (!arg) return `dmesg: option requires an argument -- '${what}'`;
  const out = new Set<number>();
  for (const word of arg.split(',')) {
    const i = names.indexOf(word.trim().toLowerCase());
    if (i < 0) return `dmesg: unknown ${what === 'l' ? 'level' : 'facility'} '${word}'`;
    out.add(i);
  }
  return out;
}

export function formatRecord(r: KlogRecord, o: Opts): string {
  let prefix = '';
  if (o.raw) prefix = `<${r.facility * 8 + r.level}>`;
  else if (o.decode) prefix = `${(FACILITY_NAMES[r.facility] ?? String(r.facility)).padEnd(6)}:${(LEVEL_NAMES[r.level] ?? '').padEnd(6)}: `;
  const time = o.notime ? '' : o.ctime && !o.raw ? `[${ctime(bootMs + r.usec / 1000)}] ` : `${formatTimestamp(r.usec)} `;
  return `${prefix}${time}${r.text}\n`;
}

export const dmesgCmd: Command = {
  name: 'dmesg',
  description: 'Print or control the kernel ring buffer',
  async exec(ctx: CommandContext): Promise<number> {
    const o: Opts = { ctime: false, notime: false, raw: false, decode: false, levels: null, facilities: null };
    let clear = false, readClear = false, follow = false, followNew = false;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      // Bundled short flags (-Tw)
      const flags = /^-[A-Za-z]{2,}$/.test(a) ? [...a.slice(1)].map(c => '-' + c) : [a];
      for (const f of flags) {
        switch (f) {
          case '-C': case '--clear': clear = true; break;
          case '-c': case '--read-clear': readClear = true; break;
          case '-T': case '--ctime': o.ctime = true; break;
          case '-t': case '--notime': o.notime = true; break;
          case '-r': case '--raw': o.raw = true; break;
          case '-x': case '--decode': o.decode = true; break;
          case '-k': case '--kernel': o.facilities = new Set([LOG_KERN]); break;
          case '-u': case '--userspace': o.facilities = new Set([LOG_USER]); break;
          case '-w': case '--follow': follow = true; break;
          case '-W': case '--follow-new': follow = followNew = true; break;
          case '-l': case '--level':
          case '-f': case '--facility': {
            const level = f === '-l' || f === '--level';
            const r = parseList(args[++i], level ? LEVEL_NAMES : FACILITY_NAMES, level ? 'l' : 'f');
            if (typeof r === 'string') { ctx.stderr += r + '\n'; return 1; }
            if (level) o.levels = r; else o.facilities = r;
            break;
          }
          case '-h': case '--help': ctx.stdout += USAGE; return 0;
          default:
            if (/^--(level|facility)=/.test(f)) {
              const [k, v] = f.slice(2).split('=');
              const r = parseList(v, k === 'level' ? LEVEL_NAMES : FACILITY_NAMES, k === 'level' ? 'l' : 'f');
              if (typeof r === 'string') { ctx.stderr += r + '\n'; return 1; }
              if (k === 'level') o.levels = r; else o.facilities = r;
              break;
            }
            ctx.stderr += `dmesg: invalid option -- '${f.replace(/^-+/, '')}'\nTry 'dmesg --help' for more information.\n`;
            return 1;
        }
      }
    }

    // Clearing needs CAP_SYSLOG, like klogctl
    if ((clear || readClear) && (ctx.shell as { uid?: number }).uid !== 0) {
      ctx.stderr += 'dmesg: klogctl failed: Operation not permitted\n';
      return 1;
    }
    if (clear) { klog.clear(); return 0; }

    const wanted = (r: KlogRecord) => (!o.levels || o.levels.has(r.level)) && (!o.facilities || o.facilities.has(r.facility));
    const show = (recs: KlogRecord[]) => recs.filter(wanted).map(r => formatRecord(r, o)).join('');

    let next = klog.lastSeq;
    if (!followNew) {
      ctx.stdout += show(klog.all());
      if (readClear) klog.clear();
    }
    if (!follow) return 0;

    // -w: stream new records until interrupted
    const write = ctx.streamStdout ?? (ctx.terminal ? (s: string) => ctx.terminal!.writeOutput(s.replace(/\n/g, '\r\n')) : null);
    if (!write) return 0; // nowhere to stream to: print what there is, like a closed pipe
    if (ctx.stdout) { write(ctx.stdout); ctx.stdout = ''; }
    const signal = ctx.shell?.abortController?.signal;
    while (!signal?.aborted) {
      if (!(await klog.waitFor(next, signal))) break;
      const recs = klog.since(next);
      next = klog.lastSeq;
      const text = show(recs);
      if (text) write(text);
    }
    return 130;
  },
};
