/**
 * Bounded console log, captured from boot.
 *
 * Every console call (and uncaught error / unhandled rejection) is stringified
 * at capture time, so no objects are retained, and kept in a ring buffer
 * with hard caps on entries, per-entry length, and total characters.
 * Consecutive identical lines collapse into one entry with a repeat count. The
 * newest entries are also saved to localStorage periodically and on page exit,
 * so a later session (or someone connecting after a crash or reload) can query
 * what happened before it.
 *
 * Queried by the `console` command and by remote peers (`{type: 'console'}`).
 */

// Safari (26) lacks Symbol.dispose/asyncDispose. Bundles like Claude Code fall
// back to Symbol.for('Symbol.dispose') when *reading* the symbol but define
// disposers under `Symbol.dispose` (undefined -> key "undefined"), so `using`
// throws "Object not disposable". Polyfill before anything else loads.
if (!(Symbol as any).dispose) Object.defineProperty(Symbol, 'dispose', { value: Symbol.for('Symbol.dispose') });
if (!(Symbol as any).asyncDispose) Object.defineProperty(Symbol, 'asyncDispose', { value: Symbol.for('Symbol.asyncDispose') });

export type ConsoleLevel ='error' | 'warn' | 'log' | 'info' | 'debug';

export interface ConsoleEntry {
  seq: number;
  t: number;          // ms epoch of the first occurrence
  last?: number;      // ms epoch of the latest repeat
  level: ConsoleLevel;
  text: string;
  count: number;      // consecutive identical repeats collapsed into this entry
}

export interface ConsoleQuery {
  grep?: string;          // regex source, case-insensitive
  level?: string;         // comma list: error,warn,log,info,debug
  since?: number;         // ms epoch, or negative = ms ago
  limit?: number;         // max entries returned (newest kept), default 100
  maxBytes?: number;      // max characters of text returned, default 64 KB
  previous?: boolean;     // query the log saved by the previous page load
}

export interface ConsoleQueryResult {
  entries: ConsoleEntry[];
  matched: number;
  truncated: boolean;
  total: number;
  dropped: number;        // entries evicted from the ring since boot
  pageStart: number;
}

const MAX_ENTRIES = 3000;
const MAX_ENTRY_CHARS = 2000;
const MAX_TOTAL_CHARS = 1_500_000;
const PERSIST_KEY = 'shiro-console-log';
const PERSIST_ENTRIES = 300;
const PERSIST_MAX_CHARS = 200_000;
const PERSIST_EVERY_MS = 5000;

const entries: ConsoleEntry[] = [];
let totalChars = 0;
let seq = 0;
let dropped = 0;
let dirty = false;
let inCapture = false;
const pageStart = Date.now();

function loadPrevious(): { pageStart: number; entries: ConsoleEntry[] } | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
const previous = typeof localStorage !== 'undefined' ? loadPrevious() : null;

function stringify(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (arg === undefined) return 'undefined';
  try {
    const s = JSON.stringify(arg);
    if (s !== undefined) return s.length > MAX_ENTRY_CHARS ? s.slice(0, MAX_ENTRY_CHARS) : s;
  } catch { /* cyclic or exotic */ }
  try { return String(arg); } catch { return '[unprintable]'; }
}

export function record(level: ConsoleLevel, text: string): void {
  if (text.length > MAX_ENTRY_CHARS) text = text.slice(0, MAX_ENTRY_CHARS) + `… [${text.length - MAX_ENTRY_CHARS} more chars]`;
  const now = Date.now();
  const lastEntry = entries[entries.length - 1];
  if (lastEntry && lastEntry.level === level && lastEntry.text === text) {
    lastEntry.count++;
    lastEntry.last = now;
    dirty = true;
    return;
  }
  entries.push({ seq: ++seq, t: now, level, text, count: 1 });
  totalChars += text.length;
  while (entries.length > MAX_ENTRIES || totalChars > MAX_TOTAL_CHARS) {
    const old = entries.shift()!;
    totalChars -= old.text.length;
    dropped++;
  }
  dirty = true;
}

