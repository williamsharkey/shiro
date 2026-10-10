import type { Command } from './index';
import { statEntry } from './flags';

/** A `touch -d`/`date -d` style date: ISO forms, `@SECONDS`, now/today/yesterday/tomorrow, `N UNIT ago`, or what Date parses */
export function parseDateString(s: string, now = Date.now()): number | null {
  const t = s.trim();
  if (/^@-?\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t.slice(1)) * 1000);
  const day = 86_400_000;
  const lower = t.toLowerCase();
  if (lower === 'now' || lower === '') return now;
  if (lower === 'today') return now;
  if (lower === 'yesterday') return now - day;
  if (lower === 'tomorrow') return now + day;
  const rel = /^([+-]?\d+)\s*(second|sec|minute|min|hour|day|week|month|year)s?(\s+ago)?$/.exec(lower);
  if (rel) {
    const n = parseInt(rel[1], 10) * (rel[3] ? -1 : 1);
    const unit = { second: 1000, sec: 1000, minute: 60_000, min: 60_000, hour: 3_600_000, day, week: 7 * day, month: 30 * day, year: 365 * day }[rel[2] as 'day'];
    return now + n * unit;
  }
  // 2020-01-01, 2020-01-01 00:00[:00[.frac]] [zone]: local time unless a zone is given
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(t);
  if (iso) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '', zone] = iso;
    const ms = Math.round(parseFloat('0' + (frac || '.0')) * 1000);
    if (!zone) return new Date(+y, +mo - 1, +d, +h, +mi, +sec, ms).getTime();
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms);
    if (/^(z|utc)$/i.test(zone)) return utc;
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    return utc - sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2), 10)) * 60_000;
  }
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `touch -t [[CC]YY]MMDDhhmm[.ss]` (local time) */
function parseStamp(s: string): number | null {
  const m = /^(\d{2}|\d{4})?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(s);
  if (!m) return null;
  let year = new Date().getFullYear();
  if (m[1]) year = m[1].length === 4 ? +m[1] : (+m[1] < 69 ? 2000 : 1900) + +m[1];
  return new Date(year, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime();
}

export const touch: Command = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(ctx) {
    const args = ctx.args;
    let noCreate = false, onlyA = false, onlyM = false;
    let when: number | null = null;
    let ref: string | undefined;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      const long = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
      if (long) {
        const val = () => long[2] ?? args[++i] ?? '';
        switch (long[1]) {
          case 'no-create': noCreate = true; break;
          case 'date': when = parseDateString(val()); if (when === null) { ctx.stderr += `touch: invalid date format '${long[2] ?? args[i]}'\n`; return 1; } break;
          case 'reference': ref = val(); break;
          case 'no-dereference': break;
          case 'time': { const v = val(); if (/^(atime|access|use)$/.test(v)) onlyA = true; else onlyM = true; break; }
          default: ctx.stderr += `touch: unrecognized option '${a}'\n`; return 1;
        }
        continue;
      }
      if (a.length > 1 && a.startsWith('-')) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          const val = () => (j + 1 < a.length ? a.slice(j + 1) : args[++i] ?? '');
          if (c === 'c') noCreate = true;
          else if (c === 'a') onlyA = true;
          else if (c === 'm') onlyM = true;
          else if (c === 'h' || c === 'f') { /* no effect */ }
          else if (c === 'd') { const v = val(); when = parseDateString(v); if (when === null) { ctx.stderr += `touch: invalid date format '${v}'\n`; return 1; } break; }
          else if (c === 't') { const v = val(); when = parseStamp(v); if (when === null) { ctx.stderr += `touch: invalid date format '${v}'\n`; return 1; } break; }
          else if (c === 'r') { ref = val(); break; }
          else { ctx.stderr += `touch: invalid option -- '${c}'\n`; return 1; }
        }
        continue;
      }
      files.push(a);
    }
    if (files.length === 0) {
      ctx.stderr += "touch: missing file operand\n";
      return 1;
    }
    let refA: number | undefined, refM: number | undefined;
    if (ref !== undefined) {
      try {
        const st: any = await ctx.fs.stat(ctx.fs.resolvePath(ref, ctx.cwd));
        refM = st.mtimeMs ?? new Date(st.mtime).getTime();
        refA = st.atimeMs ?? refM;
      } catch {
        ctx.stderr += `touch: failed to get attributes of '${ref}': No such file or directory\n`;
        return 1;
      }
    }

    let status = 0;
    for (const p of files) {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      try {
        let st: any = null;
        try { st = await statEntry(ctx.fs, resolved); } catch { st = null; }
        if (!st) {
          if (noCreate) continue;
          await ctx.fs.writeFile(resolved, "");
          st = await ctx.fs.stat(resolved);
        }
        const now = Date.now();
        const newA = refA ?? when ?? now, newM = refM ?? when ?? now;
        const curM = st.mtimeMs ?? new Date(st.mtime).getTime();
        const curA = st.atimeMs ?? curM;
        // -a / -m: just that one; both without either
        const a = onlyM && !onlyA ? curA : newA;
        const m = onlyA && !onlyM ? curM : newM;
        await ctx.fs.utimes(resolved, a, m);
      } catch (e: unknown) {
        ctx.stderr += `touch: cannot touch '${p}': ${e instanceof Error ? e.message.replace(/^\w+: /, '') : e}\n`;
        status = 1;
      }
    }
    return status;
  },
};
