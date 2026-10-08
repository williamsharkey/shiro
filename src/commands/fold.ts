import type { Command } from './index';
import { readOperands } from './flags';

/**
 * fold, as GNU coreutils: tabs advance to the next multiple of 8, \b and
 * \r move the column back (unless -b), -s breaks after the last blank.
 */
export const fold: Command = {
  name: "fold",
  description: "Wrap each input line to fit in specified width",
  async exec(ctx) {
    let width = 80;
    let bytes = false;
    let spaces = false;
    const files: string[] = [];
    const args = ctx.args;
    const setWidth = (v: string | undefined): boolean => {
      if (v === undefined || !/^\d+$/.test(v) || parseInt(v, 10) < 1) {
        ctx.stderr += v === undefined ? "fold: option requires an argument -- 'w'\n" : `fold: invalid number of columns: '${v}'${/^\d+$/.test(v) ? ': Numerical result out of range' : ''}\n`;
        return false;
      }
      width = parseInt(v, 10);
      return true;
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) {
        if (a === '--bytes') bytes = true;
        else if (a === '--spaces') spaces = true;
        else if (a === '--width' || a.startsWith('--width=')) { if (!setWidth(a === '--width' ? args[++i] : a.slice(8))) return 1; }
        else { ctx.stderr += `fold: unrecognized option '${a}'\n`; return 1; }
        continue;
      }
      if (a.length > 1 && a[0] === '-') {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (ch === 'b') bytes = true;
          else if (ch === 's') spaces = true;
          else if (ch === 'w') { if (!setWidth(a.slice(j + 1) || args[++i])) return 1; break; }
          else if (/\d/.test(ch)) {
            const m = /^\d+/.exec(a.slice(j))![0];
            if (!setWidth(m)) return 1;
            j += m.length - 1;
          } else { ctx.stderr += `fold: invalid option -- '${ch}'\n`; return 1; }
        }
        continue;
      }
      files.push(a);
    }

    const { content, status } = await readOperands(ctx, 'fold', files);
    const adjust = (col: number, c: string): number => {
      if (bytes) return col + 1;
      if (c === '\b') return col > 0 ? col - 1 : 0;
      if (c === '\r') return 0;
      if (c === '\t') return col + 8 - (col % 8);
      return col + 1;
    };

    let out = '';
    let line: string[] = [];
    let column = 0;
    for (const c of content) {
      if (c === '\n') {
        out += line.join('') + '\n';
        line = [];
        column = 0;
        continue;
      }
      for (;;) {
        column = adjust(column, c);
        if (column <= width) { line.push(c); break; }
        if (spaces) {
          let end = line.length;
          let found = false;
          while (end) {
            end--;
            if (line[end] === ' ' || line[end] === '\t') { found = true; break; }
          }
          if (found) {
            end++;
            out += line.slice(0, end).join('') + '\n';
            line = line.slice(end);
            column = 0;
            for (const x of line) column = adjust(column, x);
            continue;
          }
        }
        if (line.length === 0) { line.push(c); break; }
        out += line.join('') + '\n';
        line = [];
        column = 0;
      }
    }
    out += line.join('');
    ctx.stdout += out;
    return status;
  },
};