function install(): void {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as ConsoleLevel[]) {
    const original = console[level];
    console[level] = (...args: any[]) => {
      // Re-entrancy guard: anything that logs while we're capturing goes straight through
      if (!inCapture) {
        inCapture = true;
        try { record(level, args.map(stringify).join(' ')); } catch { /* never break logging */ }
        inCapture = false;
      }
      return original.apply(console, args);
    };
  }
  window.addEventListener('error', (event) => {
    record('error', `Uncaught ${event.error?.stack || event.message} (${event.filename}:${event.lineno}:${event.colno})`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const r = event.reason;
    record('error', `Unhandled rejection: ${r?.stack || r?.message || stringify(r)}`);
  });

  const persist = () => {
    if (!dirty) return;
    dirty = false;
    const tail: ConsoleEntry[] = [];
    let chars = 0;
    for (let i = entries.length - 1; i >= 0 && tail.length < PERSIST_ENTRIES; i--) {
      chars += entries[i].text.length;
      if (chars > PERSIST_MAX_CHARS) break;
      tail.unshift(entries[i]);
    }
    try { localStorage.setItem(PERSIST_KEY, JSON.stringify({ pageStart, entries: tail })); } catch { /* quota */ }
  };
  setInterval(persist, PERSIST_EVERY_MS);
  window.addEventListener('pagehide', persist);
}

export function queryConsole(q: ConsoleQuery = {}): ConsoleQueryResult {
  const source = q.previous ? (previous?.entries || []) : entries;
  const levels = q.level ? new Set(q.level.split(',').map((s) => s.trim().toLowerCase())) : null;
  let re: RegExp | null = null;
  if (q.grep) {
    try { re = new RegExp(q.grep, 'i'); } catch { re = new RegExp(q.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  }
  const since = q.since === undefined ? undefined : q.since < 0 ? Date.now() + q.since : q.since;
  const matchedAll = source.filter((e) =>
    (!levels || levels.has(e.level))
    && (since === undefined || (e.last ?? e.t) >= since)
    && (!re || re.test(e.text)));
  const limit = Math.max(1, q.limit ?? 100);
  const maxBytes = Math.max(256, q.maxBytes ?? 65536);
  const out: ConsoleEntry[] = [];
  let chars = 0;
  let truncated = matchedAll.length > limit;
  for (let i = matchedAll.length - 1; i >= 0 && out.length < limit; i--) {
    const e = matchedAll[i];
    if (chars + e.text.length > maxBytes) { truncated = true; break; }
    chars += e.text.length;
    out.unshift(e);
  }
  return {
    entries: out,
    matched: matchedAll.length,
    truncated,
    total: source.length,
    dropped: q.previous ? 0 : dropped,
    pageStart: q.previous ? (previous?.pageStart ?? 0) : pageStart,
  };
}

export function clearConsoleLog(): void {
  entries.length = 0;
  totalChars = 0;
  dirty = true;
}

/** Plain-text rendering used by the shell command and the probe. */
export function formatEntries(result: ConsoleQueryResult): string {
  const lines = result.entries.map((e) => {
    const time = new Date(e.t).toISOString().slice(11, 23);
    const repeat = e.count > 1 ? ` (×${e.count})` : '';
    return `${time} ${e.level.padEnd(5)} ${e.text}${repeat}`;
  });
  const note = result.truncated ? `[showing ${result.entries.length} of ${result.matched} matches; raise limit/maxBytes for more]` : '';
  return [...lines, note].filter(Boolean).join('\n');
}

if (typeof window !== 'undefined' && !(window as any).__shiroConsoleLog) {
  install();
  (window as any).__shiroConsoleLog = { query: queryConsole, clear: clearConsoleLog, format: formatEntries };
}
