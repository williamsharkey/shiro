import type { Command } from './index';
import { readOperands, splitLines } from './flags';
import { posixRegExp } from '../utils/posix-regex';

/**
 * nl, as GNU coreutils: -b/-h/-f STYLE (a, t, n, pBRE), -d CC section
 * delimiters, -i, -l, -n ln|rn|rz, -p, -s, -v, -w. Unnumbered lines get
 * width + separator-length spaces.
 */
export const nl: Command = {
  name: "nl",
  description: "Number lines of files",
  async exec(ctx) {
    const styles: Record<'h' | 'b' | 'f', string> = { h: 'n', b: 't', f: 'n' };
    let delim = '\\:';
    let incr = 1;
    let join = 1;
    let format = 'rn';
    let renumber = true;
    let sep = '\t';
    let start = 1;
    let width = 6;
    const files: string[] = [];
    const longs: Record<string, string> = {
      'body-numbering': 'b', 'section-delimiter': 'd', 'footer-numbering': 'f', 'header-numbering': 'h',
      'line-increment': 'i', 'join-blank-lines': 'l', 'number-format': 'n', 'no-renumber': 'p',
      'number-separator': 's', 'starting-line-number': 'v', 'number-width': 'w',
    };
    const opts: [string, string | undefined][] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const key = longs[name];
        if (!key) { ctx.stderr += `nl: unrecognized option '${a}'\n`; return 1; }
        if (key === 'p') { opts.push(['p', undefined]); continue; }
        opts.push([key, eq >= 0 ? a.slice(eq + 1) : args[++i]]);
        continue;
      }
      if (a.length > 1 && a[0] === '-') {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (ch === 'p') { opts.push(['p', undefined]); continue; }
          if (!'bdfhilnsvw'.includes(ch)) { ctx.stderr += `nl: invalid option -- '${ch}'\n`; return 1; }
          const rest = a.slice(j + 1);
          const val = rest !== '' ? rest : args[++i];
          if (val === undefined) { ctx.stderr += `nl: option requires an argument -- '${ch}'\n`; return 1; }
          opts.push([ch, val]);
          break;
        }
        continue;
      }
      files.push(a);
    }
    const num = (o: string, v: string, min: number): number | null => {
      if (!/^[+-]?\d+$/.test(v.trim()) || parseInt(v, 10) < min) {
        const range = /^[+-]?\d+$/.test(v.trim()) ? ': Numerical result out of range' : '';
        ctx.stderr += `nl: invalid ${({ i: 'line number increment', l: 'line number of blank lines', v: 'starting line number', w: 'line number field width' } as Record<string, string>)[o]}: '${v}'${range}\n`;
        return null;
      }
      return parseInt(v, 10);
    };
    for (const [o, v] of opts) {
      switch (o) {
        case 'b': case 'h': case 'f':
          if (!/^([atn]|p.*)$/s.test(v!)) { ctx.stderr += `nl: invalid ${({ b: 'body', h: 'header', f: 'footer' } as Record<string, string>)[o]} numbering style: '${v}'\nTry 'nl --help' for more information.\n`; return 1; }
          styles[o] = v!;
          break;
        case 'd': delim = v!.length === 1 ? v! + ':' : v!; break;
        case 'i': { const n = num(o, v!, -Infinity); if (n === null) return 1; incr = n; break; }
        case 'l': { const n = num(o, v!, 1); if (n === null) return 1; join = n; break; }
        case 'n':
          if (!['ln', 'rn', 'rz'].includes(v!)) { ctx.stderr += `nl: invalid line numbering format: '${v}'\n`; return 1; }
          format = v!;
          break;
        case 'p': renumber = false; break;
        case 's': sep = v!; break;
        case 'v': { const n = num(o, v!, -Infinity); if (n === null) return 1; start = n; break; }
        case 'w': { const n = num(o, v!, 1); if (n === null) return 1; width = n; break; }
      }
    }
    const regexes: Partial<Record<'h' | 'b' | 'f', RegExp>> = {};
    for (const k of ['h', 'b', 'f'] as const) {
      if (styles[k][0] === 'p') {
        try { regexes[k] = posixRegExp(styles[k].slice(1)); } catch {
          ctx.stderr += `nl: invalid regular expression\n`;
          return 1;
        }
      }
    }

    const { content, status } = await readOperands(ctx, 'nl', files);
    const lines = splitLines(content);
    let out = '';
    let lineNo = start;
    let section: 'h' | 'b' | 'f' = 'b';
    let blanks = 0;
    const noNum = ' '.repeat(width + sep.length);
    const fmt = (n: number) => {
      const s = String(n);
      if (format === 'ln') return s.padEnd(width, ' ');
      if (format === 'rz') return n < 0 ? '-' + String(-n).padStart(width - 1, '0') : s.padStart(width, '0');
      return s.padStart(width, ' ');
    };
    for (const line of lines) {
      // Section delimiter lines: \:\:\: header, \:\: body, \: footer
      if (delim !== '' && line !== '' && line.length % delim.length === 0 && line === delim.repeat(line.length / delim.length) && line.length / delim.length <= 3) {
        const n = line.length / delim.length;
        section = n === 3 ? 'h' : n === 2 ? 'b' : 'f';
        if (renumber) lineNo = start;
        out += '\n';
        blanks = 0;
        continue;
      }
      const style = styles[section];
      let number = false;
      if (style === 'a') {
        if (join > 1) {
          if (line === '') {
            if (++blanks === join) { number = true; blanks = 0; }
          } else { number = true; blanks = 0; }
        } else number = true;
      } else if (style === 't') number = line !== '';
      else if (style[0] === 'p') number = regexes[section]!.test(line);
      if (number) {
        out += fmt(lineNo) + sep + line + '\n';
        lineNo += incr;
      } else {
        out += noNum + line + '\n';
      }
    }
    ctx.stdout += out;
    return status;
  },
};
