/**
 * column - Format input into columns (as util-linux column)
 *
 *   column [-t] [-s SEPS] [-o SEP] [-n] [-x] [-c WIDTH] [FILE...]
 *
 * -t makes a table: each line split at the separator characters (blanks
 * by default; adjacent ones count once unless -n), every column but the
 * last padded to its widest cell, joined by -o (two spaces). Without -t,
 * the input lines are filled into as many tab-aligned columns as fit the
 * width: down the columns first, across with -x.
 */
import type { Command } from './index';
import { readInput } from './flags';

export const column: Command = {
  name: "column",
  description: "Format input into columns",
  async exec(ctx) {
    let table = false, across = false, keepEmpty = false;
    let seps: string | undefined, outSep = '  ';
    let width = parseInt(ctx.env['COLUMNS'] ?? '', 10) || 80;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) {
        const [name, v] = a.includes('=') ? [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a.slice(2), undefined];
        const val = () => v ?? args[++i] ?? '';
        if (name === 'table') table = true;
        else if (name === 'fillrows') across = true;
        else if (name === 'separator') seps = val();
        else if (name === 'output-separator') outSep = val();
        else if (name === 'output-width') width = parseInt(val(), 10) || width;
        else { ctx.stderr += `column: unrecognized option '${a}'\n`; return 1; }
        continue;
      }
      if (a.length > 1 && a.startsWith('-')) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          const val = () => (j + 1 < a.length ? a.slice(j + 1) : args[++i] ?? '');
          if (c === 't') table = true;
          else if (c === 'x') across = true;
          else if (c === 'n') keepEmpty = true;
          else if (c === 's') { seps = val(); break; }
          else if (c === 'o') { outSep = val(); break; }
          else if (c === 'c') { width = parseInt(val(), 10) || width; break; }
          else { ctx.stderr += `column: invalid option -- '${c}'\n`; return 1; }
        }
        continue;
      }
      files.push(a);
    }

    let content: string;
    try {
      ({ content } = await readInput(files, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath));
    } catch (err: any) {
      ctx.stderr += `column: ${err.message}\n`;
      return 1;
    }
    // empty lines are left out, as util-linux does
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return 0;

    if (table) {
      const escape = (s: string) => s.replace(/[\\\]^-]/g, '\\$&');
      const split = seps === undefined
        ? (l: string) => l.trim().split(keepEmpty ? /[ \t]/ : /[ \t]+/)
        : (l: string) => {
            const cells = l.split(new RegExp(`[${escape(seps!)}]`));
            return keepEmpty ? cells : cells.filter((c, k) => c !== '' || k === 0);
          };
      const rows = lines.map(split);
      const widths: number[] = [];
      for (const r of rows) r.forEach((c, k) => { widths[k] = Math.max(widths[k] ?? 0, [...c].length); });
      ctx.stdout += rows.map((r) => r.map((c, k) => (k === r.length - 1 ? c : c + ' '.repeat(widths[k] - [...c].length))).join(outSep)).join('\n') + '\n';
      return 0;
    }

    // tab-aligned columns, as wide as the longest entry rounded up to a tab stop
    const maxLen = Math.max(...lines.map((l) => [...l].length));
    const colWidth = (maxLen + 8) & ~7;
    const numCols = Math.max(1, Math.floor(width / colWidth));
    const numRows = Math.ceil(lines.length / numCols);
    const out: string[] = [];
    for (let r = 0; r < numRows; r++) {
      let row = '';
      for (let c = 0; c < numCols; c++) {
        const idx = across ? r * numCols + c : c * numRows + r;
        if (idx >= lines.length) break;
        const next = across ? idx + 1 : idx + numRows;
        const entry = lines[idx];
        row += entry;
        if (c < numCols - 1 && next < lines.length && (across ? (r * numCols + c + 1 < lines.length) : true)) {
          const len = [...entry].length;
          row += '\t'.repeat(Math.ceil((colWidth - len) / 8));
        }
      }
      out.push(row);
    }
    ctx.stdout += out.join('\n') + '\n';
    return 0;
  },
};
