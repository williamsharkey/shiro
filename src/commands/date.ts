import type { Command, CommandContext } from './index';

/**
 * date — GNU coreutils-compatible.
 *
 * Time zones come from $TZ: IANA names (through Intl), POSIX rule strings
 * (EST5EDT, EET-2EEST,M3.5.0/3,M10.5.0/4, <+03>-3), or the system zone when
 * unset. -d/--date understands the common GNU forms: @SECONDS, ISO dates and
 * times with zones, month names, MM/DD/YYYY, "now"/"today"/"tomorrow"/
 * "yesterday", weekdays, and relative items ("3 days ago", "+2 hours",
 * "next week"). Output: +FORMAT (strftime with GNU flags and widths), -I, -R,
 * --rfc-3339, -u, -r FILE, -f FILE.
 */

// ─── time zones ────────────────────────────────────────────────────────────

interface Zone {
  /** offset east of UTC in seconds, and the abbreviation, at a UTC instant */
  at(utcMs: number): { off: number; abbr: string };
}

interface Rule { kind: 'J' | 'n' | 'M'; m: number; w: number; d: number; n: number; time: number }

const DAY_MS = 86400000;

function parseOffset(s: string): number | null {
  const m = /^([+-]?)(\d{1,3})(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const v = parseInt(m[2], 10) * 3600 + (m[3] ? parseInt(m[3], 10) * 60 : 0) + (m[4] ? parseInt(m[4], 10) : 0);
  return m[1] === '-' ? -v : v;
}

/** Day of year (0-based) a POSIX rule names in YEAR */
function ruleDay(r: Rule, year: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (r.kind === 'J') return r.n - 1 + (leap && r.n >= 60 ? 1 : 0);
  if (r.kind === 'n') return r.n;
  const first = Date.UTC(year, r.m - 1, 1);
  const firstDow = new Date(first).getUTCDay();
  let day = 1 + ((r.d - firstDow + 7) % 7) + (r.w - 1) * 7;
  const dim = new Date(Date.UTC(year, r.m, 0)).getUTCDate();
  while (day > dim) day -= 7;
  return Math.round((Date.UTC(year, r.m - 1, day) - Date.UTC(year, 0, 1)) / DAY_MS);
}

function parsePosixTz(spec: string): Zone | null {
  let i = 0;
  const name = (): string | null => {
    if (spec[i] === '<') {
      const end = spec.indexOf('>', i);
      if (end < 0) return null;
      const n = spec.slice(i + 1, end);
      i = end + 1;
      return n;
    }
    const m = /^[A-Za-z]{3,}/.exec(spec.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const offset = (): number | null => {
    const m = /^[+-]?\d{1,3}(?::\d{1,2}){0,2}/.exec(spec.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseOffset(m[0]);
  };
  const std = name();
  if (std === null) return null;
  const stdOffW = offset();
  if (stdOffW === null) return null;
  const stdOff = -stdOffW;
  if (i >= spec.length) return { at: () => ({ off: stdOff, abbr: std }) };
  const dst = name();
  if (dst === null) return null;
  let dstOff = stdOff + 3600;
  if (i < spec.length && spec[i] !== ',') {
    const o = offset();
    if (o === null) return null;
    dstOff = -o;
  }
  const rule = (): Rule | null => {
    let r: Rule;
    let m: RegExpExecArray | null;
    const rest = spec.slice(i);
    if ((m = /^M(\d{1,2})\.(\d)\.(\d)/.exec(rest))) r = { kind: 'M', m: +m[1], w: +m[2], d: +m[3], n: 0, time: 7200 };
    else if ((m = /^J(\d{1,3})/.exec(rest))) r = { kind: 'J', m: 0, w: 0, d: 0, n: +m[1], time: 7200 };
    else if ((m = /^(\d{1,3})/.exec(rest))) r = { kind: 'n', m: 0, w: 0, d: 0, n: +m[1], time: 7200 };
    else return null;
    i += m[0].length;
    if (spec[i] === '/') {
      i++;
      const t = /^[+-]?\d{1,3}(?::\d{1,2}){0,2}/.exec(spec.slice(i));
      if (!t) return null;
      i += t[0].length;
      r.time = parseOffset(t[0])!;
    }
    return r;
  };
  let start: Rule | null, end: Rule | null;
  if (spec[i] === ',') {
    i++;
    start = rule();
    if (!start || spec[i] !== ',') return null;
    i++;
    end = rule();
    if (!end) return null;
  } else {
    // glibc's default rules (US)
    start = { kind: 'M', m: 3, w: 2, d: 0, n: 0, time: 7200 };
    end = { kind: 'M', m: 11, w: 1, d: 0, n: 0, time: 7200 };
  }
  const s = start, e = end;
  return {
    at(utcMs: number) {
      const year = new Date(utcMs + stdOff * 1000).getUTCFullYear();
      const startUtc = Date.UTC(year, 0, 1) + ruleDay(s, year) * DAY_MS + (s.time - stdOff) * 1000;
      const endUtc = Date.UTC(year, 0, 1) + ruleDay(e, year) * DAY_MS + (e.time - dstOff) * 1000;
      const inDst = startUtc < endUtc ? utcMs >= startUtc && utcMs < endUtc : !(utcMs >= endUtc && utcMs < startUtc);
      return inDst ? { off: dstOff, abbr: dst } : { off: stdOff, abbr: std };
    },
  };
}

function intlZone(name: string | undefined): Zone | null {
  let fmt: Intl.DateTimeFormat;
  let shorts: Intl.DateTimeFormat[];
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    // en-US only abbreviates American zones; other English locales know theirs (CET, BST, IST, AEST)
    shorts = ['en-US', 'en-GB', 'en-IN', 'en-AU', 'en-NZ', 'en-ZA', 'en-SG'].map((l) => new Intl.DateTimeFormat(l, { timeZone: name, timeZoneName: 'short' }));
  } catch {
    return null;
  }
  return {
    at(utcMs: number) {
      const parts: Record<string, string> = {};
      for (const p of fmt.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
      const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
      const off = Math.round((local - Math.floor(utcMs / 1000) * 1000) / 1000);
      let abbr = 'UTC';
      for (const f of shorts) {
        abbr = f.formatToParts(new Date(utcMs)).find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';
        if (!/^GMT[+-]/.test(abbr)) break;
      }
      if (/^GMT[+-]/.test(abbr) || abbr === 'GMT' && off !== 0) {
        const a = Math.abs(off);
        abbr = `${off < 0 ? '-' : '+'}${String(Math.floor(a / 3600)).padStart(2, '0')}${a % 3600 ? String(Math.floor((a % 3600) / 60)).padStart(2, '0') : ''}`;
      }
      if (abbr === 'GMT' && (name === 'UTC' || name === 'Etc/UTC' || name === 'Universal' || name === 'Zulu')) abbr = 'UTC';
      return { off, abbr };
    },
  };
}

function zoneFor(tz: string | undefined): Zone {
  if (tz === undefined) return intlZone(undefined) ?? { at: () => ({ off: 0, abbr: 'UTC' }) };
  const spec = tz.startsWith(':') ? tz.slice(1) : tz;
  if (spec === '') return { at: () => ({ off: 0, abbr: 'UTC' }) };
  if (!tz.startsWith(':')) {
    const p = parsePosixTz(spec);
    if (p) return p;
  }
  if (spec === 'UTC' || spec === 'Etc/UTC') return { at: () => ({ off: 0, abbr: 'UTC' }) };
  const z = intlZone(spec);
  if (z) return z;
  // glibc: an unknown zone is UTC, named after the leading letters of TZ
  const abbr = /^[A-Za-z]+/.exec(spec)?.[0] ?? 'UTC';
  return { at: () => ({ off: 0, abbr }) };
}

/** UTC ms for local wall-clock fields in ZONE */
function localToUtc(z: Zone, y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const wall = Date.UTC(y, mo, d, h, mi, s);
  const wallFixed = y < 100 && y >= 0 ? (() => { const t = new Date(wall); t.setUTCFullYear(y); return t.getTime(); })() : wall;
  let guess = wallFixed - z.at(wallFixed).off * 1000;
  guess = wallFixed - z.at(guess).off * 1000;
  return guess;
}

// ─── formatting ────────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Moment { ms: number; nanos: number }

function isoWeek(y: number, yday: number, wday: number): { year: number; week: number } {
  // ISO 8601 week number: Monday-based, week 1 holds the year's first Thursday
  const wd = (wday + 6) % 7; // Monday = 0
  const leap = (yy: number) => (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  const weeksIn = (yy: number) => {
    const jan1 = (new Date(Date.UTC(yy, 0, 1)).getUTCDay() + 6) % 7;
    return jan1 === 3 || (leap(yy) && jan1 === 2) ? 53 : 52;
  };
  const week = Math.floor((yday - wd + 10) / 7);
  if (week < 1) return { year: y - 1, week: weeksIn(y - 1) };
  if (week > weeksIn(y)) return { year: y + 1, week: 1 };
  return { year: y, week };
}

function strftime(fmt: string, t: Moment, z: Zone): string {
  const { off, abbr } = z.at(t.ms);
  const d = new Date(t.ms + off * 1000);
  const Y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate();
  const H = d.getUTCHours(), Mi = d.getUTCMinutes(), S = d.getUTCSeconds(), wd = d.getUTCDay();
  const yday = Math.round((Date.UTC(Y, mo, day) - Date.UTC(Y, 0, 1)) / DAY_MS);
  const zoneStr = (colons: number) => {
    const a = Math.abs(off);
    const hh = String(Math.floor(a / 3600)).padStart(2, '0');
    const mm = String(Math.floor((a % 3600) / 60)).padStart(2, '0');
    const ss = String(a % 60).padStart(2, '0');
    const sign = off < 0 ? '-' : '+';
    if (colons === 0) return `${sign}${hh}${mm}`;
    if (colons === 1) return `${sign}${hh}:${mm}`;
    if (colons === 2) return `${sign}${hh}:${mm}:${ss}`;
    return a % 3600 === 0 ? `${sign}${hh}` : a % 60 === 0 ? `${sign}${hh}:${mm}` : `${sign}${hh}:${mm}:${ss}`;
  };
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') { out += c; continue; }
    const m = /^%([-_0^#]*)(\d*)(:{0,3})([a-zA-Z%+])/.exec(fmt.slice(i));
    if (!m) { out += '%'; continue; }
    i += m[0].length - 1;
    const [, flags, widthS, colons, conv] = m;
    let numeric = true;
    let defPad = '0';
    let defWidth = 0;
    let v: string;
    const num = (n: number, w: number, pad = '0') => { defWidth = w; defPad = pad; return String(n); };
    switch (conv) {
      case 'a': v = DAYS[wd].slice(0, 3); numeric = false; break;
      case 'A': v = DAYS[wd]; numeric = false; break;
      case 'b': case 'h': v = MONTHS[mo].slice(0, 3); numeric = false; break;
      case 'B': v = MONTHS[mo]; numeric = false; break;
      case 'c': v = strftime('%a %b %e %H:%M:%S %Y', t, z); numeric = false; break;
      case 'C': v = num(Math.floor(Y / 100), 2); break;
      case 'd': v = num(day, 2); break;
      case 'D': v = strftime('%m/%d/%y', t, z); numeric = false; break;
      case 'e': v = num(day, 2, ' '); break;
      case 'F': v = strftime('%Y-%m-%d', t, z); numeric = false; break;
      case 'g': v = num(isoWeek(Y, yday, wd).year % 100, 2); break;
      case 'G': v = num(isoWeek(Y, yday, wd).year, 4); break;
      case 'H': v = num(H, 2); break;
      case 'I': v = num(((H + 11) % 12) + 1, 2); break;
      case 'j': v = num(yday + 1, 3); break;
      case 'k': v = num(H, 2, ' '); break;
      case 'l': v = num(((H + 11) % 12) + 1, 2, ' '); break;
      case 'm': v = num(mo + 1, 2); break;
      case 'M': v = num(Mi, 2); break;
      case 'n': v = '\n'; numeric = false; break;
      case 'N': {
        const ns = String(t.nanos).padStart(9, '0');
        const w = widthS ? parseInt(widthS, 10) : 9;
        v = w <= 9 ? ns.slice(0, w) : ns.padEnd(w, '0');
        numeric = false;
        out += v;
        continue;
      }
      case 'p': v = H < 12 ? 'AM' : 'PM'; numeric = false; break;
      case 'P': v = H < 12 ? 'am' : 'pm'; numeric = false; break;
      case 'q': v = num(Math.floor(mo / 3) + 1, 1); break;
      case 'r': v = strftime('%I:%M:%S %p', t, z); numeric = false; break;
      case 'R': v = strftime('%H:%M', t, z); numeric = false; break;
      case 's': v = num(Math.floor(t.ms / 1000), 1); break;
      case 'S': v = num(S, 2); break;
      case 't': v = '\t'; numeric = false; break;
      case 'T': v = strftime('%H:%M:%S', t, z); numeric = false; break;
      case 'u': v = num(wd || 7, 1); break;
      case 'U': v = num(Math.floor((yday + 7 - wd) / 7), 2); break;
      case 'V': v = num(isoWeek(Y, yday, wd).week, 2); break;
      case 'w': v = num(wd, 1); break;
      case 'W': v = num(Math.floor((yday + 7 - ((wd + 6) % 7)) / 7), 2); break;
      case 'x': v = strftime('%m/%d/%y', t, z); numeric = false; break;
      case 'X': v = strftime('%H:%M:%S', t, z); numeric = false; break;
      case 'y': v = num(((Y % 100) + 100) % 100, 2); break;
      case 'Y': v = num(Y, 1); break;
      case 'z': v = zoneStr(colons.length); numeric = false; break;
      case 'Z': v = abbr; numeric = false; break;
      case '+': v = strftime('%a %b %e %H:%M:%S %Z %Y', t, z); numeric = false; break;
      case '%': v = '%'; numeric = false; break;
      default: v = m[0]; numeric = false; break;
    }
    if (conv !== 'z' && colons) { out += m[0]; continue; }
    let pad = defPad;
    if (flags.includes('-')) pad = '';
    else if (flags.includes('_')) pad = ' ';
    else if (flags.includes('0')) pad = '0';
    if (!numeric && !flags.includes('0') && !flags.includes('_')) pad = numeric ? pad : ' ';
    const width = widthS ? parseInt(widthS, 10) : numeric ? defWidth : 0;
    if (flags.includes('^')) v = v.toUpperCase();
    else if (flags.includes('#')) v = /[a-z]/.test(v) ? v.toUpperCase() : v.toLowerCase();
    if (pad && v.length < width) {
      if (pad === '0' && /^[+-]/.test(v)) v = v[0] + v.slice(1).padStart(width - 1, '0');
      else v = v.padStart(width, pad);
    } else if (!pad && numeric) {
      v = String(parseInt(v, 10));
    }
    out += v;
  }
  return out;
}

// ─── parsing (a subset of GNU parse_datetime) ───────────────────────────────

const MONTH_RE = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?![a-z])/;
const DAY_RE = /^(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\.?(?![a-z])/;
const ZONES: Record<string, number> = {
  utc: 0, ut: 0, gmt: 0, z: 0, wet: 0, west: 1, bst: 1, cet: 1, cest: 2, met: 1, mest: 2, eet: 2, eest: 3,
  msk: 3, ist: 5.5, jst: 9, kst: 9, hkt: 8, awst: 8, acst: 9.5, aest: 10, aedt: 11, nzst: 12, nzdt: 13,
  est: -5, edt: -4, cst: -6, cdt: -5, mst: -7, mdt: -6, pst: -8, pdt: -7, akst: -9, akdt: -8, hst: -10,
  ast: -4, adt: -3, nst: -3.5, ndt: -2.5,
};
const ORDINALS: Record<string, number> = {
  last: -1, this: 0, next: 1, first: 1, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};
const UNITS: Record<string, [string, number]> = {
  year: ['y', 1], month: ['mo', 1], fortnight: ['d', 14], week: ['d', 7], day: ['d', 1],
  hour: ['s', 3600], minute: ['s', 60], min: ['s', 60], second: ['s', 1], sec: ['s', 1],
};

class InvalidDate extends Error {}

function parseDate(input: string, now: Moment, zone: Zone): Moment {
  let s = input.trim();
  // TZ="Zone" prefix
  const tzm = /^TZ="([^"]*)"\s*/.exec(s);
  if (tzm) { zone = zoneFor(tzm[1]); s = s.slice(tzm[0].length); }
  const at = /^@\s*([+-]?\d+)(?:[.,](\d+))?\s*$/.exec(s);
  if (at) {
    const secs = parseInt(at[1], 10);
    const frac = at[2] ? parseInt(at[2].slice(0, 9).padEnd(9, '0'), 10) : 0;
    const neg = at[1].startsWith('-');
    let ms = secs * 1000 + (neg ? -1 : 1) * Math.floor(frac / 1e6);
    let nanos = neg && frac ? 1e9 - frac : frac;
    if (neg && frac) ms = (secs - 1) * 1000 + Math.floor(nanos / 1e6);
    return { ms, nanos };
  }
  let str = s.toLowerCase();
  let y: number | null = null, mo: number | null = null, d: number | null = null;
  let h: number | null = null, mi = 0, sec = 0, nanos = 0;
  let zoneOff: number | null = null;
  let weekday: { day: number; ord: number } | null = null;
  const rel = { y: 0, mo: 0, d: 0, s: 0 };
  let relSeen = false;
  let lastRel: { k: string; v: number }[] = [];
  const bad = () => { throw new InvalidDate(); };
  const setDate = (yy: number | null, mm: number, dd: number) => {
    if (d !== null) bad();
    y = yy; mo = mm; d = dd;
  };
  const setTime = (hh: number, mm: number, ss: number, ns = 0) => {
    if (h !== null) bad();
    h = hh; mi = mm; sec = ss; nanos = ns;
  };
  const meridian = (hh: number, mer: string | undefined) => {
    if (!mer) return hh;
    if (hh < 1 || hh > 12) bad();
    const pm = mer.startsWith('p');
    return (hh % 12) + (pm ? 12 : 0);
  };
  const zoneNum = (sign: string, digits: string, colonMin?: string): number => {
    let hh: number, mm: number;
    if (colonMin !== undefined) { hh = parseInt(digits, 10); mm = parseInt(colonMin, 10); }
    else if (digits.length <= 2) { hh = parseInt(digits, 10); mm = 0; }
    else { hh = parseInt(digits.slice(0, -2), 10); mm = parseInt(digits.slice(-2), 10); }
    if (hh > 24 || mm > 59) bad();
    return (sign === '-' ? -1 : 1) * (hh * 3600 + mm * 60);
  };

  while (str.length) {
    let m: RegExpExecArray | null;
    const ws = /^[\s,]+/.exec(str);
    if (ws) { str = str.slice(ws[0].length); continue; }
    // ISO 8601 date (optionally with T and a time)
    if ((m = /^(\d{4,})-(\d{1,2})-(\d{1,2})(?=$|[^\d])/.exec(str))) {
      setDate(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
      str = str.slice(m[0].length);
      if (/^t\d/.test(str)) str = str.slice(1);
      continue;
    }
    // time of day, maybe with meridian and a numeric zone right after
    if ((m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d+))?)?(?:\s*(a\.?m\.?|p\.?m\.?)(?![a-z]))?/.exec(str))) {
      const hh = meridian(parseInt(m[1], 10), m[5]);
      const ns = m[4] ? parseInt(m[4].slice(0, 9).padEnd(9, '0'), 10) : 0;
      setTime(hh, parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : 0, ns);
      str = str.slice(m[0].length);
      const zm = /^\s*([+-])(\d{1,4})(?::(\d{2}))?(?![\d])/.exec(str);
      if (zm) { zoneOff = zoneNum(zm[1], zm[2], zm[3]); str = str.slice(zm[0].length); }
      continue;
    }
    if ((m = /^(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/.exec(str))) {
      setTime(meridian(parseInt(m[1], 10), m[2]), 0, 0);
      str = str.slice(m[0].length);
      continue;
    }
    // MM/DD[/YYYY]
    if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d+))?/.exec(str))) {
      let yy = m[3] !== undefined ? parseInt(m[3], 10) : null;
      if (yy !== null && m[3].length <= 2) yy += yy < 69 ? 2000 : 1900;
      setDate(yy, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
      str = str.slice(m[0].length);
      continue;
    }
    // Month name [day] [year]
    if ((m = MONTH_RE.exec(str))) {
      const mm = monthIndex(m[1]);
      str = str.slice(m[0].length);
      const dm = /^[\s-]*(\d{1,2})(?!\d|:)(?:(?:\s*,\s*|[\s-]+)(\d{4}|\d{1,2}(?![\d:])))?/.exec(str);
      if (dm) {
        let yy = dm[2] !== undefined ? parseInt(dm[2], 10) : null;
        if (yy !== null && dm[2].length <= 2) yy += yy < 69 ? 2000 : 1900;
        setDate(yy, mm, parseInt(dm[1], 10));
        str = str.slice(dm[0].length);
      } else {
        setDate(null, mm, 1);
      }
      continue;
    }
    // Day month-name [year]
    if ((m = /^(\d{1,2})[\s-]*(?=[a-z])/.exec(str)) && MONTH_RE.test(str.slice(m[0].length))) {
      const rest = str.slice(m[0].length);
      const mm = MONTH_RE.exec(rest)!;
      str = rest.slice(mm[0].length);
      const ym = /^[\s-]*(\d{4}|\d{2})(?![\d:])/.exec(str);
      let yy: number | null = null;
      if (ym) { yy = parseInt(ym[1], 10); if (ym[1].length === 2) yy += yy < 69 ? 2000 : 1900; str = str.slice(ym[0].length); }
      setDate(yy, monthIndex(mm[1]), parseInt(m[1], 10));
      continue;
    }
    // relative: [N|ordinal] unit[s] [ago]
    if ((m = /^(?:([+-]?\s*\d+)|(last|this|next|first|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth))?\s*(years?|months?|fortnights?|weeks?|days?|hours?|minutes?|mins?|seconds?|secs?)(?![a-z])/.exec(str))) {
      const n = m[1] !== undefined ? parseInt(m[1].replace(/\s+/g, ''), 10) : m[2] !== undefined ? ORDINALS[m[2]] : 1;
      const unit = UNITS[m[3].replace(/s$/, '')] ?? UNITS[m[3]];
      const [k, mult] = unit;
      const v = n * mult;
      (rel as any)[k] += v;
      lastRel.push({ k, v });
      relSeen = true;
      str = str.slice(m[0].length);
      continue;
    }
    if ((m = /^ago(?![a-z])/.exec(str))) {
      for (const r of lastRel) (rel as any)[r.k] -= 2 * r.v;
      lastRel = [];
      str = str.slice(m[0].length);
      continue;
    }
    // [ordinal] weekday
    if ((m = /^(?:(last|this|next|first|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|[+-]?\d+)\s+)?/.exec(str)) && DAY_RE.test(str.slice(m[0].length))) {
      const dm = DAY_RE.exec(str.slice(m[0].length))!;
      const ord = m[1] === undefined ? 0 : /\d/.test(m[1]) ? parseInt(m[1], 10) : ORDINALS[m[1]];
      if (weekday) bad();
      weekday = { day: dayIndex(dm[1]), ord };
      str = str.slice(m[0].length + dm[0].length);
      continue;
    }
    if ((m = /^(now|today)(?![a-z])/.exec(str))) { relSeen = true; str = str.slice(m[0].length); continue; }
    if ((m = /^tomorrow(?![a-z])/.exec(str))) { rel.d += 1; relSeen = true; str = str.slice(m[0].length); continue; }
    if ((m = /^yesterday(?![a-z])/.exec(str))) { rel.d -= 1; relSeen = true; str = str.slice(m[0].length); continue; }
    if ((m = /^noon(?![a-z])/.exec(str))) { setTime(12, 0, 0); str = str.slice(m[0].length); continue; }
    if ((m = /^midnight(?![a-z])/.exec(str))) { setTime(0, 0, 0); str = str.slice(m[0].length); continue; }
    // zone names / numeric zones
    if ((m = /^([a-z]{1,5})(?![a-z])(\s+dst(?![a-z]))?/.exec(str)) && ZONES[m[1]] !== undefined) {
      if (zoneOff !== null) bad();
      zoneOff = ZONES[m[1]] * 3600 + (m[2] ? 3600 : 0);
      str = str.slice(m[0].length);
      const zm = /^\s*([+-])(\d{1,4})(?::(\d{2}))?(?!\d)/.exec(str);
      if (zm && (m[1] === 'utc' || m[1] === 'gmt' || m[1] === 'ut' || m[1] === 'z')) { zoneOff += zoneNum(zm[1], zm[2], zm[3]); str = str.slice(zm[0].length); }
      continue;
    }
    if ((m = /^([+-])(\d{4}|\d{2}:\d{2})(?!\d)/.exec(str))) {
      if (zoneOff !== null) bad();
      const parts = m[2].split(':');
      zoneOff = zoneNum(m[1], parts.length === 2 ? parts[0] : m[2], parts.length === 2 ? parts[1] : undefined);
      str = str.slice(m[0].length);
      continue;
    }
    // bare numbers
    if ((m = /^(\d+)(?:\.(\d+))?/.exec(str))) {
      const digits = m[1];
      str = str.slice(m[0].length);
      if (digits.length === 8 && d === null) { setDate(parseInt(digits.slice(0, 4), 10), parseInt(digits.slice(4, 6), 10) - 1, parseInt(digits.slice(6), 10)); continue; }
      if (d !== null && y === null && (h !== null || digits.length > 2)) { y = parseInt(digits, 10); continue; }
      if (digits.length <= 4 && h === null) {
        const n = parseInt(digits, 10);
        if (digits.length <= 2) setTime(n, 0, 0);
        else setTime(Math.floor(n / 100), n % 100, 0);
        continue;
      }
      if (d !== null && y === null) { y = parseInt(digits, 10); continue; }
      bad();
    }
    bad();
  }

  // Local "now" fields in the zone
  const nowOff = zone.at(now.ms).off;
  const nd = new Date(now.ms + nowOff * 1000);
  let Y = y ?? nd.getUTCFullYear();
  let Mo = mo ?? nd.getUTCMonth();
  let D = d ?? nd.getUTCDate();
  let hh: number, mm: number, ss: number, ns: number;
  if (h !== null) { hh = h; mm = mi; ss = sec; ns = nanos; }
  else if (d !== null || weekday) { hh = 0; mm = 0; ss = 0; ns = 0; }
  else { hh = nd.getUTCHours(); mm = nd.getUTCMinutes(); ss = nd.getUTCSeconds(); ns = now.nanos; }
  void relSeen;
  // validate
  if (Mo < 0 || Mo > 11) bad();
  const dim = new Date(Date.UTC(Y, Mo + 1, 0)).getUTCDate();
  if (D < 1 || D > dim) bad();
  if (hh > 24 || mm > 59 || ss > 60 || (hh === 24 && (mm || ss))) bad();
  // relative years/months/days on the calendar
  if (rel.y || rel.mo) {
    const total = Mo + rel.mo + rel.y * 12;
    Y += Math.floor(total / 12);
    Mo = ((total % 12) + 12) % 12;
  }
  D += rel.d;
  // GNU ignores a day of the week when a date is given
  if (weekday && d === null) {
    const cur = new Date(Date.UTC(Y, Mo, D)).getUTCDay();
    let diff = (weekday.day - cur + 7) % 7;
    const ord = weekday.ord;
    if (ord > 0) diff += 7 * (ord - (diff === 0 ? 0 : 1));
    else if (ord < 0) diff = diff === 0 ? 7 * ord : diff + 7 * ord;
    if (ord > 0 && diff === 0) diff = 7;
    D += diff;
  }
  let ms: number;
  if (zoneOff !== null) ms = Date.UTC(Y, Mo, D, hh, mm, ss) - zoneOff * 1000;
  else {
    const t = new Date(Date.UTC(Y, Mo, D, hh, mm, ss));
    ms = localToUtc(zone, t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds());
  }
  ms += rel.s * 1000 + Math.floor(ns / 1e6);
  return { ms, nanos: ns };
}

