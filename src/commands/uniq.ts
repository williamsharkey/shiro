import type { Command } from './index';
import { readOperands, splitLines } from './flags';

/**
 * uniq [OPTION]... [INPUT [OUTPUT]], as GNU coreutils: -c -d -D -u -i
 * -f N -s N -w N -z --all-repeated[=M] --group[=M], obsolete -N / +N.
 * Fields are runs of blanks followed by non-blanks.
 */
export const uniq: Command = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(ctx) {
    let count = false, dupsOnly = false, uniqOnly = false, ignoreCase = false, zero = false;
    type AllRepeated = 'none' | 'prepend' | 'separate';
    type Group = 'separate' | 'prepend' | 'append' | 'both';
    let allRepeated = null as AllRepeated | null;
    let group = null as Group | null;
    let skipFields = 0, skipChars = 0, checkChars = Infinity;
    const operands: string[] = [];
    const usage = (msg: string) => { ctx.stderr += `uniq: ${msg}\nTry 'uniq --help' for more information.\n`; return 1; };
    const num = (v: string | undefined, what: string): number | null => {
      if (v === undefined || !/^\d+$/.test(v)) {
        ctx.stderr += `uniq: ${v ?? ''}: invalid number of ${what}\n`;
        return null;
      }
      return parseInt(v, 10);
    };
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { operands.push(...args.slice(i + 1)); break; }
      if (/^\+\d+$/.test(a)) { skipChars = parseInt(a.slice(1), 10); continue; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = eq >= 0 ? a.slice(eq + 1) : undefined;
        const need = () => val ?? args[++i];
        let n: number | null;
        switch (name) {
          case 'count': count = true; break;
          case 'repeated': dupsOnly = true; break;
          case 'unique': uniqOnly = true; break;
          case 'ignore-case': ignoreCase = true; break;
          case 'zero-terminated': zero = true; break;
          case 'all-repeated':
            if (val !== undefined && !['none', 'prepend', 'separate'].includes(val)) return usage(`invalid argument '${val}' for '--all-repeated'`);
            allRepeated = (val ?? 'none') as AllRepeated;
            break;
          case 'group':
            if (val !== undefined && !['separate', 'prepend', 'append', 'both'].includes(val)) return usage(`invalid argument '${val}' for '--group'`);
            group = (val ?? 'separate') as Group;
            break;
          case 'skip-fields': if ((n = num(need(), 'fields to skip')) === null) return 1; skipFields = n; break;
          case 'skip-chars': if ((n = num(need(), 'bytes to skip')) === null) return 1; skipChars = n; break;
          case 'check-chars': if ((n = num(need(), 'bytes to compare')) === null) return 1; checkChars = n; break;
          default: return usage(`unrecognized option '${a}'`);
        }
        continue;
      }
      if (a.length > 1 && a[0] === '-') {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (/\d/.test(ch)) {
            const m = /^\d+/.exec(a.slice(j))![0];
            skipFields = parseInt(m, 10);
            j += m.length - 1;
            continue;
          }
          if ('fsw'.includes(ch)) {
            const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
            if (v === undefined) return usage(`option requires an argument -- '${ch}'`);
            const n = num(v, ch === 'f' ? 'fields to skip' : ch === 's' ? 'bytes to skip' : 'bytes to compare');
            if (n === null) return 1;
            if (ch === 'f') skipFields = n; else if (ch === 's') skipChars = n; else checkChars = n;
            break;
          }
          if (ch === 'c') count = true;
          else if (ch === 'd') dupsOnly = true;
          else if (ch === 'u') uniqOnly = true;
          else if (ch === 'i') ignoreCase = true;
          else if (ch === 'z') zero = true;
          else if (ch === 'D') allRepeated = 'none' as AllRepeated;
          else return usage(`invalid option -- '${ch}'`);
        }
        continue;
      }
      operands.push(a);
    }
    if (operands.length > 2) return usage(`extra operand '${operands[2]}'`);
    if (group && (count || dupsOnly || uniqOnly || allRepeated)) return usage('--group is mutually exclusive with -c/-d/-D/-u');
    if (count && allRepeated) return usage('printing all duplicated lines and repeat counts is meaningless');

    const { content, status } = await readOperands(ctx, 'uniq', [operands[0] ?? '-']);
    if (status) return 1;
    const eol = zero ? '\0' : '\n';
    const lines = splitLines(content, eol);

    const key = (line: string): string => {
      let p = 0;
      for (let f = 0; f < skipFields && p < line.length; f++) {
        while (p < line.length && (line[p] === ' ' || line[p] === '\t')) p++;
        while (p < line.length && line[p] !== ' ' && line[p] !== '\t') p++;
      }
      p = Math.min(line.length, p + skipChars);
      let k = checkChars === Infinity ? line.slice(p) : line.slice(p, p + checkChars);
      if (ignoreCase) k = k.toLowerCase();
      return k;
    };

    let out = '';
    // Groups of equal adjacent lines
    const groups: string[][] = [];
    let prevKey: string | null = null;
    for (const line of lines) {
      const k = key(line);
      if (prevKey !== null && k === prevKey) groups[groups.length - 1].push(line);
      else groups.push([line]);
      prevKey = k;
    }
    if (group) {
      groups.forEach((g, gi) => {
        if (group === 'prepend' || group === 'both' || (group === 'separate' && gi > 0)) out += eol;
        for (const l of g) out += l + eol;
        if (group === 'append') out += eol;
      });
      if (groups.length && group === 'both') out += eol;
    } else if (allRepeated) {
      let first = true;
      for (const g of groups) {
        if (g.length < 2 || uniqOnly) continue;
        if ((allRepeated === 'prepend') || (allRepeated === 'separate' && !first)) out += eol;
        first = false;
        for (const l of g) out += l + eol;
      }
    } else {
      for (const g of groups) {
        if (dupsOnly && g.length < 2) continue;
        if (uniqOnly && g.length > 1) continue;
        out += (count ? `${String(g.length).padStart(7)} ` : '') + g[0] + eol;
      }
    }

    const outFile = operands[1];
    if (outFile !== undefined && outFile !== '-') {
      try {
        await ctx.fs.writeFile(ctx.fs.resolvePath(outFile, ctx.cwd), out);
      } catch (e: unknown) {
        ctx.stderr += `uniq: ${outFile}: ${e instanceof Error ? e.message : e}\n`;
        return 1;
      }
    } else {
      ctx.stdout += out;
    }
    return 0;
  },
};
