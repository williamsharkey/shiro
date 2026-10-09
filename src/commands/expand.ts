import type { Command } from './index';
import { readOperands } from './flags';

/**
 * Tab stops shared by expand and unexpand (GNU expand-common.c): a single
 * size, or a comma/blank separated ascending list, optionally ending in
 * `/N` (then every multiple of N) or `+N` (then every N after the last).
 */
export class TabStops {
  list: number[] = [];
  extend = 0;
  increment = 0;
  size = 0;

  /** Add stops from a -t argument; returns an error message or null */
  parse(spec: string): string | null {
    const re = /([/+]?)(\d*)/y;
    let i = 0;
    while (i < spec.length) {
      const c = spec[i];
      if (c === ',' || c === ' ' || c === '\t') { i++; continue; }
      re.lastIndex = i;
      const m = re.exec(spec);
      if (!m || (m[1] === '' && m[2] === '')) return `tab size contains invalid character(s): '${spec.slice(i)}'`;
      if (m[2] === '') return `'${m[1]}' specifier not followed by a number`;
      const n = parseInt(m[2], 10);
      if (m[1] === '/') this.extend = n;
      else if (m[1] === '+') this.increment = n;
      else {
        if (this.extend || this.increment) return `'${this.extend ? '/' : '+'}' specifier only allowed with the last value`;
        this.list.push(n);
      }
      i = re.lastIndex;
    }
    return null;
  }

  /** Validate and settle; returns an error message or null */
  finish(): string | null {
    let prev = 0;
    for (const t of this.list) {
      if (t === 0) return 'tab size cannot be 0';
      if (t <= prev) return 'tab sizes must be ascending';
      prev = t;
    }
    if (this.extend && this.increment) return "'/' specifier is mutually exclusive with '+'";
    if (this.list.length === 0) this.size = this.extend || this.increment || 8;
    else if (this.list.length === 1 && !this.extend && !this.increment) this.size = this.list[0];
    else this.size = 0;
    return null;
  }

  /** Next tab stop after `column` (`last` when past the final stop of a list) */
  next(column: number, state: { index: number }): { col: number; last: boolean } {
    if (this.size) return { col: column + (this.size - column % this.size), last: false };
    for (; state.index < this.list.length; state.index++) {
      if (column < this.list[state.index]) return { col: this.list[state.index], last: false };
    }
    if (this.extend) return { col: column + (this.extend - column % this.extend), last: false };
    if (this.increment) {
      const end = this.list[this.list.length - 1];
      return { col: column + (this.increment - ((column - end) % this.increment)), last: false };
    }
    return { col: 0, last: true };
  }
}

/** Options common to expand/unexpand: -t LIST, --tabs=LIST, obsolete -N[,N...] */
export function parseTabArgs(
  cmd: string,
  args: string[],
  onFlag: (name: string) => boolean,
): { tabs: TabStops; files: string[]; sawT: boolean; error?: string } {
  const tabs = new TabStops();
  const files: string[] = [];
  let sawT = false;
  const fail = (error: string) => ({ tabs, files, sawT, error });
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { files.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      if (a === '--tabs' || a.startsWith('--tabs=')) {
        const v = a === '--tabs' ? args[++i] : a.slice(7);
        if (v === undefined) return fail(`option '--tabs' requires an argument`);
        const e = tabs.parse(v);
        if (e) return fail(e);
        sawT = true;
        continue;
      }
      if (onFlag(a)) continue;
      return fail(`unrecognized option '${a}'`);
    }
    if (a.length > 1 && a[0] === '-') {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 't') {
          const v = a.slice(j + 1) || args[++i];
          if (v === undefined) return fail(`option requires an argument -- 't'`);
          const e = tabs.parse(v);
          if (e) return fail(e);
          sawT = true;
          break;
        }
        if (/\d/.test(ch)) {
          const m = /^[\d,]+/.exec(a.slice(j))![0];
          const e = tabs.parse(m);
          if (e) return fail(e);
          j += m.length - 1;
          continue;
        }
        if (onFlag('-' + ch)) continue;
        return fail(`invalid option -- '${ch}'`);
      }
      continue;
    }
    files.push(a);
  }
  const e = tabs.finish();
  if (e) return fail(e);
  return { tabs, files, sawT };
}

export const expand: Command = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(ctx) {
    let initialOnly = false;
    const parsed = parseTabArgs('expand', ctx.args, (f) => {
      if (f === '-i' || f === '--initial') { initialOnly = true; return true; }
      return false;
    });
    if (parsed.error) {
      ctx.stderr += `expand: ${parsed.error}\n`;
      if (/option/.test(parsed.error)) ctx.stderr += `Try 'expand --help' for more information.\n`;
      return 1;
    }
    const { tabs } = parsed;
    const { content, status } = await readOperands(ctx, 'expand', parsed.files);

    let out = '';
    let column = 0;
    const state = { index: 0 };
    let convert = true;
    for (const c of content) {
      if (convert) {
        if (c === '\t') {
          const nt = tabs.next(column, state);
          const next = nt.last ? column + 1 : nt.col;
          out += ' '.repeat(next - column);
          column = next;
        } else if (c === '\b') {
          if (column) column--;
          if (state.index) state.index--;
          out += c;
        } else if (c !== '\n') {
          column++;
          out += c;
        }
        if (initialOnly && c !== ' ' && c !== '\t') convert = false;
      } else if (c !== '\n') {
        out += c;
      }
      if (c === '\n') {
        out += c;
        column = 0;
        state.index = 0;
        convert = true;
      }
    }
    ctx.stdout += out;
    return status;
  },
};