function monthIndex(s: string): number {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3));
}
function dayIndex(s: string): number {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(s.slice(0, 3));
}

// ─── command ───────────────────────────────────────────────────────────────

export const date: Command = {
  name: "date",
  description: "Display date and time",
  async exec(ctx: CommandContext) {
    const args = ctx.args;
    let dateStr: string | null = null;
    let fileArg: string | null = null;
    let refFile: string | null = null;
    let utc = false;
    let iso: string | null = null;
    let rfc3339: string | null = null;
    let rfcEmail = false;
    let setStr: string | null = null;
    const operands: string[] = [];
    const usage = (msg: string) => { ctx.stderr += `date: ${msg}\nTry 'date --help' for more information.\n`; return 1; };
    let opts = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!opts || !a.startsWith('-') || a === '-') { operands.push(a); continue; }
      if (a === '--') { opts = false; continue; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = eq >= 0 ? a.slice(eq + 1) : undefined;
        const need = () => { const v = val ?? args[++i]; if (v === undefined) throw new Error(`option '--${name}' requires an argument`); return v; };
        try {
          switch (name) {
            case 'date': dateStr = need(); break;
            case 'file': fileArg = need(); break;
            case 'reference': refFile = need(); break;
            case 'utc': case 'universal': utc = true; break;
            case 'iso-8601': iso = val ?? 'date'; break;
            case 'rfc-3339': rfc3339 = need(); break;
            case 'rfc-email': case 'rfc-822': case 'rfc-2822': rfcEmail = true; break;
            case 'set': setStr = need(); break;
            case 'debug': break;
            default: return usage(`unrecognized option '${a}'`);
          }
        } catch (e: any) { return usage(e.message); }
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        const rest = a.slice(j + 1);
        const need = () => { j = a.length; const v = rest || args[++i]; return v; };
        switch (c) {
          case 'd': { const v = need(); if (v === undefined) return usage(`option requires an argument -- 'd'`); dateStr = v; break; }
          case 'f': { const v = need(); if (v === undefined) return usage(`option requires an argument -- 'f'`); fileArg = v; break; }
          case 'r': { const v = need(); if (v === undefined) return usage(`option requires an argument -- 'r'`); refFile = v; break; }
          case 's': { const v = need(); if (v === undefined) return usage(`option requires an argument -- 's'`); setStr = v; break; }
          case 'u': utc = true; break;
          case 'R': rfcEmail = true; break;
          case 'I': iso = rest || 'date'; j = a.length; break;
          default: return usage(`invalid option -- '${c}'`);
        }
      }
    }
    const fmtOps = operands.filter((o) => o.startsWith('+'));
    const others = operands.filter((o) => !o.startsWith('+'));
    if (fmtOps.length > 1 || (fmtOps.length && others.length)) return usage(`extra operand '${operands[1]}'`);
    if (others.length > 1) return usage(`extra operand '${others[1]}'`);
    const exclusive = [dateStr !== null, fileArg !== null, refFile !== null].filter(Boolean).length;
    if (exclusive > 1) return usage('the options to specify dates for printing are mutually exclusive');
    const styles = [iso !== null, rfc3339 !== null, rfcEmail, fmtOps.length > 0].filter(Boolean).length;
    if (styles > 1) return usage('multiple output formats specified');

    const zone = utc ? zoneFor('UTC0') : zoneFor(ctx.env.TZ);
    let format = '%a %b %e %H:%M:%S %Z %Y';
    if (fmtOps.length) format = fmtOps[0].slice(1);
    else if (rfcEmail) format = '%a, %d %b %Y %H:%M:%S %z';
    else if (rfc3339 !== null) {
      const k = rfc3339;
      if (k === 'date') format = '%Y-%m-%d';
      else if (k === 'seconds') format = '%Y-%m-%d %H:%M:%S%:z';
      else if (k === 'ns') format = '%Y-%m-%d %H:%M:%S.%N%:z';
      else return usage(`invalid argument '${k}' for '--rfc-3339'`);
    } else if (iso !== null) {
      const k = iso;
      if (k === 'date' || k === '') format = '%Y-%m-%d';
      else if (k === 'hours') format = '%Y-%m-%dT%H%:z';
      else if (k === 'minutes') format = '%Y-%m-%dT%H:%M%:z';
      else if (k === 'seconds') format = '%Y-%m-%dT%H:%M:%S%:z';
      else if (k === 'ns') format = '%Y-%m-%dT%H:%M:%S,%N%:z';
      else return usage(`invalid argument '${k}' for '--iso-8601'`);
    }

    const nowMs = Date.now();
    const now: Moment = { ms: nowMs, nanos: (nowMs % 1000) * 1e6 };

    if (setStr !== null || others.length) {
      // Setting the clock is not possible from a browser
      if (others.length && setStr === null && !/^\d{8}(\d{2}(\d{2})?)?(\.\d{2})?$/.test(others[0])) {
        ctx.stderr += `date: invalid date '${others[0]}'\n`;
        return 1;
      }
      ctx.stderr += 'date: cannot set date: Operation not permitted\n';
      return 1;
    }

    if (fileArg !== null) {
      let text: string;
      try {
        text = fileArg === '-' ? ctx.stdin || '' : await ctx.fs.readFile(ctx.fs.resolvePath(fileArg, ctx.cwd), 'utf8') as string;
      } catch {
        ctx.stderr += `date: ${fileArg}: No such file or directory\n`;
        return 1;
      }
      let status = 0;
      for (const line of text.split('\n').slice(0, text.endsWith('\n') ? -1 : undefined)) {
        try { ctx.stdout += strftime(format, parseDate(line, now, zone), zone) + '\n'; }
        catch { ctx.stderr += `date: invalid date '${line}'\n`; status = 1; }
      }
      return status;
    }

    let t: Moment = now;
    if (refFile !== null) {
      try {
        const st = await ctx.fs.stat(ctx.fs.resolvePath(refFile, ctx.cwd));
        const ms = st.mtime.getTime();
        t = { ms, nanos: (((ms % 1000) + 1000) % 1000) * 1e6 };
      } catch {
        ctx.stderr += `date: ${refFile}: No such file or directory\n`;
        return 1;
      }
    } else if (dateStr !== null) {
      try { t = parseDate(dateStr, now, zone); }
      catch {
        ctx.stderr += `date: invalid date '${dateStr}'\n`;
        return 1;
      }
    }
    ctx.stdout += strftime(format, t, zone) + '\n';
    return 0;
  },
};
